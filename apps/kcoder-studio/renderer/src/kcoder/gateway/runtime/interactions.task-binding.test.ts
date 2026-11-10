import { beforeEach, expect, test, vi } from 'vitest'
import { emitRuntimeEvent } from '../../gatewayServiceBridge'
import type { GatewayRuntimeCore } from './core'
import { forwardApprovalRequest, forwardServerRequest, respondToTaskQuestion } from './interactions'

vi.mock('../../gatewayServiceBridge', () => ({ emitRuntimeEvent: vi.fn(async () => undefined) }))
beforeEach(() => vi.clearAllMocks())

function fixture(kind: 'question' | 'approval') {
  const task = { taskId: 'original-task', serverId: 'target', threadId: 'original-thread', workspacePath: '/original' }
  const client = { supportsExperimental: () => true, respond: vi.fn() }
  const requestId = 101, turnId = 'turn', itemId = `original-${kind}`
  const runtime = {
    disposed: false, appServerDisconnectedClients: new WeakSet(),
    tasks: new Map([[task.taskId, task]]), clientByTask: new Map([[task.taskId, client]]),
    threadByTask: new Map([[task.taskId, task.threadId]]),
    taskByThread: new Map([[`target\0${task.threadId}`, task.taskId]]),
    threadKey: (serverId: string, id: string) => `${serverId}\0${id}`,
    pendingQuestionByKey: new Map(), turnAttemptIds: new Map(), forwardApprovalRequest,
  } as unknown as GatewayRuntimeCore
  const start = () => forwardServerRequest.call(runtime, client as never, {
    id: requestId, method: `${kind}/request`, params: { threadId: task.threadId, turnId,
      ...(kind === 'question'
        ? { questionId: itemId, questions: [{ id: 'choice', prompt: 'Which?', options: [] }] }
        : { approvalId: itemId, action: { type: 'command', command: 'echo controlled' }, availableDecisions: ['accept', 'decline'] }),
    },
  }, task.serverId)
  const key = `${task.taskId}\0${requestId}`
  const reply = () => respondToTaskQuestion.call(runtime, task.taskId, { requestId, itemId,
    answers: { [kind === 'question' ? 'choice' : itemId]: { answers: [kind === 'question' ? 'Original answer' : 'Allow once'] } },
  })
  return { runtime, task, client, start, reply, key }
}

for (const kind of ['question', 'approval'] as const) {
  for (const change of ['threadId', 'serverId', 'workspacePath', 'thread-map'] as const) {
    const rebind = (f: ReturnType<typeof fixture>) => {
      if (change === 'thread-map') f.runtime.threadByTask.set(f.task.taskId, 'replacement-thread')
      else f.task[change] = 'replacement'
    }

    test(`${kind}: a ${change} rebind during capture cannot publish the old card`, async () => {
      const f = fixture(kind), publishing = f.start()
      expect(f.runtime.pendingQuestionByKey.has(f.key)).toBe(true)
      rebind(f)
      await publishing
      expect(emitRuntimeEvent).not.toHaveBeenCalled()
      expect(f.client.respond).not.toHaveBeenCalled()
      expect(f.runtime.pendingQuestionByKey.has(f.key)).toBe(false)
    })

    test(`${kind}: a ${change} rebind cannot dispatch a retained answer on the same client`, async () => {
      const f = fixture(kind)
      await f.start()
      const pending = f.runtime.pendingQuestionByKey.get(f.key)!
      rebind(f)
      expect(await f.reply()).toMatchObject({ accepted: false, code: 'original_interaction_changed' })
      expect(f.client.respond).not.toHaveBeenCalled()
      expect(pending.responsePending).toBeUndefined()
      expect(pending.submittedResponse).toBeUndefined()
      expect(f.runtime.pendingQuestionByKey.get(f.key)).toBe(pending)
    })
  }

  test(`${kind}: replacing only the task projection preserves the original answer and send guard`, async () => {
    const f = fixture(kind)
    await f.start()
    f.runtime.tasks.set(f.task.taskId, { ...f.task, workspacePath: `${f.task.workspacePath}/` } as never)
    expect(await f.reply()).toMatchObject({ accepted: true, pendingServerConfirmation: true })
    expect(await f.reply()).toMatchObject({ accepted: false, code: 'request_user_input_response_pending' })
    expect(f.client.respond).toHaveBeenCalledExactlyOnceWith(101, expect.objectContaining({
      threadId: 'original-thread', turnId: 'turn',
    }))
  })
}
