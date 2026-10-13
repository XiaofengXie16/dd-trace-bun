import http from 'node:http'
import { decode } from '@msgpack/msgpack'

export interface AgentSpan { service: string; name: string; resource: string; trace: string; span: string; parent: string; error: number; meta: Record<string, string> }

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

function collect(url: string, body: Buffer, out: AgentSpan[]) {
  const d: any = decode(body, { useBigInt64: true })
  if (url.startsWith('/v0.5')) {
    const [strings, traces] = d
    const str = (i: any) => strings[Number(i)]
    for (const t of traces) for (const s of t) {
      const meta: Record<string, string> = {}
      for (const [k, v] of s[9] as Map<any, any>) meta[str(k)] = str(v)
      out.push({ service: str(s[0]), name: str(s[1]), resource: str(s[2]), trace: String(s[3]), span: String(s[4]), parent: String(s[5]), error: Number(s[8]), meta })
    }
  } else {
    for (const t of d) for (const s of t) {
      out.push({ service: s.service, name: s.name, resource: s.resource, trace: String(s.trace_id), span: String(s.span_id), parent: String(s.parent_id), error: Number(s.error), meta: s.meta ?? {} })
    }
  }
}

/** Raw HTTP/1.1 GET over Bun.connect so no tracer instrumentation touches the client side. */
export async function rawGet(port: number, path: string, headers: Record<string, string> = {}) {
  const head = [`GET ${path} HTTP/1.1`, `host: 127.0.0.1:${port}`, 'connection: close', ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`), '', ''].join('\r\n')
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    let buf = ''
    Bun.connect({
      hostname: '127.0.0.1',
      port,
      socket: {
        open(s) { s.write(head) },
        data(_s, d) { buf += new TextDecoder().decode(d) },
        close() {
          const status = Number(buf.split(' ')[1])
          resolve({ status, body: buf.slice(buf.indexOf('\r\n\r\n') + 4) })
        },
        error(_s, e) { reject(e) },
      },
    }).catch(reject)
  })
}

export const randomId = () => String(BigInt.asUintN(63, BigInt(Math.floor(Math.random() * 2 ** 52)) * 2048n + BigInt(Math.floor(Math.random() * 2048))))
