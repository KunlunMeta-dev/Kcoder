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
  snapshot: ComputerUseSnapshot
  nextAttempt?: { id: string; sequence: number }
  minimumSequence?: number
}
const validStates = new Set(['active', 'stopping', 'stopped', 'stop_failed'])

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
  beginAttempt(
    owner: object,
    serverId: string,
    taskId: string,
    turnId: string,
    attemptId: string,
    sequence: number
  ) {
    const entry = this.entries.get(this.key(serverId, taskId))
    if (
      !entry ||
      entry.owner !== owner ||
      entry.snapshot.turnId !== turnId ||
      !attemptId ||
      attemptId.length > 256 ||
      !Number.isSafeInteger(sequence) ||
      sequence < 0 ||
      (entry.snapshot.attemptId ?? turnId) === attemptId
    )
      return
    entry.nextAttempt = { id: attemptId, sequence }
  }
  apply(
    owner: object,
    serverId: string,
    taskId: string,
    turnId: string,
    payload: Record<string, unknown>
  ) {
    if (!validStates.has(String(payload.state)) || payload.target !== 'local_windows_desktop')
      return
    const state = payload.state as ComputerUseState
    const key = this.key(serverId, taskId)
    const previous = this.entries.get(key)
    const matching = previous?.owner === owner && previous.snapshot.turnId === turnId
    if (
      matching &&
      previous.minimumSequence !== undefined &&
      (typeof payload.sequence !== 'number' ||
        !Number.isSafeInteger(payload.sequence) ||
        payload.sequence < previous.minimumSequence)
    )
      return
    const nextAttempt = matching ? previous.nextAttempt : undefined
    const freshAttempt =
      nextAttempt &&
      typeof payload.sequence === 'number' &&
      Number.isSafeInteger(payload.sequence) &&
      payload.sequence >= nextAttempt.sequence
    if (nextAttempt && !freshAttempt) return
    if (matching && !freshAttempt) {
      const old = previous.snapshot.state
      if (old === 'stopped' && state !== 'stopped') return
      if (old === state && payload.diagnostic === undefined) return
      if (
        (old === 'stop_failed' || old === 'unknown') &&
        state !== old &&
        state !== 'stopped' &&
        state !== 'stopping'
      )
        return
      if (old === 'stopping' && state === 'active') return
    }
    const facts = diagnostic(payload.diagnostic)
    this.entries.set(key, {
      owner,
      minimumSequence: freshAttempt
        ? nextAttempt.sequence
        : matching
          ? previous.minimumSequence
          : undefined,
      snapshot: {
        turnId,
        state,
        attemptId: freshAttempt
          ? nextAttempt.id
          : matching
            ? (previous.snapshot.attemptId ?? turnId)
            : turnId,
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
  revoked(owner: object, serverId: string, taskId: string) {
    const entry = this.entries.get(this.key(serverId, taskId))
    if (!entry || entry.owner !== owner || !entry.snapshot.diagnostic) return
    entry.snapshot = {
      ...entry.snapshot,
      recoveryAvailable: false,
      diagnostic: { ...entry.snapshot.diagnostic, authorization: 'revoked' },
    }
    this.changed()
  }
  unconfirmed(owner: object, serverId: string, taskId: string, turnId?: string) {
    const entry = this.entries.get(this.key(serverId, taskId))
    if (!entry || entry.owner !== owner || (turnId && entry.snapshot.turnId !== turnId)) return
    if (entry.snapshot.state !== 'active' && entry.snapshot.state !== 'stopping') return
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
