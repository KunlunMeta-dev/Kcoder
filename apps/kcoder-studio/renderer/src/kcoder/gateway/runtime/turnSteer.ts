import { readTurnReceipt } from '../../../../../shared/turnReceipt'
import type { GatewayClient } from '../../gatewayRuntimeTypes'
import { emitRuntimeEvent as emit } from '../../gatewayServiceBridge'
import { TurnAcceptanceUnknownError } from '../../gatewayTurnReceipt'
import { RuntimeInputRejectedError, isRuntimeInputRejected } from '../../rpcOutcome'
import { EXECUTOR_EVENT, record, text } from './contracts'
import type { GatewayRuntimeCore } from './core'
import { isThreadNotResident, markThreadEvicted } from './threadResidency'

export const TURN_STEER_CAPABILITY = 'turnSteerV1'
export const TURN_STEER_ATTACHMENTS_CAPABILITY = 'turnSteerAttachmentsV1'

type PendingPhase =
  | 'submitting'
  | 'queued'
  | 'unknown'
  | 'settling'
  | 'fallback_authorized'
  | 'fallback_unknown'

type SettlementOutcome =
  | { kind: 'applied' }
  | { kind: 'fallback_accepted' }
  | { kind: 'failed'; error: unknown }
  | { kind: 'unknown'; error: unknown }

interface GuidanceIdentity {
  taskId: string
  serverId: string
  threadId: string
  turnId?: string
  guidanceId: string
  message: string
  prompt: string
  attachments?: unknown[]
  interruptFirst?: boolean
}

/** A steer or its explicitly authorized fallback that has not settled locally. */
interface PendingGuidance extends Omit<GuidanceIdentity, 'guidanceId'> {
  client: GatewayClient
  connectionId?: string
  phase: PendingPhase
  steerId?: number
  wirePrompt?: string
  settlementOutcome: Promise<SettlementOutcome>
  resolveSettlementOutcome: (outcome: SettlementOutcome) => void
}

// Keyed by guidanceId (the clientMessageId used for steer and fallback start).
const pendingGuidance = new WeakMap<GatewayRuntimeCore, Map<string, PendingGuidance>>()

function pendingFor(core: GatewayRuntimeCore) {
  let map = pendingGuidance.get(core)
  if (!map) {
    map = new Map()
    pendingGuidance.set(core, map)
  }
  return map
}

function connectionId(client: GatewayClient): string | undefined {
  return text(client.diagnosticConnection?.connectionId) ?? undefined
}

function ownsGuidance(core: GatewayRuntimeCore, pending: PendingGuidance, client: GatewayClient): boolean {
  const task = core.tasks.get(pending.taskId)
  return !core.disposed &&
    task?.taskId === pending.taskId &&
    task.serverId === pending.serverId &&
    task.threadId === pending.threadId &&
    core.clientByTask.get(pending.taskId) === client &&
    pending.client === client &&
    (pending.connectionId === undefined || connectionId(client) === pending.connectionId)
}

function resolveSettlement(pending: PendingGuidance, outcome: SettlementOutcome) {
  pending.resolveSettlementOutcome(outcome)
}

function settlementAttempt(outcome: SettlementOutcome, turnId?: string): SteerAttempt {
  if (outcome.kind === 'applied' || outcome.kind === 'fallback_accepted') {
    if (turnId) return { kind: 'queued', turnId }
    throw new Error('Steer settlement is missing its turn identity')
  }
  throw outcome.error instanceof Error ? outcome.error : new Error('Guidance acceptance remains unknown')
}

function makePending(identity: GuidanceIdentity, client: GatewayClient, phase: PendingPhase): PendingGuidance {
  let resolveSettlementOutcome!: (outcome: SettlementOutcome) => void
  const settlementOutcome = new Promise<SettlementOutcome>(resolve => {
    resolveSettlementOutcome = resolve
  })
  return {
    taskId: identity.taskId,
    serverId: identity.serverId,
    threadId: identity.threadId,
    turnId: identity.turnId,
    client,
    connectionId: connectionId(client),
    message: identity.message,
    prompt: identity.prompt,
    attachments: identity.attachments,
    phase,
    settlementOutcome,
    resolveSettlementOutcome,
  }
}

