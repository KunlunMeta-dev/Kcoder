import type {
  DesktopDownloadRequest,
  DesktopDownloadResult,
} from '../../../desktop/download-contract'
import type { StorageLocationsBridge } from './storageLocations'
import { navigateTo } from '@/lib/navigation'

interface DesktopHost {
  takeWorkspaceOpenRequests?(): Promise<Array<{ id: string; serverId?: string; path?: string; label?: string; error?: string }>>
  acknowledgeWorkspaceOpen?(id: string): Promise<void>
  onWorkspaceOpen?(callback: () => void): () => void
  readFeedbackDiagnostics?(options: { runtimeLogs: boolean; systemInfo: boolean }): Promise<{
    runtimeLogs: string | null; systemInfo: Record<string, unknown> | null
  }>
  captureFeedbackScreenshot?(): Promise<string>
  download?(params: DesktopDownloadRequest): Promise<DesktopDownloadResult>
  capabilities?: { completionBadge?: boolean }
  pickWorkspacePaths?(options: {
    serverId: string
    initialDirectory: string | null
    multiple: boolean
  }): Promise<string[]>
  storageLocations?: StorageLocationsBridge
  setPreferences(preferences: { closeToTrayEnabled: boolean; language: string }): Promise<unknown>
  setTrayState(state: {
    language: string
    activeTaskIds: string[] | null
    unreadCount?: number
  }): Promise<unknown>
  setTaskActivity(count: number | null): Promise<void>
  getTrayCapabilities?(): Promise<{ available: boolean }>
  hideToTray(): Promise<void>
  windowAction(action: string): Promise<unknown>
  onSettings(callback: () => void): () => void
  onMenuCommand?(
    callback: (command: 'new-chat' | 'new-temporary-chat' | 'open-folder' | 'logout') => void
  ): () => void
}

export function desktopHost(): DesktopHost | undefined {
  return (window as Window & { kcoderDesktopHost?: DesktopHost }).kcoderDesktopHost
}

export type DesktopTrayAvailability = 'available' | 'unavailable' | 'unknown'

// Read this window's live native owner; a UI projection never authorizes hide.
export async function readDesktopTrayAvailability(host = desktopHost()): Promise<DesktopTrayAvailability> {
  if (!host?.getTrayCapabilities) return 'unknown'
  try {
    const result = await host.getTrayCapabilities()
    if (desktopHost() !== host || !result || typeof result.available !== 'boolean') return 'unknown'
    return result.available ? 'available' : 'unavailable'
  } catch {
    return 'unknown'
  }
}

export async function hideDesktopWindowToTray(): Promise<void> {
  const host = desktopHost()
  const availability = await readDesktopTrayAvailability(host)
  if (!host || desktopHost() !== host || availability !== 'available') {
    throw new Error(availability === 'unavailable' ? 'DESKTOP_TRAY_UNAVAILABLE' : 'DESKTOP_TRAY_CAPABILITY_UNKNOWN')
  }
  // A lost reply is unknown; never turn this rejection into close or quit.
  await host.hideToTray()
  if (desktopHost() !== host) throw new Error('DESKTOP_TRAY_OWNER_CHANGED')
}

function language(value: unknown): string {
  return typeof value === 'string' && value.toLowerCase().startsWith('en') ? 'en' : 'zh-CN'
}

export async function syncDesktopPreferences(preferences: Record<string, unknown>) {
  await desktopHost()?.setPreferences({
    closeToTrayEnabled: preferences.closeToTrayEnabled === true,
    language: language(preferences.language),
  })
  return preferences
}

export async function syncDesktopTrayState(state: Record<string, unknown>) {
  const host = desktopHost()
  if (!host) return null
  return host.setTrayState({
    language: language(state.language),
    activeTaskIds: Array.isArray(state.activeTaskIds) ? state.activeTaskIds : null,
    ...(host.capabilities?.completionBadge === true
      ? {
          unreadCount:
            typeof state.unreadCount === 'number' &&
            Number.isInteger(state.unreadCount) &&
            state.unreadCount >= 0
              ? Math.min(state.unreadCount, 10000)
              : 0,
        }
      : {}),
  })
}

export function installDesktopHostNavigation(): () => void {
  return desktopHost()?.onSettings(() => navigateTo('/settings')) ?? (() => {})
}
