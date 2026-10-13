// CPU profiling for Bun. dd-trace's profiler samples through @datadog/pprof, a native addon
// built on V8's CpuProfiler, and Bun runs JavaScriptCore: under Bun it uploads profiles with
// no JavaScript samples in them, or nothing at all once its heap profiler throws. Bun does
// implement the inspector's Profiler domain on top of JavaScriptCore's sampling profiler,
// so this samples through `node:inspector` instead, converts each period's profile to pprof
// and uploads it to the agent the same way dd-trace does.
import { Session } from 'node:inspector'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { Label, Line, Location, Function as PprofFunction, Profile, Sample, StringTable, ValueType } from 'pprof-format'

/** The part of the inspector's `Profiler.Profile` this reads. */
export interface CpuProfile {
  nodes: { id: number; callFrame: { functionName: string; url: string; lineNumber: number; columnNumber: number }; children?: number[] }[]
  startTime: number
  endTime: number
  samples?: number[]
  timeDeltas?: number[]
}

export interface ProfilerConfig {
  /** The agent, as in dd-trace's `url` option: http(s):// or unix://. */
  url: string
  /** Tags for every profile: service, env, version, runtime-id and DD_TAGS. */
  tags: Record<string, string | undefined>
  /** How often a profile is uploaded, in milliseconds. */
  uploadPeriod: number
  /** Sampling interval, in microseconds. */
  samplingInterval: number
  /** dd-trace's version, reported as the profiler version. */
  version: string
}

// JavaScriptCore only takes samples while JavaScript runs, never while the event loop
// waits, so a sample's time delta can stretch over idle time. Cap it, so idle time isn't
// charged to the first function that runs afterwards.
const MAX_SAMPLE_INTERVALS = 2

// Frames the inspector adds that aren't functions
const SYNTHETIC_FRAMES = new Set(['(root)', '(program)', '(idle)'])

export class BunProfiler {
  readonly #config: ProfilerConfig
  readonly #session = new Session()
  #timer: ReturnType<typeof setInterval> | undefined
  #start = new Date()
  #warned = false
  #stopping: Promise<void> | undefined
  #queue = Promise.resolve()
  #sequence = 0

  constructor (config: ProfilerConfig) {
    this.#config = config
  }

  async start (): Promise<void> {
    this.#session.connect()
    await this.#post('Profiler.enable')
    await this.#post('Profiler.setSamplingInterval', { interval: this.#config.samplingInterval })
    await this.#post('Profiler.start')
    this.#start = new Date()
    this.#timer = setInterval(() => void this.flush(), this.#config.uploadPeriod)
    this.#timer.unref()
    // like dd-trace, upload what was collected since the last period when the process ends
    process.once('beforeExit', () => void this.stop())
  }

  /** Upload the profile collected since the last upload, and keep profiling. */
  flush (): Promise<void> {
    return this.#stopping ?? this.#collect(true)
  }

  /** Stop profiling and upload what's left. */
  stop (): Promise<void> {
    if (!this.#stopping) {
      clearInterval(this.#timer)
      this.#stopping = this.#collect(false).finally(() => this.#session.disconnect())
    }
    return this.#stopping
  }

  // one collection at a time, so a periodic upload and stop() don't both stop the profiler
  #collect (restart: boolean): Promise<void> {
    this.#queue = this.#queue.then(() => this.#collectNow(restart))
    return this.#queue
  }

  async #collectNow (restart: boolean): Promise<void> {
    const end = new Date()
    const start = this.#start
    let profile: CpuProfile
    try {
      ({ profile } = await this.#post<{ profile: CpuProfile }>('Profiler.stop'))
      if (restart) await this.#post('Profiler.start')
    } catch (error) {
      return this.#warn('could not collect a CPU profile', error)
    }
    this.#start = new Date()
    if (!profile.samples?.length) return
    try {
      await this.#upload(toPprof(profile, this.#config.samplingInterval, start), start, end, restart ? 'periodic' : 'on_shutdown')
    } catch (error) {
      this.#warn('could not upload a CPU profile', error)
    }
  }

  async #upload (pprof: Uint8Array, start: Date, end: Date, snapshot: string): Promise<void> {
    const { tags, version } = this.#config
    const event = {
      attachments: ['wall.pprof'],
      start: start.toISOString(),
      end: end.toISOString(),
      family: 'node',
      version: '4',
      tags_profiler: [
        'language:javascript',
        'runtime:nodejs',
        `runtime_arch:${process.arch}`,
        `runtime_os:${process.platform}`,
        `runtime_version:${process.version}`,
        `runtime_engine:bun`,
        `runtime_engine_version:${Bun.version}`,
        `process_id:${process.pid}`,
        `profiler_version:${version}`,
        'format:pprof',
        ...Object.entries(tags).filter(([, value]) => value !== undefined).map(([key, value]) => `${key}:${value}`),
        `snapshot:${snapshot}`,
        `profile_seq:${this.#sequence++}`,
      ].join(','),
      endpoint_counts: {},
      info: {
        application: { env: tags.env, service: tags.service, version: tags.version },
        platform: { kernel_name: os.type(), kernel_release: os.release(), kernel_version: os.version() },
        profiler: { version, settings: { cpuProfilingEnabled: true, profilerTypes: ['wall'] } },
        runtime: { engine: 'nodejs', version: process.version.slice(1) },
      },
    }
    const form = new FormData()
    form.append('event', new Blob([JSON.stringify(event)], { type: 'application/json' }), 'event.json')
    form.append('wall.pprof', new Blob([Bun.gzipSync(pprof as Uint8Array<ArrayBuffer>)], { type: 'application/octet-stream' }), 'wall.pprof')

