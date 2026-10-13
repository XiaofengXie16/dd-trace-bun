import tracer from 'dd-trace'
import type { TracerOptions } from 'dd-trace'
import { web } from './internals'
import { patchBunServe } from './serve'

export { recordError, setRoute, traceHandler } from './serve'

/**
 * Initialise dd-trace and instrument `Bun.serve`, and with it Elysia, Hono and anything
 * else built on it. Call it before your server starts, or preload `dd-trace-bun/init`.
 * Takes the same options as dd-trace's `tracer.init()`.
 *
 * Requests go through dd-trace's own http server plugin, so they're configured exactly as
 * on Node: `tracer.use('http', { server: { ... } })` and the `DD_*` environment variables.
 */
export function init (options: TracerOptions = {}): typeof tracer {
  if (typeof Bun === 'undefined') return tracer.init(options)

  if (options.runtimeMetrics === undefined && isTrue(process.env.DD_RUNTIME_METRICS_ENABLED)) {
    console.warn('dd-trace-bun: ignoring DD_RUNTIME_METRICS_ENABLED, dd-trace\'s runtime metrics crash Bun ' +
      '(https://github.com/oven-sh/bun/issues/18546). Pass `runtimeMetrics` to init() to override.')
  }
  tracer.init({ ...options, runtimeMetrics: options.runtimeMetrics ?? false })

  if (!web) {
    console.warn('dd-trace-bun: the installed dd-trace version is not supported, Bun.serve requests will not be traced.')
    return tracer
  }
  // dd-trace starts its http plugin, which turns these requests into spans, once node:http is loaded
  require('node:http')
  patchBunServe()
  return tracer
}

function isTrue (value: string | undefined): boolean {
  return value === '1' || value?.toLowerCase() === 'true'
}
