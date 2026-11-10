import { useEffect, useState, useSyncExternalStore } from 'react'
import {
  APP_PREFERENCES_CHANGED_EVENT,
  defaultAppPreferences,
  getAppPreferences,
  updateAppPreferences,
  type AppPreferences,
  type ConversationFontScale,
  type ConversationLineSpacing,
  type ConversationSpacing,
  type ConversationFontFamily,
} from '@/host/appPreferences'

export interface ConversationPreferencesSnapshot {
  conversationFontScale: ConversationFontScale
  conversationLineSpacing: ConversationLineSpacing
  conversationBlockSpacing: ConversationSpacing
  conversationLetterSpacing: ConversationSpacing
  conversationFontFamily: ConversationFontFamily
  thinkingCollapsedByDefault: boolean
  toolsCollapsedByDefault: boolean
  hydration: 'idle' | 'loading' | 'ready' | 'error'
  saveError: boolean
}

export interface InitialConversationPreferences {
  conversationFontScale: ConversationFontScale
  conversationLineSpacing: ConversationLineSpacing
  conversationBlockSpacing: ConversationSpacing
  conversationLetterSpacing: ConversationSpacing
  conversationFontFamily: ConversationFontFamily
  thinkingCollapsedByDefault: boolean
  toolsCollapsedByDefault: boolean
  ready: boolean
}

export type ConversationPreferencesPatch = Partial<
  Pick<
    ConversationPreferencesSnapshot,
    | 'conversationFontScale'
    | 'conversationLineSpacing'
    | 'conversationBlockSpacing'
    | 'conversationLetterSpacing'
    | 'conversationFontFamily'
    | 'thinkingCollapsedByDefault'
    | 'toolsCollapsedByDefault'
  >
>

const listeners = new Set<() => void>()
let snapshot: ConversationPreferencesSnapshot = {
  conversationFontScale: defaultAppPreferences.conversationFontScale,
  conversationLineSpacing: defaultAppPreferences.conversationLineSpacing,
  conversationBlockSpacing: defaultAppPreferences.conversationBlockSpacing,
  conversationLetterSpacing: defaultAppPreferences.conversationLetterSpacing,
  conversationFontFamily: defaultAppPreferences.conversationFontFamily,
  thinkingCollapsedByDefault: defaultAppPreferences.thinkingCollapsedByDefault,
  toolsCollapsedByDefault: defaultAppPreferences.toolsCollapsedByDefault,
  hydration: 'idle',
  saveError: false,
}
let hydrationPromise: Promise<void> | null = null
let mutationRevision = 0

function publish(next: ConversationPreferencesSnapshot) {
  if (
    next.conversationFontScale === snapshot.conversationFontScale &&
    next.conversationLineSpacing === snapshot.conversationLineSpacing &&
    next.conversationBlockSpacing === snapshot.conversationBlockSpacing &&
    next.conversationLetterSpacing === snapshot.conversationLetterSpacing &&
    next.conversationFontFamily === snapshot.conversationFontFamily &&
    next.thinkingCollapsedByDefault === snapshot.thinkingCollapsedByDefault &&
    next.toolsCollapsedByDefault === snapshot.toolsCollapsedByDefault &&
    next.hydration === snapshot.hydration &&
    next.saveError === snapshot.saveError
  ) return
  snapshot = next
  listeners.forEach(listener => listener())
}

function applyAppPreferences(preferences: AppPreferences) {
  publish({
    conversationFontScale: preferences.conversationFontScale,
    conversationLineSpacing: preferences.conversationLineSpacing,
    conversationBlockSpacing: preferences.conversationBlockSpacing,
    conversationLetterSpacing: preferences.conversationLetterSpacing,
    conversationFontFamily: preferences.conversationFontFamily,
    thinkingCollapsedByDefault: preferences.thinkingCollapsedByDefault,
    toolsCollapsedByDefault: preferences.toolsCollapsedByDefault,
    hydration: 'ready',
    saveError: false,
  })
}

