/** Runtime-created conversations need to invalidate the workbench's list projection. */
const listeners = new Set<() => void>()
export function notifyRuntimeWorkChanged(): void {
  for (const listener of listeners) listener()
}
export function subscribeRuntimeWorkChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
