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

### Configuration

Bun.serve requests go through **dd-trace's own `http` server plugin**, the same code that handles `node:http` on Node. Everything is therefore configured exactly as on Node, and behaves the same:

```ts
tracer.use('http', {
  server: {
    blocklist: ['/healthz'],
    validateStatus: (code) => code < 500,
    hooks: { request: (span, req, res) => span.setTag('tenant', req.headers['x-tenant']) },
    service: 'my-http-service',
  },
})
```

Env vars such as `DD_TRACE_HEADER_TAGS`, `DD_TRACE_HTTP_SERVER_ERROR_STATUSES`, `DD_TRACE_PROPAGATION_STYLE`, `DD_TRACE_SPAN_ATTRIBUTE_SCHEMA`, `DD_TRACE_OTEL_SEMANTICS_ENABLED`, `DD_TRACE_CLIENT_IP_ENABLED` and `DD_TRACE_RESOURCE_RENAMING_ENABLED` all apply. In hooks, `req` is a Node-style view of the Bun request (`method`, `url`, `headers`, `socket.remoteAddress`) with the original `Request` on `req.request`.

## Parity with dd-trace on Node

`test/parity/http-server.test.ts` ports dd-trace-js's own `packages/datadog-plugin-http/test/server.spec.js`, plus propagation and web-util behaviour other dd-trace specs cover. It runs the **same assertions** against three targets:

| Target | Runtime | Tracer | Result |
|---|---|---|---|
| `node:http` (reference) | Node 22 | plain dd-trace | 25 / 25 |
| `Bun.serve` | Bun 1.4.2 | dd-trace-bun | 25 / 25 |
| Elysia `.listen()` | Bun 1.4.2 | dd-trace-bun | 25 / 25 |

The cases cover:
- span shape: name, service, type, resource, `span.kind`, URL, method, status, component
- the request scope
- Datadog, W3C and B3 propagation
- 5xx and thrown errors
- query string obfuscation
- CORS preflight trace headers
- canceled requests
- OTel semantics
- `DD_TRACE_HTTP_SERVER_ERROR_STATUSES`
- `server` config, hooks, blocklist and `service` override
- resource renaming (`http.endpoint`)
- header tags
- client IP
- naming schema v1

Elysia's spans carry its matched route (`GET /*`), just as dd-trace's Express integration does, so its resource and endpoint assertions expect the route.

Not ported yet: dd-trace's AppSec/IAST request blocking (it writes to a Node `ServerResponse`), HTTP/2, and the http *client* spec. Bun's `fetch` goes through dd-trace's own fetch plugin unchanged.

## How it works

- Patches `Bun.serve` (and `server.reload`) to wrap `fetch` and every function in `routes`.
- Each request is published on dd-trace's `apm:http:server:request:*` diagnostics channels with a Node-style view of the request and response. dd-trace's own http server plugin then extracts the incoming context, creates the span, applies all its configuration and finishes the span when the `Response` is returned. The span stays active across `await`s in the handler.
- Bun's native `routes` set `http.route`, so the resource becomes `GET /users/:id`.
- Defaults `runtimeMetrics` and `profiling` to off under Bun, because their native addons crash or misbehave there. They can still be turned on with `DD_RUNTIME_METRICS_ENABLED` / `DD_PROFILING_ENABLED`.
- Relies on dd-trace internals: those channel names and `plugins/util/web`. CI runs the full suite against both the pinned dd-trace version and `latest`, so a breaking dd-trace release shows up as a red build.

## Known limitations

- The server span ends when the handler returns its `Response`, not when a streamed body finishes.
- dd-trace turns itself into a no-op inside `bun test`, because it sees Bun's jest-compatible globals. The test suite therefore runs the traced app as a subprocess (`test/fixture.ts`).
- Orchestrion-based dd-trace integrations (graphql, ai, bullmq, langchain, …) and ESM-only auto-instrumentation are still missing in Bun. That is a separate dd-trace issue which this package doesn't address yet.

## Development

```sh
bun install
bun test        # 83 tests: parity suite (node / bun / elysia) + Bun-specific tests, against a fake Datadog agent
bun run typecheck
```

Tested with Bun 1.4.2, dd-trace 6.20.1 and Elysia 1.4.30.
