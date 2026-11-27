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
  const forward = (question: Record<string, unknown>) => forwardServerRequest.call(runtime, client as never, {
    id: 101, method: 'question/request', params: {
      threadId: task.threadId, turnId: 'turn', questionId: 'original-question',
      questions: [{ id: 'choice', options: [], ...question }],
    },
  }, task.serverId)
  return { runtime, client, forward }
}

for (const field of ['prompt', 'question']) {
  it.each(['', '   ', null, 7, {}])(`invalid explicit ${field}=%j cannot reserve the original question`, async value => {
    const f = fixture()
    await f.forward({ [field]: value })
    expect(f.runtime.pendingQuestionByKey.size).toBe(0)
    expect(emitRuntimeEvent).not.toHaveBeenCalled()
    expect(f.client.respondError).not.toHaveBeenCalled()

    // A corrected original request with the same transport identity must still
    // publish its actual prompt, rather than replay a substituted default card.
    await f.forward({ [field]: 'Which original choice?' })
    const pending = f.runtime.pendingQuestionByKey.get('task\0' + 101)!
    expect(pending.renderPayload.questions).toMatchObject([{ id: 'choice', question: 'Which original choice?' }])
    expect(emitRuntimeEvent).toHaveBeenCalledOnce()
    const response = { requestId: 101, answers: { choice: { answers: ['Original answer'] } } }
    expect(await respondToTaskQuestion.call(f.runtime, 'task', response)).toMatchObject({ accepted: true })
    expect(f.client.respond).toHaveBeenCalledExactlyOnceWith(101, expect.objectContaining({
      questionId: 'original-question', threadId: 'thread', turnId: 'turn', answers: response.answers,
    }))
  })
}

it.each([
  [{}, 'Question 1'],
  [{ question: 'Legacy prompt' }, 'Legacy prompt'],
  [{ prompt: 'Canonical prompt' }, 'Canonical prompt'],
  [{ prompt: 'Canonical prompt', question: 'Legacy prompt' }, 'Canonical prompt'],
])('retains valid legacy prompt behavior %j', async (question, expected) => {
  const f = fixture()
  await f.forward(question)
  expect(f.runtime.pendingQuestionByKey.get('task\0' + 101)?.renderPayload.questions)
    .toMatchObject([{ question: expected }])
  expect(emitRuntimeEvent).toHaveBeenCalledOnce()
})

it('an invalid replay cannot republish or replace an already displayed original question', async () => {
  const f = fixture()
  await f.forward({ prompt: 'Original prompt' })
  const original = f.runtime.pendingQuestionByKey.get('task\0' + 101)
  await f.forward({ prompt: '   ' })
  expect(f.runtime.pendingQuestionByKey.get('task\0' + 101)).toBe(original)
  expect(emitRuntimeEvent).toHaveBeenCalledOnce()
})
