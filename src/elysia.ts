import { Elysia } from 'elysia'
import { nodeRequestOf, setRoute } from './serve'

const web = require('dd-trace/packages/dd-trace/src/plugins/util/web')

/**
 * Elysia plugin: tags the server span with the matched route template
 * (`http.route`, resource `GET /users/:id`) and records handler errors.
 * Needs Bun.serve to be patched (`init()` from `dd-trace-bun`).
 */
export const datadog = () =>
  new Elysia({ name: 'dd-trace-bun' })
    .onBeforeHandle({ as: 'global' }, ({ request, route }) => {
      if (route) setRoute(request, route)
    })
    .onError({ as: 'global' }, ({ request, error }) => {
      const nreq = nodeRequestOf(request)
      const span = nreq && web.root(nreq)
      if (span && error instanceof Error) span.setTag('error', error)
    })
