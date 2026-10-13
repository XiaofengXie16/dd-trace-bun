import type { Server } from 'bun'
import type { Span, Tracer } from 'dd-trace'

type Handler = (req: Request, server: Server<any>) => Response | Promise<Response> | undefined | void | Promise<Response | undefined | void>

export interface ServeTracingOptions {
  /** Service name for server spans. Defaults to the tracer's service. */
  service?: string
  /** Return false to skip tracing a request (e.g. health checks). */
  filter?: (req: Request, url: URL) => boolean
  /** Treat these statuses as errors. Defaults to >= 500. */
  isError?: (status: number) => boolean
}

const PATCHED = Symbol.for('dd-trace-bun.patched')
const ROUTE = Symbol.for('dd-trace-bun.route')

/** Route template of the request currently being handled, when Bun matched one from `routes`. */
export function routeOf(req: Request): string | undefined {
  return (req as any)[ROUTE]
}

/**
 * Wrap a Bun fetch-style handler: extract the incoming Datadog / W3C context,
 * start a `web.request` server span, keep it active for the whole handler.
 */
export function traceHandler<H extends Handler>(tracer: Tracer, handler: H, opts: ServeTracingOptions = {}, route?: string): H {
  if ((handler as any)[PATCHED]) return handler
  const isError = opts.isError ?? ((s: number) => s >= 500)

  const wrapped = function (this: unknown, req: Request, server: Server<any>) {
    let url: URL
    try {
      url = new URL(req.url)
    } catch {
      return handler.call(this, req, server)
    }
    if (opts.filter && !opts.filter(req, url)) return handler.call(this, req, server)

    const headers: Record<string, string> = {}
    req.headers.forEach((v, k) => { headers[k] = v })
    const childOf = tracer.extract('http_headers', headers) ?? undefined

    if (route) (req as any)[ROUTE] = route
    const span = tracer.startSpan('web.request', {
      childOf,
      tags: {
        'span.kind': 'server',
        'span.type': 'web',
        component: 'bun',
        'http.method': req.method,
        'http.url': url.origin + url.pathname,
        'http.useragent': headers['user-agent'],
        'resource.name': route ? `${req.method} ${route}` : req.method,
        ...(route && { 'http.route': route }),
        ...(opts.service && { 'service.name': opts.service }),
      },
    })

    return tracer.scope().activate(span, () => {
      let result
      try {
        result = handler.call(this, req, server)
      } catch (err) {
        finish(span, undefined, err)
        throw err
      }
      if (result && typeof (result as any).then === 'function') {
        return (result as Promise<Response | undefined>).then(
          (res) => { finish(span, res); return res },
          (err) => { finish(span, undefined, err); throw err },
        )
      }
      finish(span, result as Response | undefined)
      return result
    })
  }

  function finish(span: Span, res: Response | undefined, err?: unknown) {
    if (err) {
      span.setTag('error', err)
      span.setTag('http.status_code', '500')
    } else if (res instanceof Response) {
      span.setTag('http.status_code', String(res.status))
      if (isError(res.status)) span.setTag('error', true)
    } else {
      // undefined return means the request was upgraded to a WebSocket
      span.setTag('http.status_code', '101')
    }
    span.finish()
  }

  ;(wrapped as any)[PATCHED] = true
  return wrapped as unknown as H
}

/** Wrap `fetch` and every function in `routes` of a Bun.serve options object. */
export function traceServeOptions<T extends Record<string, any>>(tracer: Tracer, options: T, opts: ServeTracingOptions = {}): T {
  if (!options || typeof options !== 'object') return options
  const out: Record<string, any> = { ...options }
  if (typeof out.fetch === 'function') out.fetch = traceHandler(tracer, out.fetch, opts)
  if (out.routes && typeof out.routes === 'object') {
    const routes: Record<string, any> = {}
    for (const [path, value] of Object.entries(out.routes)) {
      if (typeof value === 'function') {
        routes[path] = traceHandler(tracer, value as Handler, opts, path)
      } else if (value && typeof value === 'object' && !(value instanceof Response) && isMethodMap(value)) {
        const methods: Record<string, any> = {}
        for (const [m, h] of Object.entries(value)) {
          methods[m] = typeof h === 'function' ? traceHandler(tracer, h as Handler, opts, path) : h
        }
        routes[path] = methods
      } else {
        // static Response / HTML bundle / false: served natively without JS, nothing to trace
        routes[path] = value
      }
    }
    out.routes = routes
  }
  return out as T
}

const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'CONNECT', 'TRACE'])
function isMethodMap(v: object): boolean {
  const keys = Object.keys(v)
  return keys.length > 0 && keys.every((k) => METHODS.has(k))
}

/**
 * Patch the global `Bun.serve` so every server (including ones created by
 * Elysia's `.listen()` or Hono's default export) is traced. Idempotent.
 */
export function patchBunServe(tracer: Tracer, opts: ServeTracingOptions = {}): () => void {
  const bun = (globalThis as any).Bun
  if (!bun || (bun.serve as any)[PATCHED]) return () => {}
  const original = bun.serve

  const patched = function (this: unknown, options: any) {
    const server = original.call(this, traceServeOptions(tracer, options, opts))
    if (server && typeof server.reload === 'function') {
      const reload = server.reload.bind(server)
      server.reload = (next: any) => reload(traceServeOptions(tracer, next, opts))
    }
    return server
  }
  ;(patched as any)[PATCHED] = true
  bun.serve = patched
  return () => { bun.serve = original }
}
