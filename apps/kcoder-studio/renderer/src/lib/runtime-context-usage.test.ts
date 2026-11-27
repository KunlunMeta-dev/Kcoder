import { describe, expect, test } from 'vitest'
import { runtimeContextUsageMetrics } from './runtime-context-usage'

describe('runtimeContextUsageMetrics', () => {
  test('uses latest request usage instead of cumulative thread usage', () => {
    expect(
      runtimeContextUsageMetrics({
        total: {
          totalTokens: 17_200_000,
          inputTokens: 17_000_000,
          cachedInputTokens: 0,
          outputTokens: 200_000,
          reasoningOutputTokens: 0,
        },
        last: {
          totalTokens: 8_000,
          inputTokens: 7_000,
          cachedInputTokens: 1_000,
          outputTokens: 1_000,
          reasoningOutputTokens: 0,
        },
        modelContextWindow: 258_400,
      })
    ).toEqual({
      usedTokens: 8_000,
      totalTokens: 258_400,
      usedPercent: 3,
      remainingPercent: 97,
    })
  })

  test.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('hides invalid latest usage %s instead of showing cumulative usage', totalTokens => {
    expect(
      runtimeContextUsageMetrics({
        total: {
          totalTokens: 15_000,
          inputTokens: 12_000,
          cachedInputTokens: 2_000,
          outputTokens: 3_000,
          reasoningOutputTokens: 0,
        },
        last: {
          totalTokens,
          inputTokens: 0,
          cachedInputTokens: 0,
          outputTokens: 0,
          reasoningOutputTokens: 0,
        },
        modelContextWindow: 258_400,
      })
    ).toBeNull()
  })
})
