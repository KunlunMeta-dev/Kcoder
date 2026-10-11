export type DesktopFileAction = 'new-temporary-chat' | 'open-folder'

const listeners = new Map<DesktopFileAction, () => void>()
const pending = new Map<DesktopFileAction, number>()

export function requestDesktopFileAction(action: DesktopFileAction) {
  const listener = listeners.get(action)
  if (listener) listener()
  else pending.set(action, Math.min(8, (pending.get(action) ?? 0) + 1))
}

export function subscribeDesktopFileAction(action: DesktopFileAction, listener: () => void) {
  listeners.set(action, listener)
  const count = pending.get(action) ?? 0
  pending.delete(action)
  for (let index = 0; index < count; index += 1) listener()
  return () => {
    if (listeners.get(action) === listener) listeners.delete(action)
  }
}

export function clearPendingDesktopFileActions() {
  pending.clear()
}
