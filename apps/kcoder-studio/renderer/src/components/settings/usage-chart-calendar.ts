import type { UsageCounters, UsageStats } from '@/kcoder/usageHistory'
type Day = UsageCounters & { label: string }
const DAY_MS = 86400000
// Calendar padding is visible, but never manufactures usage outside the reporting window.
export function usageCalendar(stats: UsageStats, daily: Day[]) {
  const end = new Date(stats.generatedAtMs)
  end.setUTCHours(0, 0, 0, 0)
  const start = new Date(end.getTime() - 175 * DAY_MS)
  start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7))
  const rows = new Map(daily.map(day => [day.label, day]))
  const tracked = stats.history
    ? new Date(stats.history.trackedSinceMs).toISOString().slice(0, 10)
    : null
  return Array.from(
    { length: Math.floor((end.getTime() - start.getTime()) / DAY_MS) + 1 },
    (_, index) => {
      const label = new Date(start.getTime() + index * DAY_MS).toISOString().slice(0, 10)
      return { label, row: tracked && label >= tracked ? rows.get(label) : undefined }
    }
  )
}
