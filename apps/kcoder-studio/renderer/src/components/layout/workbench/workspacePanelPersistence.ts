import { markEmbeddedBrowserLabelTransferred } from '@/lib/embedded-browser'
import type { RuntimeTaskAddress } from '@/types/api'
import type { WorkspaceTarget } from '@/types/workspace-files'
import { type RightWorkspacePanelTab } from '../workspace-panels/RightWorkspacePanel'
import { BLANK_BROWSER_MIGRATION_TTL_MS } from './paneLayoutStyles'
import { type PendingBlankBrowserMigration, type WorkbenchPaneWorkspaceState } from './types'

export const PANE_WORKSPACE_STORAGE_PREFIX = 'wework.desktop.pane-workspace.v1:'

export function persistedPaneWorkspaceStorageKey(paneKey: string): string {
  // standaloneChatKey increments only within the current process; regular workspaces use stable keys for full-page refresh recovery.
  const persistedPaneKey = paneKey.startsWith('blank:') ? 'blank' : paneKey
  return `${PANE_WORKSPACE_STORAGE_PREFIX}${persistedPaneKey}`
}

export function consumeLatestBlankBrowserMigration(): PendingBlankBrowserMigration | null {
  if (!browserMigrationState.latestBlankBrowserMigration) return null
  if (
    Date.now() - browserMigrationState.latestBlankBrowserMigration.createdAt >
    BLANK_BROWSER_MIGRATION_TTL_MS
  ) {
    browserMigrationState.latestBlankBrowserMigration = null
    return null
  }

  const migration = browserMigrationState.latestBlankBrowserMigration
  browserMigrationState.latestBlankBrowserMigration = null
  markEmbeddedBrowserLabelTransferred(migration.browserLabel)
  return migration
}

export const PERSISTED_RIGHT_PANEL_TABS = new Set<RightWorkspacePanelTab>([
  'terminal',
  'browser',
  'files',
])

export function readPersistedPaneWorkspaceState(
  paneKey: string
): WorkbenchPaneWorkspaceState | undefined {
  try {
    const value = JSON.parse(
      window.localStorage.getItem(persistedPaneWorkspaceStorageKey(paneKey)) ??
        window.localStorage.getItem(`${PANE_WORKSPACE_STORAGE_PREFIX}${paneKey}`) ??
        ''
    ) as Partial<WorkbenchPaneWorkspaceState>
    const rightPanelTabs = Array.isArray(value.rightPanelTabs)
      ? value.rightPanelTabs.filter(
          (tab): tab is RightWorkspacePanelTab =>
            typeof tab === 'string' && PERSISTED_RIGHT_PANEL_TABS.has(tab as RightWorkspacePanelTab)
        )
      : []
    const rightPanelView = PERSISTED_RIGHT_PANEL_TABS.has(
      value.rightPanelView as RightWorkspacePanelTab
    )
      ? (value.rightPanelView as RightWorkspacePanelTab)
      : 'launcher'
    const browserUrl = (() => {
      if (typeof value.browserUrl !== 'string' || value.browserUrl.length > 4096) return null
      const parsed = new URL(value.browserUrl)
      return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : null
    })()
    return {
      rightPanelOpen: value.rightPanelOpen === true && rightPanelTabs.length > 0,
      rightPanelView:
        rightPanelView !== 'launcher' && rightPanelTabs.includes(rightPanelView)
          ? rightPanelView
          : 'launcher',
      rightPanelTabs: [...new Set(rightPanelTabs)],
      browserUrl,
    }
  } catch {
    return undefined
  }
}

export function writePersistedPaneWorkspaceState(
  paneKey: string,
  state: WorkbenchPaneWorkspaceState
) {
  const rightPanelTabs = state.rightPanelTabs.filter(tab => PERSISTED_RIGHT_PANEL_TABS.has(tab))
  const rightPanelView = rightPanelTabs.includes(state.rightPanelView as RightWorkspacePanelTab)
    ? state.rightPanelView
    : 'launcher'
  if (rightPanelTabs.length === 0) {
    window.localStorage.removeItem(persistedPaneWorkspaceStorageKey(paneKey))
    window.localStorage.removeItem(`${PANE_WORKSPACE_STORAGE_PREFIX}${paneKey}`)
    return
  }
  window.localStorage.setItem(
    persistedPaneWorkspaceStorageKey(paneKey),
    JSON.stringify({
      rightPanelOpen: state.rightPanelOpen,
      rightPanelView,
      rightPanelTabs,
      browserUrl: rightPanelTabs.includes('browser') ? state.browserUrl : null,
    } satisfies WorkbenchPaneWorkspaceState)
  )
  if (paneKey.startsWith('blank:')) {
    window.localStorage.removeItem(`${PANE_WORKSPACE_STORAGE_PREFIX}${paneKey}`)
  }
}

export const browserMigrationState = {
  latestBlankBrowserMigration: null as PendingBlankBrowserMigration | null,
}

export function createBottomPanelWorkspaceKey({
  currentRuntimeTask,
  workspaceProjectId,
  workspaceTarget,
  executionMode,
  preferLocalTerminal,
}: {
  currentRuntimeTask: RuntimeTaskAddress | null
  workspaceProjectId?: number
  workspaceTarget: WorkspaceTarget | null
  executionMode: string
  preferLocalTerminal: boolean
}): string {
  if (currentRuntimeTask) {
    return ['runtime', currentRuntimeTask.deviceId, currentRuntimeTask.taskId].join(':')
  }

  return [
    'workspace',
    workspaceProjectId ?? 'projectless',
    workspaceTarget?.deviceId ?? '',
    workspaceTarget?.path ?? '',
    preferLocalTerminal ? 'local' : executionMode,
  ].join(':')
}
