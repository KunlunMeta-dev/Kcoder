import { expect, it, vi } from 'vitest'
import type { GatewayRuntimeCore } from './core'
import { requestAsyncQuestion } from './asyncQuestions'

function fixture(questionId: string, submissionId: string) {
  const task = { taskId: 'task', serverId: 'target', threadId: 'thread', workspacePath: '/owned' }
  const input = { questionId, submissionId, expectedRevision: 1,
    answers: { item: { text: 'Original answer' } } }
  const question = { threadId: task.threadId, questionId, revision: 2, status: 'queued',
    answer: { submissionId, answers: input.answers } }
  const receipt = { threadId: task.threadId, question, accepted: true, duplicate: true }
  const request = vi.fn(async () => receipt)
  const client = { request, supportsExperimental: () => true }
  const runtime = {
    disposed: false, resolveTaskId: (id: string) => id,
    taskDescriptor: async () => ({ taskId: task.taskId, task, server: { id: task.serverId } }),
    readyTaskClient: async () => client, assertCommandTarget: async () => undefined,
    tasks: new Map([[task.taskId, task]]), clientByTask: new Map([[task.taskId, client]]),
    appServerDisconnectedClients: new WeakSet(),
  }
  const call = (method = 'asyncQuestion/answer') => requestAsyncQuestion.call(
    runtime as unknown as GatewayRuntimeCore, { taskId: task.taskId, method, params: input })
  return { input, receipt, request, call }
}

for (const field of ['questionId', 'submissionId'] as const) {
  it(`an exact saved-answer retry preserves valid U+FEFF ${field}`, async () => {
    const f = fixture(field === 'questionId' ? '\ufeff' : 'question',
      field === 'submissionId' ? '\ufeff' : 'submission')
    await expect(f.call()).resolves.toEqual(f.receipt)
    expect(f.request).toHaveBeenCalledExactlyOnceWith('asyncQuestion/answer', {
      threadId: 'thread', ...f.input,
    })
  })

  it(`a Rust whitespace-only ${field} fails before answer dispatch`, async () => {
    const f = fixture(field === 'questionId' ? ' \u0085\t' : 'question',
      field === 'submissionId' ? ' \u0085\t' : 'submission')
    await expect(f.call()).rejects.toThrow(field === 'questionId' ? /identity/ : /incomplete/)
    expect(f.request).not.toHaveBeenCalled()
  })
}

it('a whitespace-only question cannot dispatch a cancellation either', async () => {
  const f = fixture('\u0085', 'submission')
  await expect(f.call('asyncQuestion/cancel')).rejects.toThrow(/identity/)
  expect(f.request).not.toHaveBeenCalled()
})

it('valid surrounding whitespace remains part of the exact retry identity', async () => {
  const f = fixture(' question ', ' \u0085submission\u0085 ')
  await expect(f.call()).resolves.toEqual(f.receipt)
  expect(f.request).toHaveBeenCalledExactlyOnceWith('asyncQuestion/answer', {
    threadId: 'thread', ...f.input,
  })
})
