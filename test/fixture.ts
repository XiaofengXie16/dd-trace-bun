// Runs as a plain `bun` subprocess: dd-trace turns itself into a no-op inside
// `bun test` (it sees Bun's jest-compatible globals), so the traced app lives here.
import http from 'node:http'
import { init } from '../src/index'
import { datadog } from '../src/elysia'

const tracer = init({
  service: 'bun-svc',
  url: `http://127.0.0.1:${process.env.AGENT_PORT}`,
  flushInterval: 20,
  startupLogs: false,
})
const { Elysia } = await import('elysia')

const echo = http.createServer((req, res) => res.end(JSON.stringify(req.headers)))
await new Promise<void>((r) => echo.listen(0, '127.0.0.1', () => r()))
const echoPort = (echo.address() as any).port

const bunServer = Bun.serve({
  port: 0,
  routes: {
    '/users/:id': (req) => Response.json({ id: req.params.id }),
    '/items': { GET: () => new Response('list'), POST: () => new Response('created', { status: 201 }) },
    '/static': new Response('static'),
  },
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === '/boom') throw new Error('kaboom')
    if (url.pathname === '/503') return new Response('nope', { status: 503 })
    await Bun.sleep(2)
    await tracer.trace('child.work', async () => { await Bun.sleep(2) })
    const echoed = await (await fetch(`http://127.0.0.1:${echoPort}/`)).json()
    return Response.json({ active: tracer.scope().active()?.context().toTraceId(), downstream: echoed['x-datadog-trace-id'], traceparent: echoed.traceparent })
  },
  error() { return new Response('err', { status: 500 }) },
})

const elysia = new Elysia()
  .use(datadog())
  .get('/users/:id', ({ params }) => ({ id: params.id, active: tracer.scope().active()?.context().toTraceId() }))
  .get('/plain', () => 'ok')
  .get('/fail', () => { throw new Error('elysia boom') })
  .listen(0)

const nodeServer = http.createServer((_req, res) => res.end('hi'))
await new Promise<void>((r) => nodeServer.listen(0, '127.0.0.1', () => r()))

console.log(JSON.stringify({ bun: bunServer.port, elysia: elysia.server!.port, node: (nodeServer.address() as any).port }))
