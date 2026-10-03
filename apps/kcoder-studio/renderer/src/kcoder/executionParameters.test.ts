import { describe, expect, test } from 'vitest'
import {
  executionReasoningEffort,
  executionSelectedModel,
  executionServiceTier,
} from './executionParameters'

describe('shared execution parameters', () => {
  test('prefers model reasoning and falls back for absent or malformed values', () => {
    expect(
      executionReasoningEffort({
        model_config: { reasoning: { effort: 'high' } },
        reasoning_config: { effort: 'low' },
      })
    ).toBe('high')
    expect(
      executionReasoningEffort({ model_config: [], reasoning_config: { effort: 'low' } })
    ).toBe('low')
    expect(executionReasoningEffort({ model_config: { reasoning: { effort: ' ' } } })).toBeNull()
    expect(executionReasoningEffort({})).toBeNull()
  })

  test('retains nonblank strings verbatim and rejects malformed service tiers', () => {
    expect(executionServiceTier({ model_config: { service_tier: ' priority ' } })).toBe(
      ' priority '
    )
    for (const service_tier of [null, 3, {}, [], ' ']) {
      expect(executionServiceTier({ model_config: { service_tier } })).toBeNull()
    }
  })

  test('qualifies selected models while preserving existing qualified selectors', () => {
    expect(
      executionSelectedModel(
        { model_config: { model_id: 'm', model_provider: 'fallback' } },
        { providerId: 'preferred', modelName: 'other' }
      )
    ).toBe('preferred::m')
    expect(
      executionSelectedModel({ model_config: { model_id: 'original::m' } }, { providerId: 'other' })
    ).toBe('original::m')
    expect(
      executionSelectedModel({}, { modelName: 'm', options: { codexProviderId: 'legacy' } })
    ).toBe('legacy::m')
    expect(
      executionSelectedModel({}, { modelName: 'm', options: { codex_model_provider: 'legacy' } })
    ).toBe('legacy::m')
    expect(executionSelectedModel({ model_config: { modelProvider: 'fallback' } }, {})).toBe(
      'fallback'
    )
    expect(executionSelectedModel({}, { modelName: 'm' })).toBe('m')
    expect(executionSelectedModel({}, {})).toBeNull()
  })
})
