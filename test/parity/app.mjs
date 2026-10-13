// One app, three runtimes. TARGET=node runs node:http on Node with plain dd-trace
// (the reference behaviour); TARGET=bun runs Bun.serve and TARGET=elysia runs
// Elysia .listen(), both via dd-trace-bun. The parity tests assert identical spans.
const TARGET = process.env.TARGET
const SCENARIO = process.env.SCENARIO ?? 'default'

const tracerOptions = { service: 'test', url: `http://127.0.0.1:${process.env.AGENT_PORT}`, flushInterval: 10, startupLogs: false, plugins: true }
let tracer
if (TARGET === 'node') {
  tracer = (await import('dd-trace')).default
  tracer.init(tracerOptions)
} else {
  const { init } = await import('../../src/index.ts')
  tracer = init(tracerOptions)
}

// Same plugin configurations as dd-trace-js packages/datadog-plugin-http/test/server.spec.js
const scenarios = {
  default: {},
  'server-empty': { client: false, server: {} },
  hooks: {
    client: false,
    server: {
      hooks: {
        request: (span, req) => {
          span.setTag('test.hook', 'ran')
          if (req.url?.startsWith('/products')) span.setTag('resource.name', 'GET /products')
        },
      },
    },
  },
  blocklist: { client: false, blocklist: '/health' },
  'service-diff': { client: false, server: { service: 'my-http-service' } },
  'service-same': { client: false, server: { service: 'test' } },
  renaming: { client: false, resourceRenamingEnabled: true },
  clientip: { client: false, clientIpEnabled: true },
}
tracer.use('http', scenarios[SCENARIO])

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Shared app behaviour, keyed by path.
async function handle (method, path) {
  if (path.startsWith('/slow')) await sleep(500)
  if (path.startsWith('/boom')) throw new Error('kaboom')
  const status = path.startsWith('/status/') ? Number(path.split('/')[2]) : 200
  const headers = { 'x-active': tracer.scope().active() ? '1' : '0', 'x-custom-res': 'res-value' }
  if (method === 'OPTIONS') headers['access-control-allow-origin'] = '*'
  return { status, headers }
}

let port
if (TARGET === 'node') {
  // require, not import: dd-trace hooks node:http through the CommonJS loader
  const { createRequire } = await import('node:module')
  const http = createRequire(import.meta.url)('node:http')
  const server = http.createServer(async (req, res) => {
    try {
      const { status, headers } = await handle(req.method, req.url)
      for (const [k, v] of Object.entries(headers)) res.setHeader(k, v)
      res.writeHead(status)
      res.end()
    } catch (err) {
      res.writeHead(500)
      res.end()
    }
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  port = server.address().port
} else if (TARGET === 'bun') {
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch (req) {
      const url = new URL(req.url)
      const { status, headers } = await handle(req.method, url.pathname + url.search)
      return new Response(null, { status, headers })
    },
    error () { return new Response(null, { status: 500 }) },
  })
  port = server.port
} else {
  const { Elysia } = await import('elysia')
  const { datadog } = await import('../../src/elysia.ts')
  const handler = async ({ request, set }) => {
    const url = new URL(request.url)
    const { status, headers } = await handle(request.method, url.pathname + url.search)
    set.status = status
    Object.assign(set.headers, headers)
    return ''
  }
  const app = new Elysia().use(datadog()).all('/*', handler).onError(({ set }) => { set.status = 500; return '' })
    .listen({ port: 0, hostname: '127.0.0.1' })
  port = app.server.port
}

console.log(JSON.stringify({ port }))
