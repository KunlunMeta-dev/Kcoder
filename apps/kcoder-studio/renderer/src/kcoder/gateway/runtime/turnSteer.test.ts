import { beforeEach, describe, expect, it, vi } from 'vitest'

const emitted: unknown[] = []
vi.mock('../../gatewayServiceBridge', () => ({
  emitRuntimeEvent: vi.fn(async (_name: string, payload: unknown) => {
    emitted.push(payload)
  }),
}))

import {
  deliverGuidanceFallback,
  reconcileUnsettledSteers,
  settleSteerNotification,
  trySteerRunningTurn,
} from './turnSteer'
import type { GatewayRuntimeCore } from './core'
import type { GatewayClient } from '../../gatewayRuntimeTypes'
import { TurnAcceptanceUnknownError } from '../../gatewayTurnReceipt'
import { GatewayRpcError } from '../../gatewayRpc'
import { guideTask } from './turns'

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept
    reject = decline
  })
  return { promise, resolve, reject }
}

function fakeClient(
  response: unknown = { status: 'queued', turnId: 'turn-1', steerId: 7 },
  supports = true,
  supportsAttachments = true
) {
  const request = vi.fn<(method: string, params: Record<string, unknown>) => Promise<unknown>>()
    .mockResolvedValue(response)
  const client = Object.assign(new EventTarget(), {
    diagnosticConnection: { targetId: 'server-1', connectionId: 'connection-1' },
    supportsExperimental: (capability: string) =>
      supports && (['turnSteerV1', 'turnReceiptsV1'].includes(capability) ||
        supportsAttachments && capability === 'turnSteerAttachmentsV1'),
    request,
    requestOnConnection: vi.fn((connection: string, method: string, params: Record<string, unknown>) => {
      if (connection !== 'connection-1') throw new Error('wrong connection')
      return request(method, params)
    }),
  }) as unknown as GatewayClient & {
    request: ReturnType<typeof vi.fn>
    requestOnConnection: ReturnType<typeof vi.fn>
    diagnosticConnection: { targetId: string; connectionId: string }
  }
  return { client, request, requestOnConnection: client.requestOnConnection }
}

function fakeCore(client?: GatewayClient) {
  const task = { taskId: 'task-1', serverId: 'server-1', threadId: 'thread-1' }
  const tasks = new Map([[task.taskId, task]])
  const clientByTask = new Map<string, GatewayClient>(client ? [[task.taskId, client]] : [])
  const sendTask = vi.fn(async () => ({ accepted: true }))
  const prepareAttachments = vi.fn(async (prompt: string) => `${prompt}\nATTACHMENTS`)
  const core = {
    disposed: false,
    tasks,
    clientByTask,
    activeTurnByTask: new Map(),
    taskConnection: vi.fn(async () => ({
      taskId: task.taskId,
      task: tasks.get(task.taskId),
      server: { id: task.serverId },
      client: clientByTask.get(task.taskId),
    })),
    sendTask,
    sharedRuntimeContext: vi.fn(async () => ({ instructions: '', personality: 'pragmatic' })),
    remoteSessions: { promptWithAttachmentsForClient: prepareAttachments },
    promptWithApplicationContext: (prompt: string) => prompt,
  } as unknown as GatewayRuntimeCore
  return { core, task, tasks, clientByTask, sendTask, prepareAttachments }
}

const input = {
  taskId: 'task-1',
  serverId: 'server-1',
  threadId: 'thread-1',
  turnId: 'turn-1',
  guidanceId: 'guidance-1',
  message: 'use staging',
  prompt: 'use staging',
}

const applied = {
  threadId: input.threadId,
  turnId: input.turnId,
  steerId: 7,
  clientMessageId: input.guidanceId,
}

const dropped = {
  ...applied,
  text: input.prompt,
}