function matchesIdentity(pending: PendingGuidance, input: GuidanceIdentity, client: GatewayClient) {
  return pending.taskId === input.taskId &&
    pending.serverId === input.serverId &&
    pending.threadId === input.threadId &&
    pending.turnId === input.turnId &&
    pending.client === client &&
    pending.message === input.message &&
    pending.prompt === input.prompt &&
    JSON.stringify(pending.attachments ?? []) === JSON.stringify(input.attachments ?? [])
}

function ensureCurrentOwner(core: GatewayRuntimeCore, identity: GuidanceIdentity, client: GatewayClient) {
  const task = core.tasks.get(identity.taskId)
  if (
    core.disposed || task?.serverId !== identity.serverId || task.threadId !== identity.threadId ||
    core.clientByTask.get(identity.taskId) !== client
  ) throw new Error('Guidance owner changed before delivery')
}

function releaseStaleFallbackAuthorization(core: GatewayRuntimeCore, guidanceId: string) {
  const pendingMap = pendingGuidance.get(core)
  const pending = pendingMap?.get(guidanceId)
  if (
    !pending || pending.phase !== 'fallback_authorized' ||
    ownsGuidance(core, pending, pending.client)
  ) return
  pendingMap?.delete(guidanceId)
  resolveSettlement(pending, {
    kind: 'failed',
    error: new Error('Guidance owner changed before fallback delivery'),
  })
}

export type SteerAttempt =
  | { kind: 'queued'; turnId: string }
  /** The server explicitly confirmed it recorded nothing; caller may deliver once. */
  | { kind: 'fallback' }

/**
 * Add guidance to the running turn without interrupting it. The pending
 * identity is registered before sending so an early settlement is not lost.
 */
