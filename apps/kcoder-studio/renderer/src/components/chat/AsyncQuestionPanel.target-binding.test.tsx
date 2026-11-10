import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { createInstance } from 'i18next'
import { initReactI18next } from 'react-i18next'
import chat from '@/i18n/locales/en/chat.json'
import common from '@/i18n/locales/en/common.json'
import { requestAsyncQuestion, supportsAsyncQuestions } from '@/kcoder/gateway/runtime/asyncQuestions'
import type { GatewayRuntimeCore } from '@/kcoder/gateway/runtime/core'
import type { AsyncQuestionRecord } from '../../../../shared/generated/contracts'
import { AsyncQuestionPanel } from './AsyncQuestionPanel'
import { taskDescriptor } from '@/kcoder/gateway/runtime/turns'
import { resolveTaskId } from '@/kcoder/gateway/runtime/resources'

const executor = vi.hoisted(() => ({ request: vi.fn(), subscribe: vi.fn() }))
vi.mock('@/host/localExecutor', () => ({
  requestLocalExecutor: executor.request,
  subscribeLocalExecutorEvents: executor.subscribe,
}))

beforeAll(async () => {
  await createInstance().use(initReactI18next).init({
    lng: 'en', resources: { en: { chat, common } }, interpolation: { escapeValue: false },
  })
})
beforeEach(() => {
  vi.clearAllMocks()
  executor.subscribe.mockResolvedValue(vi.fn())
})

function fixture(saved = false) {
  // Matching Native identities and paths do not make two targets equivalent.
  const tasks = ['original', 'replacement'].map(serverId => ({
    taskId: `kcoder:${serverId}:thread`, serverId, threadId: 'thread', workspacePath: '/workspace',
  }))
  const question: AsyncQuestionRecord = {
    questionId: 'question', requestId: 'request', threadId: 'thread', sourceTurnId: 'turn',
    toolCallId: 'call', revision: 1, createdAtMs: 1, status: saved ? 'queued' : 'pending',
    questions: [{ id: 'item', header: 'Decision', question: 'Which option?', multiSelect: false,
      options: [{ id: 'option', label: 'Original option', description: '' }] }],
    ...(saved ? { answer: { submissionId: 'saved', acceptedAtMs: 2,
      answers: { item: { selectedOptionIds: ['option'] } } } } : {}),
  }
  const clients = tasks.map(() => ({
    supportsExperimental: () => true,
    request: vi.fn(async (method: string, params: Record<string, unknown>) =>
      method === 'asyncQuestion/list' ? { threadId: 'thread', questions: [question] } : {
        threadId: 'thread', accepted: true, duplicate: false,
        question: { ...question, revision: 2, status: 'answer_saved',
          answer: { submissionId: params.submissionId, answers: params.answers, acceptedAtMs: 2 } },
      }),
  }))
  const runtime = {
    resolveTaskId, canonicalTaskByRequested: new Map(),
    taskDescriptor, servers: async () => tasks.map(task => ({ id: task.serverId })),
    readyTaskClient: async (task: typeof tasks[number]) => clients[tasks.findIndex(candidate => candidate.taskId === task.taskId)],
    assertCommandTarget: async () => undefined,
    tasks: new Map(tasks.map(task => [task.taskId, task])),
    clientByTask: new Map(tasks.map((task, index) => [task.taskId, clients[index]])),
    appServerDisconnectedClients: new WeakSet(),
  } as unknown as GatewayRuntimeCore
  executor.request.mockImplementation((command: string, params: Record<string, unknown>) =>
    command === 'runtime.asyncQuestion.supports'
      ? supportsAsyncQuestions.call(runtime, params) : requestAsyncQuestion.call(runtime, params))
  const address = { taskId: tasks[0].taskId, deviceId: tasks[0].serverId,
    threadId: 'thread', workspacePath: '/workspace' }
  return { address, clients, tasks, runtime }
}

