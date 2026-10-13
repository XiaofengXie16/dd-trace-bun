# dd-trace-bun

Bun-native server tracing for [dd-trace](https://github.com/DataDog/dd-trace-js). It instruments `Bun.serve`, and so Elysia, Hono and anything else built on it, so that distributed traces coming from other services (Node, Go, Python, …) **continue into your Bun service instead of starting a new trace**.

It sits on top of dd-trace rather than replacing it. Outbound `fetch`, `node:http`, Express and the database drivers dd-trace already instruments in Bun keep working, and spans go to the Datadog agent exactly as they do from Node.

## Why

dd-trace's HTTP server integration hooks Node's `http.Server`. `Bun.serve` is native and never goes through it, so with plain dd-trace in Bun (see [dd-trace-js#3749](https://github.com/DataDog/dd-trace-js/issues/3749)):

- no server span is created for requests handled by `Bun.serve`, Elysia or Hono
- incoming `x-datadog-*` / `traceparent` headers are never read
- every span you create in a handler becomes a new root trace

## Usage

Zero code changes. Preload it and configure with the usual `DD_*` env vars:

```sh
DD_SERVICE=my-bun-api DD_ENV=prod bun --preload dd-trace-bun/init src/index.ts
```

Or initialise it in code, before your server starts:

```ts
import { init } from 'dd-trace-bun'
const tracer = init({ service: 'my-bun-api' }) // same options as dd-trace's tracer.init()
```

### Elysia

`.listen()` works unchanged. Elysia 1.4 serves most routes through Bun's native `routes`, and spans are named by route template (`GET /users/:id`). For routes Elysia handles through its fetch fallback, and to record handler errors, add the plugin:

```ts
import { datadog } from 'dd-trace-bun/elysia'

new Elysia().use(datadog()).get('/users/:id', ...).listen(3000)
```

### Options

```ts
init({
  serve: {
    filter: (req, url) => url.pathname !== '/healthz', // skip tracing some requests
    isError: (status) => status >= 500,                // which statuses mark the span as an error
  },
})
```

## What it does

- Patches `Bun.serve` (and `server.reload`) to wrap `fetch` and every function in `routes`.
- Per request: extracts context with `tracer.extract('http_headers', …)` (Datadog, W3C tracecontext, B3, whatever dd-trace is configured for), starts a `web.request` span (`span.kind=server`, `component=bun`), and keeps it active for the whole handler, including across `await`s.
- Tags `http.method`, `http.url`, `http.route`, `http.status_code`, `http.useragent`. Thrown errors and 5xx responses mark the span as an error.
- Defaults `runtimeMetrics` and `profiling` to off under Bun, because their native addons crash or misbehave there. They can still be turned on with `DD_RUNTIME_METRICS_ENABLED` / `DD_PROFILING_ENABLED`.

## Known limitations

- The server span ends when the handler returns its `Response`, not when a streamed body finishes.
- dd-trace turns itself into a no-op inside `bun test`, because it sees Bun's jest-compatible globals. The test suite therefore runs the traced app as a subprocess (`test/fixture.ts`).
- Orchestrion-based dd-trace integrations (graphql, ai, bullmq, langchain, …) and ESM-only auto-instrumentation are still missing in Bun. That is a separate dd-trace issue which this package doesn't address yet.

## Development

```sh
bun install
bun test        # fake Datadog agent + traced Bun.serve / Elysia / node:http app
bun run typecheck
```

Tested with Bun 1.4.2, dd-trace 6.20.1 and Elysia 1.4.30.
