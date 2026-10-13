// Port of dd-trace-js packages/datadog-plugin-http/test/server.spec.js (plus the
// propagation / web-util behaviour other dd-trace specs cover), run against three
// targets: node:http on Node with plain dd-trace (the reference), Bun.serve and
// Elysia on Bun with dd-trace-bun. Every assertion must hold for all three.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { startFakeAgent, rawGet, randomId, type AgentSpan } from '../helpers'

const TARGETS = (process.env.TARGETS?.split(',') ?? ['node', 'bun', 'elysia']) as ('node' | 'bun' | 'elysia')[]
type Target = 'node' | 'bun' | 'elysia'

async function startApp (target: Target, scenario = 'default', env: Record<string, string> = {}) {
  const agent = await startFakeAgent()
  const proc = Bun.spawn([target === 'node' ? 'node' : 'bun', `${import.meta.dir}/app.mjs`], {
    env: { ...process.env, ...env, TARGET: target, SCENARIO: scenario, AGENT_PORT: String(agent.port) },
    stdout: 'pipe',
    stderr: 'inherit',
  })
  const reader = proc.stdout.getReader()
  let buf = ''
  while (!buf.includes('\n')) {
    const { value, done } = await reader.read()
    if (done) throw new Error(`${target} app exited before listening`)
    buf += new TextDecoder().decode(value)
  }
  const { port } = JSON.parse(buf.split('\n').find((l) => l.startsWith('{'))!)
  const serverSpan = (pred: (s: AgentSpan) => boolean = () => true) =>
    agent.waitFor((spans) => spans.some((s) => s.meta['span.kind'] === 'server' && pred(s)))
      .then((spans) => spans.find((s) => s.meta['span.kind'] === 'server' && pred(s))!)
  return {
    port,
    agent,
    get: (path: string, headers: Record<string, string> = {}, opts: Parameters<typeof rawGet>[3] = {}) =>
      rawGet(port, path, headers, { host: 'localhost', ...opts }),
    serverSpan,
    stop: () => { proc.kill(); agent.close() },
  }
}

type App = Awaited<ReturnType<typeof startApp>>

function withApp (target: Target, scenario: string, env: Record<string, string>, fn: (app: () => App) => void) {
  let app: App
  beforeAll(async () => { app = await startApp(target, scenario, env) })
  afterAll(() => app?.stop())
  fn(() => app)
}

