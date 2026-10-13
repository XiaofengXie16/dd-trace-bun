// Bun-specific behaviour: Bun.serve's routes, reload and WebSockets, Elysia, and init().
// The traced apps are in fixture.ts; behaviour shared with node:http is in parity/.
import { afterAll, describe, expect, test } from 'bun:test'
import { rawGet, randomId, spawnApp, startFakeAgent } from './helpers'

interface Ports { bun: number; classBased: number; reloaded: number; elysia: number; node: number }

const agent = await startFakeAgent()
const app = await spawnApp<Ports>(['bun', `${import.meta.dir}/fixture.ts`], {
  AGENT_PORT: String(agent.port),
  NODE_ENV: 'production',
  // turned on in many fleets, and dd-trace's runtime metrics crash Bun
  DD_RUNTIME_METRICS_ENABLED: 'true',
})
const ports = app.info
afterAll(() => { app.stop(); agent.close() })

const traced = (trace: string) => ({ 'x-datadog-trace-id': trace, 'x-datadog-parent-id': randomId() })

/** Server spans of a trace, from the fixture's Bun servers (not its node:http echo service). */
const serverSpans = (trace: string) => agent.spans.filter((s) =>
  s.trace === trace && s.meta['span.kind'] === 'server' && s.meta.component === 'http' &&
  [ports.bun, ports.classBased, ports.reloaded, ports.elysia].some((p) => s.meta['http.url']?.includes(`:${p}/`)))

const serverSpan = async (trace: string) => {
  await agent.waitFor(() => serverSpans(trace).length > 0)
  await Bun.sleep(50)
  const spans = serverSpans(trace)
  expect(spans).toHaveLength(1)
  return spans[0]!
}

describe('Bun.serve', () => {
  test('continues a Datadog trace from incoming headers', async () => {
    const trace = randomId(), parent = randomId()
    const res = await rawGet(ports.bun, '/hello', { 'x-datadog-trace-id': trace, 'x-datadog-parent-id': parent, 'x-datadog-sampling-priority': '1' })
    const body = JSON.parse(res.body)
    expect(body.active).toBe(trace)
    expect(body.downstream).toBe(trace) // outbound fetch carries the same trace
    await agent.waitFor(() => agent.spans.some((s) => s.trace === trace && s.name === 'child.work'))
    const server = await serverSpan(trace)
    expect(server.parent).toBe(parent)
    expect(server.resource).toBe('GET')
    expect(server.meta['http.status_code']).toBe('200')
    const child = agent.spans.find((s) => s.trace === trace && s.name === 'child.work')!
    expect(child.parent).toBe(server.span)
    // the downstream service's span hangs off Bun's outbound fetch span
    const outbound = agent.spans.find((s) => s.trace === trace && s.meta.component === 'fetch')!
    expect(outbound.parent).toBe(server.span)
  })

  test('continues a W3C traceparent trace', async () => {
    const traceHex = '0000000000000000' + BigInt(randomId()).toString(16).padStart(16, '0')
    const parentHex = BigInt(randomId()).toString(16).padStart(16, '0')
    const res = await rawGet(ports.bun, '/hello', { traceparent: `00-${traceHex}-${parentHex}-01` })
    const body = JSON.parse(res.body)
    expect(body.active).toBe(BigInt('0x' + traceHex.slice(16)).toString())
    expect(body.traceparent).toContain(traceHex)
  })

  test('names spans after Bun routes templates', async () => {
    const t1 = randomId(), t2 = randomId(), t3 = randomId()
    await rawGet(ports.bun, '/users/42', traced(t1))
    await rawGet(ports.bun, '/items', traced(t2))
    expect((await rawGet(ports.bun, '/items', traced(t3), { method: 'POST' })).status).toBe(201)
    const users = await serverSpan(t1)
    expect(users.resource).toBe('GET /users/:id')
    expect(users.meta['http.route']).toBe('/users/:id')
    expect((await serverSpan(t2)).resource).toBe('GET /items')
    expect((await serverSpan(t3)).resource).toBe('POST /items')
  })

  test('marks thrown errors and 5xx responses', async () => {
    const t1 = randomId(), t2 = randomId()
    expect((await rawGet(ports.bun, '/boom', traced(t1))).status).toBe(500)
    expect((await rawGet(ports.bun, '/503', traced(t2))).status).toBe(503)
    const thrown = await serverSpan(t1)
    expect(thrown.error).toBe(1)
    expect(thrown.meta['error.message']).toBe('kaboom')
    expect(thrown.meta['http.status_code']).toBe('500')
    const unavailable = await serverSpan(t2)
    expect(unavailable.error).toBe(1)
    expect(unavailable.meta['http.status_code']).toBe('503')
  })

  test('records WebSocket upgrades', async () => {
    const trace = randomId()
    // Bun's WebSocket client accepts headers
    const ws = new WebSocket(`ws://127.0.0.1:${ports.bun}/ws`, { headers: traced(trace) } as unknown as string[])
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
    ws.close()
    const span = await serverSpan(trace)
    expect(span.meta['http.status_code']).toBe('101')
    expect(span.error).toBe(0)
  })

  test('keeps concurrent request contexts isolated', async () => {
    const ids = Array.from({ length: 100 }, () => randomId())
    const bodies = await Promise.all(ids.map((t) => rawGet(ports.bun, '/hello', traced(t)).then((r) => JSON.parse(r.body))))
    bodies.forEach((body, i) => {
      expect(body.active).toBe(ids[i])
      expect(body.downstream).toBe(ids[i])
    })
    await agent.waitFor(() => ids.every((t) => serverSpans(t).length === 1))
    for (const t of ids) {
      const child = agent.spans.find((s) => s.trace === t && s.name === 'child.work')
      expect(child?.parent).toBe(serverSpans(t)[0]!.span)
    }
  })

  test('serves class-based options, whose fetch is on the prototype', async () => {
    const trace = randomId()
    expect((await rawGet(ports.classBased, '/', traced(trace))).body).toBe('class-based')
    expect((await serverSpan(trace)).meta['http.status_code']).toBe('200')
  })

  test('traces the handlers passed to server.reload(), once even if already wrapped', async () => {
    const t1 = randomId(), t2 = randomId()
    expect((await rawGet(ports.reloaded, '/x', traced(t1))).body).toBe('after reload')
    expect((await rawGet(ports.reloaded, '/things/7', traced(t2))).body).toBe('thing')
    await serverSpan(t1) // asserts there's exactly one
    expect((await serverSpan(t2)).resource).toBe('GET /things/:id')
  })
})

