import { defaultQuickPhrases } from '@/tauri/appPreferences'
import { LEGACY_KCODER_STUDIO_STORAGE_KEYS } from './legacyRuntimeAbi'

const PREFERENCES_KEY = 'kcoder-studio:app-preferences'
const KEYBINDINGS_KEY = 'kcoder-studio:keybindings-v1'
const KCODER_INSTRUCTIONS_KEY = 'kcoder-studio:kcoder-instructions-v1'
const KCODER_PERSONALITY_KEY = 'kcoder-studio:kcoder-personality-v1'
const CODEX_LOCAL_CONFIG_KEY = 'kcoder-studio:codex-local-config-v1'

const defaultPreferences: Record<string, unknown> = {
  closeToTrayEnabled: false,
  showMainWindowOnLaunch: true,
  systemDragEnabled: false,
  preventSleepWhileTasksRunning: true,
  closeToTrayHintSeen: true,
  language: 'zh-CN',
  terminalContextInjectionEnabled: true,
  experimentalFeaturesEnabled: false,
  taskCompletionNotificationsEnabled: false,
  trayUnreadEnabled: true,
  trayRunningEnabled: true,
  trayUsageEnabled: true,
  browserExternalLinkTarget: 'system',
  browserLocalLinkTarget: 'studio',
  browserDownloadDirectory: null,
  browserAskBeforeDownload: false,
  appshotsPlaySound: true,
  quickPhrases: defaultQuickPhrases.map(phrase => ({ ...phrase })),
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function allowedPreferences(value: unknown): Record<string, unknown> {
  const source = record(value)
  return Object.fromEntries(
    Object.keys(defaultPreferences)
      .filter(key => key in source)
      .map(key => [key, source[key]])
  )
}

export function readPreferences(): Record<string, unknown> {
  try {
    return {
      ...defaultPreferences,
      ...allowedPreferences(JSON.parse(localStorage.getItem(PREFERENCES_KEY) ?? '{}')),
    }
  } catch {
    return { ...defaultPreferences }
  }
}

export function writePreferences(patch: unknown): Record<string, unknown> {
  const next = { ...readPreferences(), ...allowedPreferences(patch) }
  localStorage.setItem(PREFERENCES_KEY, JSON.stringify(next))
  return next
}

export function readGatewayCodexLocalConfig() {
  try {
    const stored = record(JSON.parse(localStorage.getItem(CODEX_LOCAL_CONFIG_KEY) ?? '{}'))
    return {
      codexHome: '',
      configPath: '',
      remoteAppsEnabled: stored.remoteAppsEnabled !== false,
    }
  } catch {
    return { codexHome: '', configPath: '', remoteAppsEnabled: true }
  }
}

export function updateGatewayCodexLocalConfig(patch: unknown) {
  const current = readGatewayCodexLocalConfig()
  const requested = record(patch).remoteAppsEnabled
  const next = {
    ...current,
    remoteAppsEnabled: typeof requested === 'boolean' ? requested : current.remoteAppsEnabled,
  }
  localStorage.setItem(
    CODEX_LOCAL_CONFIG_KEY,
    JSON.stringify({ remoteAppsEnabled: next.remoteAppsEnabled })
  )
  return next
}

export function readKeybindings(): unknown[] {
  try {
    const value = JSON.parse(localStorage.getItem(KEYBINDINGS_KEY) ?? '[]')
    return Array.isArray(value) ? value : []
  } catch {
    return []
  }
}

export function writeKeybindings(value: unknown): unknown[] {
  const keybindings = Array.isArray(value) ? value : []
  const serialized = JSON.stringify(keybindings)
  if (keybindings.length > 500 || serialized.length > 256 * 1024) {
    throw new Error('快捷键配置超过 KCoder 客户端限制')
  }
  localStorage.setItem(KEYBINDINGS_KEY, serialized)
  return keybindings
}

function legacyKCoderContextValue(currentKey: string, legacyKey: string): string | null {
  return localStorage.getItem(currentKey) ?? localStorage.getItem(legacyKey)
}

// These values support one-time migration of old client state into target configuration and are no longer authoritative execution settings.
export function readLegacyKCoderContext(): {
  instructions: string | null
  personality: string | null
} {
  return {
    instructions: legacyKCoderContextValue(
      KCODER_INSTRUCTIONS_KEY,
      LEGACY_KCODER_STUDIO_STORAGE_KEYS.instructions
    ),
    personality: legacyKCoderContextValue(
      KCODER_PERSONALITY_KEY,
      LEGACY_KCODER_STUDIO_STORAGE_KEYS.personality
    ),
  }
}

export function clearLegacyKCoderContext(): void {
  for (const key of [
    KCODER_INSTRUCTIONS_KEY,
    KCODER_PERSONALITY_KEY,
    LEGACY_KCODER_STUDIO_STORAGE_KEYS.instructions,
    LEGACY_KCODER_STUDIO_STORAGE_KEYS.personality,
  ]) {
    localStorage.removeItem(key)
  }
}
