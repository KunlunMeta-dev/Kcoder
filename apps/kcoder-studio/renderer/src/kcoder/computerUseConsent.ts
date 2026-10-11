import { listenAccountContextChanges } from './accountContextEvents'
import { useSyncExternalStore } from 'react'

// Window-lifetime consent belongs to one concrete task and execution target.
// Draft consent is recorded only after that task has accepted its first turn.
const grants = new Set<string>()
const listeners = new Set<() => void>()
const key = (serverId: string, taskId: string) => JSON.stringify([serverId, taskId])
export const computerUseConsent = {
  has: (serverId: string, taskId: string) => grants.has(key(serverId, taskId)),
  set(serverId: string, taskId: string, allowed: boolean) {
    const id = key(serverId, taskId)
    if (allowed) grants.add(id)
    else grants.delete(id)
    for (const listener of listeners) listener()
  },
  subscribe(listener: () => void) {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
}
export function useComputerUseConsent(serverId: string, taskId?: string) {
  return useSyncExternalStore(
    computerUseConsent.subscribe,
    () => Boolean(taskId && computerUseConsent.has(serverId, taskId)),
    () => false
  )
}

listenAccountContextChanges(serverId => {
  for (const id of grants) {
    if (JSON.parse(id)[0] === serverId) grants.delete(id)
  }
  for (const listener of listeners) listener()
})
