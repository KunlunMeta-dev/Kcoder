import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { TaskPendingInteractions } from './TaskPendingInteractions'
import { captureTaskInteraction, readTaskInteractions, respondTaskInteraction } from '@/kcoder/gateway/runtime/taskInteractions'
import { respondToTaskQuestion } from '@/kcoder/gateway/runtime/interactions'
import { forwardAcceptedNotification } from '@/kcoder/gateway/runtime/notifications'
import type { GatewayRuntimeCore } from '@/kcoder/gateway/runtime/core'

const f = vi.hoisted(() => ({ request: vi.fn(), current: () => true }))
vi.mock('@/host/localExecutor', () => ({ requestLocalExecutor: f.request }))
vi.mock('@/kcoder/gatewayServiceBridge', () => ({ emitRuntimeEvent: vi.fn(async () => {}) }))
const t = (key: string) => key
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t }) }))
vi.mock('@/kcoder/usePluginTargetScope', () => ({
  usePluginTargetScope: () => ({ key: 'original-owner', isCurrent: f.current }),
}))

afterEach(() => { cleanup(); f.request.mockReset() })

async function fixture() {
  const taskId = 'task', requestId = 2000001
  const frame = { serverId: 'native', threadId: 'thread', turnId: 'turn', appServerEpoch: 'epoch' }
  const address = { deviceId: 'target', taskId, threadId: frame.threadId, workspacePath: '/owned' }
  const client = { supportsExperimental: () => true, respond: vi.fn(),
    request: vi.fn(async (_method: string, selector: object) => ({ ...selector, status: 'pending' })),
  }
  const pending = { client, taskId, requestId, turnId: frame.turnId, appServerEpoch: frame.appServerEpoch,
    questionId: 'question', block: { id: 'block' },
    renderPayload: { questions: [{ id: 'choice', header: 'Sources', question: 'Which sources?',
      isOther: true, multiSelect: true, options: [{ label: 'Original source', description: '' }] }] },
  }
  const task = { taskId, serverId: address.deviceId, threadId: frame.threadId, workspacePath: address.workspacePath,
    runtimeHandle: { memoryTaskSnapshot: { ...frame, attemptId: 'attempt', serverInstanceId: frame.serverId } } }
  const server = { id: address.deviceId, transport: 'local', command: '/owned/kcoder', workspacePath: '/owned' }
  const core = { disposed: false, tasks: new Map([[taskId, task]]), clientByTask: new Map([[taskId, client]]),
    threadByTask: new Map([[taskId, frame.threadId]]), appServerDisconnectedClients: new WeakSet(),
    taskByThread: new Map([[`${address.deviceId}:${frame.threadId}`, taskId]]),
    threadKey: (targetId: string, threadId: string) => `${targetId}:${threadId}`,
    activeTurnByTask: new Map([[taskId, { turnId: frame.turnId }]]),
    turnAttemptIds: new Map([[`${taskId}:${frame.turnId}`, 'attempt']]),
    pendingQuestionByKey: new Map([[`${taskId}\0${requestId}`, pending]]),
    taskDescriptor: async () => ({ taskId, task, server }), serverForParams: async () => server,
    assertCommandTarget: async () => {},
    respondToTaskQuestion: (id: string, response: Record<string, unknown>, expected: never) =>
      respondToTaskQuestion.call(core, id, response, expected),
  } as unknown as GatewayRuntimeCore
  await captureTaskInteraction(core, client as never, taskId, frame, requestId)
  f.request.mockImplementation((method, params) => method.endsWith('.read')
    ? readTaskInteractions(core, params) : respondTaskInteraction(core, params))
  render(<TaskPendingInteractions address={address} />)
  await screen.findByTestId('request-user-input-card')
  const submit = () => {
    fireEvent.click(screen.getByTestId('request-user-input-option-choice-0'))
    fireEvent.click(screen.getByTestId('request-user-input-submit-button'))
  }
  const reject = () => act(async () => {
    await forwardAcceptedNotification.call(core, 'gateway/interaction/replyRejected', {
      ...frame, requestId, questionId: 'question', reason: 'invalid_response',
    }, address.deviceId, client as never)
  })
  const refresh = () => fireEvent.click(screen.getByRole('button', { name: 'refresh' }))
  return { core, client, pending, submit, reject, refresh, request: f.request }
}

test('an original Gateway rejection and a fresh native pending read reopen the task-space card without replay', async () => {
  const f = await fixture()
  const originalCard = screen.getByTestId('request-user-input-card')
  fireEvent.change(screen.getByTestId('request-user-input-custom-choice'), {
    target: { value: 'Keep the original freeform answer' },
  })
  f.submit()
  await screen.findByText('states.response_pending')
  // Native pending alone cannot reopen a response still awaiting confirmation.
  f.refresh()
  await waitFor(() => expect(f.client.request).toHaveBeenCalledTimes(3))
  expect(screen.getByTestId('request-user-input-card')).not.toBeVisible()
  await f.reject()
  expect(f.pending).toMatchObject({ responsePending: false })
  f.refresh()
  await waitFor(() => expect(screen.getByTestId('request-user-input-card')).toBeVisible())
  expect(screen.getByTestId('request-user-input-card')).toBe(originalCard)
  expect(screen.getByTestId('request-user-input-option-choice-0')).toHaveAttribute('aria-pressed', 'true')
  expect(screen.getByTestId('request-user-input-custom-choice')).toHaveValue('Keep the original freeform answer')
  expect(f.client.respond).toHaveBeenCalledOnce()
  fireEvent.click(screen.getByTestId('request-user-input-submit-button'))
  await waitFor(() => expect(f.client.respond).toHaveBeenCalledTimes(2))
  expect(f.client.respond.mock.calls[1][1]).toMatchObject({
    answers: { choice: { answers: ['Original source', 'Keep the original freeform answer'] } },
  })
})

test('a native pending snapshot started before answer completion cannot reopen its card', async () => {
  const f = await fixture()
  let release!: () => void
  const originalRead = readTaskInteractions(f.core, { address: {
    deviceId: 'target', taskId: 'task', threadId: 'thread', workspacePath: '/owned',
  } })
  const beforeAnswer = await originalRead
  f.request.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve(beforeAnswer) }))
  f.refresh()
  await waitFor(() => expect(release).toBeTypeOf('function'))
  f.submit()
  await screen.findByText('states.response_pending')
  await act(async () => release())
  expect(screen.getByTestId('request-user-input-card')).not.toBeVisible()
  expect(f.client.respond).toHaveBeenCalledOnce()
})

test('a pending snapshot read during an unsettled response cannot release its submit guard', async () => {
  const f = await fixture()
  const beforeAnswer = await readTaskInteractions(f.core, { address: {
    deviceId: 'target', taskId: 'task', threadId: 'thread', workspacePath: '/owned',
  } })
  let finish!: () => void
  const respond = f.core.respondToTaskQuestion
  f.core.respondToTaskQuestion = async (...args) => {
    const result = await respond(...args)
    await new Promise<void>(resolve => { finish = resolve })
    return result
  }
  f.submit()
  await waitFor(() => expect(finish).toBeTypeOf('function'))
  f.request.mockResolvedValueOnce(beforeAnswer)
  f.refresh()
  await waitFor(() => expect(f.request.mock.calls.filter(([method]) => method.endsWith('.read'))).toHaveLength(2))
  expect(screen.getByTestId('request-user-input-card')).not.toBeVisible()
  await act(async () => finish())
  expect(screen.getByTestId('request-user-input-card')).not.toBeVisible()
  expect(f.client.respond).toHaveBeenCalledOnce()
})
