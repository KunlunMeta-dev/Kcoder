import { useSyncExternalStore } from 'react'
import type { RuntimeTaskAddress } from '@/types/api'
import type { StudioWorkMode } from '@/types/studioWorkMode'

export type { StudioWorkMode } from '@/types/studioWorkMode'
const MODE_KEY = 'kcoder-studio:work-mode-v1'
const VISUALIZATION_KEY = 'kcoder-studio:inline-widgets-v1'
const EVENT = 'kcoder-studio:work-mode-changed'

export function studioWorkMode(value: unknown): StudioWorkMode {
  return value === 'kworker' ? 'kworker' : 'kcoder'
}

export function readStudioWorkMode(): StudioWorkMode {
  try {
    return studioWorkMode(sessionStorage.getItem(MODE_KEY))
  } catch {
    return 'kcoder'
  }
}

export function setStudioWorkMode(mode: StudioWorkMode): void {
  try {
    sessionStorage.setItem(MODE_KEY, mode)
  } catch {
    /* The current view remains usable without storage. */
  }
  window.dispatchEvent(new Event(EVENT))
}

export function readInlineWidgetsEnabled(): boolean {
  try {
    return localStorage.getItem(VISUALIZATION_KEY) !== 'false'
  } catch {
    return true
  }
}

export function setInlineWidgetsEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(VISUALIZATION_KEY, String(enabled))
  } catch {
    /* Storage may be unavailable. */
  }
  window.dispatchEvent(new Event(EVENT))
}

function subscribe(listener: () => void) {
  window.addEventListener(EVENT, listener)
  window.addEventListener('storage', listener)
  return () => {
    window.removeEventListener(EVENT, listener)
    window.removeEventListener('storage', listener)
  }
}

export function useStudioWorkMode(address?: RuntimeTaskAddress | null): StudioWorkMode {
  const preference = useSyncExternalStore(subscribe, readStudioWorkMode, () => 'kcoder' as const)
  return address ? studioWorkMode(address.runtimeHandle?.studioWorkMode) : preference
}

export function useInlineWidgetsEnabled(): boolean {
  return useSyncExternalStore(subscribe, readInlineWidgetsEnabled, () => true)
}
