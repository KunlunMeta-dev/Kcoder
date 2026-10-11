import { Monitor, Settings2, SquareTerminal, X } from 'lucide-react'
import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import type { KeyboardEvent } from 'react'
import type { WorkspaceSessionApi } from '@/features/workbench/workbenchServices'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import type { DeviceInfo, ProjectWithTasks } from '@/types/api'
import type { WorkspaceTarget } from '@/types/workspace-files'
import { useResizableBottomPanel } from './useResizableWorkspacePanel'
import { WorkspaceAddMenu, type WorkspaceAddMenuItem } from './WorkspaceAddMenu'
import { WorkspacePanelCards } from './WorkspacePanelCards'
import type { WorkspacePanelMenuActions } from './workspace-panel-tools'
import { isKCoderGatewayPage } from '@/kcoder/gatewayRpc'
import { listSshConnections, type SshConnectionProfile } from '@/kcoder/sshTerminal'
import { SshTerminalPane } from '@/kcoder/SshTerminalPane'
import { navigateTo } from '@/lib/navigation'

interface BottomWorkspacePanelTab {
  id: string
  title: string
  sshProfile?: SshConnectionProfile
}

interface BottomWorkspacePanelProps {
  persistenceKey: string
  open: boolean
  active?: boolean
  preserveContent?: boolean
  testIdsEnabled?: boolean
  currentProject: ProjectWithTasks | null
  devices: DeviceInfo[]
  workspaceTarget: WorkspaceTarget | null
  preferLocalTerminal?: boolean
  terminalContextTitle?: string | null
  workspaceSessionApi?: WorkspaceSessionApi
  showWorkbenchBackground?: boolean
  onRequestClose: () => void
  onTerminalTabsEmpty?: () => void
}

function createTerminalTab(index: number): BottomWorkspacePanelTab {
  return { id: `terminal-${index}`, title: `Terminal ${index}` }
}

interface PersistedBottomTerminalTabs {
  activeTabId: string
  tabIds: string[]
}

const BOTTOM_TERMINAL_TABS_STORAGE_PREFIX = 'wework.workspace.bottom-terminal-tabs.v1:'

function readPersistedTabs(persistenceKey: string): PersistedBottomTerminalTabs {
  try {
    const value = JSON.parse(
      window.localStorage.getItem(`${BOTTOM_TERMINAL_TABS_STORAGE_PREFIX}${persistenceKey}`) ?? ''
    ) as Partial<PersistedBottomTerminalTabs>
    const tabIds = Array.isArray(value.tabIds)
      ? value.tabIds
          .filter((id): id is string => typeof id === 'string' && /^terminal-\d+$/.test(id))
          .slice(0, 20)
      : []
    const uniqueTabIds = [...new Set(tabIds)]
    if (uniqueTabIds.length === 0) {
      return { activeTabId: 'terminal-1', tabIds: ['terminal-1'] }
    }
    return {
      activeTabId:
        typeof value.activeTabId === 'string' && uniqueTabIds.includes(value.activeTabId)
          ? value.activeTabId
          : uniqueTabIds[0],
      tabIds: uniqueTabIds,
    }
  } catch {
    return { activeTabId: 'terminal-1', tabIds: ['terminal-1'] }
  }
}

function terminalSequenceAfter(tabIds: string[]): number {
  return Math.max(...tabIds.map(id => Number(id.slice('terminal-'.length))), 0) + 1
}

