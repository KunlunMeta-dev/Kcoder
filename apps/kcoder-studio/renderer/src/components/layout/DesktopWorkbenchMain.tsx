import { WORKBENCH_MAIN_HEADER_PORTAL_ID } from '@/components/topnav/TitlebarActionsPortal'
import {
  defaultAppearance,
  getWorkbenchBackground,
  useOptionalAppearance,
} from '@/features/appearance'
import { useWorkbench, useWorkbenchPaneContext } from '@/features/workbench/useWorkbench'
import { useWorkflowComposerIntent } from '@/features/workflows/useWorkflowComposerIntent'
import { listenAccountContextChanges } from '@/kcoder/accountContextEvents'
import { isTauriRuntime } from '@/lib/runtime-environment'
import { cn } from '@/lib/utils'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { DesktopWorkbenchPane } from './workbench/PaneLayout'
import { MAX_CACHED_DESKTOP_WORKBENCH_PANES } from './workbench/paneLayoutStyles'
import type { DesktopWorkbenchMainProps } from './workbench/types'
import { type TaskSummaryVisibility, type WorkbenchPaneWorkspaceState } from './workbench/types'
import {
  PANE_WORKSPACE_STORAGE_PREFIX,
  readPersistedPaneWorkspaceState,
  writePersistedPaneWorkspaceState,
} from './workbench/workspacePanelPersistence'
import { getRuntimeWorkbenchPaneKeys, getWorkbenchPaneKey } from './workbenchPaneIdentity'
import { CachedWorkbenchPaneStack } from './workbenchPaneStack'

