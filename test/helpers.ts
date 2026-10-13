import http from 'node:http'
import { decode } from '@msgpack/msgpack'

export interface AgentSpan { service: string; name: string; resource: string; type: string; trace: string; span: string; parent: string; error: number; meta: Record<string, string>; metrics: Record<string, number> }

/** Minimal fake Datadog agent that decodes v0.4 / v0.5 trace payloads. */
export async function startFakeAgent() {
  const spans: AgentSpan[] = []
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      if (req.url?.includes('/traces') && body.length) collect(req.url, body, spans)
      res.writeHead(req.url?.includes('/info') ? 404 : 200, { 'content-type': 'application/json' })
      res.end('{}')
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const port = (server.address() as any).port as number
  return {
    port,
    spans,
    async waitFor(pred: (s: AgentSpan[]) => boolean, ms = 5000) {
      const end = Date.now() + ms
      while (Date.now() < end) {
        if (pred(spans)) return spans
        await Bun.sleep(25)
      }
      throw new Error('timed out waiting for spans; got ' + JSON.stringify(spans.map((s) => [s.service, s.name, s.resource, s.trace]), null, 0))
    },
    close: () => server.close(),
  }
}

const toEntries = (m: any): [any, any][] => (m instanceof Map ? [...m] : Object.entries(m ?? {}))

function collect(url: string, body: Buffer, out: AgentSpan[]) {
  const d: any = decode(body, { useBigInt64: true })
  if (url.startsWith('/v0.5')) {
    const [strings, traces] = d
    const str = (i: any) => strings[Number(i)]
    for (const t of traces) for (const s of t) {
      const meta: Record<string, string> = {}
      for (const [k, v] of toEntries(s[9])) meta[str(k)] = str(v)
      const metrics: Record<string, number> = {}
      for (const [k, v] of toEntries(s[10])) metrics[str(k)] = Number(v)
      out.push({ service: str(s[0]), name: str(s[1]), resource: str(s[2]), trace: String(s[3]), span: String(s[4]), parent: String(s[5]), error: Number(s[8]), meta, metrics, type: str(s[11]) })
    }
  } else {
    for (const t of d) for (const s of t) {
      const metrics: Record<string, number> = {}
      for (const [k, v] of Object.entries(s.metrics ?? {})) metrics[k] = Number(v)
      out.push({ service: s.service, name: s.name, resource: s.resource, type: s.type, trace: String(s.trace_id), span: String(s.span_id), parent: String(s.parent_id), error: Number(s.error), meta: s.meta ?? {}, metrics })
    }
  }
}

/** Raw HTTP/1.1 GET over Bun.connect so no tracer instrumentation touches the client side. */
export async function rawGet(port: number, path: string, headers: Record<string, string> = {}, opts: { method?: string; host?: string; abortAfterMs?: number } = {}) {
  const head = [`${opts.method ?? 'GET'} ${path} HTTP/1.1`, `host: ${opts.host ?? '127.0.0.1'}:${port}`, 'connection: close', ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`), '', ''].join('\r\n')
  return new Promise<{ status: number; body: string; headers: Record<string, string> }>((resolve, reject) => {
    let buf = ''
    Bun.connect({
      hostname: '127.0.0.1',
      port,
      socket: {
        open(s) { s.write(head); if (opts.abortAfterMs) setTimeout(() => s.end(), opts.abortAfterMs) },
        data(_s, d) { buf += new TextDecoder().decode(d) },
        close() {
          const status = Number(buf.split(' ')[1])
          const headerBlock = buf.slice(0, Math.max(0, buf.indexOf('\r\n\r\n'))).split('\r\n').slice(1)
          const headers: Record<string, string> = {}
          for (const line of headerBlock) { const i = line.indexOf(':'); headers[line.slice(0, i).toLowerCase()] = line.slice(i + 1).trim() }
          resolve({ status, body: buf.slice(buf.indexOf('\r\n\r\n') + 4), headers })
        },
        error(_s, e) { reject(e) },
      },
    }).catch(reject)
  })
}

export const randomId = () => String(BigInt.asUintN(63, BigInt(Math.floor(Math.random() * 2 ** 52)) * 2048n + BigInt(Math.floor(Math.random() * 2048))))
