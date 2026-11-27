import '@/i18n'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import type { LocalExecutorEvent } from '@/host/localExecutor'
import { NotificationReplayGuard } from '@/kcoder/notificationReplayGuard'
import type { GatewayRuntimeCore } from '@/kcoder/gateway/runtime/core'
import { forwardAcceptedNotification, forwardNotification } from '@/kcoder/gateway/runtime/notifications'
import type { AsyncQuestionRecord } from '../../../../shared/generated/contracts'
import { AsyncQuestionPanel } from './AsyncQuestionPanel'

const bridge = vi.hoisted(() => ({ request: vi.fn(), listeners: new Set<(event: LocalExecutorEvent) => void>() }))
vi.mock('@/host/localExecutor', () => ({
  requestLocalExecutor: bridge.request,
  subscribeLocalExecutorEvents: async (listener: (event: LocalExecutorEvent) => void) => {
    bridge.listeners.add(listener)
    return () => { bridge.listeners.delete(listener) }
  },
}))
vi.mock('@/kcoder/gatewayServiceBridge', () => ({
  emitRuntimeEvent: async (_name: string, event: LocalExecutorEvent) => {
    for (const listener of bridge.listeners) listener(event)
  },
}))
beforeEach(() => { bridge.request.mockReset(); bridge.listeners.clear() })

function notifications() {
  const task = { taskId: 'task', serverId: 'target', threadId: 'thread' }
  const client = { supportsExperimental: () => true }
  const runtime = {
    disposed: false, appServerDisconnectedClients: new WeakSet(),
    tasks: new Map([['task', task]]), taskByThread: new Map([['target\0thread', 'task']]),
    threadKey: (target: string, thread: string) => `${target}\0${thread}`,
    clientByTask: new Map([['task', client]]), notificationReplayGuard: new NotificationReplayGuard(),
    forwardAcceptedNotification,
  } as unknown as GatewayRuntimeCore
  return (metadata: Record<string, unknown>) => forwardNotification.call(runtime, 'asyncQuestion/changed', {
    threadId: 'thread', serverId: 'native', sequence: 42,
    question: { threadId: 'thread', questionId: 'question', revision: 2, ...metadata },
  }, 'target', client as never)
}

it.each([
  { name: 'impossible pending revision', fields: { status: 'pending' } },
  { name: 'unknown record field', fields: { status: 'queued', unexpected: 'invalid snapshot' } },
  { name: 'non-string error', fields: { status: 'delivery_unknown', revision: 3, deliveryError: false } },
  { name: 'UTF-8 error overflow', fields: { status: 'delivery_unknown', revision: 3, deliveryError: '界'.repeat(683) } },
  { name: 'escaped error overflow', fields: { status: 'delivery_unknown', revision: 3, deliveryError: '\n'.repeat(1024) } },
  { name: 'invalid Unicode error', fields: { status: 'delivery_unknown', revision: 3, deliveryError: 'error\ud800' } },
  { name: 'error on queued state', fields: { status: 'queued', deliveryError: 'Old failure' } },
  { name: 'negative creation time', fields: { createdAtMs: -1 } },
  { name: 'fractional creation time', fields: { createdAtMs: 1.5 } },
  { name: 'non-numeric creation time', fields: { createdAtMs: '1' } },
  { name: 'unsafe creation time', fields: { createdAtMs: Number.MAX_SAFE_INTEGER + 1 } },
])('a legacy hint with $name cannot strand the original card after a failed refresh', async ({ fields }) => {
  const address = { taskId: 'task', deviceId: 'target', threadId: 'thread' }
  const notify = notifications()
  let durable: AsyncQuestionRecord = {
    questionId: 'question', requestId: 'request', threadId: 'thread', sourceTurnId: 'source',
    toolCallId: 'tool', revision: 1, createdAtMs: 1, status: 'pending',
    questions: [{ id: 'item', header: 'Note', question: 'Any details?', multiSelect: false, options: [] }],
  }
  let failRead = false
  bridge.request.mockImplementation(async command => {
    if (command === 'runtime.asyncQuestion.supports') return { supported: true, threadId: 'thread' }
    if (failRead) throw new Error('Original task read unavailable')
    return { threadId: 'thread', questions: [durable] }
  })
  const reads = () => bridge.request.mock.calls.filter(([, params]) => params.method === 'asyncQuestion/list').length
  render(<><AsyncQuestionPanel address={address} /><input data-testid="composer" /></>)
  const user = userEvent.setup()
  await user.click(await screen.findByTestId('async-question-toggle'))
  await user.type(screen.getByTestId('request-user-input-custom-item'), 'Retain my draft')
  const before = reads()
  failRead = true
  await act(async () => notify(fields))
  expect.soft(reads()).toBe(before)
  expect.soft(screen.getByTestId('request-user-input-submit-button')).toBeEnabled()
  expect(screen.getByTestId('request-user-input-custom-item')).toHaveValue('Retain my draft')
  expect(screen.getByTestId('composer')).toBeEnabled()

  durable = { ...durable, revision: 2, status: 'queued', answer: {
    submissionId: 'peer', acceptedAtMs: 2, answers: { item: { text: 'Saved peer answer' } },
  } }
  failRead = false
  await act(async () => notify({ status: 'queued' }))
  await waitFor(() => expect(screen.getByTestId('async-question-card-question')).toHaveAttribute('data-status', 'queued'))
  expect(screen.getByTestId('async-question-authoritative-answer-question')).toHaveTextContent('Saved peer answer')
  expect(reads()).toBe(before + 1)
  await act(async () => notify({ status: 'queued' }))
  expect(reads()).toBe(before + 1)
  expect(bridge.request.mock.calls.every(([, params]) => params.method !== 'asyncQuestion/answer')).toBe(true)
})

it.each([
  { name: 'omitted error', fields: { revision: 1, status: 'pending' } },
  { name: 'null error', fields: { revision: 1, status: 'pending', deliveryError: null } },
  { name: 'omitted legacy state', fields: { revision: 3, deliveryError: 'Read the original task' } },
  { name: 'failed delivery', fields: { revision: 3, status: 'delivery_failed', deliveryError: 'Admission rejected' } },
  { name: 'unknown delivery', fields: { revision: 3, status: 'delivery_unknown', deliveryError: 'Receipt unavailable' } },
  { name: 'exact ASCII limit', fields: { revision: 3, status: 'delivery_failed', deliveryError: 'x'.repeat(2046) } },
  { name: 'exact escaped limit', fields: { revision: 3, status: 'delivery_unknown', deliveryError: '\n'.repeat(1023) } },
  { name: 'exact UTF-8 limit', fields: { revision: 3, status: 'delivery_unknown', deliveryError: '界'.repeat(682) } },
  { name: 'zero creation time', fields: { createdAtMs: 0 } },
  { name: 'maximum safe creation time', fields: { createdAtMs: Number.MAX_SAFE_INTEGER } },
])('a valid legacy $name still refreshes once', async ({ fields }) => {
  const listener = vi.fn()
  bridge.listeners.add(listener)
  const notify = notifications()
  await notify(fields)
  await notify(fields)
  expect(listener).toHaveBeenCalledExactlyOnceWith({
    event: 'async-question:changed', payload: {
      taskId: 'task', serverId: 'target', threadId: 'thread', questionId: 'question', revision: fields.revision ?? 2,
    },
  })
})
