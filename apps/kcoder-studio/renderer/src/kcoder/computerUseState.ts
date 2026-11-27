export type ComputerUseState = 'active' | 'stopping' | 'stopped' | 'stop_failed' | 'unknown'
export type ComputerUseDiagnostic = {
  authorization: 'valid' | 'revoked' | 'unknown'
  channel: 'available' | 'unavailable' | 'unknown'
  cleanup: 'pending' | 'confirmed' | 'failed' | 'unknown'
  failureCode?: string
  operationId?: string
  tool?: string
  elapsedMs?: number
  hostPid?: number
  workerPid?: number
}
export type ComputerUseSnapshot = {
  turnId: string
  state: ComputerUseState
  attemptId?: string
  diagnostic?: ComputerUseDiagnostic
  recoveryAvailable?: boolean
}
export type ComputerUseConnectionOwner = object | string
export type ComputerUseObservationToken = Readonly<{
  owner: object
  serverId: string
  taskId: string
  turnId: string
  attemptId?: string
  connectionOwner: ComputerUseConnectionOwner
  epoch: number
  ticket: object
  requireActiveTurn: boolean
}>
function diagnostic(value: unknown): ComputerUseDiagnostic | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (
    !['valid', 'revoked', 'unknown'].includes(String(record.authorization)) ||
    !['available', 'unavailable', 'unknown'].includes(String(record.channel)) ||
    !['pending', 'confirmed', 'failed', 'unknown'].includes(String(record.cleanup))
  )
    return undefined
  return {
    authorization: record.authorization as ComputerUseDiagnostic['authorization'],
    channel: record.channel as ComputerUseDiagnostic['channel'],
    cleanup: record.cleanup as ComputerUseDiagnostic['cleanup'],
    ...(typeof record.failureCode === 'string' && /^[a-z_]{1,64}$/.test(record.failureCode)
      ? { failureCode: record.failureCode }
      : {}),
    ...(typeof record.operationId === 'string' &&
    /^[A-Za-z0-9_.:-]{1,128}$/.test(record.operationId)
      ? { operationId: record.operationId }
      : {}),
    ...(typeof record.tool === 'string' &&
    [
      'Snapshot',
      'Screenshot',
      'DisplayInventory',
      'App',
      'Click',
      'Type',
      'Scroll',
      'Move',
      'Shortcut',
      'WaitFor',
    ].includes(record.tool)
      ? { tool: record.tool }
      : {}),
    ...(typeof record.hostPid === 'number' &&
    Number.isSafeInteger(record.hostPid) &&
    record.hostPid > 0
      ? { hostPid: record.hostPid }
      : {}),
    ...(typeof record.workerPid === 'number' &&
    Number.isSafeInteger(record.workerPid) &&
    record.workerPid > 0
      ? { workerPid: record.workerPid }
      : {}),
    ...(typeof record.elapsedMs === 'number' &&
    Number.isSafeInteger(record.elapsedMs) &&
    record.elapsedMs >= 0
      ? { elapsedMs: record.elapsedMs }
      : {}),
  }
}
type Entry = {
  owner: object
  connectionOwner?: ComputerUseConnectionOwner
  sequence?: number
  epoch: number
  // Lifecycle ownership follows the current turn/attempt; the snapshot can still project an older turn.
  latestTurnId: string
  terminalAttemptId?: string
  snapshot?: ComputerUseSnapshot
  attemptId?: string
  pendingQuery?: object
  nextAttempt?: { id: string; sequence: number }
  minimumSequence?: number
}
const validStates = new Set(['active', 'stopping', 'stopped', 'stop_failed'])
function sequence(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined
}

/** Ephemeral host observations only. Never persists consent or infers release
 * from a generic turn completion / disconnected transport. */
