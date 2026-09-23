import { describe, expect, test } from 'vitest'
import { runtimeThreadId, modelSelectionFromCreateRequest } from './useWorkbenchRuntimeMessaging'

describe('runtimeThreadId', () => {
  test('uses the direct thread id from a hydrated runtime task address', () => {
    expect(
      runtimeThreadId({
        deviceId: 'local-device',
        taskId: 'task-1',
        threadId: 'thread-1',
        runtimeHandle: { modelSelection: { modelName: 'gpt-5' } },
      })
    ).toBe('thread-1')
  })

  test('falls back to the runtime handle thread id', () => {
    expect(
      runtimeThreadId({
        deviceId: 'local-device',
        taskId: 'task-1',
        runtimeHandle: { threadId: 'thread-from-handle' },
      })
    ).toBe('thread-from-handle')
  })
})


test('new follow-default conversation preserves intent in its optimistic runtime handle', () => {
  expect(modelSelectionFromCreateRequest({ teamId: 0, runtime: 'codex', message: 'first',
    modelSelectionMode: 'follow_target_default', modelOptions: { kcoderPermissionMode: 'ask' },
  })).toEqual({ modelName: '', modelType: null, options: { kcoderPermissionMode: 'ask' } })
})
