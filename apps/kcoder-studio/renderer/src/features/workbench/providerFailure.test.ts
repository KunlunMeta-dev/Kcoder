import { describe, expect, test } from 'vitest'
import { parseChatError } from '@/lib/chat-error'
import { emitResponseApiEvent, createResponseApiStreamState } from '@/stream/responseApiStream'
import {
  decodeProviderFailure,
  reduceWorkbenchMessages,
  type WorkbenchMessage,
} from '@wegent/chat-core'
import {
  createRuntimeTaskStreamHandlers,
  runtimeMessagesToWorkbenchMessages,
} from './runtimePaneMessages'

const facts = {
  category: 'invalid_parameter',
  recovery_action: 'needs_human',
  http_status: 400,
  retryable: false,
  resume_safe: false,
  retry_after_ms: 0,
} as const
describe('typed provider failure consumption', () => {
  test('rejects invalid and contradictory facts and strips arbitrary backend fields', () => {
    expect(decodeProviderFailure({ ...facts, code: 'secret', param: 'raw', nested: {} })).toEqual(
      facts
    )
    for (const value of [
      [],
      { ...facts, category: 'unknown' },
      { ...facts, retryable: 1 },
      { ...facts, http_status: -1 },
      { ...facts, http_status: 65536 },
      ...[0, 99, 1000, 65535].map(http_status => ({ ...facts, http_status })),
      { ...facts, retry_after_ms: Infinity },
      { ...facts, retry_after_ms: Number.MAX_SAFE_INTEGER + 1 },
      { ...facts, retry_after_ms: 0.5 },
      { ...facts, resume_safe: true },
      { ...facts, retryable: true },
      { ...facts, recovery_action: 'diagnose_only', resume_safe: true },
    ]) {
      expect(decodeProviderFailure(value)).toBeUndefined()
      expect(parseChatError('HTTP 401', 'quota_exceeded', value).type).toBe('authentication_error')
    }
    expect(
      decodeProviderFailure({ ...facts, http_status: null, retry_after_ms: null })
    ).toMatchObject({ http_status: null, retry_after_ms: null })
    for (const http_status of [100, 599, 999])
      expect(decodeProviderFailure({ ...facts, http_status })?.http_status).toBe(http_status)
  })
  test.each(['assistant_started', 'assistant_done', 'assistant_cancelled'] as const)(
    'clears facts on %s',
    type => {
      const failed = reduceWorkbenchMessages([], {
        type: 'assistant_error',
        subtaskId: 'turn',
        error: 'specific',
        providerFailure: facts,
      })
      const [message] = reduceWorkbenchMessages(failed, { type, subtaskId: 'turn' })
      expect(message.providerFailure).toBeUndefined()
      expect(message.error).toBeUndefined()
    }
  )
  test.each(['failed', 'error', 'Task failed with status: failed'])(
    'duplicate generic %s preserves facts with the original detailed error',
    error => {
      const failed = reduceWorkbenchMessages([], {
        type: 'assistant_error',
        subtaskId: 'turn',
        error: 'specific',
        providerFailure: facts,
      })
      const [message] = reduceWorkbenchMessages(failed, {
        type: 'assistant_error',
        subtaskId: 'turn',
        error,
      })
      expect(message).toMatchObject({ error: 'specific', providerFailure: facts })
    }
  )
  test('new typed failure replaces text and facts together and new sessions remove all old facts', () => {
    const failed = reduceWorkbenchMessages([], {
      type: 'assistant_error',
      subtaskId: 'turn',
      error: 'old',
      errorType: 'old',
      providerFailure: facts,
    })
    const nextFacts = { ...facts, category: 'forbidden' } as const
    const next = reduceWorkbenchMessages(failed, {
      type: 'assistant_error',
      subtaskId: 'turn',
      error: 'failed',
      errorType: 'new',
      providerFailure: nextFacts,
    })
    expect(next[0]).toMatchObject({ error: 'failed', errorType: 'new', providerFailure: nextFacts })
    expect(reduceWorkbenchMessages(next, { type: 'reset', messages: [] })).toEqual([])
    const other = reduceWorkbenchMessages(next, {
      type: 'assistant_started',
      subtaskId: 'another-turn',
    })
    expect(other[0]).toMatchObject({ providerFailure: nextFacts, status: 'failed' })
    expect(other[1].providerFailure).toBeUndefined()
  })
  test('structured facts beat misleading body through stream, pane and reducer', () => {
    let messages: WorkbenchMessage[] = []
    const handlers = createRuntimeTaskStreamHandlers(
      { taskId: 'task', deviceId: 'local' },
      {
        onMessageAction: action => {
          messages = reduceWorkbenchMessages(messages, action)
        },
      }
    )
    emitResponseApiEvent(
      handlers,
      'response.failed',
      {
        taskId: 'task',
        deviceId: 'local',
        subtaskId: 'turn',
        data: { message: 'HTTP 401 quota exceeded network', provider_failure: facts },
      },
      createResponseApiStreamState()
    )
    expect(messages[0]).toMatchObject({ status: 'failed', providerFailure: facts })
    expect(
      parseChatError(messages[0].error!, messages[0].errorType, messages[0].providerFailure).type
    ).toBe('invalid_parameter')
  })
  test('historical snake and camel fields reach classification', () => {
    for (const key of ['providerFailure', 'provider_failure']) {
      const [message] = runtimeMessagesToWorkbenchMessages([
        {
          id: 'a',
          role: 'assistant',
          content: '',
          status: 'failed',
          error: 'HTTP 401',
          [key]: facts,
        },
      ])
      expect(message).toMatchObject({ providerFailure: facts })
      expect(parseChatError(message.error!, message.errorType, message.providerFailure).type).toBe(
        'invalid_parameter'
      )
    }
  })
})
