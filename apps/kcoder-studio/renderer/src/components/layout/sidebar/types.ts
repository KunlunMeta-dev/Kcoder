import {
  type StandaloneRemoteDialogIntent,
  type StandaloneWorkspaceDialogMode,
} from '@/components/projects/StandaloneProjectDialogs'
import type {
  ArchiveRuntimeConversationsResult,
  ArchiveRuntimeTaskOptions,
  ArchiveRuntimeTaskResult,
} from '@/features/workbench/workbenchContextTypes'
import type {
  DeviceInfo,
  ProjectWithTasks,
  RuntimeIMNotificationSettingsResponse,
  RuntimeProjectAppearanceRequest,
  RuntimeProjectPinRequest,
  RuntimeProjectReorderRequest,
  RuntimeProjectTaskReorderRequest,
  RuntimeTaskAddress,
  RuntimeTaskPinRequest,
  RuntimeWorkListResponse,
  User as UserProfile,
} from '@/types/api'
import type { DockerRemoteDeviceCommandResponse } from '@/types/devices'
import type { CloudWorkStatus } from '@/types/workbench'
import type { PointerEventHandler } from 'react'

export interface DesktopSidebarProps {
  onHistoryRefreshed?: () => Promise<void>
  user: UserProfile | null
  projects: ProjectWithTasks[]
  devices: DeviceInfo[]
  cloudWorkStatus?: CloudWorkStatus
  runtimeWork?: RuntimeWorkListResponse | null
  currentRuntimeTask?: RuntimeTaskAddress | null
  standaloneDeviceId?: string | null
  standaloneWorkspacePath?: string | null
  imNotificationSettings?: RuntimeIMNotificationSettingsResponse | null
  unreadRuntimeTaskKeys?: ReadonlySet<string>
  preferredDeviceId?: string | null
  activeItem?: 'chat' | 'todo' | 'plugins' | 'sites' | 'automation' | 'workflows' | 'knowledge'
  collapsed?: boolean
  containerTestId?: string
  hideResizeHandle?: boolean
  onResizeCollapse?: () => void
  onResizeStateChange?: (resizing: boolean) => void
  onPointerEnter?: PointerEventHandler<HTMLElement>
  onPointerLeave?: PointerEventHandler<HTMLElement>
  onToggleSidebar?: () => void
  onOpenWorkbench?: () => void
  onOpenTodo?: () => void
  onOpenApps?: () => void
  onNewChat: () => void
  onStartStandaloneChat: () => void
  onOpenSearch?: () => void
  onSelectProject?: (projectId: number) => void
  onStartNewProjectChat: (projectId: number) => void
  onOpenRuntimeTask?: (address: RuntimeTaskAddress) => Promise<void> | void
  onMarkRuntimeTaskRead?: (address: RuntimeTaskAddress) => void
  onRenameRuntimeTask?: (address: RuntimeTaskAddress, title: string) => Promise<void> | void
  onArchiveRuntimeTask?: (
    address: RuntimeTaskAddress,
    options?: ArchiveRuntimeTaskOptions
  ) => Promise<ArchiveRuntimeTaskResult | void> | ArchiveRuntimeTaskResult | void
  onArchiveProjectConversations?: (
    runtimeProjectKey: string,
    options?: ArchiveRuntimeTaskOptions
  ) => Promise<ArchiveRuntimeConversationsResult | void> | ArchiveRuntimeConversationsResult | void
  onArchiveProjectsConversations?: (
    runtimeProjectKeys: string[],
    options?: ArchiveRuntimeTaskOptions
  ) => Promise<ArchiveRuntimeConversationsResult | void> | ArchiveRuntimeConversationsResult | void
  onArchiveChatConversations?: (
    addresses: RuntimeTaskAddress[],
    options?: ArchiveRuntimeTaskOptions
  ) => Promise<ArchiveRuntimeConversationsResult | void> | ArchiveRuntimeConversationsResult | void
  onToggleRuntimeTaskNotification?: (
    address: RuntimeTaskAddress,
    subscribed: boolean
  ) => Promise<void> | void
  onToggleGlobalImNotification?: () => Promise<void> | void
  onOpenGlobalImNotificationSettings?: () => Promise<void> | void
  onOpenPlugins: () => void
  onOpenSites?: () => void
  onRefreshDevices?: () => Promise<void>
  onOpenStandaloneFolderProject?: (
    mode: StandaloneWorkspaceDialogMode,
    intent?: StandaloneRemoteDialogIntent
  ) => void
  onOpenStandaloneWorkspace?: (
    deviceId: string,
    workspacePath: string,
    label?: string
  ) => Promise<void> | void
  onCreatePermanentWorktree?: (data: {
    deviceId: string
    sourcePath: string
    name: string
  }) => Promise<void>
  onSelectStandaloneDevice?: (deviceId: string | null) => void
  onGetRemoteDeviceStartupCommand?: () => Promise<DockerRemoteDeviceCommandResponse>
  onUpdateProjectName: (projectId: number, name: string) => Promise<void>
  onUpdateLocalRuntimeProject?: (data: {
    deviceId: string
    projectKey: string
    name: string
    roots: string[]
  }) => Promise<void>
  onRemoveProject: (projectId: number) => Promise<void>
  onReorderRuntimeProjects?: (data: RuntimeProjectReorderRequest) => Promise<void>
  onSetRuntimeProjectPinned?: (data: RuntimeProjectPinRequest) => Promise<void>
  onSetRuntimeProjectAppearance?: (data: RuntimeProjectAppearanceRequest) => Promise<void>
  onReorderRuntimeProjectTasks?: (data: RuntimeProjectTaskReorderRequest) => Promise<void>
  onSetRuntimeTaskPinned?: (data: RuntimeTaskPinRequest) => Promise<void>
  onGetDeviceHomeDirectory: (deviceId: string) => Promise<string>
  onListDeviceDirectories: (deviceId: string, path: string) => Promise<string[]>
  onCreateDeviceDirectory: (deviceId: string, path: string) => Promise<void>
  onOpenSettings: (options?: OpenSettingsOptions) => void
  onLogout: () => void
}

export interface RuntimeTaskPinOverride {
  base: boolean
  value: boolean
  requestId: number
  source: RuntimeWorkListResponse | null | undefined
}

export function getRuntimeTaskPinOverrideKey(deviceId: string, threadId: string) {
  return `${deviceId}\0${threadId}`
}

export interface OpenSettingsOptions {
  autoOpenAddCloudDeviceDialog?: boolean
  settingsPage?: 'connections'
}

export type ProjectCreateMenuPosition = {
  top: number
  left: number
}

export interface ArchiveConversationsConfirmDialogProps {
  open: boolean
  title: string
  description: string
  confirmLabel: string
  cancelLabel: string
  submitting: boolean
  testId: string
  onClose: () => void
  onConfirm: () => Promise<void> | void
}
