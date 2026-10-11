import { requestLocalExecutor } from '@/tauri/localExecutor'

export interface UsageCounters {
  requests: number
  unreportedRequests: number
  estimatedTotalRequests: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  totalTokens: number
}
export interface UsageStats {
  windowDays: number
  timeZone: string
  generatedAtMs: number
  history: null | {
    version: number
    trackedSinceMs: number
    lastRecordedAtMs: number
    days: Record<string, Record<string, UsageCounters>>
  }
}
export const emptyUsage = (): UsageCounters => ({
  requests: 0,
  unreportedRequests: 0,
  estimatedTotalRequests: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  totalTokens: 0,
})

function merge(target: UsageCounters, value: UsageCounters) {
  for (const key of Object.keys(target) as (keyof UsageCounters)[]) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 0)
      throw new Error('Invalid usage counters')
    target[key] += value[key]
    if (!Number.isSafeInteger(target[key]))
      throw new Error('Usage counters exceed the supported range')
  }
}

export function summarizeUsage(stats: UsageStats) {
  const total = emptyUsage()
  const models = new Map<string, UsageCounters>()
  const daily = []
  const today = new Date(stats.generatedAtMs)
  today.setUTCHours(0, 0, 0, 0)
  if (!Number.isFinite(today.getTime()) || stats.windowDays !== 30 || stats.timeZone !== 'UTC')
    throw new Error('Unsupported usage statistics response')
  for (let offset = 29; offset >= 0; offset--) {
    const day = new Date(today.getTime() - offset * 86400000).toISOString().slice(0, 10)
    const counters = emptyUsage()
    for (const [model, usage] of Object.entries(stats.history?.days[day] ?? {})) {
      merge(counters, usage)
      const summary = models.get(model) ?? emptyUsage()
      merge(summary, usage)
      models.set(model, summary)
    }
    merge(total, counters)
    daily.push({ label: day, ...counters })
  }
  return {
    total,
    daily,
    models: [...models]
      .map(([label, counters]) => ({ label, ...counters }))
      .sort((a, b) => b.totalTokens - a.totalTokens || a.label.localeCompare(b.label)),
  }
}

export async function readUsageStats(serverId: string): Promise<UsageStats> {
  const result = await requestLocalExecutor<UsageStats>('runtime.usage.stats', { serverId })
  summarizeUsage(result)
  return result
}