function handlePreferencesChanged(event: Event) {
  const detail = (event as CustomEvent<AppPreferences>).detail
  if (!detail || typeof detail !== 'object') return
  mutationRevision += 1
  applyAppPreferences(detail)
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  if (listeners.size === 1 && typeof window !== 'undefined') {
    window.addEventListener(APP_PREFERENCES_CHANGED_EVENT, handlePreferencesChanged)
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && typeof window !== 'undefined') {
      window.removeEventListener(APP_PREFERENCES_CHANGED_EVENT, handlePreferencesChanged)
    }
  }
}

function getSnapshot() {
  return snapshot
}

export function hydrateConversationPreferences(retry = false): Promise<void> {
  if (retry && snapshot.hydration === 'error') hydrationPromise = null
  if (hydrationPromise) return hydrationPromise
  const revisionAtStart = mutationRevision
  publish({ ...snapshot, hydration: 'loading' })
  hydrationPromise = getAppPreferences().then(
    preferences => {
      if (revisionAtStart === mutationRevision) applyAppPreferences(preferences)
      else publish({ ...snapshot, hydration: 'ready' })
    },
  ).catch(() => {
    publish({ ...snapshot, hydration: 'error' })
  })
  return hydrationPromise
}

export async function saveConversationPreferences(
  patch: ConversationPreferencesPatch,
): Promise<void> {
  mutationRevision += 1
  try {
    const preferences = await updateAppPreferences(patch)
    applyAppPreferences(preferences)
  } catch (error) {
    publish({ ...snapshot, saveError: true })
    throw error
  }
}

export async function retryConversationPreferencesSave(): Promise<void> {
  await saveConversationPreferences({
    conversationFontScale: snapshot.conversationFontScale,
    conversationLineSpacing: snapshot.conversationLineSpacing,
    conversationBlockSpacing: snapshot.conversationBlockSpacing,
    conversationLetterSpacing: snapshot.conversationLetterSpacing,
    conversationFontFamily: snapshot.conversationFontFamily,
    thinkingCollapsedByDefault: snapshot.thinkingCollapsedByDefault,
    toolsCollapsedByDefault: snapshot.toolsCollapsedByDefault,
  })
}

export function useConversationPreferences(): ConversationPreferencesSnapshot {
  const current = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  useEffect(() => {
    void hydrateConversationPreferences()
  }, [])
  return current
}

/**
 * Snapshot conversation defaults once they have been loaded for a node. A
 * settings change affects later nodes while an existing disclosure keeps its
 * original default and any explicit user choice.
 */
export function useInitialConversationPreferences(): InitialConversationPreferences {
  const current = useConversationPreferences()
  const [initial, setInitial] = useState<InitialConversationPreferences | null>(() => (
    current.hydration === 'ready' ? initialFields(current) : null
  ))

  if (!initial && current.hydration === 'ready') setInitial(initialFields(current))

  return initial ?? {
    conversationFontScale: defaultAppPreferences.conversationFontScale,
    conversationLineSpacing: defaultAppPreferences.conversationLineSpacing,
    conversationBlockSpacing: defaultAppPreferences.conversationBlockSpacing,
    conversationLetterSpacing: defaultAppPreferences.conversationLetterSpacing,
    conversationFontFamily: defaultAppPreferences.conversationFontFamily,
    thinkingCollapsedByDefault: defaultAppPreferences.thinkingCollapsedByDefault,
    toolsCollapsedByDefault: defaultAppPreferences.toolsCollapsedByDefault,
    ready: false,
  }
}

function initialFields(
  preferences: ConversationPreferencesSnapshot,
): InitialConversationPreferences {
  return {
    conversationFontScale: preferences.conversationFontScale,
    conversationLineSpacing: preferences.conversationLineSpacing,
    conversationBlockSpacing: preferences.conversationBlockSpacing,
    conversationLetterSpacing: preferences.conversationLetterSpacing,
    conversationFontFamily: preferences.conversationFontFamily,
    thinkingCollapsedByDefault: preferences.thinkingCollapsedByDefault,
    toolsCollapsedByDefault: preferences.toolsCollapsedByDefault,
    ready: true,
  }
}
