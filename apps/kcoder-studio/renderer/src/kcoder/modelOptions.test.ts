import { expect, test } from 'vitest'
import { normalizeRuntimeModelOptions, runtimeModelOptions } from './modelOptions'
import type { UnifiedModel } from '@/types/api'

const model: UnifiedModel = { name: 'gpt-5.5', modelId: 'gpt-5.5', type: 'public' }

test('normalizing provider controls preserves an explicit runtime permission choice', () => {
  for (const mode of ['ask', 'auto', 'accept_edits', 'dont_ask', 'bypass', 'yolo', 'default']) {
    expect(normalizeRuntimeModelOptions(model, { kcoderPermissionMode: mode })).toMatchObject({
      kcoderPermissionMode: mode,
    })
    expect(normalizeRuntimeModelOptions(null, { kcoderPermissionMode: mode })).toEqual({
      kcoderPermissionMode: mode,
    })
  }
})

test('runtime option carryover does not copy provider tuning or accept unknown permission modes', () => {
  expect(
    runtimeModelOptions({ kcoderPermissionMode: 'ask', reasoning: 'high', speed: 'fast' })
  ).toEqual({ kcoderPermissionMode: 'ask' })
  expect(runtimeModelOptions({ kcoderPermissionMode: 'unknown' })).toEqual({})
  expect(runtimeModelOptions({})).toEqual({})
})
