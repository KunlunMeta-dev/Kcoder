import {
  type StandaloneRemoteDialogIntent,
  type StandaloneWorkspaceDialogMode,
} from '@/components/projects/StandaloneProjectDialogs'
import { getRuntimeConfig } from '@/config/runtime'
import { useOptionalAppUpdate } from '@/features/app-update/app-update-context'
import {
  defaultAppearance,
  getWorkbenchBackground,
  useOptionalAppearance,
} from '@/features/appearance'
import { isCloudConnectionUiAvailable } from '@/features/cloud-connection/cloudConnectionAvailability'
import { useOptionalCloudConnection } from '@/features/cloud-connection/useCloudConnection'
import { useExperimentalFeaturesEnabled } from '@/features/experimental-features/useExperimentalFeaturesEnabled'
import { useEscapeKey } from '@/hooks/useEscapeKey'
import { useTranslation } from '@/hooks/useTranslation'
import {
  fetchGatewayServersWithHealth,
  getAccountDeviceId,
  isKCoderGatewayPage,
  logoutGatewayAccount,
  type GatewayServer,
} from '@/kcoder/gatewayRpc'
import { isTauriRuntime } from '@/lib/runtime-environment'
import { runtimeProjectToProject, runtimeProjectUiId } from '@/lib/runtime-project'
import { getLocalRuntimeStateDeviceId } from '@/lib/runtime-project-state'
import type { ProjectWithTasks, RuntimeProjectWork } from '@/types/api'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSidebarRelativeTimeRefresh } from '../runtimeSidebarTime'
import {
  getRuntimeChatSidebarTaskItems,
  getRuntimeSidebarTaskItems,
  getRuntimeTaskAddress,
  isRuntimeTaskSelected,
} from '../runtimeTaskSidebarHelpers'
import { useResizableSidebar } from '../useResizableSidebar'
import { canEditLocalRuntimeProject } from './sidebarSelectors'

import {
  getDesktopSidebarStorageKey,
  getDesktopSidebarStorageScope,
  pruneProjectIdSet,
  readStoredBoolean,
  readStoredNumberSet,
  writeStoredBoolean,
  writeStoredNumberSet,
} from './sidebarPersistence'
import {
  getRuntimeNotificationKey,
  getRuntimeTaskThreadId,
  getSidebarAccountSummary,
  normalizeSidebarWorkspacePath,
  standaloneRuntimeProjectWork,
} from './sidebarSelectors'
import {
  getRuntimeTaskPinOverrideKey,
  type DesktopSidebarProps,
  type RuntimeTaskPinOverride,
} from './types'
import { useSidebarArchiveAction, useSidebarTaskPinAction } from './useSidebarActions'
import { useSidebarWindowFocus } from './useSidebarWindowFocus'

