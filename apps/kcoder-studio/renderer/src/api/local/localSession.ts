import type { User, UserPreferences } from '@/types/api'

export const LOCAL_USER = {
  id: 0,
  user_name: 'local',
  email: 'local@kcoder.local',
  preferences: {},
} satisfies User

const LOCAL_USER_PREFERENCES_STORAGE_KEY = 'kcoder.localUser.preferences'
// Read legacy, write new: older installs used `wework.localUser.preferences`; the legacy key is obsolete after migration.
const LEGACY_LOCAL_USER_PREFERENCES_STORAGE_KEY = 'wework.localUser.preferences'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function localFirstPreferences(preferences: UserPreferences): UserPreferences {
  // New-chat model selection is a Gateway user preference; the local-first store
  // must not retain it, otherwise it would persistently shadow the target's real
  // selection. Strip the legacy field name as well.
  const { wework_new_chat_model_selection: _legacy, new_chat_model_selection: _current, ...rest } =
    preferences as Record<string, unknown>
  return rest as UserPreferences
}

function readLocalUserPreferences(): UserPreferences {
  try {
    const raw =
      globalThis.localStorage?.getItem(LOCAL_USER_PREFERENCES_STORAGE_KEY) ??
      globalThis.localStorage?.getItem(LEGACY_LOCAL_USER_PREFERENCES_STORAGE_KEY)
    if (!raw) return LOCAL_USER.preferences

    const parsed = JSON.parse(raw)
    return isRecord(parsed)
      ? localFirstPreferences(parsed as UserPreferences)
      : LOCAL_USER.preferences
  } catch {
    return LOCAL_USER.preferences
  }
}

export function saveLocalUserPreferences(preferences: UserPreferences): User {
  const sanitized = localFirstPreferences(preferences)
  try {
    globalThis.localStorage?.setItem(LOCAL_USER_PREFERENCES_STORAGE_KEY, JSON.stringify(sanitized))
  } catch {
    // Keep the in-session return value even if local persistence is unavailable.
  }

  return {
    ...LOCAL_USER,
    preferences: sanitized,
  }
}

export function getLocalUser(): User {
  return {
    ...LOCAL_USER,
    preferences: readLocalUserPreferences(),
  }
}
