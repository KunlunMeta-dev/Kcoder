import { ActionMenu } from '@/components/common/ActionMenu'
import { TextInputDialog } from '@/components/common/TextInputDialog'
import { useExperimentalFeaturesEnabled } from '@/features/experimental-features/useExperimentalFeaturesEnabled'
import { useRuntimeTaskLifecycle } from '@/features/workbench/runtimeTaskLifecycle'
import type {
  ArchiveRuntimeTaskOptions,
  ArchiveRuntimeTaskResult,
} from '@/features/workbench/workbenchContextTypes'
import { useTranslation } from '@/hooks/useTranslation'
import { isFailedRuntimeDraft } from '@/lib/failed-runtime-draft'
import { cn } from '@/lib/utils'
import type {
  RuntimeDeviceWorkspace,
  RuntimeIMNotificationSettingsResponse,
  RuntimeTaskAddress,
  RuntimeTaskPinRequest,
  RuntimeTaskSummary,
} from '@/types/api'
import { Archive, Bell, BellOff, Edit3, GitCompareArrows, Pin, RotateCw, X } from 'lucide-react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { RuntimeTaskActivityBadge } from '../RuntimeTaskActivityBadge'
import { SidebarHoverCard } from '../SidebarHoverCard'
import { TaskSidebarHoverCardContent } from '../TaskSidebarHoverCardContent'
import { formatRelativeSidebarTime } from '../runtimeSidebarTime'
import {
  getRuntimeTaskAddress,
  getRuntimeTaskTime,
  getRuntimeTaskWorkspaceTitle,
  isRuntimeWorktreeTask,
} from '../runtimeTaskSidebarHelpers'
import { ArchiveConversationsConfirmDialog } from './ArchiveConversationsConfirmDialog'
import {
  handleSidebarRowKeyDown,
  RUNTIME_ARCHIVE_UNDO_DELAY_MS,
  SIDEBAR_ROW_METADATA_CLASS,
} from './sidebarSelectors'

import {
  getRuntimeTaskBranch,
  getRuntimeTaskRepositoryLabel,
  getRuntimeTaskThreadId,
  getRuntimeWorkspaceDeviceColor,
  hasRuntimeTaskBranchWarning,
  isRuntimeTaskNotificationSubscribed,
  shortenSidebarHomePath,
} from './sidebarSelectors'
import { type ProjectCreateMenuPosition } from './types'

