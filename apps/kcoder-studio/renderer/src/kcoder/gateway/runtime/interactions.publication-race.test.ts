import { beforeEach, expect, test, vi } from 'vitest'
import { emitRuntimeEvent } from '../../gatewayServiceBridge'
import { forwardApprovalRequest, forwardServerRequest } from './interactions'
import { forwardAcceptedNotification } from './notifications'
import type { GatewayRuntimeCore } from './core'
import type { GatewayClient } from '../../gatewayRuntimeTypes'

vi.mock('../../gatewayServiceBridge', () => ({ emitRuntimeEvent: vi.fn(async () => undefined) }))
beforeEach(() => vi.clearAllMocks())

function publishedEvents() {
  return vi.mocked(emitRuntimeEvent).mock.calls.map(([, event]) => {
    expect(event).toEqual(expect.objectContaining({ event: expect.any(String) }))
    return (event as { event: string }).event
  })
}

function fixture(kind: 'question' | 'approval') {
  const taskId = 'task', threadId = 'thread', turnId = 'turn', requestId = 101
  const client = { respondError: vi.fn() } as unknown as GatewayClient
  const runtime = {
    disposed: false,
    appServerDisconnectedClients: new WeakSet(),
    tasks: new Map([[taskId, { taskId, serverId: 'target', threadId, workspacePath: '/owned', runtimeHandle: {} }]]),
    taskByThread: new Map([['target\0thread', taskId]]),
    threadKey: (serverId: string, id: string) => `${serverId}\0${id}`,
    clientByTask: new Map([[taskId, client]]),
    pendingQuestionByKey: new Map(),
    turnAttemptIds: new Map(),
    remoteSessions: { handleNotification: () => false },
    forwardApprovalRequest,
  } as unknown as GatewayRuntimeCore
  const params = { threadId, turnId, appServerEpoch: 'epoch',
    ...(kind === 'question'
      ? { questionId: 'question', questions: [{ id: 'choice', prompt: 'Continue?', options: [] }] }
      : { approvalId: 'approval', action: { type: 'command', command: 'echo controlled' } }) }
  const start = (patch = {}) => forwardServerRequest.call(runtime, client, { id: requestId, method: `${kind}/request`, params: { ...params, ...patch } }, 'target')
  const settle = (patch = {}, source = client) => forwardAcceptedNotification.call(runtime,
    `${kind}/resolved`, { ...params, requestId, reason: 'cancelled', ...patch }, 'target', source)
  return { runtime, client, start, settle, key: `${taskId}\0${requestId}` }
}

test.each(['question', 'approval'] as const)(
  '%s resolution received during capture cannot publish a pending card afterward', async kind => {
    const f = fixture(kind)
    const publishing = f.start()
    expect(f.runtime.pendingQuestionByKey.has(f.key)).toBe(true)
    await f.settle()
    await publishing
    expect(f.runtime.pendingQuestionByKey.has(f.key)).toBe(false)
    expect(publishedEvents())
      .toEqual(['response.block.updated'])
  }
)

test.each(['question', 'approval'] as const)(
  '%s publishes normally while the original pending request is current', async kind => {
    const f = fixture(kind)
    await f.start()
    expect(f.runtime.pendingQuestionByKey.has(f.key)).toBe(true)
    expect(publishedEvents())
      .toEqual(['response.block.created'])
    await f.settle()
    expect(publishedEvents())
      .toEqual(['response.block.created', 'response.block.updated'])
  }
)

test.each(['question', 'approval'] as const)(
  '%s publication cannot outlive runtime disposal or a replaced task client', async kind => {
    for (const change of ['dispose', 'client', 'app-server']) {
      const f = fixture(kind)
      const publishing = f.start()
      if (change === 'dispose') f.runtime.disposed = true
      else if (change === 'client') f.runtime.clientByTask.set('task', {} as GatewayClient)
      else f.runtime.appServerDisconnectedClients.add(f.client)
      await publishing
      expect(f.runtime.pendingQuestionByKey.has(f.key)).toBe(false)
    }
    expect(emitRuntimeEvent).not.toHaveBeenCalled()
  }
)

test.each(['question', 'approval'] as const)(
  '%s late receipt cannot settle a reused request from another turn, epoch or client', async kind => {
    for (const variant of ['turn', 'epoch', 'missing-epoch', 'client']) {
      const f = fixture(kind)
      await f.start()
      vi.mocked(emitRuntimeEvent).mockClear()
      const original = f.runtime.pendingQuestionByKey.get(f.key)
      await f.settle(variant === 'turn' ? { turnId: 'old-turn' } : variant === 'epoch' ? { appServerEpoch: 'old-epoch' } :
        variant === 'missing-epoch' ? { appServerEpoch: undefined } : {},
        variant === 'client' ? {} as GatewayClient : f.client)
      expect(f.runtime.pendingQuestionByKey.get(f.key)).toBe(original)
      expect(emitRuntimeEvent).not.toHaveBeenCalled()
      await f.settle()
      expect(f.runtime.pendingQuestionByKey.has(f.key)).toBe(false)
    }
  }
)

test.each(['question', 'approval'] as const)(
  '%s capture cannot publish a replaced request with the same transport ID', async kind => {
    const f = fixture(kind)
    const first = f.start()
    const replaced = f.runtime.pendingQuestionByKey.get(f.key)
    const second = f.start({ [kind === 'question' ? 'questionId' : 'approvalId']: `${kind}-replacement` })
    const current = f.runtime.pendingQuestionByKey.get(f.key)
    expect(current).not.toBe(replaced)
    await Promise.all([first, second])
    expect(f.runtime.pendingQuestionByKey.get(f.key)).toBe(current)
    expect(emitRuntimeEvent).toHaveBeenCalledTimes(1)
  }
)

test.each(['question', 'approval'] as const)(
  '%s legacy request without epoch still settles on its original turn and client', async kind => {
    const f = fixture(kind)
    await f.start()
    const pending = f.runtime.pendingQuestionByKey.get(f.key)!
    delete pending.appServerEpoch
    await f.settle({ appServerEpoch: undefined })
    expect(f.runtime.pendingQuestionByKey.has(f.key)).toBe(false)
    expect(publishedEvents())
      .toEqual(['response.block.created', 'response.block.updated'])
  }
)
