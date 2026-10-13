# dd-trace-bun

Datadog APM for Bun servers. It makes [dd-trace](https://github.com/DataDog/dd-trace-js) trace `Bun.serve`, and so Elysia, Hono and anything else built on it, so that traces coming from your other services (Node, Go, Python, …) **continue into your Bun service instead of starting over**.

It sits on top of dd-trace rather than replacing it: outbound `fetch`, `node:http`, Express and the database clients dd-trace already instruments in Bun keep working, and spans reach the Datadog agent exactly as they do from Node.

## Why

dd-trace's HTTP server integration hooks Node's `http.Server`. `Bun.serve` is native and never goes through it, so with plain dd-trace in Bun ([dd-trace-js#3749](https://github.com/DataDog/dd-trace-js/issues/3749)):

- requests handled by `Bun.serve`, Elysia or Hono get no server span
- incoming `x-datadog-*` / `traceparent` headers are never read
- every span created in a handler starts a new trace

## Install

```sh
bun add dd-trace dd-trace-bun
```

## Usage

No code changes needed. Preload it and configure dd-trace with the usual `DD_*` environment variables:

```sh
DD_SERVICE=users-api DD_ENV=prod bun --preload dd-trace-bun/init src/index.ts
```

Or initialise it in code before your server starts. `init()` takes the same options as dd-trace's `tracer.init()` and returns the tracer:

```ts
import { init } from 'dd-trace-bun'

const tracer = init({ service: 'users-api' })
```

### Elysia

`.listen()` is traced as is. Elysia serves most routes through Bun's native `routes`, so their spans are already named by route template (`GET /users/:id`). The plugin names the rest (`.all()`, optional parameters, …) and attaches handler errors to spans. Register it before your routes, because Elysia applies hooks only to routes added after them:

```ts
import { Elysia } from 'elysia'
import { datadog } from 'dd-trace-bun/elysia'

new Elysia()
  .use(datadog())
  .get('/users/:id', ({ params }) => ({ id: params.id }))
  .listen(3000)
```

### Other frameworks

Anything that ends up in `Bun.serve` is traced, including a default export Bun serves for you. Three functions let a framework integration do more:

- `setRoute(request, '/users/:id')` names the request's span after its route template.
- `recordError(request, error)` attaches an error to the span. As in dd-trace's own framework integrations, the span is only marked as an error if the response status is one (5xx by default).
- `traceHandler(fetch)` traces a fetch handler that doesn't go through `Bun.serve`.

## Configuration

Requests go through **dd-trace's own `http` server plugin**, the code that handles `node:http` on Node, so everything is configured as it is there and behaves the same:

```ts
tracer.use('http', {
  server: {
    blocklist: ['/healthz'],
    validateStatus: (code) => code < 500,
    hooks: { request: (span, req) => span?.setTag('tenant', req?.headers['x-tenant']) },
    service: 'users-http',
  },
})
```

Environment variables such as `DD_TRACE_HEADER_TAGS`, `DD_TRACE_HTTP_SERVER_ERROR_STATUSES`, `DD_TRACE_PROPAGATION_STYLE`, `DD_TRACE_SPAN_ATTRIBUTE_SCHEMA`, `DD_TRACE_OTEL_SEMANTICS_ENABLED`, `DD_TRACE_CLIENT_IP_ENABLED` and `DD_TRACE_RESOURCE_RENAMING_ENABLED` all apply. In hooks, `req` is a Node-style view of the Bun request (`method`, `url`, `headers`, `socket.remoteAddress`) with the original `Request` on `req.request`.

**AppSec** works too (`DD_APPSEC_ENABLED=true`): attacks are reported on the span, and requests that match a blocking rule get dd-trace's blocking response without reaching your handler.

## Parity with dd-trace on Node

`test/parity/http-server.test.ts` ports dd-trace-js's own `packages/datadog-plugin-http/test/server.spec.js`, plus propagation, AppSec and web-util behaviour other dd-trace specs cover. It runs the **same assertions** against three apps:

| App | Runtime | Tracer | Result |
|---|---|---|---|
| `node:http` (reference) | Node 22 | plain dd-trace | 28 / 28 |
| `Bun.serve` | Bun 1.4.2 | dd-trace-bun | 28 / 28 |
| Elysia `.listen()` | Bun 1.4.2 | dd-trace-bun | 28 / 28 |

The cases cover span shape (name, service, type, resource, kind, URL, method, status, component), the request scope, Datadog / W3C / B3 propagation, 5xx and thrown errors, query string obfuscation, CORS preflight trace headers, canceled requests, OTel semantics, `DD_TRACE_HTTP_SERVER_ERROR_STATUSES`, `server` config, hooks, blocklist and `service` override, a disabled server integration, resource renaming (`http.endpoint`), header tags, client IP, naming schema v1, and AppSec reporting and blocking. Elysia spans carry its matched route (`GET /*`), as dd-trace's Express integration does, so its resource and endpoint assertions expect the route.

`test/serve.test.ts` covers what only Bun has: native `routes`, `server.reload()`, WebSocket upgrades, class-based options, Elysia's client errors, and `node:http` in Bun still being traced once.

## How it works

- `init()` patches `Bun.serve` (and `server.reload`) to wrap `fetch` and every handler in `routes`.
- Each request is published on the diagnostics channels dd-trace's `node:http` instrumentation uses, with a Node-style view of the request and response. dd-trace's http server plugin then extracts the incoming context, starts the span, applies its configuration, and finishes the span once the handler's `Response` is known. The span is active for the whole handler, across `await`s.
- Handlers of Bun's native `routes` set `http.route`, so the resource becomes `GET /users/:id`.
- What it needs from dd-trace beyond its public API (four channel names and `plugins/util/web`) is all in `src/internals.ts`. CI runs the suite against the newest dd-trace 5 and 6, so a dd-trace release that changes them shows up as a failing build. If they're missing at runtime, `init()` logs a warning and leaves `Bun.serve` alone instead of failing.

## Limitations

- The span ends when the handler returns its `Response`, not when a streamed body finishes.
- When a bare `Bun.serve` fetch handler throws, the span records the error with status 500. Bun doesn't pass the request to your `error()` handler, so a different status it returns isn't seen. Elysia and Hono handle errors themselves and aren't affected.
- dd-trace's runtime metrics crash Bun ([oven-sh/bun#18546](https://github.com/oven-sh/bun/issues/18546)), so `init()` keeps them off even if `DD_RUNTIME_METRICS_ENABLED` is set, and logs that it did. Passing `runtimeMetrics` to `init()` overrides this.
- dd-trace's Orchestrion-based integrations (graphql, ai, bullmq, langchain, …) don't run under Bun ([dd-trace-js#3749](https://github.com/DataDog/dd-trace-js/issues/3749)). That's a gap in dd-trace itself, which this package doesn't address.
- Inside `bun test`, dd-trace turns itself into a no-op because it sees Bun's jest-compatible globals. This package's own tests therefore run the traced apps as subprocesses.

## Compatibility

Bun ≥ 1.2.23, dd-trace ≥ 5.60 and < 7, and optionally Elysia ≥ 1.2. The whole suite passes on Bun 1.2.23, 1.3.0 and 1.4.2, dd-trace 5.131.1 and 6.20.1, and Elysia 1.2.25, 1.3.21 and 1.4.30. On dd-trace 5.60.0 and 6.0.0 Bun behaves exactly like Node, but some options the suite checks didn't exist yet. The floors are the oldest versions tested; further back, dd-trace itself breaks under Bun with or without this package (5.0.0 overflows the stack, and 6.20.1 fails to load on Bun 1.2.3).

## Development

```sh
bun install
bun test          # 97 tests against a fake Datadog agent; node must be on PATH for the reference app
bun run typecheck
bun run build     # compiles src/ to dist/, which is what the npm package exports
```

To release, bump `version` in package.json and push a matching tag (`v0.2.0`). The publish workflow runs the tests and publishes to npm with provenance.

## License

Apache-2.0, like dd-trace.
