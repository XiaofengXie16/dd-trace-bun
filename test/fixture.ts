// Runs as a plain `bun` subprocess: dd-trace turns itself into a no-op inside
// `bun test` (it sees Bun's jest-compatible globals), so the traced apps live here.
import http from 'node:http'
import { Elysia, t } from 'elysia'
import { init, traceHandler } from '../src/index'
import { datadog } from '../src/elysia'

const tracer = init({
  service: 'bun-svc',
  url: `http://127.0.0.1:${process.env.AGENT_PORT}`,
  flushInterval: 20,
  startupLogs: false,
})

// downstream service that echoes the headers it received
const echo = http.createServer((req, res) => res.end(JSON.stringify(req.headers)))
await new Promise<void>((resolve) => echo.listen(0, '127.0.0.1', resolve))
const echoPort = (echo.address() as { port: number }).port

const bun = Bun.serve({
  port: 0,
  routes: {
    '/users/:id': (req) => Response.json({ id: req.params.id }),
    '/items': { GET: () => new Response('list'), POST: () => new Response('created', { status: 201 }) },
    '/static': new Response('static'),
  },
  async fetch (req, server) {
    const url = new URL(req.url)
    if (url.pathname === '/ws') return server.upgrade(req) ? undefined : new Response('no upgrade', { status: 400 })
    if (url.pathname === '/boom') throw new Error('kaboom')
    if (url.pathname === '/503') return new Response('nope', { status: 503 })
    await Bun.sleep(2)
    await tracer.trace('child.work', async () => { await Bun.sleep(2) })
    const echoed = await (await fetch(`http://127.0.0.1:${echoPort}/`)).json()
    return Response.json({
      active: tracer.scope().active()?.context().toTraceId(),
      downstream: echoed['x-datadog-trace-id'],
      traceparent: echoed.traceparent,
    })
  },
  websocket: { message (ws, message) { ws.send(message) } },
  error () { return new Response('err', { status: 500 }) },
})

// `fetch` lives on the prototype, which copying the options would lose
class ClassBasedOptions {
  port = 0
  fetch () { return new Response('class-based') }
}
const classBased = Bun.serve(new ClassBasedOptions())

const reloaded = Bun.serve({ port: 0, fetch: () => new Response('before reload') })
reloaded.reload({
  fetch: traceHandler(() => new Response('after reload')),
  routes: { '/things/:id': () => new Response('thing') },
})

const elysia = new Elysia()
  .use(datadog())
  .get('/users/:id', ({ params }) => ({ id: params.id, active: tracer.scope().active()?.context().toTraceId() }))
  .post('/items', ({ body }) => body, { body: t.Object({ name: t.String() }) })
  .get('/fail', () => { throw new Error('elysia boom') })
  .listen(0)

const node = http.createServer((_req, res) => res.end('hi'))
await new Promise<void>((resolve) => node.listen(0, '127.0.0.1', resolve))

console.log(JSON.stringify({
  bun: bun.port,
  classBased: classBased.port,
  reloaded: reloaded.port,
  elysia: elysia.server!.port,
  node: (node.address() as { port: number }).port,
}))