export function RuntimeTaskRow({
  workspace,
  task,
  projectName,
  selected,
  unread,
  marked: controlledMarked,
  indentClassName = 'pl-12',
  imNotificationSettings,
  showDeviceMarker,
  stateDeviceId,
  onOpenRuntimeTask,
  onMarkRuntimeTaskRead,
  onSetRuntimeTaskPinned,
  onRenameRuntimeTask,
  onArchiveRuntimeTask,
  onToggleRuntimeTaskNotification,
}: {
  workspace: RuntimeDeviceWorkspace
  task: RuntimeTaskSummary
  projectName?: string | null
  selected: boolean
  unread?: boolean
  marked?: boolean
  indentClassName?: string
  imNotificationSettings?: RuntimeIMNotificationSettingsResponse | null
  showDeviceMarker: boolean
  stateDeviceId?: string | null
  onOpenRuntimeTask?: (address: RuntimeTaskAddress) => Promise<void> | void
  onMarkRuntimeTaskRead?: (address: RuntimeTaskAddress) => void
  onSetRuntimeTaskPinned?: (data: RuntimeTaskPinRequest) => Promise<void>
  onRenameRuntimeTask?: (address: RuntimeTaskAddress, title: string) => Promise<void> | void
  onArchiveRuntimeTask?: (
    address: RuntimeTaskAddress,
    options?: ArchiveRuntimeTaskOptions
  ) => Promise<ArchiveRuntimeTaskResult | void> | ArchiveRuntimeTaskResult | void
  onToggleRuntimeTaskNotification?: (
    address: RuntimeTaskAddress,
    subscribed: boolean
  ) => Promise<void> | void
}) {
  const { t } = useTranslation('common')
  const experimentalFeaturesEnabled = useExperimentalFeaturesEnabled()
  const [optimisticMarked, setOptimisticMarked] = useState<{
    base: boolean
    value: boolean
  } | null>(null)
  const [pinPending, setPinPending] = useState(false)
  const [pinError, setPinError] = useState<string | null>(null)
  const [archiving, setArchiving] = useState(false)
  const [archivePending, setArchivePending] = useState(false)
  const [archiveNoticeOpen, setArchiveNoticeOpen] = useState(false)
  const [archiveError, setArchiveError] = useState<string | null>(null)
  const [forceArchiveConfirmOpen, setForceArchiveConfirmOpen] = useState(false)
  const [renameOpen, setRenameOpen] = useState(false)
  const [taskMenuPosition, setTaskMenuPosition] = useState<ProjectCreateMenuPosition | null>(null)
  const archiveDelayRef = useRef<number | null>(null)
  const worktreeTask = isRuntimeWorktreeTask(task)
  const failedDraft = isFailedRuntimeDraft(task)
  const workspaceTitle = getRuntimeTaskWorkspaceTitle(workspace)
  const projectLabel = projectName?.trim() || t('workbench.task')
  const repositoryLabel = getRuntimeTaskRepositoryLabel(workspace, task)
  const branchLabel = getRuntimeTaskBranch(task)
  const taskWorkspacePath = task.workspacePath || workspace.workspacePath
  const hostLabel =
    workspace.remoteHostId ||
    (workspace.workspaceSource === 'remote' ? workspace.deviceName || workspace.deviceId : null)
  const deviceColor = getRuntimeWorkspaceDeviceColor(workspace)
  const disabled = !workspace.available || !onOpenRuntimeTask
  const archiveDisabled =
    (!workspace.available && !failedDraft) || !onArchiveRuntimeTask || archiving || archivePending
  const taskAddress = getRuntimeTaskAddress(workspace, task)
  const pendingArchiveRequestRef = useRef({ onArchiveRuntimeTask, taskAddress })
  useEffect(() => {
    pendingArchiveRequestRef.current = { onArchiveRuntimeTask, taskAddress }
  }, [onArchiveRuntimeTask, taskAddress])
  const taskLifecycle = useRuntimeTaskLifecycle(taskAddress)
  const threadId = getRuntimeTaskThreadId(task)
  const notificationsSubscribed = isRuntimeTaskNotificationSubscribed(
    imNotificationSettings,
    taskAddress
  )
  const persistedMarked = controlledMarked ?? task.pinned ?? false
  const marked =
    optimisticMarked?.base === persistedMarked ? optimisticMarked.value : persistedMarked
  const notificationsDisabled = !workspace.available || !onToggleRuntimeTaskNotification
  const handleOpen = () => {
    if (disabled) return
    onMarkRuntimeTaskRead?.(taskAddress)
    void onOpenRuntimeTask?.(taskAddress)
  }
  const toggleTaskPinned = async () => {
    if (pinPending || !workspace.available || !threadId || !onSetRuntimeTaskPinned) return
    const nextMarked = !marked
    setPinPending(true)
    setPinError(null)
    setOptimisticMarked({ base: persistedMarked, value: nextMarked })
    try {
      await onSetRuntimeTaskPinned({
        deviceId: stateDeviceId || workspace.deviceId,
        threadId,
        pinned: nextMarked,
      })
    } catch (error) {
      setOptimisticMarked(null)
      setPinError(error instanceof Error ? error.message : t('workbench.pin_update_failed'))
    } finally {
      setPinPending(false)
    }
  }
  const handleToggleMark = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    event.currentTarget.blur()
    void toggleTaskPinned()
  }
  useEffect(() => {
    return () => {
      if (archiveDelayRef.current !== null) {
        window.clearTimeout(archiveDelayRef.current)
        archiveDelayRef.current = null
        // If the user did not revoke it, leaving the page must submit the confirmed archive immediately rather than cancel silently on unmount.
        const pending = pendingArchiveRequestRef.current
        void Promise.resolve(pending.onArchiveRuntimeTask?.(pending.taskAddress)).catch(() => {
          // The page has already left; a failed archive naturally restores the task on the next task-list load.
        })
      }
    }
  }, [])
  const runArchive = async (options?: ArchiveRuntimeTaskOptions) => {
    setArchiving(true)
    try {
      const result = await Promise.resolve(
        options ? onArchiveRuntimeTask?.(taskAddress, options) : onArchiveRuntimeTask?.(taskAddress)
      )
      if (result?.status === 'dirty_worktree') {
        setForceArchiveConfirmOpen(true)
      } else if (result?.status === 'failed') {
        setArchiveError(result.error || t('workbench.archive_runtime_task_failed'))
      }
    } catch (error) {
      setArchiveError(
        error instanceof Error ? error.message : t('workbench.archive_runtime_task_failed')
      )
    } finally {
      setArchiving(false)
    }
  }
  const scheduleArchive = () => {
    if (archiveDisabled) return
    setArchiveError(null)
    if (failedDraft) {
      void runArchive()
      return
    }
    setArchivePending(true)
    setArchiveNoticeOpen(true)
    archiveDelayRef.current = window.setTimeout(() => {
      archiveDelayRef.current = null
      setArchivePending(false)
      setArchiveNoticeOpen(false)
      void runArchive()
    }, RUNTIME_ARCHIVE_UNDO_DELAY_MS)
  }
  const handleArchive = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    event.currentTarget.blur()
    scheduleArchive()
  }
  const handleUndoArchive = () => {
    if (archiveDelayRef.current !== null) {
      window.clearTimeout(archiveDelayRef.current)
      archiveDelayRef.current = null
    }
    setArchivePending(false)
    setArchiveNoticeOpen(false)
  }
  const handleDismissArchiveNotice = () => {
    setArchiveNoticeOpen(false)
  }
  const handleCloseForceArchiveConfirm = () => {
    if (!archiving) {
      setForceArchiveConfirmOpen(false)
    }
  }
  const handleConfirmForceArchive = async () => {
    await runArchive({ force: true })
    setForceArchiveConfirmOpen(false)
  }
  const handleToggleNotification = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    event.currentTarget.blur()
    if (notificationsDisabled) return
    void onToggleRuntimeTaskNotification?.(taskAddress, notificationsSubscribed)
  }
  const notificationActionLabel = notificationsSubscribed
    ? t('workbench.unsubscribe_runtime_task_notifications', '取消任务通知')
    : t('workbench.subscribe_runtime_task_notifications', '订阅任务通知')
  const NotificationIcon = notificationsSubscribed ? Bell : BellOff
  const renderNotificationButton = (testId: string, iconTestId: string) => (
    <button
      type="button"
      data-testid={testId}
      disabled={notificationsDisabled}
      aria-pressed={notificationsSubscribed}
      onClick={handleToggleNotification}
      className={cn(
        'flex h-5 w-5 items-center justify-center text-[rgb(var(--color-sidebar-text-muted))] hover:text-[rgb(var(--color-sidebar-text-primary))] disabled:cursor-not-allowed disabled:opacity-45',
        notificationsSubscribed && 'text-primary'
      )}
      title={notificationActionLabel}
      aria-label={notificationActionLabel}
    >
      <NotificationIcon
        data-testid={iconTestId}
        className={cn('h-[15px] w-[15px]', notificationsSubscribed && 'fill-current')}
      />
    </button>
  )

  return (
    <>
      <SidebarHoverCard
        testId={`runtime-local-task-hover-card-${task.taskId}`}
        interactive
        content={
          <TaskSidebarHoverCardContent
            taskId={task.taskId}
            title={task.title}
            projectLabel={projectLabel}
            repositoryLabel={repositoryLabel}
            branchLabel={branchLabel}
            workspacePath={taskWorkspacePath ? shortenSidebarHomePath(taskWorkspacePath) : null}
            hostLabel={hostLabel}
            updatedLabel={task.updatedAt ? formatRelativeSidebarTime(task.updatedAt) : null}
            branchWarning={hasRuntimeTaskBranchWarning(task)}
          />
        }
      >
        <div
          data-testid={`runtime-local-task-row-${task.taskId}`}
          data-marked={marked ? 'true' : undefined}
          role="button"
          tabIndex={disabled ? -1 : 0}
          aria-disabled={disabled}
          onClick={handleOpen}
          onContextMenu={event => {
            event.preventDefault()
            event.stopPropagation()
            setTaskMenuPosition({ left: event.clientX, top: event.clientY })
          }}
          onDoubleClick={event => {
            event.stopPropagation()
            if (!disabled && onRenameRuntimeTask) {
              setRenameOpen(true)
            }
          }}
          onKeyDown={event => handleSidebarRowKeyDown(event, handleOpen)}
          className={cn(
            'group/task relative flex h-[30px] min-w-0 items-center rounded-[10px] pr-2 text-base leading-5',
            indentClassName,
            disabled ? 'cursor-not-allowed opacity-55' : 'cursor-default',
            selected
              ? 'bg-[rgb(var(--color-sidebar-active))] text-text-primary'
              : 'text-[rgb(var(--color-sidebar-text-primary))] hover:bg-[rgb(var(--color-sidebar-hover))]',
            (archivePending || archiving) && 'hidden'
          )}
        >
          <span className="min-w-0 flex-1 truncate">{task.title}</span>
          <span
            data-testid={`runtime-local-task-trailing-${task.taskId}`}
            className={cn(
              'relative ml-1 flex h-[30px] min-w-[30px] shrink-0 items-center justify-end'
            )}
          >
            <span
              data-testid={`runtime-local-task-time-${task.taskId}`}
              className={SIDEBAR_ROW_METADATA_CLASS}
            >
              {worktreeTask && (
                <GitCompareArrows
                  data-testid={`runtime-local-task-worktree-icon-${task.taskId}`}
                  className="h-3.5 w-3.5 shrink-0 text-[rgb(var(--color-sidebar-text-muted))]"
                  aria-label="Worktree"
                />
              )}
              {experimentalFeaturesEnabled &&
                notificationsSubscribed &&
                renderNotificationButton(
                  `runtime-local-task-notify-${task.taskId}`,
                  `runtime-local-task-notify-icon-${task.taskId}`
                )}
              <span className="flex h-[30px] min-w-[30px] items-center justify-center">
                {taskLifecycle?.derived.shouldShowSidebarRunning ||
                [
                  'waiting_approval',
                  'waiting_answer',
                  'background',
                  'aggregating',
                  'unknown',
                ].includes(task.runActivity ?? '') ? (
                  <span
                    data-testid={`runtime-local-task-running-${task.taskId}`}
                    role="status"
                    title={t(
                      `workbench.runtime_activity.${task.runActivity && ['waiting_approval', 'waiting_answer', 'background', 'aggregating', 'unknown'].includes(task.runActivity) ? task.runActivity : 'running'}`
                    )}
                    aria-label={t(
                      `workbench.runtime_activity.${task.runActivity && ['waiting_approval', 'waiting_answer', 'background', 'aggregating', 'unknown'].includes(task.runActivity) ? task.runActivity : 'running'}`
                    )}
                    className="flex h-[30px] min-w-[30px] items-center justify-center group-hover/task:visible group-focus-within/task:visible"
                  >
                    <RuntimeTaskActivityBadge
                      taskId={task.taskId}
                      activity={task.runActivity}
                      summary={task.runSummary}
                      running={taskLifecycle?.derived.shouldShowSidebarRunning === true}
                    />
                  </span>
                ) : task.runSummary?.recentError ? (
                  <RuntimeTaskActivityBadge
                    taskId={task.taskId}
                    activity="idle"
                    summary={task.runSummary}
                    running={false}
                  />
                ) : unread ? (
                  <span
                    data-testid={`runtime-local-task-unread-dot-${task.taskId}`}
                    aria-label={t('workbench.runtime_task_unread', '未读')}
                    title={t('workbench.runtime_task_unread', '未读')}
                    className="h-1.5 w-1.5 rounded-full bg-primary"
                  />
                ) : (
                  formatRelativeSidebarTime(getRuntimeTaskTime(task))
                )}
              </span>
              {showDeviceMarker && (
                <span
                  data-testid={`runtime-local-task-device-marker-${task.taskId}`}
                  title={workspaceTitle}
                  aria-label={workspaceTitle}
                  className="h-3.5 w-0.5 shrink-0 rounded-full"
                  style={{ backgroundColor: deviceColor }}
                />
              )}
            </span>
            <span
              data-testid={`runtime-local-task-hover-actions-${task.taskId}`}
              className="pointer-events-none relative z-[70] flex w-0 shrink-0 items-center justify-end gap-1 overflow-hidden opacity-0 group-hover/task:w-[72px] group-hover/task:pointer-events-auto group-hover/task:opacity-100 group-focus-within/task:w-[72px] group-focus-within/task:pointer-events-auto group-focus-within/task:opacity-100 hover:pointer-events-auto focus-within:pointer-events-auto"
            >
              {experimentalFeaturesEnabled &&
                renderNotificationButton(
                  notificationsSubscribed
                    ? `runtime-local-task-notify-hover-${task.taskId}`
                    : `runtime-local-task-notify-${task.taskId}`,
                  notificationsSubscribed
                    ? `runtime-local-task-notify-hover-icon-${task.taskId}`
                    : `runtime-local-task-notify-icon-${task.taskId}`
                )}
              <button
                type="button"
                data-testid={`runtime-local-task-mark-${task.taskId}`}
                onClick={handleToggleMark}
                disabled={
                  pinPending || !workspace.available || !threadId || !onSetRuntimeTaskPinned
                }
                className={cn(
                  'flex h-5 w-5 items-center justify-center text-[rgb(var(--color-sidebar-text-muted))] hover:text-[rgb(var(--color-sidebar-text-primary))]',
                  marked && 'text-[rgb(var(--color-sidebar-marked-accent))]'
                )}
                title={
                  marked ? t('workbench.unmark_runtime_task') : t('workbench.mark_runtime_task')
                }
                aria-label={
                  marked ? t('workbench.unmark_runtime_task') : t('workbench.mark_runtime_task')
                }
              >
                <Pin
                  data-testid={`runtime-local-task-pin-icon-${task.taskId}`}
                  className={cn('h-[15px] w-[15px]', marked && 'fill-current')}
                />
              </button>
              <button
                type="button"
                data-testid={`runtime-local-task-archive-${task.taskId}`}
                disabled={archiveDisabled}
                onClick={handleArchive}
                className="flex h-5 w-5 items-center justify-center text-[rgb(var(--color-sidebar-text-muted))] hover:text-[rgb(var(--color-sidebar-text-primary))] disabled:cursor-not-allowed disabled:opacity-45"
                title={
                  failedDraft
                    ? t('workbench.failed_task_hint')
                    : t('workbench.archive_runtime_task', '归档')
                }
                aria-label={
                  failedDraft
                    ? t('workbench.failed_task_remove')
                    : t('workbench.archive_runtime_task', '归档')
                }
              >
                {archiving ? (
                  <RotateCw className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Archive
                    data-testid={`runtime-local-task-archive-icon-${task.taskId}`}
                    className="h-[15px] w-[15px]"
                  />
                )}
              </button>
            </span>
          </span>
        </div>
      </SidebarHoverCard>
      {pinError && (
        <p
          role="alert"
          data-testid={`runtime-local-task-pin-error-${task.taskId}`}
          className={cn('break-words py-1 pr-2 text-sm text-red-500', indentClassName)}
        >
          {pinError}
        </p>
      )}
      {task.error && (
        <p
          role="alert"
          data-testid={`runtime-task-creation-error-${task.taskId}`}
          className={cn('break-words py-1 pr-2 text-sm text-red-500', indentClassName)}
        >
          {task.error}
        </p>
      )}
      {archiveError && (
        <p
          role="alert"
          data-testid={`runtime-local-task-archive-error-${task.taskId}`}
          className={cn('break-words py-1 pr-2 text-sm text-red-500', indentClassName)}
        >
          {archiveError}
        </p>
      )}
      <ActionMenu
        ariaLabel={t('workbench.task_actions')}
        testId={`runtime-local-task-menu-${task.taskId}`}
        contextMenuPosition={taskMenuPosition}
        onContextMenuClose={() => setTaskMenuPosition(null)}
        triggerClassName="hidden"
        items={[
          {
            label: marked ? t('workbench.unmark_runtime_task') : t('workbench.mark_runtime_task'),
            icon: Pin,
            testId: `runtime-local-task-menu-pin-${task.taskId}`,
            disabled: pinPending || !workspace.available || !threadId || !onSetRuntimeTaskPinned,
            onSelect: toggleTaskPinned,
          },
          {
            label: t('workbench.rename_chat', '重命名任务'),
            icon: Edit3,
            testId: `runtime-local-task-menu-rename-${task.taskId}`,
            disabled: !workspace.available || !onRenameRuntimeTask,
            onSelect: () => setRenameOpen(true),
          },
          ...(experimentalFeaturesEnabled
            ? [
                {
                  label: notificationActionLabel,
                  icon: NotificationIcon,
                  testId: `runtime-local-task-menu-notify-${task.taskId}`,
                  disabled: notificationsDisabled,
                  onSelect: () =>
                    onToggleRuntimeTaskNotification?.(taskAddress, notificationsSubscribed),
                },
              ]
            : []),
          {
            label: failedDraft
              ? t('workbench.failed_task_remove')
              : t('workbench.archive_runtime_task', '归档'),
            icon: Archive,
            testId: `runtime-local-task-menu-archive-${task.taskId}`,
            disabled: archiveDisabled,
            onSelect: scheduleArchive,
          },
        ]}
      />
      <TextInputDialog
        open={renameOpen}
        title={t('workbench.rename_chat', '重命名会话')}
        label={t('workbench.chat_name', '会话名称')}
        description={t('workbench.rename_chat_description', '保持简短且易于识别')}
        initialValue={task.title}
        confirmLabel={t('workbench.save', '保存')}
        cancelLabel={t('workbench.cancel', '取消')}
        inputTestId={`rename-runtime-local-task-input-${task.taskId}`}
        confirmTestId={`confirm-rename-runtime-local-task-${task.taskId}`}
        onClose={() => setRenameOpen(false)}
        onSubmit={title => {
          if (workspace.available) onRenameRuntimeTask?.(taskAddress, title)
        }}
      />
      {archiveNoticeOpen &&
        createPortal(
          <div
            data-testid={`runtime-local-task-archive-toast-${task.taskId}`}
            role="status"
            aria-live="polite"
            className="fixed left-1/2 top-5 z-[200] flex max-w-[calc(100vw-32px)] -translate-x-1/2 items-center gap-1 rounded-2xl border border-border bg-surface px-4 py-2 text-sm text-text-primary shadow-lg"
          >
            <button
              type="button"
              data-testid={`runtime-local-task-archive-undo-${task.taskId}`}
              onClick={handleUndoArchive}
              className="font-medium text-primary hover:underline"
            >
              {t('workbench.archive_runtime_task_undo', '撤销')}
            </button>
            <span>{t('workbench.archive_runtime_task_pending', '，稍后将归档')}</span>
            <button
              type="button"
              data-testid={`runtime-local-task-archive-toast-close-${task.taskId}`}
              onClick={handleDismissArchiveNotice}
              className="ml-2 flex h-5 w-5 items-center justify-center rounded-full text-text-muted hover:bg-muted hover:text-text-primary"
              title={t('workbench.archive_runtime_task_notice_close', '关闭归档提示')}
              aria-label={t('workbench.archive_runtime_task_notice_close', '关闭归档提示')}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>,
          document.body
        )}
      <ArchiveConversationsConfirmDialog
        open={forceArchiveConfirmOpen}
        title={t('workbench.archive_runtime_task_dirty_worktree_title')}
        description={t('workbench.archive_runtime_task_dirty_worktree_force_desc')}
        confirmLabel={t('workbench.archive_runtime_task_force_confirm')}
        cancelLabel={t('workbench.cancel')}
        submitting={archiving}
        testId={`runtime-local-task-force-archive-dialog-${task.taskId}`}
        onClose={handleCloseForceArchiveConfirm}
        onConfirm={handleConfirmForceArchive}
      />
    </>
  )
}
