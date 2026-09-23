import { describe, expect, test } from 'vitest'
import type { WorkbenchMessage } from '@/types/workbench'
import {
  filterBufferedTranscriptActions,
  reconcileRuntimeConversationMessages,
  requestUserInputAnswerScopeKey,
  transcriptSettlesLatestSeededTurn,
} from './useWorkbenchPaneSession'

function message(overrides: Partial<WorkbenchMessage>): WorkbenchMessage {
  return {
    id: 'message',
    role: 'assistant',
    content: '',
    status: 'done',
    createdAt: '2026-07-24T00:00:00.000Z',
    ...overrides,
  }
}

describe('reconcileRuntimeConversationMessages', () => {
  test('uses a settled server transcript instead of stale streaming cache state', () => {
    const transcript = [message({ id: 'server', content: 'Complete response' })]
    const cached = [
      message({
        id: 'cached',
        content: 'Complete response with stale streaming metadata',
        status: 'streaming',
      }),
    ]

    expect(reconcileRuntimeConversationMessages(transcript, cached, false)).toBe(transcript)
  })

  test('keeps richer live state while the server still reports the task running', () => {
    const transcript = [message({ id: 'server', content: 'Partial', status: 'streaming' })]
    const cached = [
      message({
        id: 'cached',
        content: 'Partial response from the live stream',
        status: 'streaming',
      }),
    ]

    expect(reconcileRuntimeConversationMessages(transcript, cached, true)).toBe(cached)
  })
})

describe('filterBufferedTranscriptActions', () => {
  test('does not replay a completed turn text stream already present in the transcript', () => {
    const transcript = [
      message({
        id: 'persisted-assistant',
        turnId: 'turn-1',
        subtaskId: 'thread-1:history:1',
        content: 'Complete response',
      }),
    ]
    const buffered = [
      { type: 'assistant_started' as const, subtaskId: 'turn-1' },
      { type: 'assistant_chunk' as const, subtaskId: 'turn-1', content: 'Complete response' },
      { type: 'assistant_done' as const, subtaskId: 'turn-1', content: 'Complete response' },
      {
        type: 'block_updated' as const,
        subtaskId: 'turn-1',
        blockId: 'background-agent-1',
        updates: { status: 'done' as const },
      },
    ]

    expect(filterBufferedTranscriptActions(transcript, buffered)).toEqual([buffered[3]])
  })

  test('replays the live stream when the transcript has not settled that turn', () => {
    const transcript = [
      message({ id: 'persisted-assistant', turnId: 'older-turn', content: 'Older response' }),
    ]
    const buffered = [
      { type: 'assistant_started' as const, subtaskId: 'turn-1' },
      { type: 'assistant_done' as const, subtaskId: 'turn-1', content: 'Current response' },
    ]

    expect(filterBufferedTranscriptActions(transcript, buffered)).toEqual(buffered)
  })
})

describe('transcriptSettlesLatestSeededTurn', () => {
  test('does not settle a live turn from an older turn with duplicate user content', () => {
    const transcript = [
      message({ id: 'older-user', role: 'user', content: 'Continue' }),
      message({ id: 'older-assistant', content: 'Older completed response' }),
    ]
    const seeded = [message({ id: 'live-user', role: 'user', content: 'Continue' })]

    expect(transcriptSettlesLatestSeededTurn(transcript, seeded)).toBe(false)
  })

  test('settles the seeded turn only after its client message id appears', () => {
    const seeded = [message({ id: 'live-user', role: 'user', content: 'Continue' })]
    const transcript = [
      message({ id: 'live-user', role: 'user', content: 'Continue' }),
      message({ id: 'live-assistant', content: 'Current completed response' }),
    ]

    expect(transcriptSettlesLatestSeededTurn(transcript, seeded)).toBe(true)
  })
})

describe('requestUserInputAnswerScopeKey', () => {
  test('keeps answered questions scoped to the task while its workspace is canonicalized', () => {
    const before = {
      key: 'device-1:/requested/path:task-1',
      identityKey: 'device-1:task-1',
      address: {
        deviceId: 'device-1',
        workspacePath: '/requested/path',
        taskId: 'task-1',
      },
    }
    const after = {
      ...before,
      key: 'device-1:/canonical/path:task-1',
      address: { ...before.address, workspacePath: '/canonical/path' },
    }
    const afterDeviceCanonicalization = {
      ...after,
      key: 'canonical-device:/canonical/path:task-1',
      identityKey: 'canonical-device:task-1',
      address: { ...after.address, deviceId: 'canonical-device' },
    }

    expect(requestUserInputAnswerScopeKey(before)).toBe(requestUserInputAnswerScopeKey(after))
    expect(requestUserInputAnswerScopeKey(before)).toBe(
      requestUserInputAnswerScopeKey(afterDeviceCanonicalization)
    )
    expect(
      requestUserInputAnswerScopeKey({
        ...after,
        identityKey: 'device-1:task-2',
        address: { ...after.address, taskId: 'task-2' },
      })
    ).not.toBe(requestUserInputAnswerScopeKey(after))
  })
})

test('an old cancelled user turn cannot settle a newer streaming turn after reopening', () => {
  const oldUser = message({ id: 'user-1', role: 'user', turnId: 'turn-1', content: 'old' })
  const oldFailure = message({ id: 'failure-1', turnId: 'turn-1', status: 'cancelled' })
  const newStream = message({
    id: 'stream-2',
    subtaskId: 'turn-2',
    status: 'streaming',
    content: 'new live text',
  })
  expect(
    transcriptSettlesLatestSeededTurn([oldUser, oldFailure], [oldUser, oldFailure, newStream])
  ).toBe(false)
  expect(
    transcriptSettlesLatestSeededTurn(
      [oldUser, oldFailure, message({ id: 'done-2', turnId: 'turn-2', status: 'done' })],
      [oldUser, oldFailure, newStream]
    )
  ).toBe(true)
})

test('a running snapshot cannot be settled by historical cancelled output', () => {
  const user = message({ id: 'user-1', role: 'user', turnId: 'turn-1' })
  const cancelled = message({ id: 'cancelled-1', turnId: 'turn-1', status: 'cancelled' })
  expect(transcriptSettlesLatestSeededTurn([user, cancelled], [user, cancelled], true)).toBe(false)
})
