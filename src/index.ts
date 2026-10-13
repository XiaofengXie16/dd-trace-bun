import tracer from 'dd-trace'
import type { TracerOptions } from 'dd-trace'
import { tracerConfig, web } from './internals.ts'
import { BunProfiler } from './profiler.ts'
import { patchBunServe } from './serve.ts'

export { recordError, setRoute, traceHandler } from './serve.ts'

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
  // dd-trace's profiler samples through V8, which Bun doesn't have, so profile with Bun's own
  const profiling = options.profiling ?? isTrue(process.env.DD_PROFILING_ENABLED)
  tracer.init({ ...options, runtimeMetrics: options.runtimeMetrics ?? false, profiling: false })
  if (profiling) startProfiler()

  if (!web) {
    console.warn('dd-trace-bun: the installed dd-trace version is not supported, Bun.serve requests will not be traced.')
    return tracer
  }
  // dd-trace starts its http plugin, which turns these requests into spans, once node:http is loaded
  require('node:http')
  patchBunServe()
  return tracer
}

function startProfiler (): void {
  const config = tracerConfig(tracer)
  if (!config) {
    console.warn('dd-trace-bun: the installed dd-trace version is not supported, CPU profiling is off.')
    return
  }
  const uploadPeriod = Number(process.env.DD_PROFILING_UPLOAD_PERIOD) || 65
  // dd-trace's sampling rate
  new BunProfiler({ ...config, uploadPeriod: uploadPeriod * 1000, samplingInterval: Math.round(1e6 / 99) }).start()
    .catch((error) => console.warn('dd-trace-bun: could not start CPU profiling:', error instanceof Error ? error.message : error))
}

function isTrue (value: string | undefined): boolean {
  return value === '1' || value?.toLowerCase() === 'true'
}
