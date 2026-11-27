import { expect, it, vi } from 'vitest'
import type { GatewayRuntimeCore } from './core'
import { forwardAcceptedNotification, forwardNotification } from './notifications'
import { NotificationReplayGuard } from '../../notificationReplayGuard'
import { emitRuntimeEvent } from '../../gatewayServiceBridge'

vi.mock('../../gatewayServiceBridge', () => ({ emitRuntimeEvent: vi.fn(async () => undefined) }))

for (const kind of ['question', 'approval'] as const) {
  const field = kind === 'question' ? 'questionId' : 'approvalId'
  const counterpart = kind === 'question' ? 'approvalId' : 'questionId'
  const conflicts: Array<[string, Record<string, unknown>]> = [
    ['mixed interaction kinds', { [counterpart]: 'another-interaction' }],
    ['another turn', { turnId: 'another-turn' }],
    ['another app-server lifetime', { appServerEpoch: 'another-epoch' }],
    ['another interaction', { [field]: 'another-interaction' }],
    ['another transport request', { requestId: 8 }],
  ]
  it.each(conflicts)(`${kind}: %s preserves the card and permits its authoritative recovery receipt`, async (_name, conflict) => {
    vi.mocked(emitRuntimeEvent).mockClear()
    const client = {}
    const pending = { taskId: 'task', requestId: 7, turnId: 'turn', appServerEpoch: 'epoch', client,
      [field]: 'original', ...(kind === 'approval' ? { approvalDecisions: { Allow: 'accept' } } : {}),
      responsePending: true, submittedResponse: { original: 'answer' }, renderPayload: {}, block: { id: 'block' } }
    const runtime = {
      disposed: false, notificationReplayGuard: new NotificationReplayGuard(), forwardAcceptedNotification,
      clientByTask: new Map([['task', client]]), taskByThread: new Map([['target\0thread', 'task']]),
      pendingQuestionByKey: new Map([['task\0' + 7, pending]]),
      threadKey: (server: string, thread: string) => `${server}\0${thread}`,
      remoteSessions: { handleNotification: () => false },
      toolPathPreviews: { beforeResumeBoundary: () => false, handle: () => {} },
    }
    const core = runtime as unknown as GatewayRuntimeCore
    const receipt = { threadId: 'thread', turnId: 'turn', requestId: 7, appServerEpoch: 'epoch',
      serverId: 'native', sequence: 42, [field]: 'original', reason: 'client_response',
      ...(kind === 'approval' ? { decision: 'accept' } : {}) }
    const notify = (params: Record<string, unknown>) =>
      forwardNotification.call(core, `${kind}/resolved`, params, 'target', client as never)

    await notify({ ...receipt, ...conflict })
    expect(runtime.pendingQuestionByKey.get('task\0' + 7)).toBe(pending)
    expect(pending.responsePending).toBe(true)
    expect(emitRuntimeEvent).not.toHaveBeenCalled()

    // A rejected frame must not claim the real receipt's sequenced replay ID.
    // Legacy recovery may omit the optional counterpart or encode it as null.
    await notify({ ...receipt, [counterpart]: null })
    expect(runtime.pendingQuestionByKey.size).toBe(0)
    expect(emitRuntimeEvent).toHaveBeenCalledExactlyOnceWith(expect.any(String), expect.objectContaining({
      event: 'response.block.updated', payload: expect.objectContaining({ taskId: 'task',
        data: expect.objectContaining({ updates: expect.objectContaining({ status: 'done' }) }) }),
    }))
    await notify(receipt)
    expect(emitRuntimeEvent).toHaveBeenCalledTimes(1)
  })
}