export function DesktopWorkbenchMain(props: DesktopWorkbenchMainProps) {
  const workflowComposerIntent = useWorkflowComposerIntent(
    props.activePane.currentRuntimeTask?.taskId
  )
  const { state } = useWorkbenchPaneContext()
  const { services } = useWorkbench()
  const appearanceContext = useOptionalAppearance()
  const appearance = appearanceContext?.appearance ?? defaultAppearance
  const background = getWorkbenchBackground(appearance, appearanceContext?.resolvedMode ?? 'light')
  const isTauri = isTauriRuntime()
  const [summaryVisibilityByPane, setSummaryVisibilityByPane] = useState<
    Record<string, TaskSummaryVisibility>
  >({})
  const changeSummaryVisibility = useCallback(
    (paneKey: string, mode: keyof TaskSummaryVisibility, open: boolean) => {
      setSummaryVisibilityByPane(current => {
        const previous = current[paneKey] ?? { pinned: false, overlay: false }
        if (previous[mode] === open) return current
        return { ...current, [paneKey]: { ...previous, [mode]: open } }
      })
    },
    []
  )
  const [terminalPinOwnersByPane, setTerminalPinOwnersByPane] = useState<Record<string, string[]>>(
    {}
  )
  const paneWorkspaceStateRef = useRef(new Map<string, WorkbenchPaneWorkspaceState>())
  const invalidatedPaneKeys = useRef(new Set<string>())
  useEffect(
    () =>
      listenAccountContextChanges(targetId => {
        const prefix = `runtime:${targetId}:`
        for (const key of paneWorkspaceStateRef.current.keys()) {
          if (key.startsWith(prefix)) {
            invalidatedPaneKeys.current.add(key)
            paneWorkspaceStateRef.current.delete(key)
          }
        }
        try {
          for (let i = localStorage.length - 1; i >= 0; i--) {
            const key = localStorage.key(i)
            if (key?.startsWith(`${PANE_WORKSPACE_STORAGE_PREFIX}${prefix}`))
              localStorage.removeItem(key)
          }
        } catch {
          /* Storage may be disabled. */
        }
        setTerminalPinOwnersByPane(current =>
          Object.fromEntries(Object.entries(current).filter(([key]) => !key.startsWith(prefix)))
        )
        setSummaryVisibilityByPane(current =>
          Object.fromEntries(Object.entries(current).filter(([key]) => !key.startsWith(prefix)))
        )
      }),
    []
  )
  const terminalPinnedPaneKeys = useMemo(
    () =>
      Object.keys(terminalPinOwnersByPane).filter(key => terminalPinOwnersByPane[key].length > 0),
    [terminalPinOwnersByPane]
  )
  const runtimePaneKeys = useMemo(
    () => getRuntimeWorkbenchPaneKeys(state.runtimeWork),
    [state.runtimeWork]
  )
  const runtimePaneKeySet = useMemo(() => new Set(runtimePaneKeys), [runtimePaneKeys])
  const prunedPaneKeys = useMemo(
    () =>
      terminalPinnedPaneKeys.filter(
        key => key.startsWith('runtime:') && !runtimePaneKeySet.has(key)
      ),
    [runtimePaneKeySet, terminalPinnedPaneKeys]
  )
  const setTerminalPanePinned = useCallback((paneKey: string, owner: string, pinned: boolean) => {
    setTerminalPinOwnersByPane(current => {
      const owners = current[paneKey] ?? []
      const nextOwners = pinned
        ? owners.includes(owner)
          ? owners
          : [...owners, owner]
        : owners.filter(candidate => candidate !== owner)
      if (nextOwners === owners) return current
      if (nextOwners.length === 0) {
        const next = { ...current }
        delete next[paneKey]
        return next
      }
      return { ...current, [paneKey]: nextOwners }
    })
  }, [])
  const rememberPaneWorkspaceState = useCallback(
    (paneKey: string, workspaceState: WorkbenchPaneWorkspaceState) => {
      if (invalidatedPaneKeys.current.has(paneKey)) return
      paneWorkspaceStateRef.current.set(paneKey, workspaceState)
      writePersistedPaneWorkspaceState(paneKey, workspaceState)
    },
    []
  )
  useEffect(() => {
    paneWorkspaceStateRef.current.forEach((_, key) => {
      if (key.startsWith('runtime:') && !runtimePaneKeySet.has(key)) {
        paneWorkspaceStateRef.current.delete(key)
      }
    })
  }, [runtimePaneKeySet])
  const paneStack = (
    <CachedWorkbenchPaneStack
      activePane={props.activePane}
      maxPanes={MAX_CACHED_DESKTOP_WORKBENCH_PANES}
      pinnedKeys={terminalPinnedPaneKeys}
      prunedKeys={prunedPaneKeys}
      validRuntimeKeys={runtimePaneKeys}
      activeTestId="desktop-workbench-main"
      renderPane={pane => (
        <DesktopWorkbenchPane
          pane={pane}
          workflowComposerIntent={workflowComposerIntent}
          workbenchVisible={props.visible ?? true}
          sidebarCollapsed={props.sidebarCollapsed}
          sidebarResizing={props.sidebarResizing ?? false}
          workspaceSessionApi={services?.workspaceSessionApi}
          summaryVisibility={summaryVisibilityByPane[getWorkbenchPaneKey(pane)]}
          onSummaryVisibilityChange={changeSummaryVisibility}
          onSidebarCollapsedChange={props.onSidebarCollapsedChange}
          onTerminalPanePinChange={setTerminalPanePinned}
          initialWorkspaceState={
            paneWorkspaceStateRef.current.get(getWorkbenchPaneKey(pane)) ??
            readPersistedPaneWorkspaceState(getWorkbenchPaneKey(pane))
          }
          onWorkspaceStateChange={rememberPaneWorkspaceState}
        />
      )}
    />
  )

  if (!isTauri) return paneStack

  return (
    <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
      <header
        id={WORKBENCH_MAIN_HEADER_PORTAL_ID}
        data-testid="workbench-main-header"
        className={cn(
          'relative z-chrome flex h-[38px] shrink-0 items-center overflow-hidden border-b border-border/40',
          background.imagePath && background.inTopBar ? 'bg-background/20' : 'bg-background/95'
        )}
      />
      {paneStack}
    </div>
  )
}
