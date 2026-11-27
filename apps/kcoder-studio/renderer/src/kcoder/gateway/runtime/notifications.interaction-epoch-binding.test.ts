import { beforeEach, expect, it, vi } from 'vitest'
import { emitRuntimeEvent } from '../../gatewayServiceBridge'
import { NotificationReplayGuard } from '../../notificationReplayGuard'
import type { GatewayRuntimeCore } from './core'
import { forwardApprovalRequest, forwardServerRequest } from './interactions'
import { forwardAcceptedNotification, forwardNotification } from './notifications'

vi.mock('../../gatewayServiceBridge', () => ({ emitRuntimeEvent: vi.fn(async () => undefined) }))
beforeEach(() => vi.clearAllMocks())

async function fixture(kind: 'question' | 'approval', epoch?: string) {
  const client = { supportsExperimental: () => true, respond: vi.fn() }
  const runtime = {
    disposed: false, appServerDisconnectedClients: new WeakSet(),
    tasks: new Map([['task', { taskId: 'task', serverId: 'target', threadId: 'thread', workspacePath: '/owned' }]]),
    clientByTask: new Map([['task', client]]), threadByTask: new Map([['task', 'thread']]),
    taskByThread: new Map([['target\0thread', 'task']]),
    threadKey: (server: string, thread: string) => `${server}\0${thread}`,
    pendingQuestionByKey: new Map(), turnAttemptIds: new Map(), forwardApprovalRequest,
    notificationReplayGuard: new NotificationReplayGuard(), forwardAcceptedNotification,
    remoteSessions: { handleNotification: () => false },
    toolPathPreviews: { beforeResumeBoundary: () => false, handle: () => {} },
  } as unknown as GatewayRuntimeCore
  const bindings = { threadId: 'thread', turnId: 'turn',
    ...(epoch === undefined ? {} : { appServerEpoch: epoch }),
    ...(kind === 'question' ? { questionId: 'question' } : { approvalId: 'approval' }) }
  await forwardServerRequest.call(runtime, client as never, { id: 101, method: `${kind}/request`,
    params: { ...bindings, ...(kind === 'question'
      ? { questions: [{ id: 'item', prompt: 'Which?', options: [] }] }
      : { action: { type: 'command', command: 'echo controlled' }, availableDecisions: ['accept', 'decline'] }) },
  }, 'target')
  const key = 'task\0' + 101
  const pending = runtime.pendingQuestionByKey.get(key)!
  pending.responsePending = true
  pending.submittedResponse = { original: 'answer' }
  vi.mocked(emitRuntimeEvent).mockClear()
  const notify = (appServerEpoch: unknown) => forwardNotification.call(runtime, `${kind}/resolved`, {
    ...bindings, appServerEpoch, requestId: 101, reason: 'client_response',
    serverId: 'native', sequence: 42,
    ...(kind === 'approval' ? { decision: 'accept' } : {}),
  }, 'target', client as never)
  return { runtime, client, key, pending, notify }
}

for (const kind of ['question', 'approval'] as const) {
  it.each(['foreign-epoch', '', 7])(
    `${kind}: an epoch-free request cannot be settled by an explicit epoch %s`, async epoch => {
      const f = await fixture(kind)
      await f.notify(epoch)
      expect(f.runtime.pendingQuestionByKey.get(f.key)).toBe(f.pending)
      expect(f.pending.responsePending).toBe(true)
      expect(f.pending.submittedResponse).toEqual({ original: 'answer' })
      expect(emitRuntimeEvent).not.toHaveBeenCalled()

      // A rejected frame must not consume the legitimate receipt's replay ID.
      await f.notify(undefined)
      expect(f.runtime.pendingQuestionByKey.has(f.key)).toBe(false)
      expect(emitRuntimeEvent).toHaveBeenCalledOnce()
      await f.notify(undefined)
      expect(emitRuntimeEvent).toHaveBeenCalledOnce()
      expect(f.client.respond).not.toHaveBeenCalled()
    }
  )

  it.each([undefined, null, 'foreign-epoch'])(
    `${kind}: a current epoch cannot be settled by %s`, async epoch => {
      const f = await fixture(kind, 'current-epoch')
      await f.notify(epoch)
      expect(f.runtime.pendingQuestionByKey.get(f.key)).toBe(f.pending)
      expect(emitRuntimeEvent).not.toHaveBeenCalled()
      await f.notify('current-epoch')
      expect(f.runtime.pendingQuestionByKey.has(f.key)).toBe(false)
      expect(emitRuntimeEvent).toHaveBeenCalledOnce()
    }
  )

  it.each([undefined, null])(`${kind}: legacy epoch %s still settles the original card`, async epoch => {
    const f = await fixture(kind)
    await f.notify(epoch)
    expect(f.runtime.pendingQuestionByKey.has(f.key)).toBe(false)
    expect(emitRuntimeEvent).toHaveBeenCalledExactlyOnceWith(expect.any(String), expect.objectContaining({
      event: 'response.block.updated', payload: expect.objectContaining({ taskId: 'task',
        data: expect.objectContaining({ updates: expect.objectContaining({ status: 'done' }) }) }),
    }))
    expect(f.client.respond).not.toHaveBeenCalled()
  })
}
