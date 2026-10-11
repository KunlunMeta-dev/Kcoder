import type { CloudLoopItem, CloudProject } from '@/api/deliveries'
import type { WorkspaceSessionApi } from '@/features/workbench/workbenchServices'
import { useWorkflowComposerIntent } from '@/features/workflows/useWorkflowComposerIntent'
import type { RuntimeTaskAddress } from '@/types/api'
import { type WorkbenchPaneIdentity } from '../workbenchPaneIdentity'
import {
  type RightWorkspacePanelTab,
  type RightWorkspacePanelView,
} from '../workspace-panels/RightWorkspacePanel'

export interface PendingTodoBinding {
  project: CloudProject
  item: CloudLoopItem | null
  target: RuntimeTaskAddress | null
}

export interface SelectedAssistantPlan {
  blockId: string
  subtaskId: string
  fallbackContent: string
}

export interface WorkbenchPaneWorkspaceState {
  rightPanelOpen: boolean
  rightPanelView: RightWorkspacePanelView
  rightPanelTabs: RightWorkspacePanelTab[]
  browserUrl: string | null
}

export type TaskSummaryVisibility = { pinned: boolean; overlay: boolean }

export type DesktopWorkbenchPaneProps = {
  pane: WorkbenchPaneIdentity
  workflowComposerIntent: ReturnType<typeof useWorkflowComposerIntent>
  workbenchVisible: boolean
  sidebarCollapsed: boolean
  sidebarResizing?: boolean
  workspaceSessionApi?: WorkspaceSessionApi
  summaryVisibility?: TaskSummaryVisibility
  onSummaryVisibilityChange: (
    paneKey: string,
    mode: keyof TaskSummaryVisibility,
    open: boolean
  ) => void
  onSidebarCollapsedChange: (collapsed: boolean) => void
  onTerminalPanePinChange: (paneKey: string, owner: string, pinned: boolean) => void
  initialWorkspaceState?: WorkbenchPaneWorkspaceState
  onWorkspaceStateChange: (paneKey: string, state: WorkbenchPaneWorkspaceState) => void
}

export interface DesktopWorkbenchMainProps {
  activePane: WorkbenchPaneIdentity
  visible?: boolean
  sidebarCollapsed: boolean
  sidebarResizing?: boolean
  onSidebarCollapsedChange: (collapsed: boolean) => void
}

export interface PendingBlankBrowserMigration {
  sourcePaneKey: string
  browserLabel: string
  rightPanelOpen: boolean
  rightPanelView: RightWorkspacePanelView
  rightPanelTabs: RightWorkspacePanelTab[]
  createdAt: number
}