export function useSidebarModel({
  onHistoryRefreshed,
  user,
  projects,
  devices,
  cloudWorkStatus,
  runtimeWork,
  currentRuntimeTask,
  standaloneDeviceId,
  standaloneWorkspacePath,
  imNotificationSettings,
  unreadRuntimeTaskKeys,
  preferredDeviceId,
  activeItem = 'chat',
  onNewChat,
  onStartStandaloneChat,
  onOpenSearch,
  onStartNewProjectChat,
  onOpenRuntimeTask,
  onMarkRuntimeTaskRead,
  onRenameRuntimeTask,
  onArchiveRuntimeTask,
  onArchiveProjectConversations,
  onArchiveProjectsConversations,
  onArchiveChatConversations,
  onToggleRuntimeTaskNotification,
  onToggleGlobalImNotification,
  onOpenGlobalImNotificationSettings,
  onOpenPlugins,
  onOpenSites,
  onRefreshDevices,
  onOpenStandaloneFolderProject,
  onOpenStandaloneWorkspace,
  onCreatePermanentWorktree,
  onSelectStandaloneDevice,
  onGetRemoteDeviceStartupCommand,
  onUpdateProjectName,
  onUpdateLocalRuntimeProject,
  onRemoveProject,
  onReorderRuntimeProjects,
  onSetRuntimeProjectPinned,
  onSetRuntimeProjectAppearance,
  onReorderRuntimeProjectTasks,
  onSetRuntimeTaskPinned,
  onGetDeviceHomeDirectory,
  onListDeviceDirectories,
  onCreateDeviceDirectory,
  onOpenSettings,
  onLogout,
  collapsed = false,
  containerTestId = 'desktop-sidebar',
  hideResizeHandle = false,
  onResizeCollapse,
  onResizeStateChange,
  onPointerEnter,
  onPointerLeave,
  onToggleSidebar,
  onOpenWorkbench,
  onOpenTodo,
  onOpenApps,
}: DesktopSidebarProps) {
  const appearanceContext = useOptionalAppearance()
  const appearance = appearanceContext?.appearance ?? defaultAppearance
  const background = getWorkbenchBackground(appearance, appearanceContext?.resolvedMode ?? 'light')
  useSidebarRelativeTimeRefresh()
  const { t } = useTranslation('common')
  const { sidebarWidth, resizing, handleResizeStart } = useResizableSidebar({
    onCollapse: onResizeCollapse,
    onResizeStateChange,
  })
  const showCloudConnectionEntry = isCloudConnectionUiAvailable()
  const cloud = useOptionalCloudConnection()
  const defaultWegentBackendUrl = getRuntimeConfig().wegentBackendUrl
  const usesCloudAccount = showCloudConnectionEntry && Boolean(defaultWegentBackendUrl)
  const requiresCloudLogin = usesCloudAccount && !cloud.isConnected
  const usesOverlayTitlebar = isTauriRuntime()
  const hasAvailableAppUpdate = Boolean(useOptionalAppUpdate()?.availableUpdate)
  const experimentalFeaturesEnabled = useExperimentalFeaturesEnabled()
  const [gatewayAccountTargets, setGatewayAccountTargets] = useState<GatewayServer[]>([])
  const refreshGatewayAccountTargets = useCallback(async () => {
    if (!isKCoderGatewayPage()) return
    try {
      const servers = await fetchGatewayServersWithHealth()
      setGatewayAccountTargets(servers.filter(server => Boolean(server.security)))
    } catch {
      setGatewayAccountTargets([])
    }
  }, [])
  useEffect(() => {
    let active = true
    const changed = () => {
      if (active) void refreshGatewayAccountTargets()
    }
    queueMicrotask(changed)
    window.addEventListener('kcoder:servers-changed', changed)
    return () => {
      active = false
      window.removeEventListener('kcoder:servers-changed', changed)
    }
  }, [refreshGatewayAccountTargets])
  const gatewayLoggedInTargets = gatewayAccountTargets.filter(server => server.accountIdentity)
  const handleGatewayAccountLogout = useCallback(
    (server: GatewayServer) =>
      logoutGatewayAccount(server.id, getAccountDeviceId()).then(() => {
        return refreshGatewayAccountTargets()
      }),
    [refreshGatewayAccountTargets]
  )
  const sidebarAccount = requiresCloudLogin
    ? {
        label: t('workbench.account_cloud_title', '云端账户'),
        detail: t('workbench.account_not_logged_in', '未登录'),
      }
    : gatewayAccountTargets.length > 0
      ? {
          label:
            gatewayLoggedInTargets.length === 1
              ? gatewayLoggedInTargets[0].accountIdentity!.username
              : t('workbench.account_gateway_section', 'KCoder 账号'),
          detail:
            gatewayLoggedInTargets.length === 1
              ? gatewayLoggedInTargets[0].label
              : gatewayLoggedInTargets.length > 1
                ? t('workbench.account_gateway_logged_in_count', '已登录 {{count}} 个目标').replace(
                    '{{count}}',
                    String(gatewayLoggedInTargets.length)
                  )
                : t('workbench.account_not_logged_in', '未登录'),
        }
      : getSidebarAccountSummary(
          usesCloudAccount ? cloud.user : user,
          t('workbench.account_fallback', '当前账号')
        )
  const windowFocused = useSidebarWindowFocus()

  const storageScope = getDesktopSidebarStorageScope(user)
  const projectsExpandedStorageKey = getDesktopSidebarStorageKey(storageScope, 'projectsExpanded')
  const chatsExpandedStorageKey = getDesktopSidebarStorageKey(storageScope, 'chatsExpanded')
  const expandedProjectIdsStorageKey = getDesktopSidebarStorageKey(
    storageScope,
    'expandedProjectIds'
  )
  const storageScopeRef = useRef(storageScope)
  const [settingsMenuOpen, setSettingsMenuOpen] = useState(false)
  const [accountCloudDialogOpen, setAccountCloudDialogOpen] = useState(false)
  const [imNotificationMenuOpen, setImNotificationMenuOpen] = useState(false)
  const [archiveSectionMode, setArchiveSectionMode] = useState<'projects' | 'chats' | null>(null)
  const [forceArchiveSectionMode, setForceArchiveSectionMode] = useState<
    'projects' | 'chats' | null
  >(null)
  const [isArchivingProjectSection, setIsArchivingProjectSection] = useState(false)
  const [isArchivingChatSection, setIsArchivingChatSection] = useState(false)
  const settingsMenuRef = useRef<HTMLDivElement>(null)
  const [projectCreateDialogOpen, setProjectCreateDialogOpen] = useState(false)
  const [standaloneWorkspaceDialogMode, setStandaloneWorkspaceDialogMode] =
    useState<StandaloneWorkspaceDialogMode | null>(null)
  const [standaloneRemoteDialogIntent, setStandaloneRemoteDialogIntent] =
    useState<StandaloneRemoteDialogIntent>('project')
  const [renamingProject, setRenamingProject] = useState<ProjectWithTasks | null>(null)
  const [editingLocalProject, setEditingLocalProject] = useState<RuntimeProjectWork | null>(null)
  const openProjectEditor = (project: ProjectWithTasks, projectWork?: RuntimeProjectWork) => {
    if (
      projectWork &&
      canEditLocalRuntimeProject(projectWork, sidebarStateDeviceId) &&
      onUpdateLocalRuntimeProject
    ) {
      setEditingLocalProject(projectWork)
      return
    }
    setRenamingProject(project)
  }
  const [projectsExpanded, setProjectsExpanded] = useState(() =>
    readStoredBoolean(projectsExpandedStorageKey, true)
  )
  const [chatsExpanded, setChatsExpanded] = useState(() =>
    readStoredBoolean(chatsExpandedStorageKey, true)
  )
  const [expandedProjectIds, setExpandedProjectIds] = useState<Set<number>>(() =>
    readStoredNumberSet(expandedProjectIdsStorageKey)
  )
  const [chatTaskPinOverrides, setChatTaskPinOverrides] = useState<
    Map<string, RuntimeTaskPinOverride>
  >(() => new Map())
  const chatTaskPinRequestIdRef = useRef(0)
  const [sidebarScrolled, setSidebarScrolled] = useState(false)
  const visibleUnreadRuntimeTaskKeys = unreadRuntimeTaskKeys ?? new Set<string>()
  const sidebarStateDeviceId = getLocalRuntimeStateDeviceId(devices)
  const standaloneProjectWork = useMemo(
    () =>
      standaloneRuntimeProjectWork(
        devices,
        standaloneDeviceId,
        standaloneWorkspacePath,
        runtimeWork
      ),
    [devices, runtimeWork, standaloneDeviceId, standaloneWorkspacePath]
  )
  const sidebarRuntimeProjects = useMemo(() => {
    const items = runtimeWork?.projects ?? []
    return standaloneProjectWork ? [standaloneProjectWork, ...items] : items
  }, [runtimeWork?.projects, standaloneProjectWork])
  const sidebarProjects = useMemo(() => {
    if (runtimeWork || standaloneProjectWork) {
      return sidebarRuntimeProjects.map(runtimeProjectToProject)
    }
    return projects
  }, [projects, runtimeWork, sidebarRuntimeProjects, standaloneProjectWork])
  const visibleExpandedProjectIds = useMemo(
    () => pruneProjectIdSet(expandedProjectIds, sidebarProjects),
    [expandedProjectIds, sidebarProjects]
  )
  const runtimeWorkByProjectId = useMemo(() => {
    return new Map(sidebarRuntimeProjects.map(item => [runtimeProjectUiId(item.project), item]))
  }, [sidebarRuntimeProjects])
  const sortableProjects = useMemo(
    () =>
      sidebarProjects.map(project => ({
        project,
        runtimeProjectWork: runtimeWorkByProjectId.get(project.id),
      })),
    [runtimeWorkByProjectId, sidebarProjects]
  )
  const pinnedProjects = useMemo(
    () =>
      sortableProjects
        .filter(({ runtimeProjectWork }) => runtimeProjectWork?.project.pinned)
        .sort(
          (left, right) =>
            (left.runtimeProjectWork?.project.pinnedOrder ?? Number.MAX_SAFE_INTEGER) -
            (right.runtimeProjectWork?.project.pinnedOrder ?? Number.MAX_SAFE_INTEGER)
        ),
    [sortableProjects]
  )
  const regularSortableProjects = useMemo(
    () => sortableProjects.filter(({ runtimeProjectWork }) => !runtimeProjectWork?.project.pinned),
    [sortableProjects]
  )
  const chatWorkspaces = useMemo(() => runtimeWork?.chats ?? [], [runtimeWork?.chats])
  const chatTaskItems = useMemo(
    () => getRuntimeChatSidebarTaskItems(chatWorkspaces),
    [chatWorkspaces]
  )
  const chatTaskItemsWithPinState = useMemo(
    () =>
      chatTaskItems.map(item => {
        const threadId = getRuntimeTaskThreadId(item.task)
        const persistedPinned = Boolean(item.task.pinned)
        const override = threadId
          ? chatTaskPinOverrides.get(
              getRuntimeTaskPinOverrideKey(item.workspace.deviceId, threadId)
            )
          : undefined
        const pinned =
          override && override.source === runtimeWork && override.base === persistedPinned
            ? override.value
            : persistedPinned
        return pinned === persistedPinned ? item : { ...item, task: { ...item.task, pinned } }
      }),
    [chatTaskItems, chatTaskPinOverrides, runtimeWork]
  )
  const regularChatTaskItems = useMemo(
    () => chatTaskItemsWithPinState.filter(({ task }) => !task.pinned),
    [chatTaskItemsWithPinState]
  )
  const pinnedTaskItems = useMemo(() => {
    const projectTasks = sidebarRuntimeProjects.flatMap(projectWork =>
      getRuntimeSidebarTaskItems(projectWork.deviceWorkspaces)
        .filter(({ task }) => task.pinned)
        .map(item => ({ ...item, projectWork }))
    )
    const chatTasks = chatTaskItemsWithPinState
      .filter(({ task }) => task.pinned)
      .map(item => ({ ...item, projectWork: null }))
    return [...projectTasks, ...chatTasks].sort(
      (left, right) =>
        (left.task.pinnedOrder ?? Number.MAX_SAFE_INTEGER) -
        (right.task.pinnedOrder ?? Number.MAX_SAFE_INTEGER)
    )
  }, [chatTaskItemsWithPinState, sidebarRuntimeProjects])
  const setChatTaskPinned = useSidebarTaskPinAction({
    onSetRuntimeTaskPinned,
    chatTaskItems,
    chatTaskPinRequestIdRef,
    setChatTaskPinOverrides,
    runtimeWork,
  })
  const projectSectionArchiveItems = useMemo(() => {
    return sidebarRuntimeProjects
      .map(projectWork => ({
        key: projectWork.project.key,
        count: getRuntimeSidebarTaskItems(projectWork.deviceWorkspaces).length,
      }))
      .filter(item => item.count > 0)
  }, [sidebarRuntimeProjects])
  const projectSectionArchiveKeys = useMemo(
    () => projectSectionArchiveItems.map(item => item.key),
    [projectSectionArchiveItems]
  )
  const projectSectionArchiveCount = useMemo(
    () => projectSectionArchiveItems.reduce((total, item) => total + item.count, 0),
    [projectSectionArchiveItems]
  )
  const chatSectionArchiveAddresses = useMemo(
    () => chatTaskItems.map(({ workspace, task }) => getRuntimeTaskAddress(workspace, task)),
    [chatTaskItems]
  )
  const chatSectionArchiveCount = chatSectionArchiveAddresses.length
  const selectedRuntimeProject = useMemo(() => {
    if (currentRuntimeTask) {
      const projectWork = sidebarRuntimeProjects.find(item =>
        item.deviceWorkspaces.some(workspace =>
          workspace.tasks.some(task => isRuntimeTaskSelected(currentRuntimeTask, workspace, task))
        )
      )
      return projectWork
        ? {
            autoExpandKey: `task:${getRuntimeNotificationKey(currentRuntimeTask)}`,
            id: runtimeProjectUiId(projectWork.project),
          }
        : null
    }

    const normalizedDeviceId = standaloneDeviceId?.trim()
    const normalizedWorkspacePath = standaloneWorkspacePath
      ? normalizeSidebarWorkspacePath(standaloneWorkspacePath)
      : ''
    if (!normalizedDeviceId || !normalizedWorkspacePath) return null

    const projectWork = sidebarRuntimeProjects.find(item =>
      item.deviceWorkspaces.some(
        workspace =>
          workspace.deviceId === normalizedDeviceId &&
          normalizeSidebarWorkspacePath(workspace.workspacePath) === normalizedWorkspacePath
      )
    )
    return projectWork
      ? {
          autoExpandKey: `workspace:${normalizedDeviceId}:${normalizedWorkspacePath}`,
          id: runtimeProjectUiId(projectWork.project),
        }
      : null
  }, [currentRuntimeTask, sidebarRuntimeProjects, standaloneDeviceId, standaloneWorkspacePath])
  const selectedRuntimeProjectId = selectedRuntimeProject?.id ?? null
  const selectedRuntimeProjectAutoExpandKey = selectedRuntimeProject?.autoExpandKey ?? null
  const selectedRuntimeChatVisible = useMemo(() => {
    if (!currentRuntimeTask) return false
    return regularChatTaskItems.some(({ workspace, task }) =>
      isRuntimeTaskSelected(currentRuntimeTask, workspace, task)
    )
  }, [currentRuntimeTask, regularChatTaskItems])
  const displayedProjectsExpanded = projectsExpanded
  const displayedChatsExpanded = chatsExpanded || selectedRuntimeChatVisible
  const isArchiveSectionSubmitting =
    archiveSectionMode === 'projects' ? isArchivingProjectSection : isArchivingChatSection
  const archiveSectionDialogTestId =
    archiveSectionMode === 'chats'
      ? 'runtime-chat-section-archive-conversations-dialog'
      : 'projects-section-archive-conversations-dialog'
  const archiveSectionDialogCount =
    archiveSectionMode === 'chats' ? chatSectionArchiveCount : projectSectionArchiveCount
  const closeArchiveSectionDialog = () => {
    if (!isArchiveSectionSubmitting) {
      setArchiveSectionMode(null)
    }
  }
  const forceArchiveSectionDialogTestId =
    forceArchiveSectionMode === 'chats'
      ? 'runtime-chat-section-force-archive-dialog'
      : 'projects-section-force-archive-dialog'
  const runArchiveSectionConversations = useSidebarArchiveAction({
    onArchiveProjectsConversations,
    onArchiveChatConversations,
    projectSectionArchiveKeys,
    chatSectionArchiveAddresses,
    setIsArchivingProjectSection,
    setIsArchivingChatSection,
    setArchiveSectionMode,
    setForceArchiveSectionMode,
  })
  const confirmArchiveSectionConversations = () => {
    if (!archiveSectionMode) return
    void runArchiveSectionConversations(archiveSectionMode)
  }
  const closeForceArchiveSectionDialog = () => {
    if (!isArchiveSectionSubmitting) {
      setForceArchiveSectionMode(null)
    }
  }
  const confirmForceArchiveSectionConversations = () => {
    if (!forceArchiveSectionMode) return
    void runArchiveSectionConversations(forceArchiveSectionMode, { force: true })
  }
  const displayedExpandedProjectIds = visibleExpandedProjectIds
  const autoExpandedProjectKeyRef = useRef<string | null>(null)

  const handleToggleProject = (projectId: number) => {
    setExpandedProjectIds(previous => {
      const next = new Set(previous)
      if (next.has(projectId)) {
        next.delete(projectId)
      } else {
        next.add(projectId)
      }
      return next
    })
  }

  useEffect(() => {
    if (selectedRuntimeProjectId === null || !selectedRuntimeProjectAutoExpandKey) return

    const scopedAutoExpandKey = `${storageScope}:${selectedRuntimeProjectAutoExpandKey}`
    if (autoExpandedProjectKeyRef.current === scopedAutoExpandKey) return

    autoExpandedProjectKeyRef.current = scopedAutoExpandKey
    setProjectsExpanded(true)
    setExpandedProjectIds(previous => {
      if (previous.has(selectedRuntimeProjectId)) return previous
      return new Set([...previous, selectedRuntimeProjectId])
    })
  }, [selectedRuntimeProjectAutoExpandKey, selectedRuntimeProjectId, storageScope])

  const openProjectCreateDialog = () => {
    setProjectCreateDialogOpen(true)
    void onRefreshDevices?.().catch(() => undefined)
  }

  useEscapeKey(() => setProjectCreateDialogOpen(false), projectCreateDialogOpen)

  useEffect(() => {
    if (storageScopeRef.current !== storageScope) return
    writeStoredBoolean(projectsExpandedStorageKey, projectsExpanded)
  }, [projectsExpanded, projectsExpandedStorageKey, storageScope])

  useEffect(() => {
    if (storageScopeRef.current !== storageScope) return
    writeStoredBoolean(chatsExpandedStorageKey, chatsExpanded)
  }, [chatsExpanded, chatsExpandedStorageKey, storageScope])

  useEffect(() => {
    if (storageScopeRef.current !== storageScope) return
    writeStoredNumberSet(expandedProjectIdsStorageKey, expandedProjectIds)
  }, [expandedProjectIds, expandedProjectIdsStorageKey, storageScope])

  useEffect(() => {
    if (storageScopeRef.current === storageScope) return

    storageScopeRef.current = storageScope
    setProjectsExpanded(readStoredBoolean(projectsExpandedStorageKey, true))
    setChatsExpanded(readStoredBoolean(chatsExpandedStorageKey, true))
    setExpandedProjectIds(readStoredNumberSet(expandedProjectIdsStorageKey))
  }, [
    chatsExpandedStorageKey,
    expandedProjectIdsStorageKey,
    projectsExpandedStorageKey,
    storageScope,
  ])

  useEffect(() => {
    if (!settingsMenuOpen && !imNotificationMenuOpen) {
      return
    }

    const handleOutsidePointer = (event: globalThis.MouseEvent | globalThis.PointerEvent) => {
      // Dialogs (quit app, account login/logout/switch) are portaled outside
      // this menu; interacting with them must keep the menu mounted.
      const target = event.target as HTMLElement | null
      if (target?.closest('[role="dialog"]')) return
      if (!settingsMenuRef.current?.contains(target)) {
        setSettingsMenuOpen(false)
        setImNotificationMenuOpen(false)
      }
    }

    document.addEventListener('pointerdown', handleOutsidePointer)
    document.addEventListener('mousedown', handleOutsidePointer)

    return () => {
      document.removeEventListener('pointerdown', handleOutsidePointer)
      document.removeEventListener('mousedown', handleOutsidePointer)
    }
  }, [imNotificationMenuOpen, settingsMenuOpen])

  const lastAutomaticTaskScroll = useRef<string | null>(null)
  useEffect(() => {
    if (!currentRuntimeTask) {
      lastAutomaticTaskScroll.current = null
      return
    }
    const sectionVisible =
      selectedRuntimeProjectId === null
        ? displayedChatsExpanded
        : displayedProjectsExpanded && displayedExpandedProjectIds.has(selectedRuntimeProjectId)
    if (!sectionVisible) {
      lastAutomaticTaskScroll.current = null
      return
    }
    const selection = JSON.stringify([
      storageScope,
      currentRuntimeTask.deviceId,
      currentRuntimeTask.taskId,
      selectedRuntimeProjectId,
    ])
    // Metadata refreshes recreate address/Set objects; they are not navigation intents.
    if (lastAutomaticTaskScroll.current === selection) return
    const taskRow = document.querySelector(
      `[data-testid="runtime-local-task-row-${currentRuntimeTask.taskId}"]`
    )
    if (taskRow) {
      lastAutomaticTaskScroll.current = selection
      taskRow.scrollIntoView({ block: 'nearest' })
    }
  }, [
    currentRuntimeTask,
    displayedChatsExpanded,
    displayedExpandedProjectIds,
    displayedProjectsExpanded,
    selectedRuntimeProjectId,
    storageScope,
  ])

  return {
    onHistoryRefreshed,
    user,
    devices,
    cloudWorkStatus,
    currentRuntimeTask,
    imNotificationSettings,
    preferredDeviceId,
    activeItem,
    onNewChat,
    onStartStandaloneChat,
    onOpenSearch,
    onStartNewProjectChat,
    onOpenRuntimeTask,
    onMarkRuntimeTaskRead,
    onRenameRuntimeTask,
    onArchiveRuntimeTask,
    onArchiveProjectConversations,
    onArchiveProjectsConversations,
    onArchiveChatConversations,
    onToggleRuntimeTaskNotification,
    onToggleGlobalImNotification,
    onOpenGlobalImNotificationSettings,
    onOpenPlugins,
    onOpenSites,
    onRefreshDevices,
    onOpenStandaloneFolderProject,
    onOpenStandaloneWorkspace,
    onCreatePermanentWorktree,
    onSelectStandaloneDevice,
    onGetRemoteDeviceStartupCommand,
    onUpdateProjectName,
    onUpdateLocalRuntimeProject,
    onRemoveProject,
    onReorderRuntimeProjects,
    onSetRuntimeProjectPinned,
    onSetRuntimeProjectAppearance,
    onReorderRuntimeProjectTasks,
    onSetRuntimeTaskPinned,
    onGetDeviceHomeDirectory,
    onListDeviceDirectories,
    onCreateDeviceDirectory,
    onOpenSettings,
    onLogout,
    collapsed,
    containerTestId,
    hideResizeHandle,
    onPointerEnter,
    onPointerLeave,
    onToggleSidebar,
    onOpenWorkbench,
    onOpenTodo,
    onOpenApps,
    background,
    t,
    sidebarWidth,
    resizing,
    handleResizeStart,
    showCloudConnectionEntry,
    cloud,
    usesCloudAccount,
    requiresCloudLogin,
    usesOverlayTitlebar,
    hasAvailableAppUpdate,
    experimentalFeaturesEnabled,
    gatewayAccountTargets,
    handleGatewayAccountLogout,
    sidebarAccount,
    windowFocused,
    settingsMenuOpen,
    setSettingsMenuOpen,
    accountCloudDialogOpen,
    setAccountCloudDialogOpen,
    imNotificationMenuOpen,
    setImNotificationMenuOpen,
    archiveSectionMode,
    setArchiveSectionMode,
    forceArchiveSectionMode,
    isArchivingProjectSection,
    isArchivingChatSection,
    settingsMenuRef,
    projectCreateDialogOpen,
    setProjectCreateDialogOpen,
    standaloneWorkspaceDialogMode,
    setStandaloneWorkspaceDialogMode,
    standaloneRemoteDialogIntent,
    setStandaloneRemoteDialogIntent,
    renamingProject,
    setRenamingProject,
    editingLocalProject,
    setEditingLocalProject,
    openProjectEditor,
    setProjectsExpanded,
    setChatsExpanded,
    sidebarScrolled,
    setSidebarScrolled,
    visibleUnreadRuntimeTaskKeys,
    sidebarStateDeviceId,
    sidebarProjects,
    pinnedProjects,
    regularSortableProjects,
    chatWorkspaces,
    regularChatTaskItems,
    pinnedTaskItems,
    setChatTaskPinned,
    projectSectionArchiveCount,
    chatSectionArchiveCount,
    displayedProjectsExpanded,
    displayedChatsExpanded,
    isArchiveSectionSubmitting,
    archiveSectionDialogTestId,
    archiveSectionDialogCount,
    closeArchiveSectionDialog,
    forceArchiveSectionDialogTestId,
    confirmArchiveSectionConversations,
    closeForceArchiveSectionDialog,
    confirmForceArchiveSectionConversations,
    displayedExpandedProjectIds,
    handleToggleProject,
    openProjectCreateDialog,
  }
}
export type SidebarModel = ReturnType<typeof useSidebarModel>