    const url = new URL(this.#config.url)
    const unix = url.protocol === 'unix:' ? url.pathname : undefined
    const endpoint = new URL('/profiling/v1/input', unix ? 'http://localhost' : url)
    const res = await fetch(endpoint, {
      method: 'POST',
      body: form,
      headers: { 'DD-EVP-ORIGIN': 'dd-trace-js', 'DD-EVP-ORIGIN-VERSION': version },
      signal: AbortSignal.timeout(10_000),
      ...(unix ? { unix } : {}),
    })
    if (!res.ok) throw new Error(`the agent responded ${res.status}`)
    await res.arrayBuffer()
  }

  #post<T = unknown> (method: string, params?: object): Promise<T> {
    return new Promise((resolve, reject) => {
      this.#session.post(method, params ?? {}, (error, result) => error ? reject(error) : resolve(result as T))
    })
  }

  #warn (message: string, error: unknown): void {
    if (this.#warned) return
    this.#warned = true
    console.warn(`dd-trace-bun: ${message}:`, error instanceof Error ? error.message : error)
  }
}

/**
 * Convert an inspector CPU profile to a pprof profile shaped like dd-trace's wall profile:
 * sample count, wall time and CPU time per stack. The two times are the same estimate,
 * since JavaScriptCore samples only while JavaScript is on the stack.
 */
export function toPprof (profile: CpuProfile, samplingInterval: number, start: Date): Uint8Array {
  const strings = new StringTable()
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]))
  const parents = new Map<number, number>()
  for (const node of profile.nodes) for (const child of node.children ?? []) parents.set(child, node.id)

  const functions: PprofFunction[] = []
  const functionIds = new Map<string, number>()
  const locations = new Map<number, Location>()
  const location = (nodeId: number): Location | undefined => {
    const cached = locations.get(nodeId)
    if (cached) return cached
    const { callFrame } = nodes.get(nodeId)!
    if (SYNTHETIC_FRAMES.has(callFrame.functionName)) return undefined
    const filename = callFrame.url.startsWith('file:') ? fileURLToPath(callFrame.url) : callFrame.url
    const name = callFrame.functionName || '(anonymous)'
    const key = `${name}\0${filename}\0${callFrame.lineNumber}`
    let functionId = functionIds.get(key)
    if (functionId === undefined) {
      functionId = functions.length + 1
      functionIds.set(key, functionId)
      functions.push(new PprofFunction({
        id: functionId,
        name: strings.dedup(name),
        systemName: strings.dedup(name),
        filename: strings.dedup(filename),
        startLine: Math.max(callFrame.lineNumber + 1, 0),
      }))
    }
    const loc = new Location({
      id: locations.size + 1,
      line: [new Line({ functionId, line: Math.max(callFrame.lineNumber + 1, 0), column: Math.max(callFrame.columnNumber + 1, 0) })],
    })
    locations.set(nodeId, loc)
    return loc
  }

  const intervalNanos = samplingInterval * 1000
  const totals = new Map<number, { count: number; nanos: number }>()
  const samples = profile.samples ?? []
  const deltas = profile.timeDeltas ?? []
  for (let i = 0; i < samples.length; i++) {
    const nanos = Math.min((deltas[i] ?? samplingInterval) * 1000, intervalNanos * MAX_SAMPLE_INTERVALS)
    const total = totals.get(samples[i]!) ?? { count: 0, nanos: 0 }
    total.count++
    total.nanos += Math.max(Math.round(nanos), 0)
    totals.set(samples[i]!, total)
  }

  // the labels dd-trace puts on samples from the main thread
  const labels = [
    new Label({ key: strings.dedup('thread name'), str: strings.dedup('Main Event Loop') }),
    new Label({ key: strings.dedup('thread id'), str: strings.dedup('0') }),
  ]
  const sample: Sample[] = []
  for (const [nodeId, { count, nanos }] of totals) {
    const locationId: number[] = []
    for (let id: number | undefined = nodeId; id !== undefined; id = parents.get(id)) {
      const loc = location(id)
      if (loc) locationId.push(Number(loc.id))
    }
    if (locationId.length) sample.push(new Sample({ locationId, value: [count, nanos, nanos], label: labels }))
  }

  return new Profile({
    sampleType: [
      new ValueType({ type: strings.dedup('sample'), unit: strings.dedup('count') }),
      new ValueType({ type: strings.dedup('wall'), unit: strings.dedup('nanoseconds') }),
      new ValueType({ type: strings.dedup('cpu'), unit: strings.dedup('nanoseconds') }),
    ],
    periodType: new ValueType({ type: strings.dedup('wall'), unit: strings.dedup('nanoseconds') }),
    period: intervalNanos,
    timeNanos: BigInt(start.getTime()) * 1_000_000n,
    durationNanos: Math.round((profile.endTime - profile.startTime) * 1000),
    sample,
    location: [...locations.values()],
    function: functions,
    stringTable: strings,
  }).encode()
}
