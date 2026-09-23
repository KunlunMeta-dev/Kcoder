import type { RuntimeTaskAddress } from '@/types/api'

const listeners = new Set<(address: RuntimeTaskAddress) => void>()

/** Clear only the client-side archive suppression after an acknowledged restore. */
export function notifyRuntimeTaskUnarchived(address: RuntimeTaskAddress): void {
  for (const listener of listeners) listener(address)
}

export function subscribeRuntimeTaskUnarchived(
  listener: (address: RuntimeTaskAddress) => void
): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
