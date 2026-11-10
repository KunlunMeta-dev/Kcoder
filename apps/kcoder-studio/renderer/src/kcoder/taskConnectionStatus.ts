type Status = 'reconnecting' | 'failed'
type Entry = { owner: object; serverId: string; status: Status }

const entries = new Map<string, Entry>()
const listeners = new Set<() => void>()
const key = (serverId: string, taskId: string) => JSON.stringify([serverId, taskId])

function notify() {
  for (const listener of listeners) listener()
}

function clearEntries(matches: (entry: Entry) => boolean) {
  let changed = false
  for (const [id, entry] of entries) {
    if (matches(entry)) {
      entries.delete(id)
      changed = true
    }
  }
  if (changed) notify()
}

export const taskConnectionStatus = {
  read(serverId: string, taskId: string): Status | null {
    return entries.get(key(serverId, taskId))?.status ?? null
  },
  subscribe(listener: () => void) {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
  start(owner: object, serverId: string, taskId: string) {
    const id = key(serverId, taskId)
    const entry: Entry = { owner, serverId, status: 'reconnecting' }
    entries.set(id, entry)
    notify()
    return (failed: boolean) => {
      if (entries.get(id) !== entry) return
      if (failed) entry.status = 'failed'
      else entries.delete(id)
      notify()
    }
  },
  clear(owner: object, serverId: string, taskId: string, failureOnly = false) {
    const id = key(serverId, taskId)
    const entry = entries.get(id)
    if (entry?.owner !== owner || (failureOnly && entry.status !== 'failed')) return
    entries.delete(id)
    notify()
  },
  clearTarget(owner: object, serverId: string) {
    clearEntries(entry => entry.owner === owner && entry.serverId === serverId)
  },
  dispose(owner: object) {
    clearEntries(entry => entry.owner === owner)
  },
}
