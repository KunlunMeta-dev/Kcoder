import { requestLocalExecutor } from '@/host/localExecutor'

export interface RuntimeClockSample {
  serverTimeMs: number
  monotonicTimeMs: number
}

/** Sample the execution target, never the browser or Gateway wall clock. */
export async function sampleRuntimeClock(serverId: string): Promise<RuntimeClockSample | null> {
  const sample = await requestLocalExecutor<{ sampledAtMs: number } | null>(
    'runtime.clock.read', { serverId }
  )
  const after = performance.now()
  if (!sample || !Number.isSafeInteger(sample.sampledAtMs) || sample.sampledAtMs <= 0) return null
  // Startup/queueing can dominate this request; counting half its RTT would invent elapsed time.
  return { serverTimeMs: sample.sampledAtMs, monotonicTimeMs: after }
}