export const BottomWorkspacePanel = memo(function BottomWorkspacePanel({
  persistenceKey,
  open,
  active = true,
  preserveContent = false,
  testIdsEnabled = true,
  currentProject,
  devices,
  workspaceTarget,
  preferLocalTerminal = false,
  terminalContextTitle,
  workspaceSessionApi,
  showWorkbenchBackground = false,
  onRequestClose,
  onTerminalTabsEmpty,
}: BottomWorkspacePanelProps) {
  const { t } = useTranslation('common')
  const { t: sshT } = useTranslation('sshTerminal')
  const [sshProfiles, setSshProfiles] = useState<SshConnectionProfile[]>([])
  const [sshLoadFailed, setSshLoadFailed] = useState(false)
  const supportsSsh = isKCoderGatewayPage()
  const { height, resizing, panelRef, handleResizeStart } = useResizableBottomPanel()
  const [initialTabs] = useState(() => readPersistedTabs(persistenceKey))
  const [terminalSequence, setTerminalSequence] = useState(() =>
    terminalSequenceAfter(initialTabs.tabIds)
  )
  const [tabs, setTabs] = useState<BottomWorkspacePanelTab[]>(() =>
    initialTabs.tabIds.map(id => createTerminalTab(Number(id.slice('terminal-'.length))))
  )
  const [activeTabId, setActiveTabId] = useState(initialTabs.activeTabId)
  const [menuActionsByTab, setMenuActionsByTab] = useState<
    Record<string, WorkspacePanelMenuActions>
  >({})
  const activeTab = tabs.find(tab => tab.id === activeTabId) ?? tabs[0] ?? null
  const activeMenuActions = activeTab ? menuActionsByTab[activeTab.id] : undefined
  const renderContent = open || preserveContent
  const panelActive = active && open
  const contentTestIdsEnabled = testIdsEnabled && open
  const testId = (value: string) => (testIdsEnabled ? value : undefined)

  useEffect(() => {
    if (!supportsSsh || !open) return
    let disposed = false
    let revision = 0
    const refresh = async () => {
      const current = ++revision
      try {
        const profiles = await listSshConnections()
        if (!disposed && current === revision) {
          setSshProfiles(profiles)
          setSshLoadFailed(false)
        }
      } catch {
        if (!disposed && current === revision) {
          setSshProfiles([])
          setSshLoadFailed(true)
        }
      }
    }
    void refresh()
    window.addEventListener('kcoder:ssh-connections-changed', refresh)
    return () => {
      disposed = true
      window.removeEventListener('kcoder:ssh-connections-changed', refresh)
    }
  }, [open, supportsSsh])

  useEffect(() => {
    window.localStorage.setItem(
      `${BOTTOM_TERMINAL_TABS_STORAGE_PREFIX}${persistenceKey}`,
      JSON.stringify({
        activeTabId,
        tabIds: tabs.filter(tab => !tab.sshProfile).map(tab => tab.id),
      } satisfies PersistedBottomTerminalTabs)
    )
  }, [activeTabId, persistenceKey, tabs])

  const openTerminalTab = useCallback(() => {
    const tab = createTerminalTab(terminalSequence)
    setTerminalSequence(current => current + 1)
    setTabs(current => [...current, tab])
    setActiveTabId(tab.id)
  }, [terminalSequence])

  const openSshTab = useCallback((profile: SshConnectionProfile) => {
    const tab = {
      id: `ssh-${crypto.randomUUID()}`,
      title: `SSH · ${profile.label}`,
      sshProfile: profile,
    }
    setTabs(current => [...current, tab])
    setActiveTabId(tab.id)
  }, [])

  const closeTab = useCallback(
    (tabId: string) => {
      menuActionsByTab[tabId]?.terminal.close?.()
      const closeIndex = tabs.findIndex(tab => tab.id === tabId)
      const nextTabs = tabs.filter(tab => tab.id !== tabId)

      setMenuActionsByTab(current => {
        if (!current[tabId]) return current
        const next = { ...current }
        delete next[tabId]
        return next
      })

      if (nextTabs.length === 0) {
        const replacementTab = createTerminalTab(terminalSequence)
        setTerminalSequence(current => current + 1)
        setTabs([replacementTab])
        setActiveTabId(replacementTab.id)
        onTerminalTabsEmpty?.()
        onRequestClose()
        return
      }

      setTabs(nextTabs)

      if (activeTabId === tabId || !nextTabs.some(tab => tab.id === activeTabId)) {
        const nextTab = nextTabs[Math.max(closeIndex - 1, 0)] ?? nextTabs[0]
        setActiveTabId(nextTab.id)
      }
    },
    [activeTabId, menuActionsByTab, onRequestClose, onTerminalTabsEmpty, tabs, terminalSequence]
  )

  const updateTabTitle = useCallback((tabId: string, title: string) => {
    const normalizedTitle = title.trim()
    if (!normalizedTitle) return

    setTabs(current => {
      const tab = current.find(item => item.id === tabId)
      if (!tab || tab.title === normalizedTitle) return current

      return current.map(item => (item.id === tabId ? { ...item, title: normalizedTitle } : item))
    })
  }, [])

  const handleMenuActionsChange = useCallback(
    (tabId: string, actions: WorkspacePanelMenuActions | null) => {
      setMenuActionsByTab(current => {
        if (!actions) {
          if (!current[tabId]) return current
          const next = { ...current }
          delete next[tabId]
          return next
        }
        if (current[tabId] === actions) return current
        return { ...current, [tabId]: actions }
      })
    },
    []
  )

  const menuItems = useMemo<WorkspaceAddMenuItem[]>(() => {
    const items: WorkspaceAddMenuItem[] = []
    if (activeMenuActions?.terminal.visible || activeTab?.sshProfile) {
      items.push({
        id: 'terminal',
        testId: 'workspace-add-terminal-option',
        icon: SquareTerminal,
        label: t('workbench.terminal', '终端'),
        disabled: tabs.length >= 20 || Boolean(activeMenuActions?.terminal.disabled),
        onSelect: openTerminalTab,
      })
    }
    if (activeMenuActions?.desktop.visible) {
      items.push({
        id: 'desktop',
        testId: 'workspace-add-desktop-option',
        icon: Monitor,
        label: t('workbench.desktop', '桌面'),
        disabled: activeMenuActions.desktop.disabled,
        onSelect: activeMenuActions.desktop.run,
      })
    }
    if (supportsSsh) {
      for (const profile of sshProfiles)
        items.push({
          id: `ssh-${profile.id}`,
          testId: `workspace-add-ssh-${profile.id}`,
          icon: SquareTerminal,
          label: sshT('menu', { label: profile.label }),
          disabled: tabs.length >= 20,
          onSelect: () => openSshTab(profile),
        })
      items.push({
        id: 'ssh-settings',
        testId: 'workspace-ssh-settings',
        icon: Settings2,
        label: sshT('manage'),
        onSelect: () => navigateTo('/settings/ssh-connections'),
      })
    }
    return items
  }, [
    activeMenuActions,
    activeTab,
    openTerminalTab,
    t,
    supportsSsh,
    sshProfiles,
    sshT,
    openSshTab,
    tabs.length,
  ])

  return (
    <section
      ref={panelRef}
      data-testid={testId('bottom-workspace-panel')}
      className={cn(
        'relative flex shrink-0 flex-col overflow-hidden ease-out',
        showWorkbenchBackground ? 'bg-background/20' : 'bg-background',
        resizing ? 'transition-none' : 'transition-[height,opacity,transform] duration-300',
        open
          ? 'pointer-events-auto translate-y-0 border-t border-border opacity-100'
          : 'pointer-events-none translate-y-3 border-t border-transparent opacity-0'
      )}
      style={{ height: open ? height : 0 }}
      aria-hidden={!open}
    >
      {renderContent && (
        <>
          <div
            data-testid={contentTestIdsEnabled ? 'bottom-workspace-resize-handle' : undefined}
            className="absolute left-0 top-[-4px] z-20 h-3 w-full cursor-row-resize bg-transparent"
            onPointerDown={handleResizeStart}
            aria-label={t('workbench.resize_bottom_workspace_panel')}
          />
          <button
            type="button"
            data-testid={contentTestIdsEnabled ? 'close-bottom-workspace-panel-button' : undefined}
            onClick={onRequestClose}
            className="absolute right-2 top-1 z-30 flex h-8 w-8 items-center justify-center rounded-md text-text-secondary hover:bg-muted hover:text-text-primary"
            aria-label={t('workbench.close_bottom_workspace_panel')}
          >
            <X className="h-3.5 w-3.5" />
          </button>
          <header
            data-testid={contentTestIdsEnabled ? 'bottom-workspace-tabbar' : undefined}
            role="tablist"
            className={cn(
              'flex h-10 shrink-0 items-center gap-1.5 overflow-hidden px-2 pr-12',
              showWorkbenchBackground ? 'bg-transparent' : 'bg-background'
            )}
          >
            <div className="flex min-w-0 items-center gap-1 overflow-x-auto">
              {tabs.map(tab => (
                <BottomWorkspaceTitleTab
                  key={tab.id}
                  testIdsEnabled={contentTestIdsEnabled}
                  active={activeTab?.id === tab.id}
                  label={tab.title}
                  onSelect={() => setActiveTabId(tab.id)}
                  onClose={() => closeTab(tab.id)}
                />
              ))}
            </div>
            <WorkspaceAddMenu
              ariaLabel={t('workbench.workspace_tab_new', '打开新标签页')}
              buttonTestId={contentTestIdsEnabled ? 'workspace-terminal-new-tab-button' : undefined}
              menuTestId={contentTestIdsEnabled ? 'workspace-terminal-new-tab-menu' : undefined}
              items={menuItems}
              buttonClassName="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-text-secondary transition-colors hover:bg-muted hover:text-text-primary"
            />
          </header>
          {sshLoadFailed && (
            <p role="alert" className="px-3 text-xs text-red-500">
              {sshT('loadFailed')}
            </p>
          )}
          <div className="relative flex min-h-0 flex-1 overflow-hidden">
            {tabs.map(tab => (
              <BottomWorkspaceTabContent
                key={tab.id}
                tab={tab}
                active={activeTab?.id === tab.id}
                showWorkbenchBackground={showWorkbenchBackground}
                currentProject={currentProject}
                devices={devices}
                workspaceTarget={workspaceTarget}
                preferLocalTerminal={preferLocalTerminal}
                terminalContextTitle={terminalContextTitle}
                workspaceSessionApi={workspaceSessionApi}
                panelActive={panelActive}
                testIdsEnabled={contentTestIdsEnabled}
                onCloseTab={closeTab}
                onUpdateTabTitle={updateTabTitle}
                onMenuActionsChange={handleMenuActionsChange}
              />
            ))}
          </div>
        </>
      )}
    </section>
  )
})

