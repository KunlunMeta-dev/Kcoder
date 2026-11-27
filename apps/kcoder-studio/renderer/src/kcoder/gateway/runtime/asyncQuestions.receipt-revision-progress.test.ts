import { expect, it, vi } from 'vitest'
import type { GatewayRuntimeCore } from './core'
import { requestAsyncQuestion } from './asyncQuestions'

function fixture(revision: number | undefined, duplicate = false, accepted = true) {
  const task = { taskId: 'task', serverId: 'target', threadId: 'thread', workspacePath: '/owned' }
  const answers = { item: { text: 'Original answer' } }
  const receipt = { threadId: task.threadId, accepted, duplicate,
    question: { threadId: task.threadId, questionId: 'question', revision,
      answer: { submissionId: accepted ? 'original' : 'another-device', answers } } }
  const client = { supportsExperimental: () => true, request: vi.fn<(method: string) => Promise<unknown>>(async () => receipt) }
  const runtime = {
    disposed: false, resolveTaskId: (id: string) => id,
    taskDescriptor: vi.fn(async () => ({ taskId: task.taskId, task, server: { id: task.serverId } })),
    readyTaskClient: vi.fn(async () => client), assertCommandTarget: vi.fn(async () => undefined),
    tasks: new Map([[task.taskId, task]]), clientByTask: new Map([[task.taskId, client]]),
    appServerDisconnectedClients: new WeakSet(),
  }
  const request = (method: string, params: Record<string, unknown>) =>
    requestAsyncQuestion.call(runtime as unknown as GatewayRuntimeCore, { taskId: task.taskId, method, params })
  const call = () => request('asyncQuestion/answer', {
    questionId: 'question', expectedRevision: 3, submissionId: 'original', answers,
  })
  const read = () => request('asyncQuestion/list', { includeTerminal: true })
  return { client, receipt, call, read }
}

it.each([1, 2, 3])('rejects a first-save revision %s from a legacy/direct transport', async revision => {
  const f = fixture(revision)
  await expect(f.call()).rejects.toThrow(/invalid.*answer receipt/i)
  expect(f.client.request).toHaveBeenCalledTimes(1)
})

it.each([4, 6, undefined])('accepts an advancing or legacy omitted revision %s', async revision => {
  const f = fixture(revision)
  await expect(f.call()).resolves.toEqual(f.receipt)
})

it.each([2, 3])('accepts an exact duplicate without advancing revision %s', async revision => {
  const f = fixture(revision, true)
  await expect(f.call()).resolves.toEqual(f.receipt)
})

it('preserves the authoritative winner when another device wins', async () => {
  const f = fixture(4, false, false)
  await expect(f.call()).resolves.toEqual(f.receipt)
})

it.each([true, false])('rejects a complete receipt whose saved answer belongs to a different item (accepted=%s)', async accepted => {
  const f = fixture(4, false, accepted)
  Object.assign(f.receipt.question, {
    requestId: 'request', sourceTurnId: 'source', toolCallId: 'tool',
    createdAtMs: 1, status: 'queued',
    questions: [{ id: 'other-item', header: 'Mode', question: 'Which mode?', options: [], multiSelect: false }],
  })
  Object.assign(f.receipt.question.answer, { acceptedAtMs: 2 })
  await expect(f.call()).rejects.toThrow(/invalid.*answer receipt/i)
  expect(f.client.request).toHaveBeenCalledTimes(1)

  const saved = { ...f.receipt.question,
    questions: [{ id: 'item', header: 'Mode', question: 'Which mode?', options: [], multiSelect: false }],
  }
  const snapshot = { threadId: f.receipt.threadId, questions: [saved] }
  f.client.request.mockResolvedValueOnce(snapshot)
  await expect(f.read()).resolves.toEqual(snapshot)
  expect(f.client.request.mock.calls.map(([method]) => method)).toEqual(['asyncQuestion/answer', 'asyncQuestion/list'])
})

it.each([
  { status: 'answer_saved', revision: 2 },
  { status: 'queued', revision: 2 },
])('rejects a duplicate claiming new execution from $status revision $revision', async state => {
  const f = fixture(state.revision, true)
  Object.assign(f.receipt.question, state)
  const snapshot = { threadId: f.receipt.threadId, questions: [f.receipt.question] }
  f.client.request.mockResolvedValueOnce({
    ...f.receipt, startedTurn: { id: 'answer-turn', status: 'running' },
  })
  await expect(f.call()).rejects.toThrow(/started turn receipt/i)

  f.client.request.mockResolvedValueOnce(snapshot)
  await expect(f.read()).resolves.toEqual(snapshot)
  expect(f.client.request.mock.calls.map(([method]) => method)).toEqual(['asyncQuestion/answer', 'asyncQuestion/list'])
})
