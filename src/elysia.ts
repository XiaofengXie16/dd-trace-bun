import { Elysia } from 'elysia'
import { recordError, setRoute } from './serve.ts'

/**
 * Elysia plugin: names spans after the matched route (`GET /users/:id`) and attaches
 * errors to them. Elysia already serves most routes through Bun's native `routes`, which
 * `init()` names on its own; this covers the rest (e.g. `.all()` and optional params) and
 * errors. Register it before your routes: Elysia applies hooks only to routes added after.
 */
export const datadog = (): Elysia =>
  new Elysia({ name: 'dd-trace-bun' })
    .onTransform({ as: 'global' }, ({ request, route }) => {
      setRoute(request, route)
    })
    .onError({ as: 'global' }, ({ request, error }) => {
      recordError(request, error)
    })
