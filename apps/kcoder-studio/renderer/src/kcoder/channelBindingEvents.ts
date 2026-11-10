const listeners = new Set<(scopeIdentity: string) => void>()

/** Invalidation only: a receipt never substitutes for a fresh Native projection. */
export function invalidateChannelBindings(scopeIdentity: string) {
  for (const listener of listeners) listener(scopeIdentity)
}

export function listenChannelBindingChanges(listener: (scopeIdentity: string) => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
