import tracer from 'dd-trace'
import type { TracerOptions } from 'dd-trace'
import { patchBunServe } from './serve'

export { tracer }
export { patchBunServe, traceHandler, traceServeOptions, setRoute, nodeRequestOf } from './serve'

const isBun = typeof (globalThis as any).Bun !== 'undefined'

/**
 * Initialise dd-trace with Bun-safe defaults and instrument Bun.serve.
 * Call this before your server starts (or use `bun --preload dd-trace-bun/init`).
 *
 * Bun.serve requests go through dd-trace's `http` server plugin, so configure
 * them exactly as on Node: `tracer.use('http', { server: { ... } })` or DD_* env vars.
 */
export function init (options: TracerOptions = {}) {
  tracer.init({
    // native addons behind these crash or misbehave on Bun (dd-trace-js#3749)
    runtimeMetrics: isBun ? envFlag('DD_RUNTIME_METRICS_ENABLED') ?? false : undefined,
    profiling: isBun ? envFlag('DD_PROFILING_ENABLED') ?? false : undefined,
    ...options,
  })
  if (isBun) {
    // dd-trace enables its http plugin when node:http is first loaded; make sure that has happened
    require('node:http')
    patchBunServe()
  }
  return tracer
}

function envFlag (name: string): boolean | undefined {
  const v = process.env[name]
  if (v === undefined) return undefined
  return v === 'true' || v === '1'
}
