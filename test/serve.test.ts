import { afterAll, describe, expect, test } from 'bun:test'
import { startFakeAgent, rawGet, randomId } from './helpers'

const agent = await startFakeAgent()
const app = Bun.spawn(['bun', `${import.meta.dir}/fixture.ts`], { env: { ...process.env, AGENT_PORT: String(agent.port), NODE_ENV: 'production' }, stdout: 'pipe', stderr: 'inherit' })
const ports: { bun: number; elysia: number; node: number } = await (async () => {
  const reader = app.stdout.getReader(); let buf = ''
  while (!buf.includes('\n')) { const { value, done } = await reader.read(); if (done) break; buf += new TextDecoder().decode(value) }
  return JSON.parse(buf.split('\n').find((l) => l.startsWith('{'))!)
})()
afterAll(() => { app.kill(); agent.close() })

const serverSpans = (trace: string) => agent.spans.filter((s) => s.trace === trace && s.service === 'bun-svc' && s.name === 'web.request' && s.meta.component === 'bun')

describe('Bun.serve', () => {
  const port = ports.bun

  test('continues a Datadog trace from incoming headers', async () => {
    const trace = randomId(), parent = randomId()
    const res = await rawGet(port, '/hello', { 'x-datadog-trace-id': trace, 'x-datadog-parent-id': parent, 'x-datadog-sampling-priority': '1' })
    const body = JSON.parse(res.body)
    expect(body.active).toBe(trace)
    expect(body.downstream).toBe(trace) // outbound fetch carries the same trace
    await agent.waitFor(() => serverSpans(trace).length === 1 && agent.spans.some((s) => s.trace === trace && s.name === 'child.work'))
    const [server] = serverSpans(trace)
    expect(server.parent).toBe(parent)
    expect(server.resource).toBe('GET')
    expect(server.meta['span.kind']).toBe('server')
    expect(server.meta['http.status_code']).toBe('200')
    const child = agent.spans.find((s) => s.trace === trace && s.name === 'child.work')!
    expect(child.parent).toBe(server.span)
    // the downstream node:http service's span hangs off Bun's outbound fetch span
    const outbound = agent.spans.find((s) => s.trace === trace && s.meta.component === 'fetch')!
    expect(outbound.parent).toBe(server.span)
  })

  test('continues a W3C traceparent trace', async () => {
    const traceHex = '0000000000000000' + BigInt(randomId()).toString(16).padStart(16, '0')
    const parentHex = BigInt(randomId()).toString(16).padStart(16, '0')
    const res = await rawGet(port, '/hello', { traceparent: `00-${traceHex}-${parentHex}-01` })
    const body = JSON.parse(res.body)
    expect(body.active).toBe(BigInt('0x' + traceHex.slice(16)).toString())
    expect(body.traceparent).toContain(traceHex)
  })

  test('names spans from Bun routes templates', async () => {
    const trace = randomId()
    await rawGet(port, '/users/42', { 'x-datadog-trace-id': trace, 'x-datadog-parent-id': randomId() })
    const t2 = randomId()
    await rawGet(port, '/items', { 'x-datadog-trace-id': t2, 'x-datadog-parent-id': randomId() })
    await agent.waitFor(() => serverSpans(trace).length === 1 && serverSpans(t2).length === 1)
    expect(serverSpans(trace)[0].resource).toBe('GET /users/:id')
    expect(serverSpans(trace)[0].meta['http.route']).toBe('/users/:id')
    expect(serverSpans(t2)[0].resource).toBe('GET /items')
  })

  test('marks thrown errors and 5xx responses', async () => {
    const t1 = randomId(), t2 = randomId()
    expect((await rawGet(port, '/boom', { 'x-datadog-trace-id': t1, 'x-datadog-parent-id': randomId() })).status).toBe(500)
    expect((await rawGet(port, '/503', { 'x-datadog-trace-id': t2, 'x-datadog-parent-id': randomId() })).status).toBe(503)
    await agent.waitFor(() => serverSpans(t1).length === 1 && serverSpans(t2).length === 1)
    expect(serverSpans(t1)[0].error).toBe(1)
    expect(serverSpans(t1)[0].meta['error.message']).toBe('kaboom')
    expect(serverSpans(t2)[0].error).toBe(1)
    expect(serverSpans(t2)[0].meta['http.status_code']).toBe('503')
  })

  test('keeps concurrent request contexts isolated', async () => {
    const ids = Array.from({ length: 100 }, () => randomId())
    const bodies = await Promise.all(ids.map((t) => rawGet(port, '/hello', { 'x-datadog-trace-id': t, 'x-datadog-parent-id': randomId() }).then((r) => JSON.parse(r.body))))
    bodies.forEach((b, i) => { expect(b.active).toBe(ids[i]); expect(b.downstream).toBe(ids[i]) })
    await agent.waitFor(() => ids.every((t) => serverSpans(t).length === 1))
    for (const t of ids) {
      const child = agent.spans.find((s) => s.trace === t && s.name === 'child.work')
      expect(child?.parent).toBe(serverSpans(t)[0].span)
    }
  })
})

describe('Elysia', () => {
  const port = ports.elysia

  test('.listen() is traced and connected, named by route template', async () => {
    const trace = randomId(), parent = randomId()
    const res = await rawGet(port, '/users/7', { 'x-datadog-trace-id': trace, 'x-datadog-parent-id': parent })
    expect(JSON.parse(res.body)).toEqual({ id: '7', active: trace })
    await agent.waitFor(() => serverSpans(trace).length === 1)
    const [span] = serverSpans(trace)
    expect(span.parent).toBe(parent)
    expect(span.resource).toBe('GET /users/:id')
  })

  test('errors thrown in handlers are recorded', async () => {
    const trace = randomId()
    const res = await rawGet(port, '/fail', { 'x-datadog-trace-id': trace, 'x-datadog-parent-id': randomId() })
    expect(res.status).toBe(500)
    await agent.waitFor(() => serverSpans(trace).length === 1)
    expect(serverSpans(trace)[0].error).toBe(1)
  })
})

describe('node:http in Bun', () => {
  test('is traced once (no duplicate span from the Bun.serve patch)', async () => {
    const trace = randomId()
    await rawGet(ports.node, '/x', { 'x-datadog-trace-id': trace, 'x-datadog-parent-id': randomId() })
    await agent.waitFor(() => agent.spans.some((s) => s.trace === trace && s.name === 'web.request'))
    await Bun.sleep(200)
    const spans = agent.spans.filter((s) => s.trace === trace && s.name === 'web.request')
    expect(spans.length).toBe(1)
    expect(spans[0].meta.component).toBe('http')
  })
})
