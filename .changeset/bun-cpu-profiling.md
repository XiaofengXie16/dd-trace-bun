---
"dd-trace-bun": minor
---

CPU profiling under Bun. dd-trace's profiler relies on V8 and uploads empty profiles (or none) under Bun, so with `DD_PROFILING_ENABLED=true` or `init({ profiling: true })`, `init()` now keeps it off and profiles through Bun's inspector instead, uploading pprof CPU profiles to the agent.
