import { expect, it, vi } from 'vitest'
import type { GatewayRuntimeCore } from './core'
import { requestAsyncQuestion } from './asyncQuestions'

function fixture(question: Record<string, unknown>) {
  const task = { taskId: 'task', serverId: 'target', threadId: 'thread', workspacePath: '/owned' }
  const receipt = { threadId: task.threadId,
    question: { threadId: task.threadId, questionId: 'question', ...question } }
  const client = { supportsExperimental: () => true,
    request: vi.fn<(method: string, params: Record<string, unknown>) => Promise<unknown>>(async () => receipt) }
  const runtime = {
    disposed: false, resolveTaskId: (id: string) => id,
    taskDescriptor: vi.fn(async () => ({ taskId: task.taskId, task, server: { id: task.serverId } })),
    readyTaskClient: vi.fn(async () => client), assertCommandTarget: vi.fn(async () => undefined),
    tasks: new Map([[task.taskId, task]]), clientByTask: new Map([[task.taskId, client]]),
    appServerDisconnectedClients: new WeakSet(),
  }
  const request = (method: string, params: Record<string, unknown>) =>
    requestAsyncQuestion.call(runtime as unknown as GatewayRuntimeCore, { taskId: task.taskId, method, params })
  const call = (expectedRevision = 3) => request('asyncQuestion/cancel', { questionId: 'question', expectedRevision })
  const read = () => request('asyncQuestion/list', {})
  return { client, receipt, call, read }
}

it.each(['pending', 'queued', 'context_applied', 'delivery_failed', 'delivery_unknown', 'stale', null])(
  'does not confirm cancellation from explicit state %s', async status => {
    const f = fixture({ status, revision: 4 })
    await expect(f.call()).rejects.toThrow(/invalid.*cancellation receipt/i)
    expect(f.client.request).toHaveBeenCalledExactlyOnceWith('asyncQuestion/cancel', {
      threadId: 'thread', questionId: 'question', expectedRevision: 3,
    })
  }
)

it.each([1, 2, 3.5, null, Number.MAX_SAFE_INTEGER + 1])(
  'does not confirm cancellation of revision 3 from revision %s', async revision => {
    const f = fixture({ status: 'cancelled', revision })
    await expect(f.call()).rejects.toThrow(/invalid.*cancellation receipt/i)
    expect(f.client.request).toHaveBeenCalledTimes(1)
  }
)

it.each([3, 4, 7])('confirms committed or idempotent cancellation at revision %s', async revision => {
  const f = fixture({ status: 'cancelled', revision })
  await expect(f.call()).resolves.toEqual(f.receipt)
})

const completeCancellation = {
  requestId: 'request', sourceTurnId: 'source', toolCallId: 'tool',
  status: 'cancelled', revision: 4, createdAtMs: 1,
  questions: [{ id: 'item', header: 'Mode', question: 'Which mode?', options: [], multiSelect: false }],
}

it('confirms an idempotent full cancellation at the committed revision', async () => {
  const f = fixture({ ...completeCancellation, revision: 3 })
  await expect(f.call()).resolves.toEqual(f.receipt)
  expect(f.client.request).toHaveBeenCalledExactlyOnceWith('asyncQuestion/cancel', {
    threadId: 'thread', questionId: 'question', expectedRevision: 3,
  })
})

it.each([1, 2])('rejects a full cancellation receipt at revision %s that cannot settle the request', async revision => {
  const f = fixture({ ...completeCancellation, revision })
  await expect(f.call(revision === 1 ? 1 : 3)).rejects.toThrow(/invalid.*cancellation receipt/i)
  const committed = { ...f.receipt.question, revision: 4 }
  f.client.request.mockResolvedValueOnce({ threadId: f.receipt.threadId, questions: [committed] })
  await expect(f.read()).resolves.toHaveProperty('questions', [committed])
  expect(f.client.request.mock.calls.map(([method]) => method)).toEqual(['asyncQuestion/cancel', 'asyncQuestion/list'])
})

it('confirms a complete cancellation at a newer revision', async () => {
  const f = fixture(completeCancellation)
  await expect(f.call()).resolves.toEqual(f.receipt)
})

it.each([false, true])('reads back a cancellation with a saved answer after an impossible revision (full=%s)', async full => {
  const answer = { acceptedAtMs: 2, submissionId: 'saved', answers: { item: { text: 'response' } } }
  const f = fixture({ ...(full ? completeCancellation : {}), status: 'cancelled', revision: 2, answer })
  await expect(f.call(2)).rejects.toThrow(/invalid.*cancellation receipt/i)

  const committed = { ...f.receipt.question, ...completeCancellation, revision: 3 }
  f.client.request.mockResolvedValueOnce({ threadId: f.receipt.threadId, questions: [committed] })
  await expect(f.read()).resolves.toHaveProperty('questions', [committed])
  f.client.request.mockResolvedValueOnce({ ...f.receipt, question: committed })
  await expect(f.call(3)).resolves.toHaveProperty('question', committed)
  expect(f.client.request.mock.calls.map(([method]) => method)).toEqual([
    'asyncQuestion/cancel', 'asyncQuestion/list', 'asyncQuestion/cancel',
  ])
})

it('rejects a prompt-bearing cancellation receipt with no revision', async () => {
  const f = fixture({ ...completeCancellation, revision: undefined })
  await expect(f.call()).rejects.toThrow(/invalid.*cancellation receipt/i)
})

it('retains compatibility with legacy omitted state and revision fields', async () => {
  const f = fixture({})
  await expect(f.call()).resolves.toEqual(f.receipt)
})

it.each([
  ['the initial revision in a sparse receipt', { status: 'cancelled', revision: 1 }],
  ['a saved answer for different prompt items', {
    ...completeCancellation,
    answer: { acceptedAtMs: 2, submissionId: 'saved', answers: { other: { text: 'response' } } },
  }],
])('requires original-task readback after %s', async (_label, question) => {
  const f = fixture(question)
  await expect(f.call(1)).rejects.toThrow(/invalid.*cancellation receipt/i)
  const committed = { threadId: f.receipt.threadId, questionId: 'question', ...completeCancellation }
  f.client.request.mockResolvedValueOnce({ threadId: f.receipt.threadId, questions: [committed] })
  await expect(f.read()).resolves.toHaveProperty('questions', [committed])
  expect(f.client.request.mock.calls.map(([method]) => method)).toEqual(['asyncQuestion/cancel', 'asyncQuestion/list'])
})
