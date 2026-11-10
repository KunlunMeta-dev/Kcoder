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
  // Different targets can restore the same thread/question IDs. The task ID
  // still has to retain the rendered target when the caller mutates its DTO.
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
    resolveTaskId: (id: string) => id,
    taskDescriptor: async ({ taskId }: { taskId: string }) => {
      const task = tasks.find(task => task.taskId === taskId)!
      return { taskId, task, server: { id: task.serverId } }
    },
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
  const mutate = () => Object.assign(address, { taskId: tasks[1].taskId, deviceId: tasks[1].serverId })
  return { address, mutate, clients, tasks }
}

it.each(['list', 'answer', 'saved-answer retry'] as const)(
  'a rendered %s keeps its original target when the caller mutates the address',
  async operation => {
    const user = userEvent.setup()
    const f = fixture(operation === 'saved-answer retry')
    render(<AsyncQuestionPanel address={f.address} />)
    await user.click(await screen.findByTestId('async-question-toggle'))
    if (operation === 'answer') await user.click(screen.getByTestId('request-user-input-option-item-0'))
    expect(f.clients[0].request).toHaveBeenCalledTimes(1)
    f.mutate()
    const before = executor.request.mock.calls.length
    await user.click(screen.getByTestId(operation === 'list' ? 'async-question-refresh'
      : operation === 'answer' ? 'request-user-input-submit-button'
        : 'async-question-continue-delivery-question'))
    const method = operation === 'list' ? 'asyncQuestion/list' : 'asyncQuestion/answer'
    await waitFor(() => expect(executor.request.mock.calls.slice(before).some(
      ([, params]) => params.method === method)).toBe(true))
    const dispatched = executor.request.mock.calls.slice(before).find(([, params]) => params.method === method)!
    expect(dispatched[1].taskId).toBe(f.tasks[0].taskId)
    expect(f.clients[0].request.mock.calls.filter(([called]) => called === method)).toHaveLength(
      operation === 'list' ? 2 : 1
    )
    expect(f.clients[1].request.mock.calls.every(([method]) => method === 'asyncQuestion/list')).toBe(true)
  }
)

it('a delayed capability read cannot switch its initial list to a mutated task address', async () => {
  const f = fixture()
  const original = executor.request.getMockImplementation()!
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  executor.request.mockImplementation(async (command: string, params: Record<string, unknown>) => {
    const result = await original(command, params)
    if (command === 'runtime.asyncQuestion.supports') await held
    return result
  })
  render(<AsyncQuestionPanel address={f.address} />)
  await waitFor(() => expect(executor.request).toHaveBeenCalledTimes(1))
  f.mutate()
  await act(async () => release())
  await screen.findByTestId('async-question-toggle')
  const firstList = executor.request.mock.calls.find(([, params]) => params.method === 'asyncQuestion/list')!
  expect(firstList[1].taskId).toBe(f.tasks[0].taskId)
  expect(f.clients[0].request).toHaveBeenCalled()
  // The state update may render the caller's new address afterwards. That new
  // visit may read its own list, but cannot redefine the old continuation.
})

it('an original task notification keeps the rendered subscription after an address mutation', async () => {
  const f = fixture()
  render(<AsyncQuestionPanel address={f.address} />)
  await screen.findByTestId('async-question-toggle')
  const listener = executor.subscribe.mock.calls[0][0]
  const before = executor.request.mock.calls.length
  f.mutate()
  await act(async () => listener({ event: 'async-question:changed', payload: {
    taskId: f.tasks[0].taskId, serverId: f.tasks[0].serverId,
    threadId: 'thread', questionId: 'question', revision: 2,
  } }))
  const refresh = executor.request.mock.calls.slice(before).find(([, params]) => params.method === 'asyncQuestion/list')
  expect(refresh?.[1].taskId).toBe(f.tasks[0].taskId)
})