for (const target of TARGETS) {
  // Elysia matches the fixture's catch-all route, so like any framework integration
  // (express, fastify, …) dd-trace names the span after it and http.route wins over
  // http.endpoint. node:http and bare Bun.serve have no route.
  const routed = target === 'elysia'
  const defaultResource = routed ? 'GET /*' : 'GET'
  describe(`${target}: http server`, () => {
    describe('without configuration', () => {
      withApp(target, 'default', {}, (app) => {
        test('should do automatic instrumentation', async () => {
          const { port } = app()
          await app().get('/user')
          const span = await app().serverSpan((s) => s.meta['http.url']?.endsWith('/user'))
          expect(span.name).toBe('web.request')
          expect(span.service).toBe('test')
          expect(span.type).toBe('web')
          expect(span.resource).toBe(defaultResource)
          expect(span.meta['span.kind']).toBe('server')
          expect(span.meta['http.url']).toBe(`http://localhost:${port}/user`)
          expect(span.meta['http.method']).toBe('GET')
          expect(span.meta['http.status_code']).toBe('200')
          expect(span.meta.component).toBe('http')
        })

        test('should run the request listener in the request scope', async () => {
          const res = await app().get('/scope')
          expect(res.headers['x-active']).toBe('1')
        })

        test('should continue a Datadog trace from incoming headers', async () => {
          const trace = randomId(), parent = randomId()
          await app().get('/dd', { 'x-datadog-trace-id': trace, 'x-datadog-parent-id': parent, 'x-datadog-sampling-priority': '1' })
          const span = await app().serverSpan((s) => s.trace === trace)
          expect(span.parent).toBe(parent)
          expect(span.metrics._sampling_priority_v1).toBe(1)
        })

        test('should continue a W3C traceparent trace', async () => {
          const lo = BigInt(randomId()), parent = BigInt(randomId())
          const traceparent = `00-${'1'.padStart(16, '0')}${lo.toString(16).padStart(16, '0')}-${parent.toString(16).padStart(16, '0')}-01`
          await app().get('/w3c', { traceparent })
          const span = await app().serverSpan((s) => s.trace === lo.toString())
          expect(span.parent).toBe(parent.toString())
          expect(span.meta['_dd.p.tid']).toBe('0000000000000001')
        })

        test('should mark 5xx responses as errors but not 4xx', async () => {
          await app().get('/status/503')
          await app().get('/status/404')
          const s5 = await app().serverSpan((s) => s.meta['http.status_code'] === '503')
          const s4 = await app().serverSpan((s) => s.meta['http.status_code'] === '404')
          expect(s5.error).toBe(1)
          expect(s4.error).toBe(0)
        })

        test('should mark thrown handler errors', async () => {
          const res = await app().get('/boom')
          expect(res.status).toBe(500)
          const span = await app().serverSpan((s) => s.meta['http.url']?.endsWith('/boom'))
          expect(span.error).toBe(1)
          expect(span.meta['http.status_code']).toBe('500')
        })

        test('should obfuscate secrets in the query string', async () => {
          await app().get('/qs?token=supersecret&page=2')
          const span = await app().serverSpan((s) => s.meta['http.url']?.includes('/qs'))
          expect(span.meta['http.url']).not.toContain('supersecret')
          expect(span.meta['http.url']).toContain('page=2')
        })

        test('should add tracing headers to CORS preflight allow-headers', async () => {
          const res = await app().get('/cors', { origin: 'http://example.com', 'access-control-request-headers': 'x-datadog-trace-id,traceparent' }, { method: 'OPTIONS' })
          expect(res.headers['access-control-allow-headers']?.split(',').sort()).toEqual(['traceparent', 'x-datadog-trace-id'])
        })
      })
    })

    describe('canceled request', () => {
      withApp(target, 'default', {}, (app) => {
        test('should send traces to agent', async () => {
          await app().get('/slow', {}, { abortAfterMs: 100 })
          const span = await app().serverSpan((s) => s.meta['http.url']?.endsWith('/slow'))
          expect(span.name).toBe('web.request')
          expect(span.resource).toBe(defaultResource)
          expect(span.meta['http.method']).toBe('GET')
        })
      })
    })

    describe('with OTel semantics enabled', () => {
      withApp(target, 'default', { DD_TRACE_OTEL_SEMANTICS_ENABLED: 'true' }, (app) => {
        test('emits OpenTelemetry server attributes and omits the Datadog ones', async () => {
          await app().get('/user', { 'user-agent': 'dd-trace-test' })
          const span = await app().serverSpan()
          expect(span.name).toBe('web.request')
          expect(span.resource).toBe(defaultResource)
          expect(span.meta['http.request.method']).toBe('GET')
          expect(span.meta['url.path']).toBe('/user')
          expect(span.meta['url.scheme']).toBe('http')
          expect(span.meta['server.address']).toBe('localhost')
          expect(span.metrics['server.port']).toBe(app().port)
          expect(span.metrics['http.response.status_code']).toBe(200)
          for (const k of ['http.method', 'http.url', 'http.status_code', 'http.useragent']) expect(span.meta[k]).toBeUndefined()
        })
      })
    })

    describe('with configured HTTP server error statuses', () => {
      withApp(target, 'server-empty', { DD_TRACE_HTTP_SERVER_ERROR_STATUSES: '200-201,202' }, (app) => {
        test('should mark a configured status code as an error', async () => {
          await app().get('/user')
          const span = await app().serverSpan()
          expect(span.meta['http.status_code']).toBe('200')
          expect(span.error).toBe(1)
        })
      })
    })

    describe('with a `server` configuration', () => {
      withApp(target, 'server-empty', {}, (app) => {
        test('should not have disabled tracing', async () => {
          await app().get('/user')
          await app().serverSpan()
        })
      })
    })

    describe('with hooks configuration', () => {
      withApp(target, 'hooks', {}, (app) => {
        test('should let the request hook override the default resource name', async () => {
          await app().get('/products')
          const span = await app().serverSpan((s) => s.meta['http.url']?.endsWith('/products'))
          expect(span.resource).toBe('GET /products')
          expect(span.meta['test.hook']).toBe('ran')
        })
        test('should keep the default resource name when the hook does not touch it', async () => {
          await app().get('/health')
          const span = await app().serverSpan((s) => s.meta['http.url']?.endsWith('/health'))
          expect(span.resource).toBe(defaultResource)
          expect(span.meta['test.hook']).toBe('ran')
        })
      })
    })

    describe('with a blocklist configuration', () => {
      withApp(target, 'blocklist', {}, (app) => {
        test('should drop traces for blocklist route', async () => {
          await app().get('/health')
          await app().get('/other')
          await app().serverSpan((s) => s.meta['http.url']?.endsWith('/other'))
          expect(app().agent.spans.some((s) => s.meta['http.url']?.endsWith('/health'))).toBe(false)
        })
      })
    })

    describe('with a `service` configuration that differs from the tracer service', () => {
      withApp(target, 'service-diff', {}, (app) => {
        test('should override the service and mark the source as `opt.plugin`', async () => {
          await app().get('/first')
          await app().get('/second')
          for (const p of ['/first', '/second']) {
            const span = await app().serverSpan((s) => s.meta['http.url']?.endsWith(p))
            expect(span.service).toBe('my-http-service')
            expect(span.meta['_dd.svc_src']).toBe('opt.plugin')
          }
        })
      })
    })

    describe('with a `service` configuration matching the tracer service', () => {
      withApp(target, 'service-same', {}, (app) => {
        test('should not add the service source tag', async () => {
          await app().get('/users')
          const span = await app().serverSpan()
          expect(span.service).toBe('test')
          expect(span.meta['_dd.svc_src']).toBeUndefined()
        })
      })
    })

    describe('with resourceRenamingEnabled configuration', () => {
      withApp(target, 'renaming', {}, (app) => {
        const cases: [string, string, string][] = [
          ['hex segments', '/users/a1f3e2d1c0/profile', '/users/{param:hex}/profile'],
          ['int segments', '/users/1234/profile', '/users/{param:int}/profile'],
          ['int id segments', '/users/1234-1234/profile', '/users/{param:int_id}/profile'],
          ['short segments unchanged', '/api/v1/users', '/api/v1/users'],
        ]
        for (const [label, path, endpoint] of cases) {
          test(`should normalize ${label}`, async () => {
            await app().get(path)
            const span = await app().serverSpan((s) => s.meta['http.url']?.endsWith(path))
            if (routed) {
              expect(span.meta['http.route']).toBe('/*')
              expect(span.meta['http.endpoint']).toBeUndefined()
            } else {
              expect(span.meta['http.endpoint']).toBe(endpoint)
            }
          })
        }
      })
    })

    describe('with header tags (DD_TRACE_HEADER_TAGS)', () => {
      withApp(target, 'default', { DD_TRACE_HEADER_TAGS: 'x-custom-req:custom.req,x-custom-res' }, (app) => {
        test('should tag configured request and response headers', async () => {
          await app().get('/hdr', { 'x-custom-req': 'req-value' })
          const span = await app().serverSpan()
          expect(span.meta['custom.req']).toBe('req-value')
          expect(span.meta['http.response.headers.x-custom-res']).toBe('res-value')
        })
      })
    })

    describe('with client IP collection', () => {
      withApp(target, 'clientip', {}, (app) => {
        test('should tag the client IP from forwarding headers', async () => {
          await app().get('/ip', { 'x-forwarded-for': '8.8.8.8, 10.0.0.1' })
          const span = await app().serverSpan()
          expect(span.meta['http.client_ip']).toBe('8.8.8.8')
        })
      })
    })

    describe('with b3 propagation', () => {
      withApp(target, 'default', { DD_TRACE_PROPAGATION_STYLE_EXTRACT: 'b3multi' }, (app) => {
        test('should continue a B3 trace', async () => {
          const trace = BigInt(randomId()), parent = BigInt(randomId())
          await app().get('/b3', { 'x-b3-traceid': trace.toString(16).padStart(16, '0'), 'x-b3-spanid': parent.toString(16).padStart(16, '0'), 'x-b3-sampled': '1' })
          const span = await app().serverSpan()
          expect(span.trace).toBe(trace.toString())
          expect(span.parent).toBe(parent.toString())
        })
      })
    })

    describe('with naming schema v1', () => {
      withApp(target, 'default', { DD_TRACE_SPAN_ATTRIBUTE_SCHEMA: 'v1' }, (app) => {
        test('should use the v1 operation name', async () => {
          await app().get('/user')
          const span = await app().serverSpan()
          expect(span.name).toBe('http.server.request')
          expect(span.service).toBe('test')
        })
      })
    })
  })
}
