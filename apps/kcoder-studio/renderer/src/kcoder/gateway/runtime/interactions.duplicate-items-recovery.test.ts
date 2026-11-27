import { beforeEach, expect, it, vi } from 'vitest'
import { emitRuntimeEvent } from '../../gatewayServiceBridge'
import type { GatewayRuntimeCore } from './core'
import { forwardServerRequest, respondToTaskQuestion } from './interactions'

vi.mock('../../gatewayServiceBridge', () => ({ emitRuntimeEvent: vi.fn(async () => undefined) }))
beforeEach(() => vi.clearAllMocks())

function fixture() {
  const client = { respond: vi.fn(), respondError: vi.fn(), supportsExperimental: () => true }
  const task = { taskId: 'task', serverId: 'target', threadId: 'thread', workspacePath: '/owned' }
  const runtime = {
    disposed: false, appServerDisconnectedClients: new WeakSet(),
    tasks: new Map([[task.taskId, task]]), clientByTask: new Map([[task.taskId, client]]),
    threadByTask: new Map([[task.taskId, task.threadId]]),
    taskByThread: new Map([['target\0thread', task.taskId]]),
    threadKey: (target: string, thread: string) => `${target}\0${thread}`,
    activeTurnByTask: new Map(), turnAttemptIds: new Map(), pendingQuestionByKey: new Map(),
  } as unknown as GatewayRuntimeCore
  const forward = (ids: (string | undefined)[], questions: unknown = ids.map((id, index) => ({ id, prompt: `Original question ${index + 1}`, options: [] }))) => forwardServerRequest.call(runtime, client as never, {
    id: 101, method: 'question/request', params: {
      threadId: task.threadId, turnId: 'turn', questionId: 'original-question',
      questions,
    },
  }, task.serverId)
  return { runtime, client, forward }
}

it.each([
  ['duplicate explicit items', ['item', 'item']],
  ['legacy fallback collision', [undefined, 'question-1']],
] as const)('%s cannot retain an ambiguous question ahead of its corrected replay', async (_name, ids) => {
  const f = fixture()
  await f.forward([...ids])
  expect(f.runtime.pendingQuestionByKey.size).toBe(0)
  expect(emitRuntimeEvent).not.toHaveBeenCalled()
  expect(f.client.respondError).not.toHaveBeenCalled()

  await f.forward(['first', 'second'])
  const pending = f.runtime.pendingQuestionByKey.get('task\0' + 101)!
  expect(pending.renderPayload.questions).toMatchObject([
    { id: 'first', question: 'Original question 1' }, { id: 'second', question: 'Original question 2' },
  ])
  expect(emitRuntimeEvent).toHaveBeenCalledOnce()
  const answers = { first: { answers: ['First answer'] }, second: { answers: ['Second answer'] } }
  expect(await respondToTaskQuestion.call(f.runtime, 'task', { requestId: 101, answers }))
    .toMatchObject({ accepted: true })
  expect(f.client.respond).toHaveBeenCalledExactlyOnceWith(101, expect.objectContaining({
    questionId: 'original-question', threadId: 'thread', turnId: 'turn', answers,
  }))
})

it('keeps distinct legacy fallback IDs and the original pending object on an invalid replay', async () => {
  const f = fixture()
  await f.forward([undefined, undefined])
  const original = f.runtime.pendingQuestionByKey.get('task\0' + 101)!
  expect(original.renderPayload.questions).toMatchObject([{ id: 'question-1' }, { id: 'question-2' }])
  await f.forward(['item', 'item'])
  expect(f.runtime.pendingQuestionByKey.get('task\0' + 101)).toBe(original)
  expect(emitRuntimeEvent).toHaveBeenCalledOnce()
})

for (const questions of [[], null, {}]) {
  it(`rejects explicit unusable questions ${JSON.stringify(questions)} before reserving the original card`, async () => {
    const f = fixture()
    await f.forward([], questions)
    expect(f.runtime.pendingQuestionByKey.size).toBe(0)
    expect(emitRuntimeEvent).not.toHaveBeenCalled()
    expect(f.client.respondError).not.toHaveBeenCalled()
    await f.forward(['first', 'second'])
    const pending = f.runtime.pendingQuestionByKey.get('task\0' + 101)!
    expect(pending.renderPayload.questions).toMatchObject([{ id: 'first' }, { id: 'second' }])
    const answers = { first: { answers: ['A'] }, second: { answers: ['B'] } }
    expect(await respondToTaskQuestion.call(f.runtime, 'task', { requestId: 101, answers }))
      .toMatchObject({ accepted: true })
    expect(f.client.respond).toHaveBeenCalledExactlyOnceWith(101, expect.objectContaining({ answers }))
  })
}
