import { useCallback, useSyncExternalStore } from 'react'

const DEFAULT_KEY = 'kcoder-studio:processing-window-enabled'
const CONVERSATIONS_KEY = 'kcoder-studio:conversation-processing-windows-v1'
const CHANGE_EVENT = 'kcoder:conversation-process-preferences-changed'
const MAX_CONVERSATIONS = 2000
let cachedJson: string | null | undefined
let cachedModes = new Map<string, boolean>()

export function readProcessingWindowDefault(): boolean {
  try {
    return localStorage.getItem(DEFAULT_KEY) === 'true'
  } catch {
    return false
  }
}

export function setProcessingWindowDefault(enabled: boolean) {
  localStorage.setItem(DEFAULT_KEY, String(enabled))
  window.dispatchEvent(new Event(CHANGE_EVENT))
}

function readModes() {
  try {
    const json = localStorage.getItem(CONVERSATIONS_KEY)
    if (json !== cachedJson) {
      const value: unknown = json ? JSON.parse(json) : []
      cachedModes = new Map(
        Array.isArray(value)
          ? value
              .slice(-MAX_CONVERSATIONS)
              .flatMap(entry =>
                Array.isArray(entry) &&
                entry.length === 2 &&
                typeof entry[0] === 'string' &&
                typeof entry[1] === 'boolean'
                  ? [[entry[0], entry[1]] as [string, boolean]]
                  : []
              )
          : []
      )
      cachedJson = json
    }
  } catch {
    // A client storage failure must not block or alter a target-side task.
  }
  return cachedModes
}

export function readConversationProcessingWindow(key: string | number | null | undefined) {
  return key == null ? false : (readModes().get(String(key)) ?? false)
}

export function rememberConversationProcessingWindow(
  key: string,
  enabled = readProcessingWindowDefault()
) {
  const modes = readModes()
  if (modes.has(key)) return
  const next = new Map(modes)
  next.set(key, enabled)
  while (next.size > MAX_CONVERSATIONS) next.delete(next.keys().next().value!)
  const json = JSON.stringify([...next])
  try {
    localStorage.setItem(CONVERSATIONS_KEY, json)
    cachedJson = json
  } catch {
    // Retain the current client's choice in memory when persistence is unavailable.
  }
  cachedModes = next
  window.dispatchEvent(new Event(CHANGE_EVENT))
}

function subscribe(listener: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === DEFAULT_KEY || event.key === CONVERSATIONS_KEY)
      listener()
  }
  window.addEventListener(CHANGE_EVENT, listener)
  window.addEventListener('storage', onStorage)
  return () => {
    window.removeEventListener(CHANGE_EVENT, listener)
    window.removeEventListener('storage', onStorage)
  }
}

export function useProcessingWindowDefault() {
  return useSyncExternalStore(subscribe, readProcessingWindowDefault, () => false)
}

export function useConversationProcessingWindow(key: string | number | null | undefined) {
  const getSnapshot = useCallback(() => readConversationProcessingWindow(key), [key])
  return useSyncExternalStore(subscribe, getSnapshot, () => false)
}
