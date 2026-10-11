import { ActionMenu } from '@/components/common/ActionMenu'
import { CloudConnectionSidebarButton } from '@/features/cloud-connection/CloudConnectionSidebarButton'
import { SHOW_PLUGINS_NAVIGATION } from '@/features/plugins/visibility'
import { getRuntimeTaskReminderItemKey } from '@/features/workbench/runtimeTaskReminders'
import { navigateTo } from '@/lib/navigation'
import {
  getRuntimeProjectReorderRequest,
  getRuntimeProjectSidebarStateKey,
} from '@/lib/runtime-project-state'
import { cn } from '@/lib/utils'
import {
  Archive,
  BookOpen,
  Clock3,
  FolderOpen,
  FolderPlus,
  GitCompareArrows,
  Globe2,
  Grid3X3,
  MessageSquarePlus,
  Sparkles,
  X,
} from 'lucide-react'
import { createPortal } from 'react-dom'
import { RuntimeThreadListStatus } from '../RuntimeThreadListStatus'
import { SidebarSortableList } from '../SidebarSortableList'
import { isRuntimeTaskSelected } from '../runtimeTaskSidebarHelpers'
import { ProjectItem } from './ProjectSection'
import { SidebarButton, SidebarSectionHeader } from './SidebarWidgets'
import { RuntimeTaskRow } from './TaskRow'
import { getRuntimeTaskThreadId } from './sidebarSelectors'
import type { SidebarModel } from './useSidebarModel'

