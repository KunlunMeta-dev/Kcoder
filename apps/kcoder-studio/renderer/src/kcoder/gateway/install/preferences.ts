import { defaultQuickPhrases } from '@/tauri/appPreferences'
import { LEGACY_KCODER_STUDIO_STORAGE_KEYS } from '../../legacyRuntimeAbi'
import { record } from '../runtime/contracts'

export const PREFERENCES_KEY = 'kcoder-studio:app-preferences'

export const KCODER_RUNTIME_CONFIG_KEY = 'kcoder-studio:kcoder-runtime-config-v1'

export const defaultPreferences = {
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

export function readPreferences(): Record<string, unknown> {
  try {
    return {
      ...defaultPreferences,
      ...record(JSON.parse(localStorage.getItem(PREFERENCES_KEY) ?? '{}')),
    }
  } catch {
    return { ...defaultPreferences }
  }
}

export function writePreferences(patch: unknown): Record<string, unknown> {
  const next = { ...readPreferences(), ...record(patch) }
  localStorage.setItem(PREFERENCES_KEY, JSON.stringify(next))
  return next
}

export function readMigratedStorageValue(currentKey: string, legacyKey: string): string | null {
  const currentValue = localStorage.getItem(currentKey)
  if (currentValue !== null) return currentValue
  const legacyValue = localStorage.getItem(legacyKey)
  if (legacyValue === null) return null
  localStorage.setItem(currentKey, legacyValue)
  localStorage.removeItem(legacyKey)
  return legacyValue
}

export function readGatewayRuntimeConfig() {
  try {
    const stored = record(
      JSON.parse(
        readMigratedStorageValue(
          KCODER_RUNTIME_CONFIG_KEY,
          LEGACY_KCODER_STUDIO_STORAGE_KEYS.runtimeConfig
        ) ?? '{}'
      )
    )
    return {
      codexHome: '',
      configPath: '',
      remoteAppsEnabled: stored.remoteAppsEnabled !== false,
    }
  } catch {
    return { codexHome: '', configPath: '', remoteAppsEnabled: true }
  }
}

export function updateGatewayRuntimeConfig(patch: unknown) {
  const current = readGatewayRuntimeConfig()
  const requested = record(patch).remoteAppsEnabled
  const next = {
    ...current,
    remoteAppsEnabled: typeof requested === 'boolean' ? requested : current.remoteAppsEnabled,
  }
  localStorage.setItem(
    KCODER_RUNTIME_CONFIG_KEY,
    JSON.stringify({
      remoteAppsEnabled: next.remoteAppsEnabled,
    })
  )
  localStorage.removeItem(LEGACY_KCODER_STUDIO_STORAGE_KEYS.runtimeConfig)
  return next
}
