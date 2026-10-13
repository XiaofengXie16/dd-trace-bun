// Node-style views of a Bun request and response: the parts of node:http's
// IncomingMessage and ServerResponse that dd-trace's http server plugin and AppSec use.
import type { Server } from 'bun'
import { responseWriteHead } from './internals'

/**
 * A Bun request as dd-trace sees it. This is also the `req` passed to
 * `tracer.use('http', { server: { hooks: { request } } })`; `request` is the original.
 */
export interface NodeRequest {
  method: string
  /** Path and query string, like node:http's `req.url`. */
  url: string
  /** Lower-case header names. */
  headers: Record<string, string>
  socket: { remoteAddress: string | undefined; encrypted: boolean }
  request: Request
}

export function toNodeRequest (request: Request, server: Server<unknown> | undefined): NodeRequest {
  const url = new URL(request.url)
  const headers = Object.fromEntries(request.headers)
  headers.host ??= url.host
  return {
    method: request.method,
    url: url.pathname + url.search,
    headers,
    // no server when the handler is called directly, e.g. Elysia's app.handle()
    socket: { remoteAddress: server?.requestIP?.(request)?.address, encrypted: url.protocol === 'https:' },
    request,
  }
}

/**
 * A Bun response as dd-trace sees it. It holds the status and headers of the Response the
 * handler returned. dd-trace may add headers to it (CORS allow-headers on preflights) or,
 * when AppSec blocks a request, replace it with a response of its own.
 */
export class NodeResponse {
  statusCode = 200
  headersSent = false
  #headers = new Map<string, string | string[]>()
  #added = new Map<string, string>()
  #ended = false
  #body: string | undefined

  constructor (readonly req: NodeRequest) {}

  /** Record the status and headers the handler responded with. */
  load (response: Response): void {
    this.statusCode = response.status
    for (const [name, value] of response.headers) this.#headers.set(name, value)
    const cookies = response.headers.getSetCookie()
    if (cookies.length > 0) this.#headers.set('set-cookie', cookies)
  }

  /** True once dd-trace wrote a complete response itself (AppSec blocking). */
  get ended (): boolean {
    return this.#ended
  }

  /** The response dd-trace wrote. */
  toResponse (): Response {
    const headers = new Headers()
    for (const [name, value] of this.#headers) {
      for (const v of [value].flat()) headers.append(name, v)
    }
    return new Response(this.#body ?? null, { status: this.statusCode, headers })
  }

  /** The handler's response, with any headers dd-trace added. */
  withAddedHeaders (response: Response): Response {
    if (this.#added.size === 0) return response
    try {
      for (const [name, value] of this.#added) response.headers.set(name, value)
      return response
    } catch {
      // immutable headers, e.g. a Response from fetch()
      const headers = new Headers(response.headers)
      for (const [name, value] of this.#added) headers.set(name, value)
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
    }
  }

  getHeader (name: string): string | string[] | undefined {
    return this.#headers.get(name.toLowerCase())
  }

  getHeaders (): Record<string, string | string[]> {
    return Object.fromEntries(this.#headers)
  }

  getHeaderNames (): string[] {
    return [...this.#headers.keys()]
  }

  setHeader (name: string, value: string | number | string[]): this {
    const v = Array.isArray(value) ? value : String(value)
    this.#headers.set(name.toLowerCase(), v)
    this.#added.set(name.toLowerCase(), [v].flat().join(', '))
    return this
  }

  removeHeader (name: string): void {
    this.#headers.delete(name.toLowerCase())
    this.#added.delete(name.toLowerCase())
  }

  // Like dd-trace's wrapper around node:http's writeHead: AppSec inspects the response
  // here and may block it, in which case it has already written its own.
  writeHead (statusCode?: number, headers?: Record<string, string>): this {
    const abortController = new AbortController()
    if (responseWriteHead.hasSubscribers) {
      responseWriteHead.publish({
        req: this.req,
        res: this,
        abortController,
        statusCode: statusCode ?? this.statusCode,
        responseHeaders: { ...this.getHeaders(), ...headers },
      })
    }
    if (abortController.signal.aborted) return this

    if (statusCode !== undefined) this.statusCode = statusCode
    for (const [name, value] of Object.entries(headers ?? {})) this.setHeader(name, value)
    this.headersSent = true
    return this
  }

  end (body?: string): this {
    this.#body = body
    this.#ended = true
    this.headersSent = true
    return this
  }
}
