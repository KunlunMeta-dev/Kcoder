import { expect, test } from 'vitest'
import { MODEL_SELECTION_MODE_CAPABILITY, modelSelectionModeParams } from './modelSelectionMode'

const supported = { supportsExperimental: (name: string) => name === MODEL_SELECTION_MODE_CAPABILITY }
test('legacy calls omit the field even with an old server', () => {
  expect(modelSelectionModeParams(undefined, {}, 'vendor::model')).toEqual({})
})
test('following default is explicit and requires negotiated support', () => {
  expect(modelSelectionModeParams('follow_target_default', supported, undefined)).toEqual({ modelSelectionMode: 'follow_target_default' })
  expect(() => modelSelectionModeParams('follow_target_default', {}, undefined)).toThrow('does not support')
})
test('explicit selections preserve qualified identities', () => {
  expect(modelSelectionModeParams('explicit', supported, 'vendor::shared')).toEqual({ modelSelectionMode: 'explicit' })
  expect(() => modelSelectionModeParams('explicit', supported, ' ')).toThrow('nonempty')
})
test('conflicting selection and continuation are rejected', () => {
  expect(() => modelSelectionModeParams('follow_target_default', supported, 'vendor::model')).toThrow('cannot include model')
  expect(() => modelSelectionModeParams('follow_target_default', supported, undefined, 'turn-1')).toThrow('continuation')
  expect(() => modelSelectionModeParams('default', supported, undefined)).toThrow('Invalid')
})

test('thread projection keeps follow intent separate from its resolved model', async () => {
  const { threadModelSelectionMode } = await import('./modelSelectionMode')
  expect(threadModelSelectionMode({ model: 'vendor::model', modelSelectionMode: 'follow_target_default' })).toBe('follow_target_default')
  expect(threadModelSelectionMode({ model: 'vendor::model' })).toBeUndefined()
  expect(() => threadModelSelectionMode({ modelSelectionMode: 'default' })).toThrow('Invalid')
})

test('resume projects authoritative selection without treating legacy absence as a reset', async () => {
  const { applyThreadModelSelection } = await import('./modelSelectionMode')
  const task: { model?: string; modelSelectionMode?: 'explicit' | 'follow_target_default' } = { model: 'stale::model', modelSelectionMode: 'explicit' }
  applyThreadModelSelection(task, { modelSelectionMode: 'follow_target_default', selectedModel: 'current::model' })
  expect(task).toEqual({ model: 'current::model', modelSelectionMode: 'follow_target_default' })
  applyThreadModelSelection(task, { model: 'legacy-label' })
  expect(task.modelSelectionMode).toBe('follow_target_default')
  expect(() => applyThreadModelSelection(task, { modelSelectionMode: 'explicit', selectedModel: 123 })).toThrow('Invalid')
  expect(task.modelSelectionMode).toBe('follow_target_default')
})
