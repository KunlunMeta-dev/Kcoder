import { ActionMenu } from '@/components/common/ActionMenu'
import { TextInputDialog } from '@/components/common/TextInputDialog'
import { ProjectFolderIcon } from '@/components/projects/ProjectFolderIcon'
import { ProjectHistoryRefreshDialog } from '@/components/projects/ProjectHistoryRefreshDialog'
import {
  debugRuntimeSidebarState,
  warnRuntimeSidebarMismatch,
} from '@/features/workbench/runtimeSidebarDiagnostics'
import {
  getRuntimeTaskLifecycleKey,
  useRuntimeTaskLifecycleStoreSnapshot,
} from '@/features/workbench/runtimeTaskLifecycle'
import { getRuntimeTaskReminderItemKey } from '@/features/workbench/runtimeTaskReminders'
import type {
  ArchiveRuntimeConversationsResult,
  ArchiveRuntimeTaskOptions,
  ArchiveRuntimeTaskResult,
} from '@/features/workbench/workbenchContextTypes'
import { useTranslation } from '@/hooks/useTranslation'
import { openLocalWorkspace } from '@/lib/local-terminal'
import { getRuntimeProjectSidebarStateKey } from '@/lib/runtime-project-state'
import { cn } from '@/lib/utils'
import type {
  DeviceInfo,
  ProjectWithTasks,
  RuntimeIMNotificationSettingsResponse,
  RuntimeProjectAppearanceRequest,
  RuntimeProjectPinRequest,
  RuntimeProjectReorderRequest,
  RuntimeProjectTaskReorderRequest,
  RuntimeProjectWork,
  RuntimeTaskAddress,
  RuntimeTaskPinRequest,
} from '@/types/api'
import {
  Archive,
  ChevronDown,
  ChevronRight,
  Edit3,
  FolderOpen,
  GitCompareArrows,
  MessageSquarePlus,
  Pin,
  RotateCw,
  Sparkles,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { ProjectSidebarHoverCardContent } from '../ProjectSidebarHoverCardContent'
import { RuntimeThreadListStatus } from '../RuntimeThreadListStatus'
import { SidebarHoverCard } from '../SidebarHoverCard'
import { SidebarSortableList } from '../SidebarSortableList'
import {
  RUNTIME_PROJECT_TASK_PREVIEW_LIMIT,
  getNextRuntimeSidebarTaskVisibleLimit,
  getRuntimeSidebarTaskItems,
  getRuntimeTaskAddress,
  getVisibleRuntimeSidebarTaskItems,
  hasExpandedRuntimeSidebarTaskItems,
  hasHiddenRuntimeSidebarTaskItems,
  isRuntimeTaskSelected,
} from '../runtimeTaskSidebarHelpers'
import { ArchiveConversationsConfirmDialog } from './ArchiveConversationsConfirmDialog'
import { ProjectDeviceInlineStatus } from './DeviceSection'
import {
  canEditLocalRuntimeProject,
  formatSidebarTemplate,
  getDeviceUnavailableActionTitle,
} from './sidebarSelectors'

import { RuntimeTaskRow } from './TaskRow'
import {
  PROJECT_APPEARANCE_COLORS,
  PROJECT_APPEARANCE_COLOR_VALUES,
  getProjectDeviceId,
  getProjectFinderWorkspacePath,
  getProjectHoverSources,
  getRuntimeProjectDeviceState,
  getRuntimeTaskThreadId,
  getSidebarDeviceState,
  isRuntimeRemoteProject,
  isRuntimeTaskWaiting,
  isSidebarDeviceOnline,
  shortenSidebarHomePath,
  shouldShowProjectDeviceStatus,
} from './sidebarSelectors'
import { type ProjectCreateMenuPosition } from './types'

export function ProjectItem({
  onHistoryRefreshed,
  project,
  expanded,
  onToggleProject,
  devices,
  runtimeProjectWork,
  currentRuntimeTask,
  unreadTaskKeys,
  imNotificationSettings,
  showDeviceMarker,
  sidebarStateDeviceId,
  onStartNewProjectChat,
  onRemoveProject,
  onCreatePermanentWorktree,
  onSetRuntimeProjectPinned,
  onSetRuntimeProjectAppearance,
  onReorderRuntimeProjectTasks,
  onSetRuntimeTaskPinned,
  onRenameProject,
  onOpenRuntimeTask,
  onMarkRuntimeTaskRead,
  onRenameRuntimeTask,
  onArchiveRuntimeTask,
  onArchiveProjectConversations,
  onToggleRuntimeTaskNotification,
}: {
  onHistoryRefreshed?: () => Promise<void>
  project: ProjectWithTasks
  expanded: boolean
  onToggleProject: (projectId: number) => void
  devices: DeviceInfo[]
  runtimeProjectWork?: RuntimeProjectWork
  currentRuntimeTask?: RuntimeTaskAddress | null
  unreadTaskKeys: ReadonlySet<string>
  imNotificationSettings?: RuntimeIMNotificationSettingsResponse | null
  showDeviceMarker: boolean
  sidebarStateDeviceId?: string | null
  onStartNewProjectChat: (projectId: number) => void
  onRemoveProject: (projectId: number) => Promise<void>
  onCreatePermanentWorktree?: (data: {
    deviceId: string
    sourcePath: string
    name: string
  }) => Promise<void>
  onReorderRuntimeProjects?: (data: RuntimeProjectReorderRequest) => Promise<void>
  onSetRuntimeProjectPinned?: (data: RuntimeProjectPinRequest) => Promise<void>
  onSetRuntimeProjectAppearance?: (data: RuntimeProjectAppearanceRequest) => Promise<void>
  onReorderRuntimeProjectTasks?: (data: RuntimeProjectTaskReorderRequest) => Promise<void>
  onSetRuntimeTaskPinned?: (data: RuntimeTaskPinRequest) => Promise<void>
  onRenameProject: (project: ProjectWithTasks, projectWork?: RuntimeProjectWork) => void
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
  onToggleRuntimeTaskNotification?: (
    address: RuntimeTaskAddress,
    subscribed: boolean
  ) => Promise<void> | void
}) {
  const { t } = useTranslation('common')
  const lifecycleSnapshot = useRuntimeTaskLifecycleStoreSnapshot()
  const runtimeWorkspaces = runtimeProjectWork?.deviceWorkspaces
  const allRuntimeTaskItems = useMemo(
    () => getRuntimeSidebarTaskItems(runtimeWorkspaces ?? []),
    [runtimeWorkspaces]
  )
  const runtimeTaskItems = useMemo(
    () => allRuntimeTaskItems.filter(({ task }) => !task.pinned),
    [allRuntimeTaskItems]
  )
  const [runtimeTaskVisibleLimit, setRuntimeTaskVisibleLimit] = useState(
    RUNTIME_PROJECT_TASK_PREVIEW_LIMIT
  )
  const [projectArchiving, setProjectArchiving] = useState(false)
  const [archiveConfirmOpen, setArchiveConfirmOpen] = useState(false)
  const [historyRefreshOpen, setHistoryRefreshOpen] = useState(false)
  const [forceArchiveConfirmOpen, setForceArchiveConfirmOpen] = useState(false)
  const [removeConfirmOpen, setRemoveConfirmOpen] = useState(false)
  const [createPermanentWorktreeOpen, setCreatePermanentWorktreeOpen] = useState(false)
  const [removingProject, setRemovingProject] = useState(false)
  const [optimisticProjectPinned, setOptimisticProjectPinned] = useState<{
    base: boolean
    value: boolean
  } | null>(null)
  const [projectPinPending, setProjectPinPending] = useState(false)
  const [projectPinError, setProjectPinError] = useState<string | null>(null)
  const [projectMenuPosition, setProjectMenuPosition] = useState<ProjectCreateMenuPosition | null>(
    null
  )
  const prioritizedRuntimeTaskItems = runtimeTaskItems
  const visibleRuntimeTaskItems = useMemo(
    () => getVisibleRuntimeSidebarTaskItems(prioritizedRuntimeTaskItems, runtimeTaskVisibleLimit),
    [prioritizedRuntimeTaskItems, runtimeTaskVisibleLimit]
  )
  const hasHiddenRuntimeTasks = hasHiddenRuntimeSidebarTaskItems(
    prioritizedRuntimeTaskItems,
    runtimeTaskVisibleLimit
  )
  const canCollapseRuntimeTasks = hasExpandedRuntimeSidebarTaskItems(
    prioritizedRuntimeTaskItems,
    runtimeTaskVisibleLimit
  )
  useEffect(() => {
    const details = {
      projectId: project.id,
      currentTaskId: currentRuntimeTask?.taskId ?? null,
      visibleLimit: runtimeTaskVisibleLimit,
      allTaskIds: prioritizedRuntimeTaskItems.map(item => item.task.taskId),
      visibleTaskIds: visibleRuntimeTaskItems.map(item => item.task.taskId),
      hiddenTaskIds: prioritizedRuntimeTaskItems
        .slice(visibleRuntimeTaskItems.length)
        .map(item => item.task.taskId),
    }
    debugRuntimeSidebarState('project-visible-items', details)

    const currentTaskId = currentRuntimeTask?.taskId
    if (
      currentTaskId &&
      prioritizedRuntimeTaskItems.some(item => item.task.taskId === currentTaskId) &&
      !visibleRuntimeTaskItems.some(item => item.task.taskId === currentTaskId)
    ) {
      warnRuntimeSidebarMismatch(details)
    }
  }, [
    currentRuntimeTask?.taskId,
    prioritizedRuntimeTaskItems,
    project.id,
    runtimeTaskVisibleLimit,
    visibleRuntimeTaskItems,
  ])
  const projectDeviceState =
    getRuntimeProjectDeviceState(runtimeProjectWork, devices) ??
    getSidebarDeviceState(getProjectDeviceId(project), devices)
  const showProjectDeviceStatus = shouldShowProjectDeviceStatus(
    projectDeviceState,
    devices,
    isRuntimeRemoteProject(runtimeProjectWork)
  )
  const canStartProjectChat = isSidebarDeviceOnline(projectDeviceState)
  const canArchiveProjectConversations =
    Boolean(runtimeProjectWork?.project.key) &&
    allRuntimeTaskItems.length > 0 &&
    Boolean(onArchiveProjectConversations) &&
    !projectArchiving
  const finderWorkspacePath = getProjectFinderWorkspacePath(project, runtimeProjectWork, devices)
  const permanentWorktreeSource = runtimeWorkspaces?.find(
    workspace => workspace.deviceId.trim() && workspace.workspacePath.trim()
  )
  const newProjectChatTitle =
    projectDeviceState && !canStartProjectChat
      ? getDeviceUnavailableActionTitle(t, projectDeviceState)
      : t('workbench.new_project_chat', '新建项目对话')
  const archiveConversationCount = allRuntimeTaskItems.length
  const displayProjectName =
    runtimeProjectWork?.project.nameKey === 'currentComputer'
      ? t('runtimeTarget.currentComputer')
      : project.name
  const archiveProjectName = displayProjectName
  const persistedProjectPinned = runtimeProjectWork?.project.pinned ?? false
  const projectPinned =
    optimisticProjectPinned?.base === persistedProjectPinned
      ? optimisticProjectPinned.value
      : persistedProjectPinned
  const projectStateDeviceId =
    sidebarStateDeviceId ??
    runtimeProjectWork?.project.stateDeviceId ??
    runtimeWorkspaces?.[0]?.deviceId ??
    null
  const projectSidebarStateKey = runtimeProjectWork
    ? getRuntimeProjectSidebarStateKey(runtimeProjectWork.project)
    : null
  const projectAppearance = runtimeProjectWork?.project.appearance
  const projectMarker = projectAppearance?.marker
  const projectAppearanceColor = projectAppearance?.color
    ? PROJECT_APPEARANCE_COLOR_VALUES[projectAppearance.color]
    : undefined
  const projectEditable = canEditLocalRuntimeProject(runtimeProjectWork, sidebarStateDeviceId)
  const projectHoverSources = getProjectHoverSources(
    runtimeProjectWork,
    finderWorkspacePath,
    path => {
      void openLocalWorkspace({ opener: 'finder', path })
    },
    path =>
      formatSidebarTemplate(t('workbench.open_project_source'), {
        source: shortenSidebarHomePath(path),
      })
  )
  const projectActiveTaskCount = allRuntimeTaskItems.filter(({ workspace, task }) =>
    lifecycleSnapshot.runningTaskKeys.has(
      getRuntimeTaskLifecycleKey(getRuntimeTaskAddress(workspace, task))
    )
  ).length
  const projectWaitingTaskCount = allRuntimeTaskItems.filter(({ task }) =>
    isRuntimeTaskWaiting(task)
  ).length
  const projectUnreadTaskCount = allRuntimeTaskItems.filter(({ workspace, task }) =>
    unreadTaskKeys.has(getRuntimeTaskReminderItemKey(workspace, task))
  ).length
  const toggleProjectPinned = async () => {
    const projectKey = projectSidebarStateKey
    if (projectPinPending || !projectKey || !projectStateDeviceId || !onSetRuntimeProjectPinned)
      return
    const nextPinned = !projectPinned
    setProjectPinPending(true)
    setProjectPinError(null)
    setOptimisticProjectPinned({ base: persistedProjectPinned, value: nextPinned })
    try {
      await onSetRuntimeProjectPinned({
        deviceId: projectStateDeviceId,
        projectKey,
        pinned: nextPinned,
      })
    } catch (error) {
      setOptimisticProjectPinned(null)
      setProjectPinError(error instanceof Error ? error.message : t('workbench.pin_update_failed'))
    } finally {
      setProjectPinPending(false)
    }
  }
  const cycleProjectAppearance = async () => {
    const projectKey = projectSidebarStateKey
    if (!projectKey || !projectStateDeviceId || !onSetRuntimeProjectAppearance) return
    const currentIndex = PROJECT_APPEARANCE_COLORS.indexOf(
      projectAppearance?.color as (typeof PROJECT_APPEARANCE_COLORS)[number]
    )
    const color = PROJECT_APPEARANCE_COLORS[(currentIndex + 1) % PROJECT_APPEARANCE_COLORS.length]
    await onSetRuntimeProjectAppearance({
      deviceId: projectStateDeviceId,
      projectKey,
      appearance: { ...projectAppearance, color },
    })
  }
  const closeArchiveConfirm = () => {
    if (!projectArchiving) {
      setArchiveConfirmOpen(false)
    }
  }
  const runArchiveProjectConversations = async (options?: ArchiveRuntimeTaskOptions) => {
    const runtimeProjectKey = runtimeProjectWork?.project.key
    if (!runtimeProjectKey || !onArchiveProjectConversations) return
    setProjectArchiving(true)
    try {
      const result = await onArchiveProjectConversations(runtimeProjectKey, options)
      if (result?.status === 'dirty_worktree') {
        setArchiveConfirmOpen(false)
        setForceArchiveConfirmOpen(true)
        return
      }
      setArchiveConfirmOpen(false)
      setForceArchiveConfirmOpen(false)
    } finally {
      setProjectArchiving(false)
    }
  }
  const confirmArchiveProjectConversations = () => runArchiveProjectConversations()
  const closeForceArchiveConfirm = () => {
    if (!projectArchiving) {
      setForceArchiveConfirmOpen(false)
    }
  }
  const confirmForceArchiveProjectConversations = () =>
    runArchiveProjectConversations({ force: true })
  const closeRemoveConfirm = () => {
    if (!removingProject) {
      setRemoveConfirmOpen(false)
    }
  }
  const confirmRemoveProject = async () => {
    setRemovingProject(true)
    try {
      await onRemoveProject(project.id)
      setRemoveConfirmOpen(false)
    } catch (error) {
      console.error('[KCoder Studio project removal] failed', error)
    } finally {
      setRemovingProject(false)
    }
  }

  return (
    <div data-testid="project-item" className="space-y-0.5">
      <SidebarHoverCard
        testId={`project-hover-card-${project.id}`}
        interactive
        cardClassName="w-[320px]"
        content={
          <ProjectSidebarHoverCardContent
            project={project}
            remote={isRuntimeRemoteProject(runtimeProjectWork)}
            marker={
              projectMarker?.kind === 'emoji' && 'emoji' in projectMarker ? (
                <span className="text-sm">{String(projectMarker.emoji)}</span>
              ) : undefined
            }
            markerColor={projectAppearanceColor}
            taskCount={allRuntimeTaskItems.length}
            activeCount={projectActiveTaskCount}
            waitingCount={projectWaitingTaskCount}
            unreadCount={projectUnreadTaskCount}
            pinned={projectPinned}
            canPin={Boolean(
              !projectPinPending &&
              runtimeProjectWork?.project.key &&
              projectStateDeviceId &&
              onSetRuntimeProjectPinned
            )}
            sources={projectHoverSources}
            onTogglePin={() => void toggleProjectPinned()}
            onRename={() => onRenameProject(project)}
          />
        }
      >
        <div
          data-testid={`project-row-${project.id}`}
          onContextMenu={event => {
            event.preventDefault()
            event.stopPropagation()
            setProjectMenuPosition({ left: event.clientX, top: event.clientY })
          }}
          className="group/project relative flex h-[30px] min-w-0 items-center gap-1 rounded-[10px] pl-2.5 pr-1 text-base leading-5 text-[rgb(var(--color-sidebar-text-primary))] hover:bg-[rgb(var(--color-sidebar-hover))]"
        >
          <button
            type="button"
            data-testid="project-item-button"
            onClick={() => {
              onToggleProject(project.id)
            }}
            aria-expanded={expanded}
            className={cn(
              'flex min-w-0 flex-1 items-center gap-2.5 text-left',
              showProjectDeviceStatus ? 'pr-[132px]' : 'pr-[58px]'
            )}
          >
            <span
              className="flex h-4 w-4 shrink-0 items-center justify-center"
              style={projectAppearanceColor ? { color: projectAppearanceColor } : undefined}
            >
              {projectMarker?.kind === 'emoji' && 'emoji' in projectMarker ? (
                <span data-testid={`project-appearance-emoji-${project.id}`} className="text-sm">
                  {String(projectMarker.emoji)}
                </span>
              ) : (
                <ProjectFolderIcon
                  project={project}
                  remote={isRuntimeRemoteProject(runtimeProjectWork)}
                  className="h-3.5 w-3.5 shrink-0"
                />
              )}
            </span>
            <span className="flex min-w-0 flex-1 items-center gap-1.5">
              <span data-testid={`project-title-${project.id}`} className="min-w-0 truncate">
                {displayProjectName}
              </span>
              <ChevronRight
                data-testid={`project-collapsed-hover-indicator-${project.id}`}
                className={cn(
                  'hidden h-3.5 w-3.5 shrink-0 text-[rgb(var(--color-sidebar-text-primary))] opacity-0 transition-opacity',
                  !expanded &&
                    'group-hover/project:block group-hover/project:opacity-100 group-focus-within/project:block group-focus-within/project:opacity-100'
                )}
              />
              <ChevronDown
                data-testid={`project-expanded-hover-indicator-${project.id}`}
                className={cn(
                  'hidden h-3.5 w-3.5 shrink-0 text-[rgb(var(--color-sidebar-text-primary))] opacity-0 transition-opacity',
                  expanded &&
                    'group-hover/project:block group-hover/project:opacity-100 group-focus-within/project:block group-focus-within/project:opacity-100'
                )}
              />
            </span>
          </button>
          {showProjectDeviceStatus && (
            <ProjectDeviceInlineStatus
              deviceState={projectDeviceState}
              testId={`project-device-status-${project.id}`}
              className="pointer-events-none absolute right-2 top-1/2 max-w-[124px] -translate-y-1/2 justify-end text-right group-hover/project:invisible group-focus-within/project:invisible"
            />
          )}
          <div className="pointer-events-auto absolute right-1 top-1/2 z-[70] flex w-[58px] shrink-0 -translate-y-1/2 items-center justify-end opacity-0 transition-opacity group-hover/project:opacity-100 hover:opacity-100 focus-within:opacity-100">
            <ActionMenu
              ariaLabel={t('workbench.project_actions', '项目操作')}
              testId={`project-menu-${project.id}`}
              contextMenuPosition={projectMenuPosition}
              onContextMenuClose={() => setProjectMenuPosition(null)}
              items={[
                {
                  label: t('history_refresh.action'),
                  icon: RotateCw,
                  testId: `refresh-project-history-${project.id}`,
                  disabled: !runtimeWorkspaces?.some(
                    workspace =>
                      workspace.available &&
                      workspace.deviceStatus !== 'offline' &&
                      workspace.deviceId &&
                      workspace.workspacePath
                  ),
                  onSelect: () => setHistoryRefreshOpen(true),
                },
                {
                  label: projectPinned ? t('workbench.unpin_project') : t('workbench.pin_project'),
                  icon: Pin,
                  testId: `pin-project-${project.id}`,
                  disabled:
                    projectPinPending ||
                    !runtimeProjectWork?.project.key ||
                    !projectStateDeviceId ||
                    !onSetRuntimeProjectPinned,
                  onSelect: toggleProjectPinned,
                },
                {
                  label: projectEditable
                    ? t('workbench.edit_project', '编辑项目')
                    : t('workbench.rename_project', '重命名项目'),
                  icon: Edit3,
                  testId: projectEditable
                    ? `edit-project-${project.id}`
                    : `rename-project-${project.id}`,
                  onSelect: () => onRenameProject(project, runtimeProjectWork),
                },
                {
                  label: t('workbench.change_project_appearance'),
                  icon: Sparkles,
                  testId: `change-project-appearance-${project.id}`,
                  disabled:
                    !runtimeProjectWork?.project.key ||
                    !projectStateDeviceId ||
                    !onSetRuntimeProjectAppearance,
                  onSelect: cycleProjectAppearance,
                },
                ...(finderWorkspacePath
                  ? [
                      {
                        label: t('workbench.show_in_finder', '在 Finder 中显示'),
                        icon: FolderOpen,
                        testId: `show-project-in-finder-${project.id}`,
                        onSelect: () =>
                          openLocalWorkspace({
                            opener: 'finder',
                            path: finderWorkspacePath,
                          }),
                      },
                    ]
                  : []),
                {
                  label: t('workbench.create_permanent_worktree'),
                  icon: GitCompareArrows,
                  testId: `create-permanent-worktree-${project.id}`,
                  disabled: !permanentWorktreeSource || !onCreatePermanentWorktree,
                  onSelect: () => setCreatePermanentWorktreeOpen(true),
                },
                {
                  label: projectArchiving
                    ? t('workbench.archiving_conversations', '归档中...')
                    : t('workbench.archive_project_conversations', '归档对话'),
                  icon: Archive,
                  testId: `archive-project-conversations-${project.id}`,
                  disabled: !canArchiveProjectConversations,
                  onSelect: () => setArchiveConfirmOpen(true),
                },
                {
                  label: t('workbench.remove_project', '移除'),
                  icon: X,
                  testId: `remove-project-${project.id}`,
                  danger: true,
                  onSelect: () => setRemoveConfirmOpen(true),
                },
              ]}
              triggerClassName="flex h-7 w-7 items-center justify-center rounded-lg text-[rgb(var(--color-sidebar-text-secondary))] hover:bg-[rgb(var(--color-sidebar-hover))] hover:text-[rgb(var(--color-sidebar-text-primary))]"
            />
            <button
              type="button"
              data-testid="project-new-conversation-button"
              disabled={!canStartProjectChat}
              onClick={event => {
                event.stopPropagation()
                if (!canStartProjectChat) return
                onStartNewProjectChat(project.id)
              }}
              className="flex h-7 w-7 items-center justify-center rounded-lg text-[rgb(var(--color-sidebar-text-secondary))] hover:bg-[rgb(var(--color-sidebar-hover))] hover:text-[rgb(var(--color-sidebar-text-primary))] disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent disabled:hover:text-[rgb(var(--color-sidebar-text-secondary))]"
              title={newProjectChatTitle}
              aria-label={newProjectChatTitle}
            >
              <MessageSquarePlus className="h-4 w-4" />
            </button>
          </div>
        </div>
      </SidebarHoverCard>
      <RuntimeThreadListStatus workspaces={runtimeProjectWork?.deviceWorkspaces ?? []} />
      {historyRefreshOpen && (
        <ProjectHistoryRefreshDialog
          workspaces={runtimeWorkspaces ?? []}
          onClose={() => setHistoryRefreshOpen(false)}
          onReady={onHistoryRefreshed}
        />
      )}
      {projectPinError && (
        <p
          role="alert"
          data-testid={`project-pin-error-${project.id}`}
          className="break-words px-3 py-1 text-sm text-red-500"
        >
          {projectPinError}
        </p>
      )}
      <TextInputDialog
        open={createPermanentWorktreeOpen}
        title={t('workbench.create_permanent_worktree_title')}
        description={t('workbench.create_permanent_worktree_description')}
        label={t('workbench.project_name')}
        initialValue={`${project.name}_2`}
        confirmLabel={t('workbench.create')}
        cancelLabel={t('workbench.cancel')}
        inputTestId={`permanent-worktree-name-${project.id}`}
        confirmTestId={`confirm-create-permanent-worktree-${project.id}`}
        onClose={() => setCreatePermanentWorktreeOpen(false)}
        onSubmit={async name => {
          if (!permanentWorktreeSource || !onCreatePermanentWorktree) return
          await onCreatePermanentWorktree({
            deviceId: permanentWorktreeSource.deviceId,
            sourcePath: permanentWorktreeSource.workspacePath,
            name,
          })
        }}
      />
      <div
        data-testid={`project-local-tasks-panel-${project.id}`}
        aria-hidden={!expanded}
        className={cn(
          'grid overflow-hidden transition-[grid-template-rows,opacity] duration-[220ms] ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none',
          expanded ? 'grid-rows-[1fr] opacity-100' : 'pointer-events-none grid-rows-[0fr] opacity-0'
        )}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="space-y-0.5">
            {runtimeTaskItems.length === 0 ? (
              <div
                data-testid={`project-local-tasks-empty-${project.id}`}
                className="ml-9 rounded-md px-2 py-1.5 text-xs text-[rgb(var(--color-sidebar-text-muted))]"
              >
                {t('workbench.no_chats', '暂无会话')}
              </div>
            ) : (
              <>
                <SidebarSortableList
                  testId={`project-runtime-task-sortable-${project.id}`}
                  className="space-y-0.5"
                  items={visibleRuntimeTaskItems}
                  getId={({ workspace, task }) =>
                    `${workspace.deviceId}:${getRuntimeTaskThreadId(task) || task.taskId}`
                  }
                  getLabel={({ task }) => task.title}
                  canDrag={({ task }) =>
                    Boolean(
                      getRuntimeTaskThreadId(task) &&
                      runtimeProjectWork?.project.key &&
                      onReorderRuntimeProjectTasks
                    )
                  }
                  onMove={async (moved, before) => {
                    const projectKey = runtimeProjectWork?.project.key
                    const deviceId =
                      runtimeProjectWork?.project.stateDeviceId || moved.workspace.deviceId
                    const movedThreadId = getRuntimeTaskThreadId(moved.task)
                    if (!projectKey || !movedThreadId || !onReorderRuntimeProjectTasks) {
                      throw new Error('Runtime task ordering is unavailable')
                    }
                    const firstHiddenTask = prioritizedRuntimeTaskItems.at(
                      visibleRuntimeTaskItems.length
                    )?.task
                    const beforeThreadId =
                      (before ? getRuntimeTaskThreadId(before.task) : null) ||
                      (firstHiddenTask ? getRuntimeTaskThreadId(firstHiddenTask) : null)
                    await onReorderRuntimeProjectTasks({
                      deviceId,
                      projectKey,
                      threadId: movedThreadId,
                      beforeThreadId,
                      insertAtEnd: beforeThreadId === null,
                    })
                  }}
                  renderItem={({ workspace, task }) => (
                    <RuntimeTaskRow
                      workspace={workspace}
                      task={task}
                      projectName={displayProjectName}
                      selected={isRuntimeTaskSelected(currentRuntimeTask, workspace, task)}
                      unread={unreadTaskKeys.has(getRuntimeTaskReminderItemKey(workspace, task))}
                      marked={task.pinned}
                      indentClassName="pl-9"
                      imNotificationSettings={imNotificationSettings}
                      showDeviceMarker={showDeviceMarker}
                      onOpenRuntimeTask={onOpenRuntimeTask}
                      onMarkRuntimeTaskRead={onMarkRuntimeTaskRead}
                      stateDeviceId={runtimeProjectWork?.project.stateDeviceId}
                      onSetRuntimeTaskPinned={onSetRuntimeTaskPinned}
                      onRenameRuntimeTask={onRenameRuntimeTask}
                      onArchiveRuntimeTask={onArchiveRuntimeTask}
                      onToggleRuntimeTaskNotification={onToggleRuntimeTaskNotification}
                    />
                  )}
                />
                {(hasHiddenRuntimeTasks || canCollapseRuntimeTasks) && (
                  <div className="ml-9 flex h-8 items-center gap-2">
                    {hasHiddenRuntimeTasks ? (
                      <button
                        type="button"
                        data-testid={`project-runtime-tasks-expand-${project.id}`}
                        onClick={() =>
                          setRuntimeTaskVisibleLimit(currentLimit =>
                            getNextRuntimeSidebarTaskVisibleLimit(
                              currentLimit,
                              prioritizedRuntimeTaskItems.length
                            )
                          )
                        }
                        className="flex h-8 items-center rounded-md px-2 text-left text-sm font-semibold leading-[18px] text-[rgb(var(--color-sidebar-text-muted))] hover:bg-[rgb(var(--color-sidebar-hover))] hover:text-[rgb(var(--color-sidebar-text-secondary))]"
                      >
                        {t('workbench.expand_display', '展开显示')}
                      </button>
                    ) : (
                      <button
                        type="button"
                        data-testid={`project-runtime-tasks-collapse-${project.id}`}
                        onClick={() =>
                          setRuntimeTaskVisibleLimit(RUNTIME_PROJECT_TASK_PREVIEW_LIMIT)
                        }
                        className="flex h-8 items-center rounded-md px-2 text-left text-sm font-semibold leading-[18px] text-[rgb(var(--color-sidebar-text-muted))] hover:bg-[rgb(var(--color-sidebar-hover))] hover:text-[rgb(var(--color-sidebar-text-secondary))]"
                      >
                        {t('workbench.collapse_display', '折叠显示')}
                      </button>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
      <ArchiveConversationsConfirmDialog
        open={archiveConfirmOpen}
        title={t('workbench.archive_project_dialog_title', {
          defaultValue: '归档 {{count}} 个对话?',
          count: archiveConversationCount,
        })}
        description={t('workbench.archive_project_dialog_desc', {
          defaultValue: '这会将 {{projectName}} 中的对话归档。之后你可以在已归档对话中找到它们',
          projectName: archiveProjectName,
        })}
        confirmLabel={t('workbench.archive_project_dialog_confirm', '全部归档')}
        cancelLabel={t('workbench.cancel', '取消')}
        submitting={projectArchiving}
        testId={`archive-project-conversations-dialog-${project.id}`}
        onClose={closeArchiveConfirm}
        onConfirm={confirmArchiveProjectConversations}
      />
      <ArchiveConversationsConfirmDialog
        open={removeConfirmOpen}
        title={t('workbench.remove_project_dialog_title', {
          projectName: project.name,
          defaultValue: '移除 {{projectName}}?',
        })}
        description={t('workbench.remove_project_dialog_desc', {
          defaultValue: '这将从 KCoder Studio 中移除该项目。磁盘上的文件不会被删除。',
        })}
        confirmLabel={t('workbench.remove_project_dialog_confirm', '移除')}
        cancelLabel={t('workbench.cancel', '取消')}
        submitting={removingProject}
        testId={`remove-project-dialog-${project.id}`}
        onClose={closeRemoveConfirm}
        onConfirm={confirmRemoveProject}
      />
      <ArchiveConversationsConfirmDialog
        open={forceArchiveConfirmOpen}
        title={t('workbench.archive_runtime_task_dirty_worktree_title')}
        description={t('workbench.archive_runtime_task_dirty_worktree_force_desc')}
        confirmLabel={t('workbench.archive_runtime_task_force_confirm')}
        cancelLabel={t('workbench.cancel', '取消')}
        submitting={projectArchiving}
        testId={`archive-project-force-dialog-${project.id}`}
        onClose={closeForceArchiveConfirm}
        onConfirm={confirmForceArchiveProjectConversations}
      />
    </div>
  )
}
