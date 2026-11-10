import { describe, expect, it } from 'vitest'
import { normalizeTurnFileCapture } from '../../../../shared/turnFileCapture'
import type { TurnFileChangesCapture } from '../../../../shared/generated/contracts'
import { createResponseApiStreamState, emitResponseApiEvent } from '@/stream/responseApiStream'
import { reduceWorkbenchMessages } from '@wegent/chat-core'
import {
  createRuntimeTaskStreamHandlers,
  runtimeMessagesToWorkbenchMessages,
} from './runtimePaneMessages'

const capture: TurnFileChangesCapture = {
  version: 1,
  captureId: 'a'.repeat(64),
  threadId: 'thread-1',
  turnId: 'turn-1',
  attemptId: 'attempt-1',
  state: 'failed',
  base: null,
  head: null,
  limitations: ['captureFailed'],
  artifactId: null,
}

describe('capture observations are distinct from a successful task or an empty diff', () => {
  it('does not invent a successful empty capture for legacy, malformed or foreign data', () => {
    expect(normalizeTurnFileCapture(undefined)).toBeUndefined()
    expect(normalizeTurnFileCapture({ ...capture, state: 'unchanged' })).toBeUndefined()
    expect(normalizeTurnFileCapture({ ...capture, owner: 'trusted' })).toBeUndefined()
    for (const binding of [{ threadId: 'peer' }, { turnId: 'peer' }, { attemptId: 'peer' }])
      expect(normalizeTurnFileCapture(capture, binding)).toBeUndefined()
  })

  it('keeps an unsettled observation unknown without mutating the stored source', () => {
    const pending = { ...capture, state: 'capturing' as const, limitations: [] }
    expect(normalizeTurnFileCapture(pending)).toMatchObject({
      state: 'unknown',
      limitations: ['captureIncomplete'],
    })
    expect(pending.state).toBe('capturing')
  })

  it.each(['completed', 'failed', 'interrupted'])(
    'preserves failed capture through the actual terminal adapter: %s',
    terminalStatus => {
      let messages: ReturnType<typeof reduceWorkbenchMessages> = []
      const handlers = createRuntimeTaskStreamHandlers(
        { deviceId: 'local', taskId: 'task-1' },
        {
          onMessageAction: action => {
            messages = reduceWorkbenchMessages(messages, action)
          },
        }
      )
      const state = createResponseApiStreamState()
      const base = {
        taskId: 'task-1',
        deviceId: 'local',
        subtaskId: 'attempt-1',
        turnId: 'turn-1',
        attemptId: 'attempt-1',
      }
      emitResponseApiEvent(handlers, 'response.created', { ...base, data: {} }, state)
      emitResponseApiEvent(
        handlers,
        terminalStatus === 'completed' ? 'response.completed' : 'response.failed',
        {
          ...base,
          data: {
            terminalStatus,
            value: 'result',
            message: 'stopped',
            file_changes_capture: capture,
          },
        },
        state
      )
      expect(messages.at(-1)?.fileChangesCapture).toEqual(capture)
      expect(messages.at(-1)?.fileChanges).toBeUndefined()
    }
  )

  it('restores a capture from history but rejects a different attempt record', () => {
    const message = {
      id: 'history',
      role: 'assistant' as const,
      content: 'result',
      turnId: 'turn-1',
      attemptId: 'attempt-1',
      fileChangesCapture: capture,
    }
    expect(runtimeMessagesToWorkbenchMessages([message])[0].fileChangesCapture).toEqual(capture)
    expect(
      runtimeMessagesToWorkbenchMessages([{ ...message, attemptId: 'peer-attempt' }])[0]
        .fileChangesCapture
    ).toBeUndefined()
  })
})
