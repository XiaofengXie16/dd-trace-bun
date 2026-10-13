// Runs as a plain `bun` subprocess, like fixture.ts: a busy Bun.serve app with profiling on.
import * as jsc from 'bun:jsc'
import { init } from '../src/index.ts'

init({
  service: 'bun-profiled',
  env: 'test',
  url: `http://127.0.0.1:${process.env.AGENT_PORT}`,
  startupLogs: false,
})

function busyWork (n: number) {
  let x = 0
  for (let i = 0; i < n; i++) x = (x * 31 + i) | 0
  return x
}
// keep it a frame of its own, as JavaScriptCore would otherwise inline it into the handler
(jsc as unknown as { noInline (fn: Function): void }).noInline(busyWork)

const server = Bun.serve({ port: 0, fetch: () => new Response(String(busyWork(5e6))) })
console.log(JSON.stringify({ port: server.port }))
