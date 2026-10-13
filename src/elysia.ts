import { Elysia } from 'elysia'
import tracer from 'dd-trace'

/**
 * Elysia plugin: names the active server span after the matched route
 * template (e.g. `GET /users/:id`) and records handler errors on it.
 * Works whether Elysia serves the request from Bun's native `routes`
 * or through its `fetch` fallback, as long as Bun.serve is patched
 * (`init()` from `dd-trace-bun`).
 */
export const datadog = () =>
  new Elysia({ name: 'dd-trace-bun' })
    .onBeforeHandle({ as: 'global' }, ({ request, route }) => {
      const span = tracer.scope().active()
      if (!span || !route) return
      span.setTag('resource.name', `${request.method} ${route}`)
      span.setTag('http.route', route)
    })
    .onError({ as: 'global' }, ({ error }) => {
      const span = tracer.scope().active()
      if (span && error instanceof Error) span.setTag('error', error)
    })
