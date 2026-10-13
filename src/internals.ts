// Everything dd-trace-bun takes from dd-trace that isn't public API.
//
// Bun.serve requests are published on the diagnostics channels dd-trace's node:http
// server instrumentation uses (packages/datadog-instrumentations/src/http/server.js),
// so dd-trace's http server plugin and AppSec handle them exactly like node:http
// requests. CI runs the test suite against the newest dd-trace 5 and 6 releases, so a
// change to any of this shows up as a failing build.
import dc from 'node:diagnostics_channel'
import { createRequire } from 'node:module'
import os from 'node:os'
import type { Span } from 'dd-trace'

export const requestStart = dc.channel('apm:http:server:request:start')
export const requestExit = dc.channel('apm:http:server:request:exit')
export const requestFinish = dc.channel('apm:http:server:request:finish')
export const responseWriteHead = dc.channel('apm:http:server:response:writeHead:start')

/** The parts of dd-trace's `plugins/util/web`, the request context all its web integrations share. */
interface WebUtil {
  root (req: object): Span | null
  setRoute (req: object, path: string): void
  addError (req: object, error: unknown): void
}

/** Undefined when the installed dd-trace doesn't have the expected internals. */
export const web: WebUtil | undefined = loadWebUtil()

function loadWebUtil (): WebUtil | undefined {
  try {
    const util = createRequire(import.meta.url)('dd-trace/packages/dd-trace/src/plugins/util/web')
    const complete = ['root', 'setRoute', 'addError'].every((name) => typeof util[name] === 'function')
    return complete ? util : undefined
  } catch {
    return undefined
  }
}

/** The parts of dd-trace's resolved configuration the profiler needs. */
export interface TracerConfig {
  /** The agent URL. */
  url: string
  /** Global tags: service, env, version, runtime-id and DD_TAGS. */
  tags: Record<string, string | undefined>
  /** dd-trace's version. */
  version: string
}

/** Undefined before `tracer.init()`, or when the installed dd-trace keeps its config elsewhere. */
export function tracerConfig (tracer: object): TracerConfig | undefined {
  const config = (tracer as { _tracer?: { _config?: { url?: unknown; tags?: unknown; reportHostname?: unknown } } })._tracer?._config
  if (!config?.url || typeof config.tags !== 'object' || !config.tags) return undefined
  const { version } = createRequire(import.meta.url)('dd-trace/package.json') as { version: string }
  const tags: Record<string, string | undefined> = { ...config.tags as Record<string, string> }
  if (config.reportHostname) tags.host = os.hostname()
  // what dd-trace's profiler adds for source code integration, when set in the environment
  if (process.env.DD_GIT_REPOSITORY_URL && process.env.DD_GIT_COMMIT_SHA) {
    tags['git.repository_url'] = process.env.DD_GIT_REPOSITORY_URL
    tags['git.commit.sha'] = process.env.DD_GIT_COMMIT_SHA
  }
  return { url: String(config.url), tags, version }
}