export async function trySteerRunningTurn(
  core: GatewayRuntimeCore,
  client: GatewayClient,
  input: GuidanceIdentity & { turnId: string }
): Promise<SteerAttempt> {
  if (client.supportsExperimental?.(TURN_STEER_CAPABILITY) !== true) return { kind: 'fallback' }
  if (input.attachments?.length &&
      client.supportsExperimental?.(TURN_STEER_ATTACHMENTS_CAPABILITY) !== true) return { kind: 'fallback' }
  releaseStaleFallbackAuthorization(core, input.guidanceId)
  ensureCurrentOwner(core, input, client)

  const pendingMap = pendingFor(core)
  const previous = pendingMap.get(input.guidanceId)
  if (previous) {
    if (!matchesIdentity(previous, input, client))
      throw new Error('Guidance identity is already owned by another request')
    if (previous.phase === 'queued') return { kind: 'queued', turnId: input.turnId }
    if (previous.phase === 'fallback_authorized') return { kind: 'fallback' }
    if (previous.phase === 'settling' || previous.phase === 'fallback_unknown')
      return settlementAttempt(await previous.settlementOutcome, input.turnId)
    throw new Error('Guidance acceptance remains unknown; do not resend it')
  }

  const pending = makePending(input, client, 'submitting')
  pendingMap.set(input.guidanceId, pending)
  try {
    if (input.attachments?.length) {
      const { server } = await core.taskConnection({ taskId: input.taskId })
      const settings = await core.sharedRuntimeContext(client)
      pending.wirePrompt = await core.remoteSessions.promptWithAttachmentsForClient(
        input.prompt, { attachments: input.attachments }, server, client, settings, input.threadId
      )
    } else {
      pending.wirePrompt = input.prompt
    }
    if (!ownsGuidance(core, pending, client))
      throw new Error('Guidance owner changed before delivery')
  } catch (error) {
    // Uploading a file does not submit the guidance. Keep explicit preparation
    // failures retryable instead of claiming that its acceptance is unknown.
    if (pendingMap.get(input.guidanceId) === pending) pendingMap.delete(input.guidanceId)
    resolveSettlement(pending, { kind: 'failed', error })
    throw error instanceof RuntimeInputRejectedError ? error : new RuntimeInputRejectedError(error)
  }
  const params = {
    threadId: input.threadId,
    turnId: input.turnId,
    text: pending.wirePrompt,
    clientMessageId: input.guidanceId,
  }
  let request: Promise<Record<string, unknown>>
  try {
    if (pending.connectionId) {
      if (!client.requestOnConnection)
        throw new Error('Bound Gateway connection cannot send a steer request')
      request = client.requestOnConnection(pending.connectionId, 'turn/steer', params)
    } else {
      request = client.request<Record<string, unknown>>('turn/steer', params)
    }
  } catch (error) {
    pending.phase = 'unknown'
    throw error
  }
  const ack = request.then(
    value => ({ kind: 'reply' as const, value: record(value) }),
    error => ({ kind: 'error' as const, error })
  )
  const first = await Promise.race([
    ack,
    pending.settlementOutcome.then(outcome => ({ kind: 'settlement' as const, outcome })),
  ])
  if (first.kind === 'settlement') return settlementAttempt(first.outcome, input.turnId)

  if (first.kind === 'error') {
    if (pending.phase === 'settling' || pending.phase === 'fallback_unknown')
      return settlementAttempt(await pending.settlementOutcome, input.turnId)
    const evicted = client.supportsExperimental?.('threadResidencyV1') === true &&
      isThreadNotResident(first.error, input.threadId, input.serverId)
    if (evicted || isRuntimeInputRejected(first.error)) {
      // The original running turn is gone. A resumed thread cannot accept
      // guidance for that turn, but it can be used by the next normal input.
      if (evicted && ownsGuidance(core, pending, client)) markThreadEvicted(client, input.threadId)
      pendingMap.delete(input.guidanceId)
      const error = evicted ? new RuntimeInputRejectedError(first.error) : first.error
      resolveSettlement(pending, { kind: 'failed', error })
      throw error
    } else {
      pending.phase = 'unknown'
    }
    throw first.error
  }

  if (!ownsGuidance(core, pending, client)) {
    pending.phase = 'unknown'
    throw new Error('Guidance owner changed while steering; acceptance remains unknown')
  }
  const status = text(first.value.status)
  if (status === 'queued') {
    const acknowledgedTurnId = text(first.value.turnId) ?? input.turnId
    if (acknowledgedTurnId !== input.turnId) {
      if (pending.phase === 'settling' || pending.phase === 'fallback_unknown')
        return settlementAttempt(await pending.settlementOutcome, input.turnId)
      pending.phase = 'unknown'
      throw new Error('Steer acknowledgement belongs to another turn')
    }
    const acknowledgedSteerId = first.value.steerId
    if (typeof acknowledgedSteerId === 'number' && Number.isSafeInteger(acknowledgedSteerId))
      pending.steerId = acknowledgedSteerId
    if (pending.phase === 'submitting') pending.phase = 'queued'
    return { kind: 'queued', turnId: input.turnId }
  }
  if (status === 'no_active_turn' || status === 'busy' || status === 'queue_full') {
    if (pending.phase === 'settling' || pending.phase === 'fallback_unknown')
      return settlementAttempt(await pending.settlementOutcome, input.turnId)
    pending.phase = 'fallback_authorized'
    return { kind: 'fallback' }
  }

  if (pending.phase === 'settling' || pending.phase === 'fallback_unknown')
    return settlementAttempt(await pending.settlementOutcome, input.turnId)
  pending.phase = 'unknown'
  throw new Error('Steer acknowledgement did not confirm acceptance')
}