export function SidebarWorklists({ model }: { model: SidebarModel }) {
  const {
    onHistoryRefreshed,
    devices,
    cloudWorkStatus,
    currentRuntimeTask,
    imNotificationSettings,
    activeItem,
    onStartStandaloneChat,
    onStartNewProjectChat,
    onOpenRuntimeTask,
    onMarkRuntimeTaskRead,
    onRenameRuntimeTask,
    onArchiveRuntimeTask,
    onArchiveProjectConversations,
    onArchiveProjectsConversations,
    onArchiveChatConversations,
    onToggleRuntimeTaskNotification,
    onOpenPlugins,
    onOpenSites,
    onOpenStandaloneFolderProject,
    onCreatePermanentWorktree,
    onSelectStandaloneDevice,
    onRemoveProject,
    onReorderRuntimeProjects,
    onSetRuntimeProjectPinned,
    onSetRuntimeProjectAppearance,
    onReorderRuntimeProjectTasks,
    onSetRuntimeTaskPinned,
    onOpenSettings,
    t,
    showCloudConnectionEntry,
    experimentalFeaturesEnabled,
    setArchiveSectionMode,
    isArchivingProjectSection,
    isArchivingChatSection,
    projectCreateDialogOpen,
    setProjectCreateDialogOpen,
    setStandaloneWorkspaceDialogMode,
    setStandaloneRemoteDialogIntent,
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
    displayedExpandedProjectIds,
    handleToggleProject,
    openProjectCreateDialog,
  } = model
  return (
    <>
      <div
        data-testid="sidebar-worklists-scroll"
        data-scrolled={sidebarScrolled}
        onScroll={event => setSidebarScrolled(event.currentTarget.scrollTop > 0)}
        className={cn(
          'scrollbar-none relative mb-2 mt-0.5 min-h-0 flex-1 overflow-y-auto pb-3 [overflow-anchor:none] [mask-image:linear-gradient(to_bottom,black_0,black_calc(100%_-_16px),transparent_100%)]',
          sidebarScrolled &&
            '[mask-image:linear-gradient(to_bottom,transparent_0,black_12px,black_calc(100%_-_16px),transparent_100%)]'
        )}
      >
        <nav className="mb-4 space-y-0.5">
          <SidebarButton
            icon={Clock3}
            label={t('workbench.automations', '自动化')}
            testId="automations-button"
            selected={activeItem === 'automation'}
            onClick={() => navigateTo('/automations')}
          />
          <SidebarButton
            icon={GitCompareArrows}
            label={t('workflowCanvas.heading')}
            testId="workflows-button"
            selected={activeItem === 'workflows'}
            onClick={() => navigateTo('/workflows')}
          />
          <SidebarButton
            icon={BookOpen}
            label={t('knowledge:title')}
            testId="knowledge-button"
            selected={activeItem === 'knowledge'}
            onClick={() => navigateTo('/knowledge')}
          />
          {SHOW_PLUGINS_NAVIGATION && (
            <SidebarButton
              icon={Sparkles}
              label={t('workbench.plugins', '插件')}
              testId="plugins-button"
              selected={activeItem === 'plugins'}
              onClick={onOpenPlugins}
            />
          )}
          {experimentalFeaturesEnabled && (
            <SidebarButton
              icon={Grid3X3}
              label={t('workbench.sites', '站点')}
              testId="sites-button"
              selected={activeItem === 'sites'}
              onClick={onOpenSites ?? (() => navigateTo('/sites'))}
            />
          )}
          {showCloudConnectionEntry && (
            <CloudConnectionSidebarButton
              devices={devices}
              cloudWorkStatus={cloudWorkStatus}
              onOpenSettings={() => onOpenSettings({ settingsPage: 'connections' })}
              onSelectCloudDevice={deviceId => onSelectStandaloneDevice?.(deviceId)}
              onAddDevice={() => {
                if (onOpenStandaloneFolderProject) {
                  onOpenStandaloneFolderProject('remote', 'add-device')
                } else {
                  setStandaloneRemoteDialogIntent('add-device')
                  setStandaloneWorkspaceDialogMode('remote')
                }
              }}
            />
          )}
        </nav>
        {(pinnedTaskItems.length > 0 || pinnedProjects.length > 0) && (
          <section data-testid="sidebar-pinned-section" className="mb-5">
            <div
              data-testid="sidebar-pinned-section-header"
              className="mb-1 flex h-[30px] items-center px-2.5 text-xs font-medium leading-4 text-[rgb(var(--color-sidebar-text-muted))] opacity-75"
            >
              {t('workbench.pinned')}
            </div>
            {pinnedTaskItems.length > 0 && (
              <SidebarSortableList
                testId="pinned-runtime-task-sortable-list"
                className="space-y-0.5"
                items={pinnedTaskItems}
                getId={({ workspace, task }) =>
                  `${workspace.deviceId}:${getRuntimeTaskThreadId(task) || task.taskId}`
                }
                getLabel={({ task }) => task.title}
                canDrag={({ task }) =>
                  Boolean(getRuntimeTaskThreadId(task) && onSetRuntimeTaskPinned)
                }
                onMove={async (moved, before) => {
                  const movedThreadId = getRuntimeTaskThreadId(moved.task)
                  if (!movedThreadId || !onSetRuntimeTaskPinned) {
                    throw new Error('Pinned task ordering is unavailable')
                  }
                  const movedDeviceId =
                    moved.projectWork?.project.stateDeviceId || moved.workspace.deviceId
                  const beforeDeviceId =
                    before?.projectWork?.project.stateDeviceId || before?.workspace.deviceId
                  if (beforeDeviceId && beforeDeviceId !== movedDeviceId) {
                    throw new Error('Pinned tasks from different devices cannot be reordered')
                  }
                  await onSetRuntimeTaskPinned({
                    deviceId: movedDeviceId,
                    threadId: movedThreadId,
                    pinned: true,
                    beforeThreadId: before ? getRuntimeTaskThreadId(before.task) : null,
                  })
                }}
                renderItem={({ workspace, task, projectWork }) => (
                  <RuntimeTaskRow
                    workspace={workspace}
                    task={task}
                    projectName={projectWork?.project.name}
                    selected={isRuntimeTaskSelected(currentRuntimeTask, workspace, task)}
                    unread={visibleUnreadRuntimeTaskKeys.has(
                      getRuntimeTaskReminderItemKey(workspace, task)
                    )}
                    marked
                    indentClassName="pl-2.5"
                    imNotificationSettings={imNotificationSettings}
                    showDeviceMarker={false}
                    stateDeviceId={projectWork?.project.stateDeviceId || workspace.deviceId}
                    onOpenRuntimeTask={onOpenRuntimeTask}
                    onMarkRuntimeTaskRead={onMarkRuntimeTaskRead}
                    onSetRuntimeTaskPinned={
                      projectWork || !onSetRuntimeTaskPinned
                        ? onSetRuntimeTaskPinned
                        : setChatTaskPinned
                    }
                    onRenameRuntimeTask={onRenameRuntimeTask}
                    onArchiveRuntimeTask={onArchiveRuntimeTask}
                    onToggleRuntimeTaskNotification={onToggleRuntimeTaskNotification}
                  />
                )}
              />
            )}
            {pinnedProjects.length > 0 && (
              <SidebarSortableList
                testId="pinned-runtime-project-sortable-list"
                className="mt-1 space-y-1"
                items={pinnedProjects}
                getId={({ runtimeProjectWork }) =>
                  `${sidebarStateDeviceId || runtimeProjectWork?.project.stateDeviceId || 'device'}:${runtimeProjectWork ? getRuntimeProjectSidebarStateKey(runtimeProjectWork.project) : 'project'}`
                }
                getLabel={({ project }) => project.name}
                canDrag={({ runtimeProjectWork }) =>
                  Boolean(runtimeProjectWork?.project.key && onSetRuntimeProjectPinned)
                }
                onMove={async (moved, before) => {
                  const movedProject = moved.runtimeProjectWork?.project
                  const beforeProject = before?.runtimeProjectWork?.project
                  const deviceId =
                    sidebarStateDeviceId ||
                    movedProject?.stateDeviceId ||
                    moved.runtimeProjectWork?.deviceWorkspaces[0]?.deviceId
                  if (!movedProject || !deviceId || !onSetRuntimeProjectPinned) {
                    throw new Error('Pinned project ordering is unavailable')
                  }
                  await onSetRuntimeProjectPinned({
                    deviceId,
                    projectKey: getRuntimeProjectSidebarStateKey(movedProject),
                    pinned: true,
                    beforeProjectKey: beforeProject
                      ? getRuntimeProjectSidebarStateKey(beforeProject)
                      : null,
                  })
                }}
                renderItem={({ project, runtimeProjectWork }) => (
                  <ProjectItem
                    onHistoryRefreshed={onHistoryRefreshed}
                    project={project}
                    expanded={displayedExpandedProjectIds.has(project.id)}
                    devices={devices}
                    runtimeProjectWork={runtimeProjectWork}
                    currentRuntimeTask={currentRuntimeTask}
                    unreadTaskKeys={visibleUnreadRuntimeTaskKeys}
                    imNotificationSettings={imNotificationSettings}
                    showDeviceMarker={false}
                    sidebarStateDeviceId={sidebarStateDeviceId}
                    onToggleProject={handleToggleProject}
                    onStartNewProjectChat={onStartNewProjectChat}
                    onRemoveProject={onRemoveProject}
                    onCreatePermanentWorktree={onCreatePermanentWorktree}
                    onReorderRuntimeProjects={onReorderRuntimeProjects}
                    onSetRuntimeProjectPinned={onSetRuntimeProjectPinned}
                    onSetRuntimeProjectAppearance={onSetRuntimeProjectAppearance}
                    onReorderRuntimeProjectTasks={onReorderRuntimeProjectTasks}
                    onSetRuntimeTaskPinned={onSetRuntimeTaskPinned}
                    onRenameProject={openProjectEditor}
                    onOpenRuntimeTask={onOpenRuntimeTask}
                    onMarkRuntimeTaskRead={onMarkRuntimeTaskRead}
                    onRenameRuntimeTask={onRenameRuntimeTask}
                    onArchiveRuntimeTask={onArchiveRuntimeTask}
                    onArchiveProjectConversations={onArchiveProjectConversations}
                    onToggleRuntimeTaskNotification={onToggleRuntimeTaskNotification}
                  />
                )}
              />
            )}
          </section>
        )}
        <section>
          <div>
            <SidebarSectionHeader
              title={t('workbench.projects', '项目')}
              expanded={displayedProjectsExpanded}
              hasContent={sidebarProjects.length > 0}
              toggleTestId="projects-section-toggle"
              iconTestId="projects-section-chevron-right"
              onToggle={() => setProjectsExpanded(expanded => !expanded)}
            >
              <div className="flex items-center">
                <ActionMenu
                  ariaLabel={t('workbench.project_list_actions', '项目列表操作')}
                  testId="projects-section-menu"
                  items={[
                    {
                      label: t('workbench.archive_all_chats', '归档所有聊天'),
                      icon: Archive,
                      testId: 'projects-section-archive-all-chats',
                      disabled:
                        !onArchiveProjectsConversations ||
                        projectSectionArchiveCount === 0 ||
                        isArchivingProjectSection,
                      onSelect: () => setArchiveSectionMode('projects'),
                    },
                  ]}
                  triggerClassName="flex h-8 w-8 items-center justify-center rounded-md text-[rgb(var(--color-sidebar-text-secondary))] hover:bg-[rgb(var(--color-sidebar-hover))] hover:text-[rgb(var(--color-sidebar-text-primary))]"
                />
                <button
                  type="button"
                  aria-label={t('workbench.new_project', '新建项目')}
                  data-testid="projects-create-button"
                  onClick={event => {
                    event.stopPropagation()
                    openProjectCreateDialog()
                  }}
                  className="flex h-8 w-8 items-center justify-center rounded-md text-[rgb(var(--color-sidebar-text-secondary))] hover:bg-[rgb(var(--color-sidebar-hover))] hover:text-[rgb(var(--color-sidebar-text-primary))]"
                  aria-expanded={projectCreateDialogOpen}
                >
                  <FolderPlus className="h-4 w-4" />
                </button>
              </div>
            </SidebarSectionHeader>
          </div>
          {projectCreateDialogOpen &&
            createPortal(
              <div
                data-testid="project-create-dialog-overlay"
                className="fixed inset-0 z-modal flex items-center justify-center bg-black/35 px-4"
                onClick={event => {
                  if (event.target === event.currentTarget) setProjectCreateDialogOpen(false)
                }}
              >
                <div
                  role="dialog"
                  aria-modal="true"
                  aria-labelledby="project-create-dialog-title"
                  data-testid="projects-create-button-menu"
                  className="w-full max-w-[520px] rounded-2xl border border-border bg-popover p-5 text-text-primary shadow-2xl"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <h2 id="project-create-dialog-title" className="heading-base">
                        {t('workbench.create_project_title', '创建项目')}
                      </h2>
                      <p className="mt-2 text-sm leading-5 text-text-secondary">
                        {t(
                          'workbench.create_project_description',
                          '选择项目运行的位置。之后可以在项目中切换工作目录。'
                        )}
                      </p>
                    </div>
                    <button
                      type="button"
                      data-testid="close-project-source-dialog"
                      aria-label={t('workbench.close_dialog', '关闭')}
                      onClick={() => setProjectCreateDialogOpen(false)}
                      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-text-secondary hover:bg-muted"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                  <div className="mt-5 grid gap-3 sm:grid-cols-2">
                    <button
                      type="button"
                      data-testid="project-create-local-option"
                      onClick={() => {
                        setProjectCreateDialogOpen(false)
                        if (onOpenStandaloneFolderProject) {
                          onOpenStandaloneFolderProject('existing')
                        } else {
                          setStandaloneWorkspaceDialogMode('existing')
                        }
                      }}
                      className="rounded-xl border border-border bg-background p-4 text-left hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
                    >
                      <FolderOpen className="h-5 w-5 text-text-primary" />
                      <span className="mt-3 block text-base font-medium">
                        {t('workbench.local_project', '本地项目')}
                      </span>
                      <span className="mt-1 block text-sm leading-5 text-text-secondary">
                        {t('workbench.local_project_description', '选择一个或多个本地文件夹。')}
                      </span>
                    </button>
                    <button
                      type="button"
                      data-testid="project-create-remote-option"
                      onClick={() => {
                        setProjectCreateDialogOpen(false)
                        if (onOpenStandaloneFolderProject) {
                          onOpenStandaloneFolderProject('remote', 'project')
                        } else {
                          setStandaloneRemoteDialogIntent('project')
                          setStandaloneWorkspaceDialogMode('remote')
                        }
                      }}
                      className="rounded-xl border border-border bg-background p-4 text-left hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
                    >
                      <Globe2 className="h-5 w-5 text-text-primary" />
                      <span className="mt-3 block text-base font-medium">
                        {t('workbench.cloud_project', '云端项目')}
                      </span>
                      <span className="mt-1 block text-sm leading-5 text-text-secondary">
                        {t(
                          'workbench.cloud_project_description',
                          '使用云设备或远程主机上的项目目录。'
                        )}
                      </span>
                    </button>
                  </div>
                </div>
              </div>,
              document.body
            )}
          {displayedProjectsExpanded && (
            <SidebarSortableList
              testId="runtime-project-sortable-list"
              className="space-y-1"
              items={regularSortableProjects}
              getId={({ project, runtimeProjectWork }) =>
                runtimeProjectWork
                  ? `${sidebarStateDeviceId || runtimeProjectWork.project.stateDeviceId || 'device'}:${getRuntimeProjectSidebarStateKey(runtimeProjectWork.project)}`
                  : `project:${project.id}`
              }
              getLabel={({ project }) => project.name}
              canDrag={({ runtimeProjectWork }) =>
                Boolean(runtimeProjectWork?.project.key && onReorderRuntimeProjects)
              }
              onMove={async (moved, before) => {
                const movedRuntimeProject = moved.runtimeProjectWork
                if (!movedRuntimeProject || !onReorderRuntimeProjects) {
                  throw new Error('Runtime project ordering is unavailable')
                }
                const request = getRuntimeProjectReorderRequest(
                  movedRuntimeProject,
                  before?.runtimeProjectWork,
                  sidebarStateDeviceId
                )
                if (!request) throw new Error('Runtime project ordering is unavailable')
                await onReorderRuntimeProjects(request)
              }}
              renderItem={({ project, runtimeProjectWork }) => (
                <ProjectItem
                  onHistoryRefreshed={onHistoryRefreshed}
                  project={project}
                  expanded={displayedExpandedProjectIds.has(project.id)}
                  devices={devices}
                  runtimeProjectWork={runtimeProjectWork}
                  currentRuntimeTask={currentRuntimeTask}
                  unreadTaskKeys={visibleUnreadRuntimeTaskKeys}
                  imNotificationSettings={imNotificationSettings}
                  showDeviceMarker={false}
                  sidebarStateDeviceId={sidebarStateDeviceId}
                  onToggleProject={handleToggleProject}
                  onStartNewProjectChat={onStartNewProjectChat}
                  onRemoveProject={onRemoveProject}
                  onCreatePermanentWorktree={onCreatePermanentWorktree}
                  onReorderRuntimeProjects={onReorderRuntimeProjects}
                  onSetRuntimeProjectPinned={onSetRuntimeProjectPinned}
                  onSetRuntimeProjectAppearance={onSetRuntimeProjectAppearance}
                  onReorderRuntimeProjectTasks={onReorderRuntimeProjectTasks}
                  onSetRuntimeTaskPinned={onSetRuntimeTaskPinned}
                  onRenameProject={openProjectEditor}
                  onOpenRuntimeTask={onOpenRuntimeTask}
                  onMarkRuntimeTaskRead={onMarkRuntimeTaskRead}
                  onRenameRuntimeTask={onRenameRuntimeTask}
                  onArchiveRuntimeTask={onArchiveRuntimeTask}
                  onArchiveProjectConversations={onArchiveProjectConversations}
                  onToggleRuntimeTaskNotification={onToggleRuntimeTaskNotification}
                />
              )}
            />
          )}
        </section>

        <section data-testid="runtime-chat-section" className="mt-8">
          <SidebarSectionHeader
            title={t('workbench.tasks')}
            expanded={displayedChatsExpanded}
            hasContent={regularChatTaskItems.length > 0}
            toggleTestId="runtime-chat-section-toggle"
            iconTestId="runtime-chat-section-chevron-right"
            onToggle={() => setChatsExpanded(expanded => !expanded)}
          >
            <div className="flex items-center">
              <ActionMenu
                ariaLabel={t('workbench.chat_list_actions', '对话列表操作')}
                testId="runtime-chat-section-menu"
                items={[
                  {
                    label: t('workbench.archive_all_chats', '归档所有聊天'),
                    icon: Archive,
                    testId: 'runtime-chat-section-archive-all-chats',
                    disabled:
                      !onArchiveChatConversations ||
                      chatSectionArchiveCount === 0 ||
                      isArchivingChatSection,
                    onSelect: () => setArchiveSectionMode('chats'),
                  },
                ]}
                triggerClassName="flex h-8 w-8 items-center justify-center rounded-md text-[rgb(var(--color-sidebar-text-secondary))] hover:bg-[rgb(var(--color-sidebar-hover))] hover:text-[rgb(var(--color-sidebar-text-primary))]"
              />
              <button
                type="button"
                aria-label={t('workbench.new_task')}
                data-testid="runtime-chat-section-new-chat-button"
                onClick={event => {
                  event.stopPropagation()
                  onStartStandaloneChat()
                }}
                className="flex h-8 w-8 items-center justify-center rounded-md text-[rgb(var(--color-sidebar-text-secondary))] hover:bg-[rgb(var(--color-sidebar-hover))] hover:text-[rgb(var(--color-sidebar-text-primary))]"
              >
                <MessageSquarePlus className="h-4 w-4" />
              </button>
            </div>
          </SidebarSectionHeader>
          <RuntimeThreadListStatus workspaces={chatWorkspaces} />
          {displayedChatsExpanded && (
            <div className="space-y-0.5 pb-2">
              {regularChatTaskItems.length === 0 ? (
                <div
                  data-testid="runtime-chat-empty"
                  className="ml-2 rounded-md px-3 py-1.5 text-xs text-[rgb(var(--color-sidebar-text-muted))]"
                >
                  {t('workbench.no_chats', '暂无会话')}
                </div>
              ) : (
                <SidebarSortableList
                  testId="runtime-chat-task-sortable-list"
                  className="space-y-0.5"
                  items={regularChatTaskItems}
                  getId={({ workspace, task }) =>
                    `${workspace.deviceId}:${getRuntimeTaskThreadId(task) || task.taskId}`
                  }
                  getLabel={({ task }) => task.title}
                  canDrag={({ task }) =>
                    Boolean(getRuntimeTaskThreadId(task) && onReorderRuntimeProjectTasks)
                  }
                  onMove={async (moved, before) => {
                    const movedThreadId = getRuntimeTaskThreadId(moved.task)
                    if (!movedThreadId || !onReorderRuntimeProjectTasks) {
                      throw new Error('Runtime task ordering is unavailable')
                    }
                    if (before && before.workspace.deviceId !== moved.workspace.deviceId) {
                      throw new Error('Tasks from different devices cannot be reordered together')
                    }
                    const beforeThreadId = before ? getRuntimeTaskThreadId(before.task) : null
                    await onReorderRuntimeProjectTasks({
                      deviceId: moved.workspace.deviceId,
                      projectKey: 'chats',
                      threadId: movedThreadId,
                      beforeThreadId,
                      insertAtEnd: beforeThreadId === null,
                    })
                  }}
                  renderItem={({ workspace, task }) => (
                    <RuntimeTaskRow
                      workspace={workspace}
                      task={task}
                      projectName={null}
                      selected={isRuntimeTaskSelected(currentRuntimeTask, workspace, task)}
                      unread={visibleUnreadRuntimeTaskKeys.has(
                        getRuntimeTaskReminderItemKey(workspace, task)
                      )}
                      indentClassName="pl-2.5"
                      imNotificationSettings={imNotificationSettings}
                      showDeviceMarker={false}
                      stateDeviceId={workspace.deviceId}
                      onOpenRuntimeTask={onOpenRuntimeTask}
                      onMarkRuntimeTaskRead={onMarkRuntimeTaskRead}
                      onRenameRuntimeTask={onRenameRuntimeTask}
                      onArchiveRuntimeTask={onArchiveRuntimeTask}
                      onSetRuntimeTaskPinned={
                        onSetRuntimeTaskPinned ? setChatTaskPinned : undefined
                      }
                      onToggleRuntimeTaskNotification={onToggleRuntimeTaskNotification}
                    />
                  )}
                />
              )}
            </div>
          )}
        </section>
      </div>
    </>
  )
}
