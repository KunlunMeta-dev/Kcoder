import { beforeEach, expect, test, vi } from 'vitest'
import { emitRuntimeEvent } from '../../gatewayServiceBridge'
import { NotificationReplayGuard } from '../../notificationReplayGuard'
import type { GatewayRuntimeCore } from './core'
import { forwardApprovalRequest, forwardServerRequest } from './interactions'
import { forwardAcceptedNotification, forwardNotification } from './notifications'

vi.mock('../../gatewayServiceBridge', () => ({ emitRuntimeEvent: vi.fn(async () => undefined) }))
beforeEach(() => vi.clearAllMocks())

async function fixture(kind: 'question' | 'approval') {
  const task = { taskId: 'task', serverId: 'target', threadId: 'thread', workspacePath: '/original' }
  const originalTask = { ...task }
  const client = { supportsExperimental: () => true, respond: vi.fn() }
  const runtime = {
    disposed: false, appServerDisconnectedClients: new WeakSet(),
    tasks: new Map([[task.taskId, task]]), clientByTask: new Map([[task.taskId, client]]),
    threadByTask: new Map([[task.taskId, task.threadId]]),
    taskByThread: new Map([['target\0thread', task.taskId]]),
    threadKey: (server: string, thread: string) => `${server}\0${thread}`,
    pendingQuestionByKey: new Map(), turnAttemptIds: new Map(), forwardApprovalRequest,
    notificationReplayGuard: new NotificationReplayGuard(), forwardAcceptedNotification,
    remoteSessions: { handleNotification: () => false },
    toolPathPreviews: { beforeResumeBoundary: () => false, handle: () => {} },
  } as unknown as GatewayRuntimeCore
  const bindings = { threadId: 'thread', turnId: 'turn', appServerEpoch: 'epoch',
    ...(kind === 'question' ? { questionId: 'question' } : { approvalId: 'approval' }) }
  await forwardServerRequest.call(runtime, client as never, { id: 101, method: `${kind}/request`,
    params: { ...bindings, ...(kind === 'question'
      ? { questions: [{ id: 'choice', prompt: 'Which?', options: [] }] }
      : { action: { type: 'command', command: 'echo controlled' }, availableDecisions: ['accept', 'decline'] }) },
  }, 'target')
  const key = 'task\0' + 101
  const pending = runtime.pendingQuestionByKey.get(key)!
  pending.responsePending = true
  pending.submittedResponse = { requestId: 101, answers: { choice: { answers: ['Original answer'] } } }
  const submitted = pending.submittedResponse
  vi.mocked(emitRuntimeEvent).mockClear()
  const notify = (rejection: boolean, patch: Record<string, unknown> = {}) => forwardNotification.call(runtime,
    rejection ? 'gateway/interaction/replyRejected' : `${kind}/resolved`,
    { ...bindings, serverId: 'native', sequence: 42, requestId: 101,
      reason: rejection ? 'invalid_response' : 'client_response',
      ...(kind === 'approval' && !rejection ? { decision: 'accept' } : {}), ...patch },
    'target', client as never)
  const restore = () => {
    Object.assign(task, originalTask)
    runtime.threadByTask.set(task.taskId, originalTask.threadId)
  }
  return { runtime, task, client, pending, key, submitted, notify, restore }
}

for (const kind of ['question', 'approval'] as const) {
  for (const rejection of [false, true]) {
    for (const change of ['threadId', 'serverId', 'workspacePath', 'thread-map'] as const) {
      test(`${kind}: ${rejection ? 'rejection' : 'resolution'} cannot publish across a ${change} rebind`, async () => {
        const f = await fixture(kind)
        if (change === 'thread-map') f.runtime.threadByTask.set('task', 'replacement')
        else f.task[change] = 'replacement'
        await f.notify(rejection)
        expect(emitRuntimeEvent).not.toHaveBeenCalled()
        expect(f.runtime.pendingQuestionByKey.get(f.key)).toBe(f.pending)
        expect(f.pending.responsePending).toBe(true)
        expect(f.pending.submittedResponse).toBe(f.submitted)

        // Ignoring a stale projection must preserve this receipt's replay ID.
        f.restore()
        await f.notify(rejection)
        expect(emitRuntimeEvent).toHaveBeenCalledOnce()
        expect(f.runtime.pendingQuestionByKey.has(f.key)).toBe(rejection)
        expect(f.client.respond).not.toHaveBeenCalled()
      })
    }

    test(`${kind}: ${rejection ? 'rejection' : 'resolution'} preserves equivalent workspace aliases`, async () => {
      const f = await fixture(kind)
      f.runtime.tasks.set('task', { ...f.task, workspacePath: '/original/' } as never)
      await f.notify(rejection)
      expect(emitRuntimeEvent).toHaveBeenCalledOnce()
      expect(f.runtime.pendingQuestionByKey.has(f.key)).toBe(rejection)
    })
  }
}

for (const kind of ['question', 'approval'] as const) {
  test.each([undefined, 42])(`${kind}: a failed rejection projection remains recoverable with sequence=%s`, async sequence => {
    const f = await fixture(kind)
    vi.mocked(emitRuntimeEvent).mockRejectedValueOnce(new Error('projection failed'))
    await expect(f.notify(true, { sequence })).rejects.toThrow('projection failed')
    expect(f.runtime.pendingQuestionByKey.get(f.key)).toBe(f.pending)
    expect(f.pending.responsePending).toBe(true)
    // The rejected answer must not be shown as confirmed if a terminal follows.
    expect(f.pending.submittedResponse).toBeUndefined()

    await f.notify(true, { sequence })
    expect(emitRuntimeEvent).toHaveBeenCalledTimes(2)
    expect(f.pending.responsePending).toBe(false)
    expect(emitRuntimeEvent).toHaveBeenLastCalledWith(expect.any(String), expect.objectContaining({
      event: 'response.block.updated', payload: expect.objectContaining({ taskId: 'task',
        data: expect.objectContaining({ updates: expect.objectContaining({ status: 'error' }) }) }),
    }))
    await f.notify(true, { sequence })
    expect(emitRuntimeEvent).toHaveBeenCalledTimes(2)
    expect(f.client.respond).not.toHaveBeenCalled()
  })

  test.each([
    { turnId: 'old-turn' },
    { appServerEpoch: 'old-epoch' },
    { [kind === 'question' ? 'questionId' : 'approvalId']: 'another-interaction' },
  ])(`${kind}: a mismatched rejection %j cannot claim the real receipt's replay identity`, async patch => {
    const f = await fixture(kind)
    await f.notify(true, patch)
    expect(f.pending.responsePending).toBe(true)
    expect(f.pending.submittedResponse).toBe(f.submitted)
    expect(emitRuntimeEvent).not.toHaveBeenCalled()
    await f.notify(true)
    expect(f.pending.responsePending).toBe(false)
    expect(emitRuntimeEvent).toHaveBeenCalledOnce()
    expect(f.client.respond).not.toHaveBeenCalled()
  })
}
