import type { Server } from 'bun'
import { createRequire } from 'node:module'
import dc from 'node:diagnostics_channel'

// Requests are fed through dd-trace's own HTTP server plugin (the same
// diagnostics channels its node:http instrumentation publishes on), so span
// shape, naming schema, propagation styles, header tags, query string
// obfuscation, client IP, error statuses, blocklist, hooks and `service`
// all follow `tracer.use('http', { server })` / DD_* exactly as on Node.
const startCh = dc.channel('apm:http:server:request:start')
const exitCh = dc.channel('apm:http:server:request:exit')
const finishCh = dc.channel('apm:http:server:request:finish')

const require = createRequire(import.meta.url)
const web = require('dd-trace/packages/dd-trace/src/plugins/util/web')
const { storage } = require('dd-trace/packages/datadog-core')
const legacyStorage = storage('legacy')

type Handler = (req: Request, server: Server<any>) => unknown

const PATCHED = Symbol.for('dd-trace-bun.patched')
const shims = new WeakMap<Request, ShimRequest>()

interface ShimRequest {
  method: string
  url: string
  headers: Record<string, string>
  socket: { remoteAddress?: string; encrypted: boolean }
  httpVersion: string
  request: Request
}

class ShimResponse {
  statusCode = 200
  headersSent = false
  #headers = new Map<string, string | string[]>()
  #extra = new Map<string, string>()
  constructor (public req: ShimRequest) {}
  load (res: Response) {
    this.statusCode = res.status
    res.headers.forEach((v, k) => this.#headers.set(k, v))
  }
  getHeader (name: string) { return this.#headers.get(name.toLowerCase()) }
  getHeaders () { return Object.fromEntries(this.#headers) }
  setHeader (name: string, value: string | string[]) {
    const v = Array.isArray(value) ? value.join(',') : String(value)
    this.#headers.set(name.toLowerCase(), v)
    this.#extra.set(name, v)
    return this
  }
  writeHead () { this.headersSent = true; return this }
  /** Headers the tracer added (e.g. CORS allow-headers for trace context on preflights). */
  get added () { return this.#extra }
}

/** dd-trace's view of a Bun request, for `web.*` helpers and `server.hooks.request`. */
export function nodeRequestOf (req: Request): ShimRequest | undefined {
  return shims.get(req)
}

/** Set the route template for the current request (resource becomes `GET /users/:id`). */
export function setRoute (req: Request, route: string) {
  const shim = shims.get(req)
  if (shim) web.setRoute(shim, route)
}

function toShim (req: Request, server: Server<any> | undefined): ShimRequest {
  const url = new URL(req.url)
  const headers: Record<string, string> = {}
  req.headers.forEach((v, k) => { headers[k] = v })
  headers.host ??= url.host
  let remoteAddress: string | undefined
  try { remoteAddress = server?.requestIP?.(req)?.address } catch {}
  return {
    method: req.method,
    url: url.pathname + url.search,
    headers,
    socket: { remoteAddress, encrypted: url.protocol === 'https:' },
    httpVersion: '1.1',
    request: req,
  }
}

/**
 * Wrap a Bun fetch-style handler so each request is a dd-trace HTTP server span,
 * continuing any incoming trace context and active for the whole handler.
 */
export function traceHandler<H extends Handler> (handler: H, route?: string): H {
  if ((handler as any)[PATCHED]) return handler

  const wrapped = function (this: unknown, req: Request, server: Server<any>) {
    // http plugin disabled (tracer.use('http', false), DD_TRACE_DISABLED_INSTRUMENTATIONS, …)
    if (!startCh.hasSubscribers) return handler.call(this, req, server)

    const nreq = toShim(req, server)
    const nres = new ShimResponse(nreq)
    shims.set(req, nreq)

    return legacyStorage.run(legacyStorage.getStore(), () => {
      const ctx = { req: nreq, res: nres, abortController: new AbortController() }
      startCh.publish(ctx)
      if (route) web.setRoute(nreq, route)

      let result
      try {
        result = handler.call(this, req, server)
      } catch (err) {
        fail(nreq, nres, err)
        throw err
      } finally {
        exitCh.publish(ctx)
      }

      if (result && typeof (result as any).then === 'function') {
        return (result as Promise<unknown>).then(
          (res) => complete(nreq, nres, res),
          (err) => { fail(nreq, nres, err); throw err },
        )
      }
      return complete(nreq, nres, result)
    })
  }

  ;(wrapped as any)[PATCHED] = true
  return wrapped as unknown as H
}

function complete (nreq: ShimRequest, nres: ShimResponse, res: unknown) {
  if (res instanceof Response) {
    nres.load(res)
  } else {
    // undefined: the request was upgraded to a WebSocket
    nres.statusCode = 101
  }
  // Let the tracer's wrapped writeHead run (CORS preflight handling), then apply anything it set.
  nres.writeHead()
  finishCh.publish({ req: nreq })
  if (res instanceof Response && nres.added.size > 0) {
    try {
      for (const [k, v] of nres.added) res.headers.set(k, v)
    } catch {
      const headers = new Headers(res.headers)
      for (const [k, v] of nres.added) headers.set(k, v)
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
    }
  }
  return res
}

function fail (nreq: ShimRequest, nres: ShimResponse, err: unknown) {
  const span = web.root(nreq)
  if (span && err instanceof Error) span.setTag('error', err)
  nres.statusCode = 500
  finishCh.publish({ req: nreq })
}

/** Wrap `fetch` and every function in `routes` of a Bun.serve options object. */
export function traceServeOptions<T> (options: T): T {
  if (!options || typeof options !== 'object') return options
  const out: Record<string, any> = { ...(options as any) }
  if (typeof out.fetch === 'function') out.fetch = traceHandler(out.fetch)
  if (out.routes && typeof out.routes === 'object') {
    const routes: Record<string, any> = {}
    for (const [path, value] of Object.entries(out.routes)) {
      if (typeof value === 'function') {
        routes[path] = traceHandler(value as Handler, path)
      } else if (value && typeof value === 'object' && !(value instanceof Response) && isMethodMap(value)) {
        const methods: Record<string, any> = {}
        for (const [m, h] of Object.entries(value)) {
          methods[m] = typeof h === 'function' ? traceHandler(h as Handler, path) : h
        }
        routes[path] = methods
      } else {
        // static Response / HTML bundle / false: served natively, no JS runs
        routes[path] = value
      }
    }
    out.routes = routes
  }
  return out as T
}

const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'CONNECT', 'TRACE'])
function isMethodMap (v: object): boolean {
  const keys = Object.keys(v)
  return keys.length > 0 && keys.every((k) => METHODS.has(k))
}

/**
 * Patch the global `Bun.serve` so every server (including Elysia's `.listen()`
 * and Hono's default export) is traced. Idempotent; returns an undo function.
 */
export function patchBunServe (): () => void {
  const bun = (globalThis as any).Bun
  if (!bun || bun.serve[PATCHED]) return () => {}
  const original = bun.serve

  const patched = function (this: unknown, options: any) {
    const server = original.call(this, traceServeOptions(options))
    if (server && typeof server.reload === 'function') {
      const reload = server.reload.bind(server)
      server.reload = (next: any) => reload(traceServeOptions(next))
    }
    return server
  }
  ;(patched as any)[PATCHED] = true
  bun.serve = patched
  return () => { bun.serve = original }
}
