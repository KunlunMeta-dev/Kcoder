export type ComputerUseState = 'active' | 'stopping' | 'stopped' | 'stop_failed' | 'unknown'
export type ComputerUseSnapshot = { turnId: string; state: ComputerUseState }
type Entry = { owner: object; snapshot: ComputerUseSnapshot }
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
    if (previous?.owner === owner && previous.snapshot.turnId === turnId) {
      const old = previous.snapshot.state
      if (old === state || old === 'stopped') return
      if (
        (old === 'stop_failed' || old === 'unknown') &&
        state !== 'stopped' &&
        state !== 'stopping'
      )
        return
      if (old === 'stopping' && state === 'active') return
    }
    this.entries.set(key, { owner, snapshot: { turnId, state } })
    this.changed()
  }
  unconfirmed(owner: object, serverId: string, taskId: string, turnId?: string) {
    const entry = this.entries.get(this.key(serverId, taskId))
    if (!entry || entry.owner !== owner || (turnId && entry.snapshot.turnId !== turnId)) return
    if (entry.snapshot.state !== 'active' && entry.snapshot.state !== 'stopping') return
    entry.snapshot = { ...entry.snapshot, state: 'unknown' }
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
