// An ordinary Elysia app: no tracing code. Run with
//   DD_SERVICE=bun-callee bun --preload dd-trace-bun/init examples/elysia-app.ts
import { Elysia } from 'elysia'

new Elysia()
  .get('/hello', async () => {
    await Bun.sleep(5)
    const r = await fetch('http://127.0.0.1:4200/echo')
    return { downstreamSawTraceId: (await r.json())['x-datadog-trace-id'] }
  })
  .listen(Number(process.argv[2] ?? 3000))
console.log('elysia up')
