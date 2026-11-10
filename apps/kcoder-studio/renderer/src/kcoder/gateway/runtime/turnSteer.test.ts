import { beforeEach, describe, expect, it, vi } from 'vitest'

const emitted: unknown[] = []
vi.mock('../../gatewayServiceBridge', () => ({
  emitRuntimeEvent: vi.fn(async (_name: string, payload: unknown) => {
    emitted.push(payload)
  }),
}))

import {
  redeliverUnsettledSteers,
  settleSteerNotification,
  trySteerRunningTurn,
} from './turnSteer'
import type { GatewayRuntimeCore } from './core'
import type { GatewayClient } from '../../gatewayRuntimeTypes'

function fakeClient(status: string, supports = true) {
  const request = vi.fn(async () => ({ status, turnId: 'turn-1', steerId: 7 }))
  return {
    client: { supportsExperimental: () => supports, request } as unknown as GatewayClient,
    request,
  }
}

function fakeCore() {
  const sendTask = vi.fn(async () => ({}))
  const core = {
    sendTask,
    taskConnection: vi.fn(async () => ({ taskId: 'task-1', server: { id: 'server-1' } })),
  } as unknown as GatewayRuntimeCore
  return { core, sendTask }
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

describe('turn steering', () => {
  beforeEach(() => emitted.splice(0))

  it('falls back without a request when the server cannot steer', async () => {
    const { core } = fakeCore()
    const { client, request } = fakeClient('queued', false)
    expect(await trySteerRunningTurn(core, client, input)).toEqual({ kind: 'fallback' })
    expect(request).not.toHaveBeenCalled()
  })

  it('falls back when no turn accepted the steer', async () => {
    const { core } = fakeCore()
    const { client } = fakeClient('no_active_turn')
    expect(await trySteerRunningTurn(core, client, input)).toEqual({ kind: 'fallback' })
  })

  it('reports guidance as applied only once the turn applied the steer', async () => {
    const { core, sendTask } = fakeCore()
    const { client, request } = fakeClient('queued')
    expect(await trySteerRunningTurn(core, client, input)).toEqual({
      kind: 'queued',
      turnId: 'turn-1',
    })
    expect(request).toHaveBeenCalledWith('turn/steer', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      text: 'use staging',
      clientMessageId: 'guidance-1',
    })
    expect(emitted).toHaveLength(0)
    const applied = { threadId: 'thread-1', turnId: 'turn-1', steerId: 7, clientMessageId: 'guidance-1' }
    expect(await settleSteerNotification(core, 'turn/steer/applied', applied, 'server-1')).toBe(true)
    expect(emitted).toHaveLength(1)
    // A repeated notification settles nothing twice.
    await settleSteerNotification(core, 'turn/steer/applied', applied, 'server-1')
    expect(emitted).toHaveLength(1)
    expect(sendTask).not.toHaveBeenCalled()
  })

  it('resends a dropped steer as the next turn', async () => {
    const { core, sendTask } = fakeCore()
    const { client } = fakeClient('queued')
    await trySteerRunningTurn(core, client, input)
    await settleSteerNotification(
      core,
      'turn/steer/dropped',
      { threadId: 'thread-1', turnId: 'turn-1', steerId: 7, clientMessageId: 'guidance-1', text: 'use staging' },
      'server-1'
    )
    expect(sendTask).toHaveBeenCalledWith(
      { taskId: 'task-1', executionRequest: { prompt: 'use staging' } },
      { id: 'server-1' },
      false
    )
    expect(emitted).toHaveLength(1)
  })

  it('ignores other notifications', async () => {
    const { core } = fakeCore()
    expect(await settleSteerNotification(core, 'turn/completed', {}, 'server-1')).toBe(false)
  })

  it('redelivers a steer once when its server process exited before settling it', async () => {
    const { core, sendTask } = fakeCore()
    const { client } = fakeClient('queued')
    await trySteerRunningTurn(core, client, input)
    expect(await redeliverUnsettledSteers(core, 'task-1', 'server-2')).toBe(0)
    expect(await redeliverUnsettledSteers(core, 'task-1', 'server-1')).toBe(1)
    expect(sendTask).toHaveBeenCalledWith(
      { taskId: 'task-1', executionRequest: { prompt: 'use staging' } },
      { id: 'server-1' },
      false
    )
    // A late settlement or a second recovery delivers nothing again.
    expect(await redeliverUnsettledSteers(core, 'task-1', 'server-1')).toBe(0)
    const dropped = { clientMessageId: 'guidance-1', text: 'use staging' }
    await settleSteerNotification(core, 'turn/steer/dropped', dropped, 'server-1')
    expect(sendTask).toHaveBeenCalledTimes(1)
  })
})
