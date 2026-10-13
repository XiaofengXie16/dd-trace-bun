import type { Server } from 'bun'
import { requestExit, requestFinish, requestStart, web } from './internals.ts'
import { NodeResponse, toNodeRequest, type NodeRequest } from './node-http.ts'

type Handler = (request: Request, server: Server<any>) => unknown

const TRACED = Symbol.for('dd-trace-bun.traced')
const requests = new WeakMap<Request, NodeRequest>()

/**
 * Trace a Bun fetch handler: each request becomes a dd-trace HTTP server span that
 * continues the caller's trace and is active for the whole handler. Only needed for
 * handlers that don't go through `Bun.serve`; `init()` instruments those already.
 */
export function traceHandler<H extends Handler> (handler: H): H {
  return trace(handler)
}

/** Name the request's span after a route template, e.g. `/users/:id` (resource `GET /users/:id`). */
export function setRoute (request: Request, route: string): void {
  const req = requests.get(request)
  if (req && route) web?.setRoute(req, route)
}

/**
 * Attach an error to the request's span. As in dd-trace's framework integrations, the
 * span is marked as an error only if the response status is one (5xx by default).
 */
export function recordError (request: Request, error: unknown): void {
  const req = requests.get(request)
  if (req) web?.addError(req, error)
}

/**
 * Patch the global `Bun.serve`, so every server is traced: plain Bun.serve, Elysia's
 * `.listen()`, Hono's and anything else's default export. Idempotent.
 */
export function patchBunServe (): void {
  const bun = globalThis.Bun as { serve: Function & { [TRACED]?: true } } | undefined
  if (!bun || bun.serve[TRACED]) return
  const original = bun.serve

  bun.serve = Object.assign(function serve (this: unknown, options: unknown) {
    const server = original.call(this, traceOptions(options))
    const reload = server.reload
    server.reload = (next: unknown) => reload.call(server, traceOptions(next))
    return server
  }, { [TRACED]: true as const })
}

/** Bun.serve options with `fetch` and every handler in `routes` traced. */
function traceOptions (options: unknown): unknown {
  if (!options || typeof options !== 'object') return options
  const { fetch, routes } = options as { fetch?: unknown; routes?: unknown }
  // inherit the rest, including methods of class-based options
  const traced = Object.create(options)
  if (typeof fetch === 'function') traced.fetch = trace(fetch as Handler)
  if (routes && typeof routes === 'object') traced.routes = traceRoutes(routes)
  return traced
}

function traceRoutes (routes: object): Record<string, unknown> {
  const traced: Record<string, unknown> = {}
  for (const [path, value] of Object.entries(routes)) {
    if (typeof value === 'function') {
      traced[path] = trace(value, path)
    } else if (isMethodMap(value)) {
      traced[path] = Object.fromEntries(Object.entries(value).map(([method, handler]) =>
        [method, typeof handler === 'function' ? trace(handler as Handler, path) : handler]))
    } else {
      // a static Response, HTML import or `false`: Bun serves these without running JS
      traced[path] = value
    }
  }
  return traced
}

const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'CONNECT', 'TRACE'])

function isMethodMap (value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') return false
  const keys = Object.keys(value)
  return keys.length > 0 && keys.every((key) => METHODS.has(key))
}

// The request lifecycle mirrors dd-trace's node:http server instrumentation: publish
// start, run the handler (unless AppSec blocked the request), publish exit, and publish
// finish once the response is known.
function trace<H extends Handler> (handler: H, route?: string): H {
  if ((handler as { [TRACED]?: true })[TRACED]) return handler

  const traced = function (this: unknown, request: Request, server: Server<any>) {
    // the http integration is disabled, or this dd-trace isn't supported
    if (!requestStart.hasSubscribers || !web) return handler.call(this, request, server)

    const req = toNodeRequest(request, server)
    const res = new NodeResponse(req)
    const ctx = { req, res, abortController: new AbortController() }
    requests.set(request, req)

    requestStart.publish(ctx)
    if (route) web.setRoute(req, route)

    let result: unknown
    try {
      if (!ctx.abortController.signal.aborted) result = handler.call(this, request, server)
    } catch (error) {
      return failed(req, res, error)
    } finally {
      requestExit.publish(ctx)
    }

    return isThenable(result)
      ? result.then((value) => responded(req, res, value), (error) => failed(req, res, error))
      : responded(req, res, result)
  }

  return Object.assign(traced, { [TRACED]: true as const }) as unknown as H
}

function responded (req: NodeRequest, res: NodeResponse, value: unknown): unknown {
  if (!res.ended) {
    if (value instanceof Response) res.load(value)
    // returning nothing is only valid after server.upgrade(req)
    else if (value === undefined) res.statusCode = 101
    // runs dd-trace's writeHead hooks: CORS preflight headers, AppSec response checks
    res.writeHead()
  }
  requestFinish.publish({ req })

  if (res.ended) return res.toResponse()
  return value instanceof Response ? res.withAddedHeaders(value) : value
}

function failed (req: NodeRequest, res: NodeResponse, error: unknown): Response {
  // AppSec blocked the request from inside the handler (e.g. RASP aborted a query)
  if (res.ended) {
    requestFinish.publish({ req })
    return res.toResponse()
  }
  web?.addError(req, error)
  res.statusCode = 500
  requestFinish.publish({ req })
  throw error
}

function isThenable (value: unknown): value is PromiseLike<unknown> {
  return typeof (value as PromiseLike<unknown> | undefined)?.then === 'function'
}