describe('Elysia', () => {
  test('.listen() is traced and connected, named by route template', async () => {
    const trace = randomId(), parent = randomId()
    const res = await rawGet(ports.elysia, '/users/7', { 'x-datadog-trace-id': trace, 'x-datadog-parent-id': parent })
    expect(JSON.parse(res.body)).toEqual({ id: '7', active: trace })
    const span = await serverSpan(trace)
    expect(span.parent).toBe(parent)
    expect(span.resource).toBe('GET /users/:id')
  })

  test('records errors thrown in handlers', async () => {
    const trace = randomId()
    expect((await rawGet(ports.elysia, '/fail', traced(trace))).status).toBe(500)
    const span = await serverSpan(trace)
    expect(span.error).toBe(1)
    expect(span.meta['error.message']).toBe('elysia boom')
  })

  test('does not mark client errors as span errors', async () => {
    const notFound = randomId(), invalid = randomId()
    expect((await rawGet(ports.elysia, '/missing', traced(notFound))).status).toBe(404)
    const res = await fetch(`http://127.0.0.1:${ports.elysia}/items`, {
      method: 'POST',
      headers: { ...traced(invalid), 'content-type': 'application/json' },
      body: JSON.stringify({ name: 42 }),
    })
    expect(res.status).toBe(422)
    expect((await serverSpan(notFound)).error).toBe(0)
    const span = await serverSpan(invalid)
    expect(span.error).toBe(0)
    expect(span.resource).toBe('POST /items')
  })
})

describe('node:http in Bun', () => {
  test('is traced once, by dd-trace itself', async () => {
    const trace = randomId()
    await rawGet(ports.node, '/x', traced(trace))
    await agent.waitFor(() => agent.spans.some((s) => s.trace === trace))
    await Bun.sleep(200)
    const spans = agent.spans.filter((s) => s.trace === trace)
    expect(spans).toHaveLength(1)
    expect(spans[0]!.meta.component).toBe('http')
  })
})

describe('init()', () => {
  test('ignores DD_RUNTIME_METRICS_ENABLED, which crashes Bun', () => {
    // the fixture runs with it set, so it's still serving requests
    expect(app.stderr()).toContain('dd-trace-bun: ignoring DD_RUNTIME_METRICS_ENABLED')
  })
})
