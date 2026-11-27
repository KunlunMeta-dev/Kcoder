import type { WorkspaceSessionApi } from '@/features/workbench/workbenchServices'
import { memo, useCallback } from 'react'
import { type BottomPanelRenderContext } from '../desktopWorkbenchPaneTypes'
import { BottomWorkspacePanel } from '../workspace-panels/BottomWorkspacePanel'

export const MemoizedBottomWorkspacePanel = memo(function MemoizedBottomWorkspacePanel({
  panelKey,
  open,
  active,
  context,
  workspaceSessionApi,
  showWorkbenchBackground,
  onRequestClose,
  onTerminalTabsEmpty,
}: {
  panelKey: string
  open: boolean
  active: boolean
  context: BottomPanelRenderContext
  workspaceSessionApi?: WorkspaceSessionApi
  showWorkbenchBackground: boolean
  onRequestClose: (key: string) => void
  onTerminalTabsEmpty: () => void
}) {
  const closePanel = useCallback(() => onRequestClose(panelKey), [onRequestClose, panelKey])

  return (
    <BottomWorkspacePanel
      persistenceKey={panelKey}
      open={open}
      active={active}
      preserveContent
      testIdsEnabled={active}
      currentProject={context.currentProject}
      devices={context.devices}
      workspaceTarget={context.workspaceTarget}
      preferLocalTerminal={context.preferLocalTerminal}
      terminalContextTitle={context.terminalContextTitle}
      workspaceSessionApi={workspaceSessionApi}
      showWorkbenchBackground={showWorkbenchBackground}
      onRequestClose={closePanel}
      onTerminalTabsEmpty={onTerminalTabsEmpty}
    />
  )
})