describe('turn steering delivery and recovery', () => {
  beforeEach(() => emitted.splice(0))

  it('accepts image-only guidance at the public runtime entry and still rejects empty input', async () => {
    const { client } = fakeClient()
    const { core, sendTask } = fakeCore(client)
    ;(core.activeTurnByTask as Map<string, unknown>).set(input.taskId, { turnId: input.turnId })
    await expect(guideTask.call(core, {
      taskId: input.taskId, message: '', attachments: [{ local_path: '/owned/photo.png' }],
      clientGuidanceId: input.guidanceId,
    })).resolves.toMatchObject({ success: true, steered: true, guidanceId: input.guidanceId })
    await expect(guideTask.call(core, {
      taskId: input.taskId, message: '  ', attachments: [],
    })).rejects.toThrow('消息不能为空')
    expect(sendTask).not.toHaveBeenCalled()
  })

  it('prepares attachment-only guidance once and steers without interrupting the turn', async () => {
    const { client, request } = fakeClient()
    const { core, sendTask, prepareAttachments } = fakeCore(client)
    const attachments = [{ local_path: '/owned/photo.png' }]
    const guidance = { ...input, message: '', prompt: '', attachments }
    expect(await trySteerRunningTurn(core, client, guidance)).toEqual({ kind: 'queued', turnId: input.turnId })
    expect(await trySteerRunningTurn(core, client, guidance)).toEqual({ kind: 'queued', turnId: input.turnId })
    expect(prepareAttachments).toHaveBeenCalledOnce()
    expect(prepareAttachments).toHaveBeenCalledWith('', { attachments }, { id: input.serverId }, client,
      { instructions: '', personality: 'pragmatic' }, input.threadId)
    expect(request).toHaveBeenCalledExactlyOnceWith('turn/steer', {
      threadId: input.threadId, turnId: input.turnId, clientMessageId: input.guidanceId,
      text: '\nATTACHMENTS',
    })
    expect(sendTask).not.toHaveBeenCalled()
  })

  it('preserves original attachments for one fallback after a dropped prepared steer', async () => {
    const { client } = fakeClient()
    const { core, sendTask } = fakeCore(client)
    const attachments = [{ local_path: '/owned/photo.png' }]
    await trySteerRunningTurn(core, client, { ...input, attachments })
    await settleSteerNotification(core, 'turn/steer/dropped', {
      ...dropped, text: `${input.prompt}\nATTACHMENTS`,
    }, input.serverId, client)
    expect(sendTask).toHaveBeenCalledExactlyOnceWith({
      taskId: input.taskId, clientMessageId: input.guidanceId,
      executionRequest: { prompt: input.prompt, attachments },
    }, { id: input.serverId }, false, client)
  })

  it('does not prepare attachments for targets that only advertise text steering', async () => {
    const { client, request } = fakeClient(undefined, true, false)
    const { core, prepareAttachments } = fakeCore(client)
    expect(await trySteerRunningTurn(core, client, {
      ...input, attachments: [{ local_path: '/owned/photo.png' }],
    })).toEqual({ kind: 'fallback' })
    expect(request).not.toHaveBeenCalled()
    expect(prepareAttachments).not.toHaveBeenCalled()
  })

  it('allows the same guidance identity after an upload fails before submission', async () => {
    const { client, request } = fakeClient()
    const { core, prepareAttachments } = fakeCore(client)
    prepareAttachments.mockRejectedValueOnce(new Error('upload rejected'))
    const guidance = { ...input, attachments: [{ local_path: '/owned/photo.png' }] }
    await expect(trySteerRunningTurn(core, client, guidance)).rejects.toThrow('upload rejected')
    expect(request).not.toHaveBeenCalled()
    await expect(trySteerRunningTurn(core, client, guidance)).resolves.toMatchObject({ kind: 'queued' })
    expect(request).toHaveBeenCalledOnce()
  })

  it('does not submit attachments if the owner changes while preparing them', async () => {
    const { client, request } = fakeClient()
    const { core, clientByTask, prepareAttachments } = fakeCore(client)
    prepareAttachments.mockImplementationOnce(async () => {
      clientByTask.set(input.taskId, fakeClient().client)
      return 'prepared'
    })
    await expect(trySteerRunningTurn(core, client, {
      ...input, attachments: [{ local_path: '/owned/photo.png' }],
    })).rejects.toThrow('owner changed before delivery')
    expect(request).not.toHaveBeenCalled()
  })

  it('keeps an explicit remote rejection retryable without starting a fallback', async () => {
    const { client, request } = fakeClient()
    const { core, sendTask } = fakeCore(client)
    request.mockRejectedValueOnce(new GatewayRpcError('invalid image', -32602, undefined, 'runtime-session', 'remote'))
    await expect(trySteerRunningTurn(core, client, input)).rejects.toThrow('invalid image')
    await expect(trySteerRunningTurn(core, client, input)).resolves.toMatchObject({ kind: 'queued' })
    expect(sendTask).not.toHaveBeenCalled()
  })

  it('uses the stable guidance identity for one fallback after an explicit rejection', async () => {
    for (const status of ['no_active_turn', 'busy', 'queue_full']) {
      const { client } = fakeClient({ status, turnId: input.turnId })
      const { core, sendTask } = fakeCore(client)
      const attempt = await trySteerRunningTurn(core, client, input)
      expect(attempt).toEqual({ kind: 'fallback' })
      await deliverGuidanceFallback(core, client, input)
      expect(sendTask).toHaveBeenCalledWith(
        {
          taskId: input.taskId,
          clientMessageId: input.guidanceId,
          executionRequest: { prompt: input.prompt },
        },
        { id: input.serverId },
        false,
        client
      )
    }
    expect(emitted).toHaveLength(3)
  })

  it('allows the same queued row identity to retry after fallback is explicitly rejected', async () => {
    const { client, request } = fakeClient({ status: 'no_active_turn', turnId: input.turnId })
    const { core, sendTask } = fakeCore(client)
    sendTask.mockRejectedValueOnce(new Error('turn start explicitly rejected'))
    expect(await trySteerRunningTurn(core, client, input)).toEqual({ kind: 'fallback' })
    await expect(deliverGuidanceFallback(core, client, input)).rejects.toThrow('explicitly rejected')

    expect(await trySteerRunningTurn(core, client, input)).toEqual({ kind: 'fallback' })
    await expect(deliverGuidanceFallback(core, client, input)).resolves.toMatchObject({ accepted: true })
    expect(request).toHaveBeenCalledTimes(2)
    expect(sendTask).toHaveBeenCalledTimes(2)
    expect(sendTask.mock.calls.every(([params]) => params.clientMessageId === input.guidanceId)).toBe(true)
    expect(emitted).toHaveLength(1)
  })

  it('releases the same identity after sendTask confirms the fallback was not accepted', async () => {
    const { client, request } = fakeClient({ status: 'no_active_turn', turnId: input.turnId })
    const { core, sendTask } = fakeCore(client)
    sendTask.mockResolvedValueOnce({ accepted: false })
    expect(await trySteerRunningTurn(core, client, input)).toEqual({ kind: 'fallback' })
    await expect(deliverGuidanceFallback(core, client, input)).resolves.toEqual({ accepted: false })

    expect(await trySteerRunningTurn(core, client, input)).toEqual({ kind: 'fallback' })
    await expect(deliverGuidanceFallback(core, client, input)).resolves.toMatchObject({ accepted: true })
    expect(request).toHaveBeenCalledTimes(2)
    expect(sendTask).toHaveBeenCalledTimes(2)
    expect(emitted).toHaveLength(1)
  })

  it('releases an unsent fallback authorization after reconnect so the same row can retry', async () => {
    const oldOwner = fakeClient({ status: 'no_active_turn', turnId: input.turnId })
    const { core, clientByTask, sendTask } = fakeCore(oldOwner.client)
    expect(await trySteerRunningTurn(core, oldOwner.client, input)).toEqual({ kind: 'fallback' })

    const newOwner = fakeClient({ status: 'no_active_turn', turnId: input.turnId })
    clientByTask.set(input.taskId, newOwner.client)
    await expect(deliverGuidanceFallback(core, oldOwner.client, input))
      .rejects.toThrow('Guidance owner changed before delivery')
    expect(sendTask).not.toHaveBeenCalled()

    expect(await trySteerRunningTurn(core, newOwner.client, input)).toEqual({ kind: 'fallback' })
    await expect(deliverGuidanceFallback(core, newOwner.client, input)).resolves.toMatchObject({ accepted: true })
    expect(newOwner.request).toHaveBeenCalledTimes(1)
    expect(sendTask).toHaveBeenCalledTimes(1)
    expect(sendTask.mock.calls[0]?.[0]).toMatchObject({ clientMessageId: input.guidanceId })
    expect(emitted).toHaveLength(1)
  })

  it('keeps an unknown steer identity when the owner changes', async () => {
    const oldOwner = fakeClient()
    oldOwner.request.mockRejectedValueOnce(new Error('steer ACK lost'))
    const { core, clientByTask, sendTask } = fakeCore(oldOwner.client)
    await expect(trySteerRunningTurn(core, oldOwner.client, input)).rejects.toThrow('steer ACK lost')

    const newOwner = fakeClient({ status: 'no_active_turn', turnId: input.turnId })
    clientByTask.set(input.taskId, newOwner.client)
    await expect(trySteerRunningTurn(core, newOwner.client, input))
      .rejects.toThrow('Guidance identity is already owned by another request')
    expect(newOwner.request).not.toHaveBeenCalled()
    expect(sendTask).not.toHaveBeenCalled()
    expect(emitted).toHaveLength(0)
  })

  it('does not send a steer when the capability is absent', async () => {
    const { client, request } = fakeClient({ status: 'queued' }, false)
    const { core } = fakeCore(client)
    expect(await trySteerRunningTurn(core, client, input)).toEqual({ kind: 'fallback' })
    expect(request).not.toHaveBeenCalled()
  })

  it('delivers attachments on a normal fallback and records the same identity', async () => {
    const { client } = fakeClient({ status: 'queued' }, false)
    const { core, sendTask } = fakeCore(client)
    const attachments = [{ local_path: '/owned/guide.txt' }]
    await deliverGuidanceFallback(core, client, {
      ...input,
      turnId: undefined,
      attachments,
    })
    expect(sendTask).toHaveBeenCalledWith(
      {
        taskId: input.taskId,
        clientMessageId: input.guidanceId,
        executionRequest: { prompt: input.prompt, attachments },
      },
      { id: input.serverId },
      false,
      client
    )
  })

  it('emits only after the matching applied settlement and consumes duplicates once', async () => {
    const { client, requestOnConnection } = fakeClient()
    const { core, sendTask } = fakeCore(client)
    expect(await trySteerRunningTurn(core, client, input)).toEqual({ kind: 'queued', turnId: input.turnId })
    expect(requestOnConnection).toHaveBeenCalledWith('connection-1', 'turn/steer', {
      threadId: input.threadId,
      turnId: input.turnId,
      text: input.prompt,
      clientMessageId: input.guidanceId,
    })
    expect(emitted).toHaveLength(0)
    expect(await settleSteerNotification(core, 'turn/steer/applied', applied, input.serverId, client)).toBe(true)
    await settleSteerNotification(core, 'turn/steer/applied', applied, input.serverId, client)
    expect(emitted).toHaveLength(1)
    expect(sendTask).not.toHaveBeenCalled()
  })

  it('handles applied settlement before the steer ACK without waiting for the ACK', async () => {
    const pendingAck = deferred<Record<string, unknown>>()
    const { client, request } = fakeClient()
    request.mockImplementation(() => pendingAck.promise)
    const { core, sendTask } = fakeCore(client)
    const attempt = trySteerRunningTurn(core, client, input)
    await settleSteerNotification(core, 'turn/steer/applied', applied, input.serverId, client)
    await expect(attempt).resolves.toEqual({ kind: 'queued', turnId: input.turnId })
    pendingAck.resolve({ status: 'queued', turnId: input.turnId, steerId: 7 })
    expect(sendTask).not.toHaveBeenCalled()
    expect(emitted).toHaveLength(1)
  })

  it('consumes an early dropped settlement once even when the late ACK says rejected', async () => {
    const pendingAck = deferred<Record<string, unknown>>()
    const { client, request } = fakeClient()
    request.mockImplementation(() => pendingAck.promise)
    const { core, sendTask } = fakeCore(client)
    const attempt = trySteerRunningTurn(core, client, input)
    await settleSteerNotification(core, 'turn/steer/dropped', dropped, input.serverId, client)
    await expect(attempt).resolves.toEqual({ kind: 'queued', turnId: input.turnId })
    pendingAck.resolve({ status: 'no_active_turn', turnId: input.turnId })
    expect(sendTask).toHaveBeenCalledTimes(1)
    expect(sendTask.mock.calls[0]?.[0]).toMatchObject({ clientMessageId: input.guidanceId })
    expect(emitted).toHaveLength(1)
  })

  it('keeps an early dropped fallback single-flight when the steer ACK is lost during delivery', async () => {
    const pendingAck = deferred<Record<string, unknown>>()
    const pendingSend = deferred<Record<string, unknown>>()
    const { client, request } = fakeClient()
    request.mockImplementation(() => pendingAck.promise)
    const { core, sendTask } = fakeCore(client)
    sendTask.mockImplementation(() => pendingSend.promise)
    const attempt = trySteerRunningTurn(core, client, input)
    const settlement = settleSteerNotification(core, 'turn/steer/dropped', dropped, input.serverId, client)
    pendingAck.reject(new Error('steer ACK lost'))
    pendingSend.resolve({ accepted: true })
    await expect(settlement).resolves.toBe(true)
    await expect(attempt).resolves.toEqual({ kind: 'queued', turnId: input.turnId })
    await settleSteerNotification(core, 'turn/steer/dropped', dropped, input.serverId, client)
    expect(sendTask).toHaveBeenCalledTimes(1)
    expect(emitted).toHaveLength(1)
  })

  it('does not resend after an ambiguous steer ACK or treat its absence as a dropped receipt', async () => {
    const { client, request } = fakeClient()
    request.mockRejectedValueOnce(new Error('ACK lost'))
    const { core, sendTask } = fakeCore(client)
    await expect(trySteerRunningTurn(core, client, input)).rejects.toThrow('ACK lost')
    await expect(trySteerRunningTurn(core, client, input)).rejects.toThrow('remains unknown')
    expect(await reconcileUnsettledSteers(core, input.taskId, input.serverId, client)).toBe(0)
    expect(request).toHaveBeenCalledTimes(1)
    expect(request.mock.calls.some(([method]) => method === 'turn/receipt/read')).toBe(false)
    expect(sendTask).not.toHaveBeenCalled()
    expect(emitted).toHaveLength(0)
  })

  it('falls back only for an exact dropped identity and prompt', async () => {
    const { client } = fakeClient()
    const { core, task, tasks, clientByTask, sendTask } = fakeCore(client)
    await trySteerRunningTurn(core, client, input)
    const wrongClient = fakeClient().client
    const mismatches: Array<[Record<string, unknown>, string, GatewayClient]> = [
      [{ ...dropped, threadId: 'other-thread' }, input.serverId, client],
      [{ ...dropped, turnId: 'other-turn' }, input.serverId, client],
      [{ ...dropped, text: 'different prompt' }, input.serverId, client],
      [dropped, 'other-server', client],
      [dropped, input.serverId, wrongClient],
    ]
    for (const [params, serverId, sourceClient] of mismatches) {
      await settleSteerNotification(core, 'turn/steer/dropped', params, serverId, sourceClient)
    }
    expect(sendTask).not.toHaveBeenCalled()
    expect(emitted).toHaveLength(0)

    task.threadId = 'replacement-thread'
    tasks.set(task.taskId, task)
    clientByTask.set(task.taskId, client)
    await settleSteerNotification(core, 'turn/steer/dropped', dropped, input.serverId, client)
    expect(sendTask).not.toHaveBeenCalled()
    expect(emitted).toHaveLength(0)
  })

  it('single-flights duplicate dropped settlements and leaves a failed fallback unapplied', async () => {
    const { client } = fakeClient()
    const { core, sendTask } = fakeCore(client)
    const pendingSend = deferred<Record<string, unknown>>()
    sendTask.mockImplementation(() => pendingSend.promise)
    await trySteerRunningTurn(core, client, input)
    const first = settleSteerNotification(core, 'turn/steer/dropped', dropped, input.serverId, client)
    await settleSteerNotification(core, 'turn/steer/dropped', dropped, input.serverId, client)
    expect(sendTask).toHaveBeenCalledTimes(1)
    pendingSend.reject(new Error('turn start rejected'))
    await expect(first).rejects.toThrow('turn start rejected')
    await settleSteerNotification(core, 'turn/steer/dropped', dropped, input.serverId, client)
    expect(sendTask).toHaveBeenCalledTimes(1)
    expect(emitted).toHaveLength(0)
  })

  it('preserves a fallback unknown across resume and reconciles only a positive receipt', async () => {
    const { client } = fakeClient()
    const { core, sendTask, clientByTask } = fakeCore(client)
    sendTask.mockRejectedValueOnce(new TurnAcceptanceUnknownError(new Error('start ACK lost')))
    await trySteerRunningTurn(core, client, input)
    await expect(settleSteerNotification(core, 'turn/steer/dropped', dropped, input.serverId, client))
      .rejects.toBeInstanceOf(TurnAcceptanceUnknownError)
    expect(sendTask).toHaveBeenCalledTimes(1)
    expect(emitted).toHaveLength(0)

    const resumed = fakeClient()
    resumed.request.mockImplementation(async method =>
      method === 'turn/receipt/read' ? { receipt: null } : { status: 'queued' }
    )
    clientByTask.set(input.taskId, resumed.client)
    expect(await reconcileUnsettledSteers(core, input.taskId, input.serverId, resumed.client)).toBe(0)
    expect(sendTask).toHaveBeenCalledTimes(1)
    expect(emitted).toHaveLength(0)

    resumed.request.mockImplementation(async method => method === 'turn/receipt/read'
      ? { receipt: { threadId: input.threadId, turnId: 'fallback-turn', status: 'running' } }
      : { status: 'queued' })
    expect(await reconcileUnsettledSteers(core, input.taskId, input.serverId, resumed.client)).toBe(1)
    expect(resumed.request).toHaveBeenCalledWith('turn/receipt/read', {
      threadId: input.threadId,
      clientMessageId: input.guidanceId,
    })
    expect(sendTask).toHaveBeenCalledTimes(1)
    expect(emitted).toHaveLength(1)
  })

  it('does not reconcile or replay pending steer work for a new client owner', async () => {
    const { client, request } = fakeClient()
    const { core, clientByTask, sendTask } = fakeCore(client)
    expect(await trySteerRunningTurn(core, client, input)).toMatchObject({ kind: 'queued' })
    const newOwner = fakeClient()
    clientByTask.set(input.taskId, newOwner.client)
    await settleSteerNotification(core, 'turn/steer/dropped', dropped, input.serverId, client)
    expect(await reconcileUnsettledSteers(core, input.taskId, input.serverId, newOwner.client)).toBe(0)
    expect(request.mock.calls.some(([method]) => method === 'turn/receipt/read')).toBe(false)
    expect(sendTask).not.toHaveBeenCalled()
    expect(emitted).toHaveLength(0)
  })
})
