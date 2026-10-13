import http from 'node:http'
import { decode } from '@msgpack/msgpack'

export interface AgentSpan {
  service: string
  name: string
  resource: string
  type: string
  trace: string
  span: string
  parent: string
  error: number
  meta: Record<string, string>
  metrics: Record<string, number>
}

/** A profile upload: its multipart form, with event.json and the pprof files. */
export interface AgentProfile {
  headers: Record<string, string | string[] | undefined>
  form: FormData
}

/** Minimal fake Datadog agent that decodes v0.4 / v0.5 trace payloads and keeps profile uploads. */
export async function startFakeAgent () {
  const spans: AgentSpan[] = []
  const profiles: AgentProfile[] = []
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      if (req.url?.includes('/traces') && body.length) spans.push(...decodeTraces(req.url, body))
      if (req.url === '/profiling/v1/input') {
        void new Response(body, { headers: { 'content-type': req.headers['content-type']! } }).formData()
          .then((form) => profiles.push({ headers: req.headers, form }))
      }
      res.writeHead(req.url?.includes('/info') ? 404 : 200, { 'content-type': 'application/json' })
      res.end('{}')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    port: (server.address() as { port: number }).port,
    spans,
    profiles,
    async waitFor (predicate: (spans: AgentSpan[]) => boolean, ms = 5000) {
      const deadline = Date.now() + ms
      while (Date.now() < deadline) {
        if (predicate(spans)) return spans
        await Bun.sleep(25)
      }
      throw new Error(`timed out waiting for spans; got ${JSON.stringify(spans.map((s) => [s.service, s.name, s.resource, s.trace]))}`)
    },
    close: () => server.close(),
  }
}

const entries = (m: unknown): [unknown, unknown][] => (m instanceof Map ? [...m] : Object.entries(m ?? {}))

function decodeTraces (url: string, body: Buffer): AgentSpan[] {
  const payload: any = decode(body, { useBigInt64: true })
  const spans: AgentSpan[] = []
  if (url.startsWith('/v0.5')) {
    const [strings, traces] = payload
    const str = (i: unknown) => strings[Number(i)]
    for (const s of traces.flat()) {
      spans.push({
        service: str(s[0]), name: str(s[1]), resource: str(s[2]), type: str(s[11]),
        trace: String(s[3]), span: String(s[4]), parent: String(s[5]), error: Number(s[8]),
        meta: Object.fromEntries(entries(s[9]).map(([k, v]) => [str(k), str(v)])),
        metrics: Object.fromEntries(entries(s[10]).map(([k, v]) => [str(k), Number(v)])),
      })
    }
  } else {
    for (const s of payload.flat()) {
      spans.push({
        service: s.service, name: s.name, resource: s.resource, type: s.type,
        trace: String(s.trace_id), span: String(s.span_id), parent: String(s.parent_id), error: Number(s.error),
        meta: s.meta ?? {},
        metrics: Object.fromEntries(entries(s.metrics).map(([k, v]) => [k, Number(v)])),
      })
    }
  }
  return spans
}

/**
 * Run a traced app as a subprocess and wait for the JSON line it prints once listening.
 * stderr is passed through and also kept for assertions.
 */
export async function spawnApp<T> (cmd: string[], env: Record<string, string>) {
  const proc = Bun.spawn(cmd, { env: { ...process.env, ...env }, stdout: 'pipe', stderr: 'pipe' })
  let stderr = ''
  void (async () => {
    for await (const chunk of proc.stderr) {
      process.stderr.write(chunk)
      stderr += new TextDecoder().decode(chunk)
    }
  })()

  const reader = proc.stdout.getReader()
  let stdout = ''
  let line: string | undefined
  while (!line) {
    const { value, done } = await reader.read()
    if (done) throw new Error(`${cmd.join(' ')} exited before listening`)
    stdout += new TextDecoder().decode(value)
    line = stdout.split('\n').find((l) => l.startsWith('{') && stdout.includes(`${l}\n`))
  }
  // keep draining, so the app never blocks on a full pipe
  void (async () => { while (!(await reader.read()).done); })()
  return { info: JSON.parse(line) as T, stderr: () => stderr, stop: () => proc.kill() }
}

/** Raw HTTP/1.1 request over Bun.connect, so no tracer instrumentation touches the client side. */
export async function rawGet (port: number, path: string, headers: Record<string, string> = {}, opts: { method?: string; host?: string; abortAfterMs?: number } = {}) {
  const head = [
    `${opts.method ?? 'GET'} ${path} HTTP/1.1`,
    `host: ${opts.host ?? '127.0.0.1'}:${port}`,
    'connection: close',
    ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
    '', '',
  ].join('\r\n')
  return new Promise<{ status: number; body: string; headers: Record<string, string> }>((resolve, reject) => {
    let raw = Buffer.alloc(0)
    const parse = () => {
      const end = raw.indexOf('\r\n\r\n')
      if (end === -1) return undefined
      const [statusLine = '', ...headerLines] = raw.subarray(0, end).toString().split('\r\n')
      const headers: Record<string, string> = {}
      for (const line of headerLines) {
        const i = line.indexOf(':')
        headers[line.slice(0, i).toLowerCase()] = line.slice(i + 1).trim()
      }
      const body = raw.subarray(end + 4)
      const complete = headers['content-length'] !== undefined && body.length >= Number(headers['content-length'])
      return { status: Number(statusLine.split(' ')[1]), body: body.toString(), headers, complete }
    }
    Bun.connect({
      hostname: '127.0.0.1',
      port,
      socket: {
        open (socket) {
          socket.write(head)
          if (opts.abortAfterMs) setTimeout(() => socket.end(), opts.abortAfterMs)
        },
        data (socket, data) {
          raw = Buffer.concat([raw, data])
          // don't rely on the server closing the connection (Bun 1.3.0 doesn't, after some async handlers)
          const res = parse()
          if (res?.complete) {
            resolve(res)
            socket.end()
          }
        },
        close () {
          resolve(parse() ?? { status: NaN, body: '', headers: {} })
        },
        error (_socket, error) { reject(error) },
      },
    }).catch(reject)
  })
}

/** A random 63-bit id, as a decimal string like dd-trace's 64-bit ids. */
export const randomId = () => String(crypto.getRandomValues(new BigUint64Array(1))[0]! >> 1n)
