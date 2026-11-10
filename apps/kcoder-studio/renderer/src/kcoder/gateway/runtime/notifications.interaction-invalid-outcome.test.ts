import { expect, it, vi } from 'vitest'
import type { GatewayRuntimeCore } from './core'
import { forwardAcceptedNotification, forwardNotification } from './notifications'
import { NotificationReplayGuard } from '../../notificationReplayGuard'
import { emitRuntimeEvent } from '../../gatewayServiceBridge'

vi.mock('../../gatewayServiceBridge', () => ({ emitRuntimeEvent: vi.fn(async () => undefined) }))

for (const kind of ['question', 'approval'] as const) {
  const outcomes: Array<[string, Record<string, unknown>]> = [
    ['missing reason', {}],
    ['null reason', { reason: null }],
    ['object reason', { reason: { status: 'client_response' } }],
  ]
  if (kind === 'approval') outcomes.push(['invalid decision', { reason: 'client_response', decision: 'unknown' }])
  it.each(outcomes)(`${kind}: %s cannot retire a pending card or consume its valid receipt`, async (_name, outcome) => {
    vi.mocked(emitRuntimeEvent).mockClear()
    const client = {}
    const pending = { taskId: 'task', requestId: 7, turnId: 'turn', appServerEpoch: 'epoch', client,
      ...(kind === 'question' ? { questionId: 'question' } : { approvalId: 'approval', approvalDecisions: ['accept'] }),
      renderPayload: {}, block: { id: 'block' } }
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
      serverId: 'native', sequence: 42,
      ...(kind === 'question' ? { questionId: 'question' } : { approvalId: 'approval' }) }
    await forwardNotification.call(core, `${kind}/resolved`, { ...receipt, ...outcome }, 'target', client as never)
    expect(runtime.pendingQuestionByKey.get('task\0' + 7)).toBe(pending)
    expect(emitRuntimeEvent).not.toHaveBeenCalled()

    await forwardNotification.call(core, `${kind}/resolved`, { ...receipt, reason: 'client_response',
      ...(kind === 'approval' ? { decision: 'accept' } : {}) }, 'target', client as never)
    expect(runtime.pendingQuestionByKey.size).toBe(0)
    expect(emitRuntimeEvent).toHaveBeenCalledExactlyOnceWith(expect.any(String), expect.objectContaining({
      event: 'response.block.updated', payload: expect.objectContaining({ taskId: 'task',
        data: expect.objectContaining({ updates: expect.objectContaining({ status: 'done' }) }) }),
    }))
  })
}
