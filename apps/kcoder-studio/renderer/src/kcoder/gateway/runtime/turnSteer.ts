import { emitRuntimeEvent as emit } from '../../gatewayServiceBridge'
import type { GatewayClient } from '../../gatewayRuntimeTypes'
import { EXECUTOR_EVENT, record, text } from './contracts'
import type { GatewayRuntimeCore } from './core'

export const TURN_STEER_CAPABILITY = 'turnSteerV1'

/** A guidance message accepted by the running turn but not yet in history. */
interface PendingGuidance {
  taskId: string
  serverId: string
  turnId: string
  message: string
  /** Exact text sent with the steer; redelivered if the server never settles it. */
  prompt: string
}

// Keyed by guidanceId (sent as the steer's clientMessageId). Settled exactly
// once by `turn/steer/applied` or `turn/steer/dropped`.
const pendingGuidance = new WeakMap<GatewayRuntimeCore, Map<string, PendingGuidance>>()

function pendingFor(core: GatewayRuntimeCore) {
  let map = pendingGuidance.get(core)
  if (!map) {
    map = new Map()
    pendingGuidance.set(core, map)
  }
  return map
}

export type SteerAttempt =
  | { kind: 'queued'; turnId: string }
  /** Nothing was recorded; the caller must deliver the guidance another way. */
  | { kind: 'fallback' }

/**
 * Add guidance to the running turn without interrupting it. Returns
 * `fallback` when the server cannot steer or no turn is running, so the caller
 * keeps the existing interrupt-and-restart path.
 */
export async function trySteerRunningTurn(
  core: GatewayRuntimeCore,
  client: GatewayClient,
  input: {
    taskId: string
    serverId: string
    threadId: string
    turnId: string
    guidanceId: string
    message: string
    prompt: string
  }
): Promise<SteerAttempt> {
  if (client.supportsExperimental?.(TURN_STEER_CAPABILITY) !== true) return { kind: 'fallback' }
  const result = record(
    await client.request<Record<string, unknown>>('turn/steer', {
      threadId: input.threadId,
      turnId: input.turnId,
      text: input.prompt,
      clientMessageId: input.guidanceId,
    })
  )
  if (result.status !== 'queued') return { kind: 'fallback' }
  pendingFor(core).set(input.guidanceId, {
    taskId: input.taskId,
    serverId: input.serverId,
    turnId: text(result.turnId) ?? input.turnId,
    message: input.message,
    prompt: input.prompt,
  })
  return { kind: 'queued', turnId: text(result.turnId) ?? input.turnId }
}

/** Handle `turn/steer/applied` and `turn/steer/dropped`; true when consumed. */
export async function settleSteerNotification(
  core: GatewayRuntimeCore,
  method: string,
  params: Record<string, unknown>,
  sourceServerId?: string
): Promise<boolean> {
  if (method !== 'turn/steer/applied' && method !== 'turn/steer/dropped') return false
  const guidanceId = text(params.clientMessageId)
  const pending = guidanceId ? pendingFor(core).get(guidanceId) : undefined
  if (!guidanceId || !pending || pending.serverId !== sourceServerId) return true
  pendingFor(core).delete(guidanceId)
  if (method === 'turn/steer/dropped') {
    // The turn ended before the steer entered history. Deliver it as the next
    // turn rather than losing it; the server returned the exact text it held.
    const prompt = text(params.text)
    if (!prompt) return true
    await core.sendTask(
      { taskId: pending.taskId, executionRequest: { prompt } },
      await core.taskConnection({ taskId: pending.taskId }).then(connection => connection.server),
      false
    )
  }
  await emit(EXECUTOR_EVENT, {
    event: 'response.guidance.applied',
    payload: {
      taskId: pending.taskId,
      subtaskId: pending.turnId,
      deviceId: pending.serverId,
      data: { guidanceId, message: pending.message, appliedAtMs: Date.now() },
    },
  })
  return true
}

/**
 * After a lost connection is recovered, deliver steers the old server process
 * never settled as the next turn, once each. A process that exits cannot send
 * `turn/steer/dropped`, and the interrupted turn is not resumed, so without
 * this the guidance would silently disappear.
 */
export async function redeliverUnsettledSteers(
  core: GatewayRuntimeCore,
  taskId: string,
  serverId: string
): Promise<number> {
  const unsettled = [...pendingFor(core)].filter(
    ([, pending]) => pending.taskId === taskId && pending.serverId === serverId
  )
  for (const [guidanceId] of unsettled) pendingFor(core).delete(guidanceId)
  if (unsettled.length === 0) return 0
  const prompt = unsettled.map(([, pending]) => pending.prompt).join('\n\n')
  await core.sendTask(
    { taskId, executionRequest: { prompt } },
    await core.taskConnection({ taskId }).then(connection => connection.server),
    false
  )
  return unsettled.length
}