function BottomWorkspaceTabContent({
  tab,
  active,
  showWorkbenchBackground,
  currentProject,
  devices,
  workspaceTarget,
  preferLocalTerminal,
  terminalContextTitle,
  workspaceSessionApi,
  panelActive,
  testIdsEnabled,
  onCloseTab,
  onUpdateTabTitle,
  onMenuActionsChange,
}: {
  tab: BottomWorkspacePanelTab
  active: boolean
  showWorkbenchBackground: boolean
  currentProject: ProjectWithTasks | null
  devices: DeviceInfo[]
  workspaceTarget: WorkspaceTarget | null
  preferLocalTerminal: boolean
  terminalContextTitle?: string | null
  workspaceSessionApi?: WorkspaceSessionApi
  panelActive: boolean
  testIdsEnabled: boolean
  onCloseTab: (tabId: string) => void
  onUpdateTabTitle: (tabId: string, title: string) => void
  onMenuActionsChange: (tabId: string, actions: WorkspacePanelMenuActions | null) => void
}) {
  const handleRequestClose = useCallback(() => onCloseTab(tab.id), [onCloseTab, tab.id])
  const handleTitleChange = useCallback(
    (title: string) => onUpdateTabTitle(tab.id, title),
    [onUpdateTabTitle, tab.id]
  )
  const handleMenuActionsChange = useCallback(
    (actions: WorkspacePanelMenuActions | null) => onMenuActionsChange(tab.id, actions),
    [onMenuActionsChange, tab.id]
  )

  return (
    <div hidden={!active} className="absolute inset-0 min-h-0 w-full">
      {tab.sshProfile ? (
        <SshTerminalPane
          profile={tab.sshProfile}
          sessionId={tab.id}
          active={panelActive && active}
        />
      ) : (
        <WorkspacePanelCards
          showWorkbenchBackground={showWorkbenchBackground}
          currentProject={currentProject}
          devices={devices}
          workspaceTarget={workspaceTarget}
          defaultOpenTool="terminal"
          onRequestClose={handleRequestClose}
          hideTerminalChrome
          preferLocalTerminal={preferLocalTerminal}
          terminalContextTitle={terminalContextTitle}
          terminalPersistenceScope={tab.id}
          workspaceSessionApi={workspaceSessionApi}
          panelActive={panelActive && active}
          testIdsEnabled={testIdsEnabled}
          onTerminalTitleChange={handleTitleChange}
          onMenuActionsChange={handleMenuActionsChange}
        />
      )}
    </div>
  )
}

