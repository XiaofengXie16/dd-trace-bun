import tracer from 'dd-trace'
import type { TracerOptions } from 'dd-trace'
import { patchBunServe, type ServeTracingOptions } from './serve'

export { tracer }
export { patchBunServe, traceHandler, traceServeOptions, routeOf, type ServeTracingOptions } from './serve'

const isBun = typeof (globalThis as any).Bun !== 'undefined'

/**
 * Initialise dd-trace with Bun-safe defaults and instrument Bun.serve.
 * Call this before importing your server code (or use `bun --preload dd-trace-bun/init`).
 */
export function init(options: TracerOptions & { serve?: ServeTracingOptions } = {}) {
  const { serve, ...tracerOptions } = options
  tracer.init({
    // native addons behind these crash or misbehave on Bun (dd-trace-js#3749)
    runtimeMetrics: isBun ? envFlag('DD_RUNTIME_METRICS_ENABLED') ?? false : undefined,
    profiling: isBun ? envFlag('DD_PROFILING_ENABLED') ?? false : undefined,
    ...tracerOptions,
  })
  if (isBun) patchBunServe(tracer, serve)
  return tracer
}

function envFlag(name: string): boolean | undefined {
  const v = process.env[name]
  if (v === undefined) return undefined
  return v === 'true' || v === '1'
}
