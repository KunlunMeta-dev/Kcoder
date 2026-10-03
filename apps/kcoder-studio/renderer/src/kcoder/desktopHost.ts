import { navigateTo } from '@/lib/navigation'

interface DesktopHost {
  capabilities?: { completionBadge?: boolean }
  pickWorkspacePaths?(options: {
    serverId: string
    initialDirectory: string | null
    multiple: boolean
  }): Promise<string[]>
  setPreferences(preferences: { closeToTrayEnabled: boolean; language: string }): Promise<unknown>
  setTrayState(state: {
    language: string
    activeTaskIds: string[] | null
    unreadCount?: number
  }): Promise<unknown>
  setTaskActivity(count: number | null): Promise<void>
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

export async function syncDesktopTaskActivity(count: number | null): Promise<void> {
  await desktopHost()?.setTaskActivity(count)
}