function BottomWorkspaceTitleTab({
  testIdsEnabled,
  active,
  label,
  onSelect,
  onClose,
}: {
  testIdsEnabled: boolean
  active: boolean
  label: string
  onSelect: () => void
  onClose: () => void
}) {
  const { t } = useTranslation('common')
  const testId = (value: string) => (testIdsEnabled ? value : undefined)
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') {
      return
    }
    event.preventDefault()
    onSelect()
  }
  return (
    <div
      data-testid={testId('bottom-workspace-terminal-tab')}
      role="tab"
      aria-selected={active}
      tabIndex={0}
      title={label}
      onClick={onSelect}
      onKeyDown={handleKeyDown}
      className={cn(
        'group relative flex h-8 min-w-0 max-w-[200px] cursor-pointer items-center gap-1.5 overflow-hidden rounded-xl py-1 pl-2 pr-7 text-left text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
        active
          ? 'bg-muted text-text-primary'
          : 'bg-background text-text-secondary hover:bg-muted hover:text-text-primary'
      )}
    >
      <SquareTerminal
        data-testid={testId('bottom-workspace-terminal-tab-icon')}
        className="h-3.5 w-3.5 shrink-0 text-text-secondary"
      />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <button
        type="button"
        data-testid={testId('close-bottom-workspace-tab-button')}
        onClick={event => {
          event.stopPropagation()
          onClose()
        }}
        className="pointer-events-none absolute right-1 top-1/2 flex h-[18px] w-[18px] -translate-y-1/2 items-center justify-center rounded-full text-text-secondary opacity-0 transition-colors hover:!bg-text-secondary hover:text-background focus-visible:pointer-events-auto focus-visible:bg-border/70 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 group-hover:pointer-events-auto group-hover:bg-border/70 group-hover:opacity-100"
        aria-label={t('workbench.close_terminal', '关闭终端')}
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  )
}