it.each(['support', 'asyncQuestion/list', 'asyncQuestion/answer', 'asyncQuestion/cancel'])(
  '%s rejects an explicit target different from the task mapping before connection preparation', async method => {
    const f = fixture()
    const ready = vi.spyOn(f.runtime, 'readyTaskClient')
    const params = { taskId: f.tasks[1].taskId, deviceId: f.tasks[0].serverId,
      workspacePath: '/workspace' }
    const operation = method === 'support'
      ? supportsAsyncQuestions.call(f.runtime, params)
      : requestAsyncQuestion.call(f.runtime, { ...params, method, params: {
          threadId: 'thread', questionId: 'question', submissionId: 'stable', expectedRevision: 1,
          answers: { item: { selectedOptionIds: ['option'] } },
        } })
    await expect(operation).rejects.toThrow('Asynchronous question task ownership changed')
    expect(ready).not.toHaveBeenCalled()
    expect(f.clients[1].request).not.toHaveBeenCalled()
  }
)

it.each(['list', 'answer', 'saved-answer retry'] as const)(
  'the rendered target fences a %s after its task alias is redirected to another target', async operation => {
    const f = fixture(operation === 'saved-answer retry')
    // Index aliases can be rebound by directory recovery before the next click.
    // Both targets deliberately have the same workspace and Native identities.
    render(<AsyncQuestionPanel address={f.address} />)
    const user = userEvent.setup()
    await user.click(await screen.findByTestId('async-question-toggle'))
    if (operation === 'answer') await user.click(screen.getByTestId('request-user-input-option-item-0'))
    const ready = vi.spyOn(f.runtime, 'readyTaskClient')
    f.runtime.canonicalTaskByRequested.set(f.address.taskId, f.tasks[1].taskId)
    const before = executor.request.mock.calls.length
    await user.click(screen.getByTestId(operation === 'list' ? 'async-question-refresh'
      : operation === 'answer' ? 'request-user-input-submit-button'
        : 'async-question-continue-delivery-question'))
    await waitFor(() => expect(executor.request.mock.calls.length).toBeGreaterThan(before))
    await waitFor(() => expect(screen.getByTestId('async-question-retry')).toBeEnabled())
    expect(ready).not.toHaveBeenCalled()
    expect(f.clients[1].request).not.toHaveBeenCalled()
    expect(executor.request.mock.calls.slice(before).every(([, params]) =>
      params.deviceId === f.tasks[0].serverId)).toBe(true)
    // Restore the original mapping and explicitly reread. Recovery must keep
    // the card and must never replay the blocked answer or send local metadata.
    f.runtime.canonicalTaskByRequested.delete(f.address.taskId)
    await user.click(screen.getByTestId('async-question-retry'))
    await waitFor(() => expect(screen.queryByTestId('async-question-retry')).not.toBeInTheDocument())
    expect(screen.getByTestId('async-question-card-question')).toHaveAttribute(
      'data-status', operation === 'saved-answer retry' ? 'queued' : 'pending')
    expect(f.clients[0].request.mock.calls.every(([method, params]) =>
      method === 'asyncQuestion/list' && !Object.hasOwn(params, 'deviceId'))).toBe(true)
    expect(f.clients[1].request).not.toHaveBeenCalled()
  }
)

it('pins both initial discovery and recovered discovery to the rendered target', async () => {
  const f = fixture()
  render(<AsyncQuestionPanel address={f.address} />)
  await screen.findByTestId('async-question-toggle')
  const listener = executor.subscribe.mock.calls[0][0]
  await act(async () => listener({ event: 'async-question:refresh', payload: {
    taskId: f.address.taskId, serverId: f.address.deviceId, threadId: f.address.threadId,
    workspacePath: f.address.workspacePath,
  } }))
  await waitFor(() => expect(executor.request.mock.calls.filter(([command]) =>
    command === 'runtime.asyncQuestion.supports')).toHaveLength(2))
  expect(executor.request.mock.calls.every(([, params]) => params.deviceId === f.address.deviceId)).toBe(true)
})
