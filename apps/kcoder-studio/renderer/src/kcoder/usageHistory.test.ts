import { expect, test } from 'vitest'
import { emptyUsage, summarizeUsage, type UsageStats } from './usageHistory'

test('groups thirty UTC days and models without adding cached tokens again', () => {
  const stats: UsageStats = {
    windowDays: 30,
    timeZone: 'UTC',
    generatedAtMs: Date.parse('2026-09-08T00:01:00Z'),
    history: {
      version: 1,
      trackedSinceMs: 1,
      lastRecordedAtMs: 2,
      days: {
        '2026-09-08': {
          model: {
            ...emptyUsage(),
            requests: 1,
            inputTokens: 100,
            outputTokens: 20,
            cacheReadTokens: 80,
            totalTokens: 120,
          },
        },
        '2026-08-10': { other: { ...emptyUsage(), requests: 1, totalTokens: 4 } },
        '2026-08-09': { old: { ...emptyUsage(), requests: 1, totalTokens: 900 } },
      },
    },
  }
  const result = summarizeUsage(stats)
  expect(result.daily).toHaveLength(30)
  expect(result.total.totalTokens).toBe(124)
  expect(result.total.cacheReadTokens).toBe(80)
  expect(result.models.map(item => item.label)).toEqual(['model', 'other'])
})

test('rejects malformed counters rather than rendering NaN or negative consumption', () => {
  const stats: UsageStats = {
    windowDays: 30,
    timeZone: 'UTC',
    generatedAtMs: Date.parse('2026-09-08'),
    history: {
      version: 1,
      trackedSinceMs: 1,
      lastRecordedAtMs: 2,
      days: { '2026-09-08': { model: { ...emptyUsage(), totalTokens: -1 } } },
    },
  }
  expect(() => summarizeUsage(stats)).toThrow('Invalid usage counters')
})
