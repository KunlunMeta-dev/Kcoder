import { expect, it, vi } from 'vitest'
import type { GatewayRuntimeCore } from './core'
import { requestAsyncQuestion } from './asyncQuestions'

it.each(['client', 'connection'].flatMap(replacement =>
  [false, true].map(oldFirst => ({ replacement, oldFirst }))))(
  'late answer receipts preserve the recovered snapshot ($replacement, oldFirst=$oldFirst)',
  async ({ replacement, oldFirst }) => {
    const task = { taskId: 'kcoder:target:thread', serverId: 'target',
      threadId: 'thread', workspacePath: '/owned', running: false }
    const input = { questionId: 'question', submissionId: 'submission', expectedRevision: 1,
      answers: { item: { text: 'original answer' } } }
    const receipt = { threadId: task.threadId, accepted: true, duplicate: false,
      question: { threadId: task.threadId, questionId: input.questionId,
        answer: { submissionId: input.submissionId, answers: input.answers } },
      startedTurn: { id: 'reused-turn', status: 'running' } }
    const receipts: Array<(value: typeof receipt) => void> = []
    const makeClient = (connectionId: string) => ({
      diagnosticConnection: { connectionId }, supportsExperimental: () => true,
      request: vi.fn(() => new Promise<typeof receipt>(resolve => receipts.push(resolve))),
    })
    let client = makeClient('original')
    const runtime = {
      disposed: false, resolveTaskId: (id: string) => id,
      taskDescriptor: async () => ({ taskId: task.taskId, task, server: { id: task.serverId } }),
      readyTaskClient: async () => client, assertCommandTarget: async () => undefined,
      tasks: new Map([[task.taskId, task]]), clientByTask: new Map([[task.taskId, client]]),
      appServerDisconnectedClients: new WeakSet(), trackActiveTurn: vi.fn(),
    }
    const answer = () => requestAsyncQuestion.call(runtime as unknown as GatewayRuntimeCore,
      { taskId: task.taskId, method: 'asyncQuestion/answer', params: input })
    const old = answer().then(() => undefined, error => error)
    await vi.waitFor(() => expect(receipts).toHaveLength(1))
    if (replacement === 'client') client = makeClient('replacement')
    else client.diagnosticConnection.connectionId = 'replacement'
    runtime.clientByTask.set(task.taskId, client)
    // The original resume/event path has already confirmed this execution ended.
    const restored = { ...task, running: false, turnStatus: 'completed' }
    runtime.tasks.set(task.taskId, restored)
    const recovered = answer()
    await vi.waitFor(() => expect(receipts).toHaveLength(2))
    if (oldFirst) { receipts[0](receipt); expect(await old).toBeInstanceOf(Error) }
    receipts[1](receipt)
    await recovered
    if (!oldFirst) { receipts[0](receipt); expect(await old).toBeInstanceOf(Error) }
    expect(runtime.tasks.get(task.taskId)).toBe(restored)
    expect(runtime.trackActiveTurn).not.toHaveBeenCalled()
    expect(receipts).toHaveLength(2)
  }
)