async function emitGuidanceApplied(
  pending: PendingGuidance,
  guidanceId: string,
  turnId?: string
) {
  await emit(EXECUTOR_EVENT, {
    event: 'response.guidance.applied',
    payload: {
      taskId: pending.taskId,
      ...(turnId ? { subtaskId: turnId } : {}),
      deviceId: pending.serverId,
      data: { guidanceId, message: pending.message, appliedAtMs: Date.now() },
    },
  })
}

/** Send one normal turn only after a known rejection or exact dropped event. */
export async function deliverGuidanceFallback(
  core: GatewayRuntimeCore,
  client: GatewayClient,
  input: GuidanceIdentity
): Promise<Record<string, unknown>> {
  releaseStaleFallbackAuthorization(core, input.guidanceId)
  ensureCurrentOwner(core, input, client)
  const pendingMap = pendingFor(core)
  let pending = pendingMap.get(input.guidanceId)
  if (pending) {
    if (!matchesIdentity(pending, input, client) ||
        (pending.phase !== 'fallback_authorized' && pending.phase !== 'settling'))
      throw new Error('Guidance fallback is already in progress or has an unknown outcome')
  } else {
    pending = makePending(input, client, 'fallback_authorized')
    pendingMap.set(input.guidanceId, pending)
  }

  pending.phase = 'settling'
  let fallbackAccepted = false
  try {
    const { task, server: currentServer, client: currentClient } = await core.taskConnection({ taskId: input.taskId })
    if (
      task.serverId !== input.serverId || task.threadId !== input.threadId ||
      currentServer.id !== input.serverId || currentClient !== client ||
      !ownsGuidance(core, pending, client)
    ) throw new TurnAcceptanceUnknownError(new Error('Guidance owner changed before fallback send'))
    const result = record(await core.sendTask(
      {
        taskId: input.taskId,
        clientMessageId: input.guidanceId,
        executionRequest: {
          prompt: input.prompt,
          ...(input.attachments ? { attachments: input.attachments } : {}),
        },
      },
      currentServer,
      input.interruptFirst === true,
      client
    ))
    if (result.accepted !== true) {
      pendingMap.delete(input.guidanceId)
      resolveSettlement(pending, { kind: 'failed', error: new Error('Guidance fallback was rejected') })
      return result
    }
    fallbackAccepted = true
    if (!ownsGuidance(core, pending, client))
      throw new TurnAcceptanceUnknownError(new Error('Guidance owner changed after fallback send'))
    const activeTurnId = text(core.activeTurnByTask.get(input.taskId)?.turnId) ?? undefined
    await emitGuidanceApplied(pending, input.guidanceId, activeTurnId)
    if (pendingMap.get(input.guidanceId) === pending) pendingMap.delete(input.guidanceId)
    resolveSettlement(pending, { kind: 'fallback_accepted' })
    return result
  } catch (error) {
    const unknown = fallbackAccepted || error instanceof TurnAcceptanceUnknownError
    if (unknown) pending.phase = 'fallback_unknown'
    else if (pendingMap.get(input.guidanceId) === pending) pendingMap.delete(input.guidanceId)
    resolveSettlement(pending, unknown ? { kind: 'unknown', error } : { kind: 'failed', error })
    throw error
  }
}

