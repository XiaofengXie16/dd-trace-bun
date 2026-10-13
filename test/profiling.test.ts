// CPU profiling under Bun: dd-trace's V8-based profiler is replaced by one sampling through
// Bun's inspector, and its profiles reach the agent in the format dd-trace's do.
import { afterAll, describe, expect, test } from 'bun:test'
import { Profile } from 'pprof-format'
import { toPprof, type CpuProfile } from '../src/profiler.ts'
import { spawnApp, startFakeAgent } from './helpers'

/** Each sample's stack (root first, function names) with its values. */
function stacks (pprof: Uint8Array) {
  const profile = Profile.decode(pprof)
  const str = (i: unknown) => profile.stringTable.strings[Number(i)]!
  const functions = new Map(profile.function.map((f) => [Number(f.id), f]))
  const locations = new Map(profile.location.map((l) => [Number(l.id), functions.get(Number(l.line[0]!.functionId))!]))
  return {
    profile,
    str,
    samples: profile.sample.map((s) => ({
      stack: s.locationId.map((id) => str(locations.get(Number(id))!.name)).reverse(),
      files: s.locationId.map((id) => str(locations.get(Number(id))!.filename)).reverse(),
      values: s.value.map(Number),
      labels: Object.fromEntries(s.label.map((l) => [str(l.key), str(l.str)])),
    })),
  }
}

describe('toPprof', () => {
  const frame = (functionName: string, url = 'file:///app/index.js', lineNumber = 0) =>
    ({ functionName, url, lineNumber, columnNumber: 0, scriptId: '1' })
  const cpuProfile: CpuProfile = {
    nodes: [
      { id: 1, callFrame: frame('(root)', ''), children: [2, 4] },
      { id: 2, callFrame: frame('handler', 'file:///app/index.js', 9), children: [3] },
      { id: 3, callFrame: frame('', 'file:///app/util.js', 2) },
      { id: 4, callFrame: frame('(program)', '') },
    ],
    startTime: 0,
    endTime: 100_000,
    samples: [2, 3, 3, 2, 3, 4],
    // in microseconds; the 50ms gap before the fourth sample is idle time
    timeDeltas: [10_000, 10_000, 10_000, 50_000, 10_000, 10_000],
  }
  const { profile, str, samples } = stacks(toPprof(cpuProfile, 10_000, new Date(1_700_000_000_000)))

  test('has dd-trace\'s wall profile sample types', () => {
    expect(profile.sampleType.map((t) => `${str(t.type)}/${str(t.unit)}`)).toEqual(['sample/count', 'wall/nanoseconds', 'cpu/nanoseconds'])
    expect(Number(profile.period)).toBe(10_000_000)
    expect(BigInt(profile.timeNanos)).toBe(1_700_000_000_000_000_000n)
    expect(Number(profile.durationNanos)).toBe(100_000_000)
  })

  test('aggregates samples by stack, with file paths and anonymous functions named', () => {
    const byStack = Object.fromEntries(samples.map((s) => [s.stack.join(' > '), s]))
    expect(Object.keys(byStack).sort()).toEqual(['handler', 'handler > (anonymous)'])
    expect(byStack['handler > (anonymous)']!.files).toEqual(['/app/index.js', '/app/util.js'])
    expect(byStack['handler > (anonymous)']!.values[0]).toBe(3)
    expect(byStack['handler > (anonymous)']!.labels['thread name']).toBe('Main Event Loop')
  })

  test('drops synthetic frames and caps time spanning idle gaps', () => {
    expect(samples.flatMap((s) => s.stack)).not.toContain('(program)')
    const handler = samples.find((s) => s.stack.join() === 'handler')!
    // 10ms, and 20ms rather than 50ms for the sample after the idle gap
    expect(handler.values).toEqual([2, 30_000_000, 30_000_000])
  })
})

describe('profiling a Bun app', async () => {
  const agent = await startFakeAgent()
  const app = await spawnApp<{ port: number }>(['bun', `${import.meta.dir}/profiling-app.ts`], {
    AGENT_PORT: String(agent.port),
    DD_PROFILING_ENABLED: 'true',
    DD_PROFILING_UPLOAD_PERIOD: '1',
    // dd-trace's heap profiler throws under Bun, which stops its profiler before any upload;
    // without it, dd-trace's profiler would upload (empty) profiles if it were running
    DD_PROFILING_PROFILERS: 'wall',
  })
  afterAll(() => { app.stop(); agent.close() })

  test('uploads CPU profiles with the app\'s functions to the agent', async () => {
    const deadline = Date.now() + 10_000
    let found: ReturnType<typeof stacks> | undefined
    let event: any
    while (!found && Date.now() < deadline) {
      await fetch(`http://127.0.0.1:${app.info.port}/`).then((res) => res.text())
      for (const upload of agent.profiles) {
        const pprof = upload.form.get('wall.pprof') as Blob | null
        if (!pprof) continue
        const decoded = stacks(Bun.gunzipSync(new Uint8Array(await pprof.arrayBuffer())))
        if (decoded.samples.some((s) => s.stack.includes('busyWork'))) {
          found = decoded
          event = JSON.parse(await (upload.form.get('event') as Blob).text())
        }
      }
    }
    expect(found).toBeDefined()
    const busy = found!.samples.find((s) => s.stack.includes('busyWork'))!
    expect(busy.files.at(-1)).toEndWith('profiling-app.ts')
    expect(busy.values[2]).toBeGreaterThan(0)

    expect(event.family).toBe('node')
    expect(event.attachments).toEqual(['wall.pprof'])
    expect(event.tags_profiler).toContain('service:bun-profiled')
    expect(event.tags_profiler).toContain('env:test')
    expect(event.tags_profiler).toContain('runtime_engine:bun')
    expect(event.tags_profiler).toMatch(/runtime-id:[0-9a-f-]{36}/)
  })

  test('keeps dd-trace\'s own profiler off', async () => {
    // a few upload periods, so dd-trace's profiler would have uploaded too
    while (agent.profiles.length < 3) await Bun.sleep(50)
    for (const upload of agent.profiles) {
      const event = JSON.parse(await (upload.form.get('event') as Blob).text())
      expect(event.tags_profiler).toContain('runtime_engine:bun')
    }
  })
})