export class ComputerUseStateStore {
  private entries = new Map<string, Entry>()
  private listeners = new Set<() => void>()
  private key(serverId: string, taskId: string) {
    return JSON.stringify([serverId, taskId])
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  private changed() {
    for (const listener of this.listeners) listener()
  }
  get(serverId: string, taskId: string): ComputerUseSnapshot | null {
    return this.entries.get(this.key(serverId, taskId))?.snapshot ?? null
  }
  isLatestTurn(owner: object, serverId: string, taskId: string, turnId: string): boolean {
    const entry = this.entries.get(this.key(serverId, taskId))
    return entry?.owner === owner && entry.latestTurnId === turnId
  }
  noteTurnStarted(
    owner: object,
    serverId: string,
    taskId: string,
    turnId: string,
    attemptId?: string
  ) {
    const entry = this.entries.get(this.key(serverId, taskId))
    if (entry?.owner !== owner || !turnId) return
    const newTurn = entry.latestTurnId !== turnId
    if (newTurn) {
      entry.epoch += 1
      entry.terminalAttemptId = undefined
      entry.minimumSequence = undefined
      entry.nextAttempt = undefined
    }
    entry.latestTurnId = turnId
    if (newTurn) entry.attemptId = attemptId ?? turnId
  }
  beginAttempt(
    owner: object,
    serverId: string,
    taskId: string,
    turnId: string,
    attemptId: string,
    attemptSequence: number,
    connectionOwner?: ComputerUseConnectionOwner
  ) {
    const entry = this.entries.get(this.key(serverId, taskId))
    if (
      !entry ||
      entry.owner !== owner ||
      entry.latestTurnId !== turnId ||
      !attemptId ||
      attemptId.length > 256 ||
      !Number.isSafeInteger(attemptSequence) ||
      attemptSequence < 0
    )
      return
    const sameConnection = entry.connectionOwner === connectionOwner
    if (sameConnection && entry.sequence !== undefined && attemptSequence <= entry.sequence) return
    const sameAttempt = (entry.attemptId ?? entry.snapshot?.attemptId ?? turnId) === attemptId
    if (sameConnection && sameAttempt) {
      if (entry.minimumSequence === undefined) entry.minimumSequence = attemptSequence
      return
    }
    if (!sameConnection) {
      entry.sequence = undefined
      entry.minimumSequence = undefined
    }
    entry.connectionOwner = connectionOwner
    entry.minimumSequence = attemptSequence
    entry.nextAttempt = sameAttempt ? undefined : { id: attemptId, sequence: attemptSequence }
    if (!sameAttempt) {
      entry.terminalAttemptId = undefined
      entry.attemptId = attemptId
    }
    entry.epoch += 1
  }
  apply(
    owner: object,
    serverId: string,
    taskId: string,
    turnId: string,
    payload: Record<string, unknown>,
    connectionOwner?: ComputerUseConnectionOwner
  ) {
    if (!validStates.has(String(payload.state)) || payload.target !== 'local_windows_desktop')
      return
    const state = payload.state as ComputerUseState
    const key = this.key(serverId, taskId)
    const previous = this.entries.get(key)
    const sameOwner = previous?.owner === owner
    const sameConnection = sameOwner && previous.connectionOwner === connectionOwner
    const matching = sameOwner && previous.snapshot?.turnId === turnId
    const sameTurn = sameOwner && previous.latestTurnId === turnId
    const eventSequence = sequence(payload.sequence)
    if (
      sameConnection &&
      previous.sequence !== undefined &&
      (eventSequence === undefined || eventSequence <= previous.sequence)
    )
      return
    if (
      sameTurn && sameConnection &&
      previous.minimumSequence !== undefined &&
      (eventSequence === undefined || eventSequence < previous.minimumSequence)
    )
      return
    const nextAttempt = sameTurn && sameConnection ? previous.nextAttempt : undefined
    const freshAttempt =
      nextAttempt &&
      eventSequence !== undefined &&
      eventSequence >= nextAttempt.sequence
    const eventAttemptId = freshAttempt
      ? nextAttempt.id
      : sameTurn
        ? (previous.attemptId ?? (matching ? previous.snapshot?.attemptId : undefined) ?? turnId)
        : turnId
    if (nextAttempt && !freshAttempt) return
    if (sameTurn && previous.terminalAttemptId === eventAttemptId && state === 'active') return
    if (matching && previous.snapshot && sameConnection && !freshAttempt) {
      const old = previous.snapshot.state
      if (old === 'stopped' && state !== 'stopped') return
      if (old === state && payload.diagnostic === undefined) return
      if (
        (old === 'stop_failed' || old === 'unknown') &&
        state !== old &&
        state !== 'stopped' &&
        state !== 'stopping' &&
        !(old === 'unknown' && eventSequence !== undefined &&
          (state === 'stop_failed' ||
            (state === 'active' && previous.terminalAttemptId !== (previous.snapshot.attemptId ?? turnId))))
      )
        return
      if (old === 'stopping' && state === 'active') return
    }
    const facts = diagnostic(payload.diagnostic)
    const attemptId = eventAttemptId
    const nextEpoch = sameOwner
      ? previous.epoch + (facts?.authorization === 'revoked' ? 1 : 0)
      : 0
    this.entries.set(key, {
      owner,
      connectionOwner,
      sequence: eventSequence ?? (sameConnection ? previous.sequence : undefined),
      epoch: nextEpoch,
      latestTurnId: turnId,
      terminalAttemptId: sameTurn && !freshAttempt ? previous.terminalAttemptId : undefined,
      attemptId,
      pendingQuery: sameOwner ? previous.pendingQuery : undefined,
      minimumSequence: freshAttempt
        ? nextAttempt.sequence
        : sameTurn && sameConnection
          ? previous.minimumSequence
          : undefined,
      snapshot: {
        turnId,
        state,
        attemptId,
        ...(facts
          ? {
              diagnostic: facts,
              recoveryAvailable:
                payload.recoveryAvailable === true && facts.authorization === 'valid',
            }
          : {}),
      },
    })
    this.changed()
  }
  captureUnsettled(
    owner: object,
    serverId: string,
    taskId: string,
    connectionOwner: ComputerUseConnectionOwner
  ): ComputerUseObservationToken | null {
    const entry = this.entries.get(this.key(serverId, taskId))
    if (
      !entry ||
      entry.owner !== owner ||
      !entry.snapshot ||
      (entry.snapshot?.state !== 'unknown' && entry.snapshot?.state !== 'stop_failed') ||
      !entry.latestTurnId
    )
      return null
    const ticket = {}
    entry.pendingQuery = ticket
    const attemptId =
      entry.attemptId ??
      (entry.snapshot.turnId === entry.latestTurnId ? entry.snapshot.attemptId : undefined)
    return {
      owner,
      serverId,
      taskId,
      turnId: entry.latestTurnId,
      ...(attemptId ? { attemptId } : {}),
      connectionOwner,
      epoch: entry.epoch,
      ticket,
      requireActiveTurn: false,
    }
  }
  captureActiveTurn(
    owner: object,
    serverId: string,
    taskId: string,
    turnId: string,
    attemptId: string,
    connectionOwner: ComputerUseConnectionOwner
  ): ComputerUseObservationToken | null {
    if (!turnId || !attemptId || attemptId.length > 256) return null
    const key = this.key(serverId, taskId)
    let entry = this.entries.get(key)
    if (entry && entry.owner !== owner) return null
    if (!entry) {
      entry = {
        owner,
        connectionOwner,
        epoch: 0,
        latestTurnId: turnId,
        attemptId,
      }
      this.entries.set(key, entry)
    } else {
      const sameConnection = entry.connectionOwner === connectionOwner
      if (
        sameConnection &&
        entry.snapshot?.turnId === turnId &&
        (entry.snapshot.attemptId ?? turnId) === attemptId &&
        entry.snapshot.state !== 'unknown'
      )
        return null
      const attemptChanged = (entry.attemptId ?? entry.snapshot?.attemptId ?? turnId) !== attemptId
      if (entry.latestTurnId !== turnId || !sameConnection || attemptChanged) {
        entry.epoch += 1
        entry.terminalAttemptId = undefined
        entry.nextAttempt = undefined
      }
      if (!sameConnection) {
        entry.sequence = undefined
        entry.minimumSequence = undefined
      }
      entry.connectionOwner = connectionOwner
      entry.latestTurnId = turnId
      entry.attemptId = attemptId
    }
    const ticket = {}
    entry.pendingQuery = ticket
    return {
      owner,
      serverId,
      taskId,
      turnId,
      attemptId,
      connectionOwner,
      epoch: entry.epoch,
      ticket,
      requireActiveTurn: true,
    }
  }
  releaseObservation(token: ComputerUseObservationToken) {
    const key = this.key(token.serverId, token.taskId)
    const entry = this.entries.get(key)
    if (entry?.owner !== token.owner || entry.pendingQuery !== token.ticket) return
    if (!entry.snapshot) this.entries.delete(key)
    else entry.pendingQuery = undefined
  }
  applyObservation(
    token: ComputerUseObservationToken,
    connectionOwner: ComputerUseConnectionOwner,
    observedSequence: number,
    observation: Record<string, unknown>
  ): boolean {
    const entry = this.entries.get(this.key(token.serverId, token.taskId))
    const matchingSnapshot = entry?.snapshot?.turnId === token.turnId
    const currentAttemptId = matchingSnapshot
      ? (entry?.attemptId ?? entry.snapshot?.attemptId)
      : entry?.attemptId
    if (
      !entry ||
      entry.owner !== token.owner ||
      entry.epoch !== token.epoch ||
      entry.latestTurnId !== token.turnId ||
      currentAttemptId !== token.attemptId ||
      entry.pendingQuery !== token.ticket ||
      (entry.terminalAttemptId === (token.attemptId ?? token.turnId) &&
        observation.state === 'active') ||
      token.connectionOwner !== connectionOwner ||
      !Number.isSafeInteger(observedSequence) ||
      observedSequence < 0 ||
      !validStates.has(String(observation.state)) ||
      observation.target !== 'local_windows_desktop'
    )
      return false
    const sameConnection = entry.connectionOwner === connectionOwner
    if (sameConnection && entry.sequence !== undefined && observedSequence <= entry.sequence)
      return false
    const facts = diagnostic(observation.diagnostic)
    this.entries.set(this.key(token.serverId, token.taskId), {
      ...entry,
      connectionOwner,
      sequence: observedSequence,
      epoch: entry.epoch,
      attemptId: token.attemptId,
      pendingQuery: undefined,
      minimumSequence: sameConnection ? entry.minimumSequence : undefined,
      nextAttempt: sameConnection ? entry.nextAttempt : undefined,
      snapshot: {
        ...(matchingSnapshot ? entry.snapshot : {}),
        turnId: token.turnId,
        ...(token.attemptId ? { attemptId: token.attemptId } : {}),
        state: observation.state as ComputerUseState,
        ...(facts
          ? {
              diagnostic: facts,
              recoveryAvailable:
                observation.recoveryAvailable === true && facts.authorization === 'valid',
            }
          : { diagnostic: undefined, recoveryAvailable: false }),
      },
    })
    this.changed()
    return true
  }
  revoked(owner: object, serverId: string, taskId: string) {
    const entry = this.entries.get(this.key(serverId, taskId))
    if (!entry || entry.owner !== owner) return
    entry.epoch += 1
    if (!entry.snapshot) return
    entry.snapshot = entry.snapshot.diagnostic
      ? {
          ...entry.snapshot,
          recoveryAvailable: false,
          diagnostic: { ...entry.snapshot.diagnostic, authorization: 'revoked' },
        }
      : { ...entry.snapshot, recoveryAvailable: false }
    this.changed()
  }
  unconfirmed(
    owner: object,
    serverId: string,
    taskId: string,
    turnId?: string,
    terminal = false
  ) {
    const entry = this.entries.get(this.key(serverId, taskId))
    if (
      !entry ||
      entry.owner !== owner ||
      (turnId && entry.latestTurnId !== turnId)
    )
      return
    entry.epoch += 1
    if (terminal) entry.terminalAttemptId = entry.attemptId ?? entry.snapshot?.attemptId ?? entry.latestTurnId
    if (!entry.snapshot || (turnId && entry.snapshot.turnId !== turnId)) return
    if (entry.snapshot.state === 'active' || entry.snapshot.state === 'stopping') {
      entry.snapshot = {
        ...entry.snapshot,
        state: 'unknown',
        recoveryAvailable: false,
        ...(entry.snapshot.diagnostic
          ? { diagnostic: { ...entry.snapshot.diagnostic, channel: 'unknown', cleanup: 'unknown' } }
          : {}),
      }
      this.changed()
    }
  }
  dispose(owner: object) {
    let changed = false
    for (const [key, entry] of this.entries) {
      if (entry.owner === owner) {
        this.entries.delete(key)
        changed = true
      }
    }
    if (changed) this.changed()
  }
}
export const computerUseStates = new ComputerUseStateStore()