/** Handle `turn/steer/applied` and `turn/steer/dropped`; true when consumed. */
export async function settleSteerNotification(
  core: GatewayRuntimeCore,
  method: string,
  params: Record<string, unknown>,
  sourceServerId?: string,
  sourceClient?: GatewayClient
): Promise<boolean> {
  if (method !== 'turn/steer/applied' && method !== 'turn/steer/dropped') return false
  const guidanceId = text(params.clientMessageId)
  const pendingMap = pendingFor(core)
  const pending = guidanceId ? pendingMap.get(guidanceId) : undefined
  if (!guidanceId || !pending) return true

  const currentTask = core.tasks.get(pending.taskId)
  if (!currentTask || currentTask.serverId !== pending.serverId || currentTask.threadId !== pending.threadId) {
    pendingMap.delete(guidanceId)
    resolveSettlement(pending, { kind: 'failed', error: new Error('Guidance task owner changed') })
    return true
  }
  if (
    pending.serverId !== sourceServerId ||
    !sourceClient ||
    !ownsGuidance(core, pending, sourceClient) ||
    !pending.turnId ||
    text(params.threadId) !== pending.threadId ||
    text(params.turnId) !== pending.turnId ||
    typeof params.steerId !== 'number' || !Number.isSafeInteger(params.steerId) ||
    (pending.steerId !== undefined && params.steerId !== pending.steerId) ||
    (method === 'turn/steer/dropped' && params.text !== pending.wirePrompt)
  ) return true
  if (
    pending.phase === 'settling' || pending.phase === 'fallback_unknown' ||
    pending.phase === 'fallback_authorized'
  ) return true

  pending.phase = 'settling'
  if (method === 'turn/steer/applied') {
    try {
      await emitGuidanceApplied(pending, guidanceId, pending.turnId)
      pendingMap.delete(guidanceId)
      resolveSettlement(pending, { kind: 'applied' })
    } catch (error) {
      pending.phase = 'unknown'
      resolveSettlement(pending, { kind: 'unknown', error })
      throw error
    }
    return true
  }

  await deliverGuidanceFallback(
    core,
    sourceClient,
    {
      taskId: pending.taskId,
      serverId: pending.serverId,
      threadId: pending.threadId,
      turnId: pending.turnId,
      guidanceId,
      message: pending.message,
      prompt: pending.prompt,
      ...(pending.attachments ? { attachments: pending.attachments } : {}),
    }
  )
  return true
}

/** Reconcile only a fallback whose explicit dropped/rejected outcome authorized a start. */
export async function reconcileUnsettledSteers(
  core: GatewayRuntimeCore,
  taskId: string,
  serverId: string,
  client: GatewayClient
): Promise<number> {
  const task = core.tasks.get(taskId)
  if (!task || task.serverId !== serverId || core.clientByTask.get(taskId) !== client || core.disposed) return 0
  const candidates = [...pendingFor(core)].filter(([, pending]) =>
    pending.taskId === taskId && pending.serverId === serverId && pending.phase === 'fallback_unknown'
  )
  let reconciled = 0
  await Promise.all(candidates.map(async ([guidanceId, pending]) => {
    if (pending.threadId !== task.threadId) {
      pendingFor(core).delete(guidanceId)
      return
    }
    try {
      const result = await readTurnReceipt(client, {
        threadId: pending.threadId,
        clientMessageId: guidanceId,
      })
      const currentTask = core.tasks.get(taskId)
      if (
        pendingFor(core).get(guidanceId) !== pending ||
        pending.phase !== 'fallback_unknown' ||
        currentTask?.serverId !== serverId || currentTask.threadId !== pending.threadId ||
        core.clientByTask.get(taskId) !== client || core.disposed || !result.turn
      ) return
      await emitGuidanceApplied(pending, guidanceId, result.turn.id)
      if (pendingFor(core).get(guidanceId) === pending) {
        pendingFor(core).delete(guidanceId)
        reconciled += 1
      }
    } catch {
      // No receipt is not proof that the steer or fallback did not run.
    }
  }))
  return reconciled
}

export function clearPendingSteersForTask(
  core: GatewayRuntimeCore,
  taskId: string,
  threadId?: string
) {
  const map = pendingFor(core)
  for (const [guidanceId, pending] of map) {
    if (pending.taskId !== taskId || (threadId && pending.threadId !== threadId)) continue
    map.delete(guidanceId)
    resolveSettlement(pending, { kind: 'failed', error: new Error('Guidance task owner was disposed') })
  }
}

export function disposePendingSteers(core: GatewayRuntimeCore) {
  const map = pendingGuidance.get(core)
  if (!map) return
  for (const pending of map.values())
    resolveSettlement(pending, { kind: 'failed', error: new Error('Gateway runtime was disposed') })
  map.clear()
  pendingGuidance.delete(core)
}
