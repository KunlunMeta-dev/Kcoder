import { expect, test } from 'vitest'
import type { UnifiedModel } from '@/types/api'
import { evolutionFailureKind } from './evolutionApi'
import {
  DEFAULT_EVAL,
  advancedDraft,
  applyAdvanced,
  restoreAdvancedDefaults,
  configuredModelOptions,
  defaultEvolutionSettings,
  isModelMissing,
  itemEnabled,
  modelRefValue,
  parseModelRefValue,
  validateAdvanced,
  withTarget,
} from './evolutionSettingsModel'
import { decisionLabelKey, inventoryTargetKey, proposalDecisions } from './evolutionTargetModel'

test('model references round-trip case-preserving and placeholders are not configured models', () => {
  const ref = { provider: 'Azure:East', model: 'GPT-5.1-Mini' }
  expect(parseModelRefValue(modelRefValue(ref))).toEqual(ref)
  expect(parseModelRefValue('follow_session')).toBeNull()
  const models = [
    { name: 'a', type: 'runtime', modelId: 'M1', config: { codexProviderId: 'P' } },
    { name: 'b', type: 'runtime', modelId: null, config: { codexProviderId: 'P' } },
    { name: 'c', type: 'runtime', modelId: 'M1', config: { codexProviderId: 'P' } },
    { name: 'd', type: 'runtime', modelId: 'M2', compatibilityDisabled: true, config: { codexProviderId: 'Q' } },
  ] as UnifiedModel[]
  const options = configuredModelOptions(models)
  expect(options.map(option => [option.ref, option.available])).toEqual([
    [{ provider: 'P', model: 'M1' }, true],
    [{ provider: 'Q', model: 'M2' }, false],
  ])
  expect(isModelMissing(null, options)).toBe(false)
  expect(isModelMissing({ provider: 'P', model: 'M1' }, options)).toBe(false)
  expect(isModelMissing({ provider: 'p', model: 'm1' }, options)).toBe(true)
  expect(isModelMissing({ provider: 'Q', model: 'M2' }, options)).toBe(true)
})

test('advanced validation covers ranges, ordering and the optional limit', () => {
  const draft = advancedDraft(defaultEvolutionSettings())
  expect(validateAdvanced(draft)).toEqual({})
  expect(validateAdvanced({ ...draft, candidate_traffic: '0' })).toEqual({ candidate_traffic: 'range_traffic' })
  expect(validateAdvanced({ ...draft, promote_threshold: 'abc' })).toEqual({ promote_threshold: 'range_fraction' })
  expect(validateAdvanced({ ...draft, rollback_threshold: '0.8' })).toEqual({
    rollback_threshold: 'rollback_not_below',
  })
  expect(validateAdvanced({ ...draft, monthly_max_tokens: '1.5' })).toEqual({
    monthly_max_tokens: 'positive_integer',
  })
  expect(validateAdvanced({ ...draft, monthly_max_tokens: '' })).toEqual({})
})

test('evaluation thresholds validate UI ranges and stay absent for older targets', () => {
  const draft = advancedDraft(defaultEvolutionSettings())
  expect(draft.win_rate).toBe('0.6')
  expect(validateAdvanced({ ...draft, win_rate: '0.4' })).toEqual({ win_rate: 'range_win_rate' })
  expect(validateAdvanced({ ...draft, win_rate: '1' })).toEqual({})
  expect(validateAdvanced({ ...draft, max_diversity_drop: '0.6' })).toEqual({
    max_diversity_drop: 'range_diversity_drop',
  })
  const legacy = { ...defaultEvolutionSettings() }
  delete legacy.eval
  expect(applyAdvanced(legacy, advancedDraft(legacy))).not.toHaveProperty('eval')
  expect(restoreAdvancedDefaults(legacy)).not.toHaveProperty('eval')
  expect(applyAdvanced(legacy, { ...advancedDraft(legacy), win_rate: '0.7' }).eval).toEqual({
    win_rate: 0.7,
    max_diversity_drop: 0.1,
  })
  const tuned = { ...defaultEvolutionSettings(), eval: { win_rate: 0.9, max_diversity_drop: 0.3 } }
  expect(restoreAdvancedDefaults(tuned).eval).toEqual(DEFAULT_EVAL)
})

test('item scope semantics and target keys', () => {
  const settings = defaultEvolutionSettings()
  expect(itemEnabled(settings, 'skill', 'skill:user:x')).toBe(true)
  const selected = withTarget(settings, 'skill', { scope: 'selected' })
  expect(itemEnabled(selected, 'skill', 'skill:user:x')).toBe(false)
  expect(inventoryTargetKey({ targetKey: null })).toBeNull()
  expect(inventoryTargetKey({ targetKey: 'skill:bundled:docx' })).toBe('skill:bundled:docx')
  const decisions = (state: 'draft' | 'evaluated' | 'canary' | 'promoted' | 'rolled_back' | 'rejected') =>
    proposalDecisions({ id: '1', state, createdAt: '', actor: 'auto', diff: '' })
  expect(decisions('draft')).toEqual(['accept', 'reject'])
  expect(decisions('evaluated')).toEqual(['accept', 'reject'])
  expect(decisions('canary')).toEqual(['accept', 'reject', 'pin_stable'])
  expect(decisions('promoted')).toEqual(['rollback'])
  expect(decisions('rolled_back')).toEqual([])
  expect(decisions('rejected')).toEqual([])
  const proposal = (state: 'evaluated' | 'canary') => ({ id: '1', state, createdAt: '', actor: 'auto' as const, diff: '' })
  expect(decisionLabelKey(proposal('evaluated'), 'accept')).toBe('approve')
  expect(decisionLabelKey(proposal('canary'), 'accept')).toBe('promote')
  expect(decisionLabelKey(proposal('canary'), 'pin_stable')).toBe('pin_stable')
})

test('classifies contract errors and unknown write outcomes', () => {
  expect(evolutionFailureKind({ data: { kind: 'evolution_revision_conflict' } }, true)).toBe('conflict')
  expect(evolutionFailureKind({ message: 'evolution_content_too_large: 70 KiB' })).toBe('too_large')
  expect(evolutionFailureKind({ data: { kind: 'evolution_unsupported' } })).toBe('unsupported')
  expect(evolutionFailureKind({ reason: 'timeout' }, true)).toBe('unconfirmed')
  expect(evolutionFailureKind({ reason: 'remote' }, true)).toBe('unavailable')
})
