import { beforeEach, expect, test, vi } from 'vitest'
import { emit as publishRuntimeEvent, listen } from '@/lib/runtime-events'
import { registerRuntimeTransport } from '@/lib/runtime-transport'
import { emitRuntimeEvent } from '../../gatewayServiceBridge'
import { forwardApprovalRequest, forwardServerRequest, respondToTaskQuestion } from './interactions'
import { forwardAcceptedNotification, forwardNotification } from './notifications'
import { NotificationReplayGuard } from '../../notificationReplayGuard'
import type { GatewayRuntimeCore } from './core'
import type { GatewayClient } from '../../gatewayRuntimeTypes'

vi.mock('../../gatewayServiceBridge', () => ({ emitRuntimeEvent: vi.fn(async () => undefined) }))
beforeEach(() => {
  vi.mocked(emitRuntimeEvent).mockReset().mockResolvedValue(undefined)
})

async function fixture(kind: 'question' | 'approval') {
  const taskId = 'task', threadId = 'thread', turnId = 'turn', requestId = 101
  const client = { respond: vi.fn(), supportsExperimental: () => true } as unknown as GatewayClient
  const runtime = {
    disposed: false, appServerDisconnectedClients: new WeakSet(),
    tasks: new Map([[taskId, { taskId, serverId: 'target', threadId, workspacePath: '/owned', runtimeHandle: {} }]]),
    taskByThread: new Map([['target\0thread', taskId]]),
    threadByTask: new Map([[taskId, threadId]]),
    threadKey: (serverId: string, id: string) => `${serverId}\0${id}`,
    clientByTask: new Map([[taskId, client]]), pendingQuestionByKey: new Map(),
    turnAttemptIds: new Map(), remoteSessions: { handleNotification: () => false }, forwardApprovalRequest,
    forwardAcceptedNotification, notificationReplayGuard: new NotificationReplayGuard(),
  } as unknown as GatewayRuntimeCore
  const params = { threadId, turnId, appServerEpoch: 'epoch',
    ...(kind === 'question'
      ? { questionId: 'question', questions: [{ id: 'choice', prompt: 'Continue?', options: [] }] }
      : { approvalId: 'approval', action: { type: 'command', command: 'echo controlled' } }) }
  const request = () => forwardServerRequest.call(runtime, client,
    { id: requestId, method: `${kind}/request`, params }, 'target')
  await request()
  const key = `${taskId}\0${requestId}`
  const original = runtime.pendingQuestionByKey.get(key)!
  const settle = (reason = 'cancelled') => forwardAcceptedNotification.call(runtime,
    `${kind}/resolved`, { ...params, requestId, reason }, 'target', client)
  const replay = () => forwardNotification.call(runtime, `${kind}/resolved`, {
    ...params, requestId, reason: 'cancelled', serverId: 'native', sequence: 10,
  }, 'target', client)
  const answer = () => respondToTaskQuestion.call(runtime, taskId,
    { requestId, answers: { [kind === 'question' ? 'choice' : 'approval']: { answers: ['Continue'] } } })
  vi.mocked(emitRuntimeEvent).mockClear()
  return { runtime, client, key, original, request, settle, replay, answer }
}

for (const kind of ['question', 'approval'] as const) {
  test(`${kind}: ordered notification recovery releases only the failed projection's replay identity`, async () => {
    const f = await fixture(kind)
    vi.mocked(emitRuntimeEvent).mockRejectedValueOnce(new Error('projection failed'))
    await expect(f.replay()).rejects.toThrow('projection failed')
    await f.replay()
    expect(emitRuntimeEvent).toHaveBeenCalledTimes(2)
    expect(f.runtime.pendingQuestionByKey.has(f.key)).toBe(false)
    await f.replay()
    expect(emitRuntimeEvent).toHaveBeenCalledTimes(2)
    expect(f.client.respond).not.toHaveBeenCalled()
  })

  test(`${kind}: a failed terminal projection retries the original receipt without reopening input`, async () => {
    const f = await fixture(kind)
    const unregister = registerRuntimeTransport(() => undefined)
    const stop = await listen('local-executor:event', () => { throw new Error('projection failed') })
    vi.mocked(emitRuntimeEvent).mockImplementation(publishRuntimeEvent)
    try {
      await expect(f.settle()).rejects.toThrow('projection failed')
      expect(f.runtime.pendingQuestionByKey.get(f.key)).toBe(f.original)
      expect(await f.answer()).toMatchObject({ accepted: false, code: 'request_user_input_response_pending' })
      await f.request()
      expect(emitRuntimeEvent).toHaveBeenCalledTimes(1)
      stop()
      // Recovery cannot replace the first authoritative outcome with a later frame.
      await f.settle('client_response')
      expect(f.runtime.pendingQuestionByKey.has(f.key)).toBe(false)
      expect(emitRuntimeEvent).toHaveBeenCalledTimes(2)
      expect(vi.mocked(emitRuntimeEvent).mock.calls[1][1]).toMatchObject({
        event: 'response.block.updated', payload: { data: { updates: { status: 'error' } } },
      })
      expect(f.client.respond).not.toHaveBeenCalled()
    } finally {
      stop()
      unregister()
    }
  })

  test(`${kind}: concurrent terminal replays share one publication and cannot delete a replacement`, async () => {
    const f = await fixture(kind)
    let release!: () => void
    vi.mocked(emitRuntimeEvent).mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const first = f.settle(), second = f.settle()
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    expect(emitRuntimeEvent).toHaveBeenCalledTimes(1)
    expect(await f.answer()).toMatchObject({ accepted: false, code: 'request_user_input_response_pending' })
    const replacement = { ...f.original, turnId: 'replacement-turn' }
    f.runtime.pendingQuestionByKey.set(f.key, replacement)
    release()
    await Promise.all([first, second])
    expect(f.runtime.pendingQuestionByKey.get(f.key)).toBe(replacement)
    expect(f.client.respond).not.toHaveBeenCalled()
  })
}
