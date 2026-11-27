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

it.each([
  { name: 'duplicate selections', answers: { item: { selectedOptionIds: ['option', 'option'] } } },
  { name: 'oversized text', answers: { item: { text: '界'.repeat(5500) } } },
])('$name cannot consume the refresh needed to display the saved peer answer', async ({ answers }) => {
  const address = { taskId: 'task', deviceId: 'target', threadId: 'thread' }
  const task = { taskId: 'task', serverId: 'target', threadId: 'thread' }
  const client = { supportsExperimental: () => true }
  const runtime = {
    disposed: false, appServerDisconnectedClients: new WeakSet(),
    tasks: new Map([['task', task]]), taskByThread: new Map([['target\0thread', 'task']]),
    threadKey: (target: string, thread: string) => `${target}\0${thread}`,
    clientByTask: new Map([['task', client]]), notificationReplayGuard: new NotificationReplayGuard(),
    forwardAcceptedNotification,
  } as unknown as GatewayRuntimeCore
  let durable: AsyncQuestionRecord = {
    questionId: 'question', requestId: 'request', threadId: 'thread', sourceTurnId: 'source',
    toolCallId: 'tool', revision: 1, createdAtMs: 1, status: 'pending',
    questions: [{ id: 'item', header: 'Mode', question: 'Which mode?', multiSelect: false,
      options: [{ id: 'option', label: 'Original option', description: '' }] }],
  }
  bridge.request.mockImplementation(async command => command === 'runtime.asyncQuestion.supports'
    ? { supported: true, threadId: 'thread' } : { threadId: 'thread', questions: [durable] })
  const notify = (answer: unknown) => forwardNotification.call(runtime, 'asyncQuestion/changed', {
    threadId: 'thread', serverId: 'native', sequence: 42,
    question: { threadId: 'thread', questionId: 'question', revision: 2, status: 'queued', answer },
  }, 'target', client as never)
  const reads = () => bridge.request.mock.calls.filter(([, params]) => params.method === 'asyncQuestion/list').length
  render(<><AsyncQuestionPanel address={address} /><input data-testid="composer" /></>)
  const user = userEvent.setup()
  await user.click(await screen.findByTestId('async-question-toggle'))
  await user.type(screen.getByTestId('request-user-input-custom-item'), 'Keep the original draft')
  const before = reads()
  await act(async () => notify({ submissionId: 'peer', acceptedAtMs: 2, answers }))
  expect(reads()).toBe(before)
  expect(screen.getByTestId('request-user-input-custom-item')).toHaveValue('Keep the original draft')
  expect(screen.getByTestId('request-user-input-submit-button')).toBeEnabled()
  expect(screen.getByTestId('composer')).toBeEnabled()
  const answer = { submissionId: 'peer', acceptedAtMs: 2,
    answers: { item: { selectedOptionIds: [], text: 'Authoritative peer answer' } } }
  durable = { ...durable, revision: 2, status: 'queued', answer }
  await act(async () => notify(answer))
  await waitFor(() => expect(screen.getByTestId('async-question-card-question')).toHaveAttribute('data-status', 'queued'))
  expect(screen.getByTestId('async-question-authoritative-answer-question')).toHaveTextContent('Authoritative peer answer')
  expect(screen.getByTestId('async-question-continue-delivery-question')).toBeEnabled()
  expect(reads()).toBe(before + 1)
  await act(async () => notify(answer))
  expect(reads()).toBe(before + 1)
  expect(bridge.request.mock.calls.every(([, params]) => params.method !== 'asyncQuestion/answer')).toBe(true)
})
