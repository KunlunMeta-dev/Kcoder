/* eslint-disable @typescript-eslint/no-unused-vars */
import { render } from '@testing-library/react'
import { createContext, StrictMode, useContext, useEffect, useState } from 'react'
import { vi } from 'vitest'
import { LOCAL_USER } from '@/api/local/localSession'
import {
  CloudConnectionContext,
  DISCONNECTED_STATE,
  type CloudConnectionContextValue,
} from '@/features/cloud-connection/CloudConnectionContext'
import { WorkbenchProvider, type WorkbenchServices } from './WorkbenchProvider'
import { useWorkbench } from './useWorkbench'
import { MessageList } from '@/components/chat/MessageList'
import { TaskPlanProgress } from '@/components/chat/composer/TaskPlanProgress'
import { useWorkbenchPaneSession } from '@/components/layout/useWorkbenchPaneSession'
import { buildRuntimeTaskRoute } from '@/lib/navigation'
import { runtimeProjectUiId, standaloneRuntimeProjectKey } from '@/lib/runtime-project'
import { findRuntimeTask } from './workbenchRuntimeHelpers'
import { useRuntimeTaskRouteRestoration } from './useRuntimeTaskRouteRestoration'
import { modelSelectionFromRuntimeHandle } from './runtimeContextUsage'
import {
  useRuntimeTaskLifecycle,
  useRuntimeTaskLifecycleStoreSnapshot,
} from './runtimeTaskLifecycle'
import type { ChatStreamHandlers } from '@/stream/chatStream'
import {
  getWorkbenchPaneKey,
  type WorkbenchPaneIdentity,
} from '@/components/layout/workbenchPaneIdentity'
import type {
  Attachment,
  DeviceInfo,
  ProjectWithTasks,
  RuntimeTaskAddress,
  RuntimeGoal,
  TurnFileChangesSummary,
  RuntimeWorkListResponse,
  User,
} from '@/types/api'

import {
  createImageAttachment,
  createLocalImageAttachment,
  createProject,
} from './WorkbenchProvider.factories.test-support'
import { useWorkbenchProbeSession } from './WorkbenchProvider.render.test-support'
export function ProjectSendProbe() {
  const { workbench, paneSession, currentRuntimeTask } = useWorkbenchProbeSession()
  const taskLifecycle = useRuntimeTaskLifecycle(currentRuntimeTask)
  const imageAttachment = createImageAttachment()
  const localImageAttachment = createLocalImageAttachment()
  const currentRuntimeTaskSummary = findRuntimeTask(workbench.state.runtimeWork, currentRuntimeTask)
  const currentModelSelection =
    currentRuntimeTaskSummary?.modelSelection ??
    modelSelectionFromRuntimeHandle(currentRuntimeTask?.runtimeHandle)

  return (
    <div>
      <span data-testid="current-runtime-task-address">
        {currentRuntimeTask
          ? `${currentRuntimeTask.deviceId}:${currentRuntimeTask.taskId}`
          : 'none'}
      </span>
      <span data-testid="current-project-name">
        {workbench.state.currentProject?.name ?? 'none'}
      </span>
      <span data-testid="standalone-workspace-path">
        {workbench.state.standaloneWorkspacePath ?? 'none'}
      </span>
      <span data-testid="standalone-device-id">{workbench.state.standaloneDeviceId ?? 'none'}</span>
      <span data-testid="current-project-device-id">
        {workbench.state.currentProject?.config?.execution?.deviceId ??
          workbench.state.currentProject?.config?.device_id ??
          'none'}
      </span>
      <span data-testid="standalone-chat-key">{workbench.state.standaloneChatKey}</span>
      <span data-testid="composer-input">{paneSession.input}</span>
      <span data-testid="message-contents">
        {paneSession.messages.map(message => message.content).join('|')}
      </span>
      <span data-testid="message-roles">
        {paneSession.messages.map(message => `${message.role}:${message.content}`).join('|')}
      </span>
      <span data-testid="message-goal-flags">
        {paneSession.messages
          .filter(message => message.runtimeGoalRequest === true)
          .map(message => `goal:${message.content}`)
          .join('|') || 'none'}
      </span>
      <span data-testid="goal-objective">{paneSession.goal?.objective ?? 'none'}</span>
      <span data-testid="goal-draft-active">
        {paneSession.goalDraftActive ? 'active' : 'inactive'}
      </span>
      <span data-testid="project-collaboration-mode">
        {workbench.projectChat.selectedModelOptions.collaborationMode ?? 'default'}
      </span>
      <span data-testid="runtime-context-window">
        {workbench.projectChat.contextUsage?.modelContextWindow ?? 'none'}
      </span>
      <span data-testid="runtime-task-model-selection">
        {currentModelSelection
          ? [
              currentModelSelection.modelName,
              currentModelSelection.modelType ?? '',
              currentModelSelection.options?.collaborationMode ?? '',
            ].join(':')
          : 'none'}
      </span>
      <span data-testid="runtime-project-order">
        {workbench.state.runtimeWork?.projects
          .map(projectWork => projectWork.project.name)
          .join('|') ?? ''}
      </span>
      <span data-testid="runtime-chat-workspaces">
        {workbench.state.runtimeWork?.chats.map(workspace => workspace.workspacePath).join('|') ??
          ''}
      </span>
      <span data-testid="runtime-task-titles">
        {workbench.state.runtimeWork?.projects
          .flatMap(projectWork =>
            projectWork.deviceWorkspaces.flatMap(workspace =>
              workspace.tasks.map(task => task.title)
            )
          )
          .join('|') ?? ''}
      </span>
      <span data-testid="runtime-task-statuses">
        {workbench.state.runtimeWork?.projects
          .flatMap(projectWork =>
            projectWork.deviceWorkspaces.flatMap(workspace =>
              workspace.tasks.map(task => task.status ?? 'none')
            )
          )
          .join('|') ?? ''}
      </span>
      <span data-testid="current-created-runtime-task-running">
        {taskLifecycle?.derived.isRunning ? 'running' : 'idle'}
      </span>
      <span data-testid="runtime-task-errors">
        {workbench.state.runtimeWork?.projects
          .flatMap(projectWork =>
            projectWork.deviceWorkspaces.flatMap(workspace =>
              workspace.tasks.map(task => task.error ?? '')
            )
          )
          .join('|') ?? ''}
      </span>
      <span data-testid="project-attachment-count">{workbench.projectChat.attachments.length}</span>
      <span data-testid="workbench-error">{workbench.state.error ?? ''}</span>
      <span data-testid="pane-session-error">{paneSession.error ?? ''}</span>
      <span data-testid="sending-state">{paneSession.sending ? 'sending' : 'idle'}</span>
      <span data-testid="pane-busy">{paneSession.status.isBusy ? 'busy' : 'idle'}</span>
      <span data-testid="pane-waiting">
        {paneSession.status.isWaitingForAssistantIndicator ? 'waiting' : 'idle'}
      </span>
      <button type="button" onClick={() => workbench.selectProjectWorkspace(7, null)}>
        select project
      </button>
      <button type="button" onClick={() => workbench.startNewChat()}>
        start new chat
      </button>
      <button type="button" onClick={() => workbench.startNewProjectChat(7)}>
        start new project chat
      </button>
      <button type="button" onClick={() => workbench.startStandaloneChat()}>
        start standalone chat
      </button>
      <button
        type="button"
        onClick={() =>
          void workbench.openRuntimeTask({
            deviceId: 'device-1',
            workspacePath: '/workspace/project-alpha',
            taskId: 'runtime-a',
          })
        }
      >
        open project runtime task
      </button>
      <button
        type="button"
        onClick={() =>
          void workbench.openStandaloneWorkspace('device-1', '/workspace/direct-codex')
        }
      >
        open standalone workspace
      </button>
      <button
        type="button"
        onClick={() =>
          void workbench.openStandaloneWorkspace('device-1', '/workspace/web', undefined, [
            '/workspace/web',
            '/workspace/api',
          ])
        }
      >
        open multi-root workspace
      </button>
      <button
        type="button"
        onClick={() =>
          void workbench.openStandaloneWorkspace('device-1', '/workspace/product', 'Product', [
            '/workspace/product',
          ])
        }
      >
        create named local project
      </button>
      <button
        type="button"
        onClick={() => {
          const deviceId = workbench.state.standaloneDeviceId
          const workspacePath = workbench.state.standaloneWorkspacePath
          if (!deviceId || !workspacePath) return
          void workbench.removeProject(
            runtimeProjectUiId({
              key: standaloneRuntimeProjectKey(workspacePath),
              stateDeviceId: deviceId,
              name: workspacePath,
            })
          )
        }}
      >
        remove standalone workspace
      </button>
      <button
        type="button"
        onClick={() =>
          void workbench.openStandaloneWorkspace(
            'device-1',
            '/workspace/direct-codex',
            'Direct Codex'
          )
        }
      >
        open labeled standalone workspace
      </button>
      <button
        type="button"
        onClick={() =>
          void workbench.openStandaloneWorkspace(
            'local-device',
            '/workspace/cli-codex',
            'CLI Project'
          )
        }
      >
        open cli local-device workspace
      </button>
      <button type="button" onClick={() => paneSession.setInput('修复 CI')}>
        set input
      </button>
      <button type="button" onClick={() => void paneSession.setCurrentGoal()}>
        set goal
      </button>
      <button
        type="button"
        onClick={() => workbench.projectChat.setSelectedModelOption('collaborationMode', 'plan')}
      >
        enable plan mode
      </button>
      <button
        type="button"
        onClick={() => {
          workbench.projectChat.setSelectedModelOption('collaborationMode', 'plan')
          void paneSession.send()
        }}
      >
        enable plan and send
      </button>
      <button
        type="button"
        onClick={() => workbench.projectChat.addExistingAttachment(imageAttachment)}
      >
        add image attachment
      </button>
      <button
        type="button"
        onClick={() => workbench.projectChat.addExistingAttachment(localImageAttachment)}
      >
        add local image attachment
      </button>
      <button type="button" onClick={() => void paneSession.send()}>
        send
      </button>
      <button
        type="button"
        onClick={() => {
          const address = {
            deviceId: 'device-1',
            taskId: 'runtime-b',
            workspacePath: '/workspace/project-alpha',
          }
          window.history.pushState({}, '', buildRuntimeTaskRoute(address))
          void workbench.openRuntimeTask(address)
        }}
      >
        open runtime b
      </button>
      <button type="button" onClick={() => void workbench.refreshWorkLists()}>
        refresh work lists
      </button>
      <MessageList
        messages={paneSession.messages}
        isWaitingForAssistant={paneSession.status.isWaitingForAssistantIndicator}
        onRetryFailedMessage={message => void paneSession.retryFailedMessage(message)}
      />
    </div>
  )
}

export function RuntimePaneSendProbe() {
  const workbench = useWorkbench()
  const runtimeTasks = [
    ...(workbench.state.runtimeWork?.projects.flatMap(project =>
      project.deviceWorkspaces.flatMap(workspace => workspace.tasks)
    ) ?? []),
    ...(workbench.state.runtimeWork?.chats.flatMap(workspace => workspace.tasks) ?? []),
  ]

  return (
    <div>
      <span data-testid="current-runtime-task-address">
        {workbench.state.currentRuntimeTask
          ? [
              workbench.state.currentRuntimeTask.deviceId,
              workbench.state.currentRuntimeTask.taskId,
              workbench.state.currentRuntimeTask.workspacePath ?? '',
            ].join(':')
          : 'none'}
      </span>
      <span data-testid="runtime-local-task-count">{runtimeTasks.length}</span>
      <span data-testid="runtime-project-count">
        {workbench.state.runtimeWork?.projects.length ?? 0}
      </span>
      <span data-testid="runtime-local-task-titles">
        {runtimeTasks.map(task => task.title).join('|')}
      </span>
      <span data-testid="runtime-pane-standalone-chat-key">
        {workbench.state.standaloneChatKey}
      </span>
      <RuntimePaneStackItem
        key={getWorkbenchPaneKey({
          currentRuntimeTask: workbench.state.currentRuntimeTask,
          currentProject: workbench.state.currentProject,
          standaloneChatKey: workbench.state.standaloneChatKey,
        })}
        pane={{
          currentRuntimeTask: workbench.state.currentRuntimeTask,
          currentProject: workbench.state.currentProject,
          standaloneChatKey: workbench.state.standaloneChatKey,
        }}
      />
    </div>
  )
}

export function RuntimePaneStackItem({ pane }: { pane: WorkbenchPaneIdentity }) {
  const workbench = useWorkbench()
  const paneSession = useWorkbenchPaneSession({
    currentRuntimeTask: pane.currentRuntimeTask,
  })

  return (
    <>
      <span data-testid="active-pane-key">
        {pane.currentRuntimeTask
          ? [
              pane.currentRuntimeTask.deviceId,
              pane.currentRuntimeTask.taskId,
              pane.currentRuntimeTask.workspacePath ?? '',
            ].join(':')
          : pane.currentProject
            ? `project:${pane.currentProject.id}`
            : 'standalone'}
      </span>
      <span data-testid="pane-message-roles">
        {paneSession.messages.map(message => `${message.role}:${message.content}`).join('|')}
      </span>
      <span data-testid="pane-goal-objective">{paneSession.goal?.objective ?? 'none'}</span>
      <span data-testid="pane-goal-draft-active">
        {paneSession.goalDraftActive ? 'active' : 'inactive'}
      </span>
      <button type="button" onClick={() => workbench.selectProjectWorkspace(7, 22)}>
        select mapped project workspace
      </button>
      <button type="button" onClick={() => workbench.startNewProjectChat(7)}>
        start new project task
      </button>
      <button type="button" onClick={() => void paneSession.setCurrentGoal()}>
        set pane goal
      </button>
      <button type="button" onClick={() => paneSession.setInput('修复 CI')}>
        set pane input
      </button>
      <button type="button" onClick={() => void paneSession.send()}>
        send pane input
      </button>
      <MessageList
        messages={paneSession.messages}
        isWaitingForAssistant={paneSession.status.isWaitingForAssistantIndicator}
      />
    </>
  )
}

export function RuntimePaneSessionIdentityProbe() {
  const [address, setAddress] = useState<RuntimeTaskAddress>({
    deviceId: 'device-1',
    workspacePath: '/workspace/project-alpha',
    taskId: 'runtime-a',
  })
  const paneSession = useWorkbenchPaneSession({ currentRuntimeTask: address })

  return (
    <div>
      <span data-testid="runtime-session-messages">
        {paneSession.messages.map(message => message.content).join('|')}
      </span>
      <button
        type="button"
        onClick={() =>
          setAddress({
            deviceId: 'device-1',
            workspacePath: '/workspace/project-alpha',
            taskId: 'runtime-a',
          })
        }
      >
        rebuild same runtime address
      </button>
    </div>
  )
}

export function RuntimePlanScopeProbe() {
  const { workbench, paneSession } = useWorkbenchProbeSession()
  const runtimeTask = {
    deviceId: 'device-1',
    workspacePath: '/workspace/project-alpha',
    taskId: 'runtime-plan-scope',
  }

  return (
    <div>
      <span data-testid="runtime-plan-scope-task">
        {workbench.state.currentRuntimeTask?.taskId ?? 'none'}
      </span>
      <TaskPlanProgress plan={paneSession.taskPlan} />
      <button type="button" onClick={() => void workbench.openRuntimeTask(runtimeTask)}>
        open runtime plan scope
      </button>
      <button type="button" onClick={workbench.startNewChat}>
        start new plan scope chat
      </button>
    </div>
  )
}

export function RuntimeProjectMutationProbe() {
  const workbench = useWorkbench()
  return (
    <div>
      <span data-testid="mutation-project-name">
        {workbench.state.currentProject?.name ?? 'none'}
      </span>
      <span data-testid="mutation-project-order">
        {workbench.state.runtimeWork?.projects
          .map(projectWork => projectWork.project.name)
          .join('|') ?? ''}
      </span>
      <button
        type="button"
        onClick={() =>
          void workbench
            .createProject(
              {
                name: 'New Runtime Project',
                description: '',
                config: { mode: 'workspace' },
              },
              { refreshWorkLists: false }
            )
            .then(project =>
              workbench.prepareDeviceWorkspace(
                {
                  projectId: project.id,
                  deviceId: 'device-1',
                  workspacePath: '/workspace/new-runtime-project',
                  action: 'select',
                },
                { refreshWorkLists: false }
              )
            )
        }
      >
        create runtime project
      </button>
      <button type="button" onClick={() => void workbench.updateProjectName(7, 'Hello project')}>
        rename runtime project
      </button>
      <button type="button" onClick={() => void workbench.removeProject(7)}>
        remove runtime project
      </button>
    </div>
  )
}

export function ProjectWorkPreferenceProbe() {
  const workbench = useWorkbench()

  return (
    <div>
      <span data-testid="current-project-id">{workbench.state.currentProject?.id ?? 'none'}</span>
      <span data-testid="project-execution-mode">{workbench.projectExecutionMode}</span>
      <span data-testid="project-worktree-branch">{workbench.projectWorktreeBranch ?? ''}</span>
      <button type="button" onClick={() => workbench.selectProjectWorkspace(7, 22)}>
        select project 7
      </button>
      <button type="button" onClick={() => workbench.selectProjectWorkspace(8, 33)}>
        select project 8
      </button>
      <button type="button" onClick={() => workbench.setProjectExecutionMode('git_worktree')}>
        use worktree
      </button>
      <button type="button" onClick={() => workbench.setProjectExecutionMode('current_workspace')}>
        use local
      </button>
      <button type="button" onClick={() => workbench.setProjectWorktreeBranch('feature/alpha')}>
        select alpha
      </button>
      <button type="button" onClick={() => workbench.setProjectWorktreeBranch('feature/beta')}>
        select beta
      </button>
    </div>
  )
}

export function ArchiveRuntimeTaskProbe() {
  const workbench = useWorkbench()
  const [lastArchiveResult, setLastArchiveResult] = useState('')
  return (
    <div>
      <span data-testid="workbench-error">{workbench.state.error ?? ''}</span>
      <span data-testid="archive-result">{lastArchiveResult}</span>
      <span data-testid="current-runtime-task">
        {workbench.state.currentRuntimeTask?.taskId ?? ''}
      </span>
      <button
        type="button"
        onClick={() =>
          void workbench.openRuntimeTask({
            deviceId: 'device-1',
            workspacePath: '/workspace/worktrees/9/project-alpha',
            taskId: 'runtime-worktree',
          })
        }
      >
        open archived worktree target
      </button>
      <button
        type="button"
        onClick={() =>
          void workbench.openRuntimeTask({
            deviceId: 'device-1',
            workspacePath: '/workspace/project-alpha',
            taskId: 'runtime-b',
          })
        }
      >
        open runtime b
      </button>
      <button
        type="button"
        onClick={() =>
          void workbench
            .archiveRuntimeTask({
              deviceId: 'device-1',
              workspacePath: '/workspace/worktrees/9/project-alpha',
              taskId: 'runtime-worktree',
            })
            .then(result => setLastArchiveResult(result?.status ?? 'none'))
        }
      >
        archive worktree task
      </button>
      <button
        type="button"
        onClick={() =>
          void workbench
            .archiveRuntimeTask(
              {
                deviceId: 'device-1',
                workspacePath: '/workspace/worktrees/9/project-alpha',
                taskId: 'runtime-worktree',
              },
              { force: true }
            )
            .then(result => setLastArchiveResult(result?.status ?? 'none'))
        }
      >
        force archive worktree task
      </button>
    </div>
  )
}

export function ArchiveProjectConversationsProbe() {
  const workbench = useWorkbench()
  const [lastArchiveResult, setLastArchiveResult] = useState('')
  return (
    <div>
      <span data-testid="workbench-error">{workbench.state.error ?? ''}</span>
      <span data-testid="archive-result">{lastArchiveResult}</span>
      <button
        type="button"
        onClick={() =>
          void workbench
            .archiveProjectsConversations(['project:7', 'remote-project-key'])
            .then(result => setLastArchiveResult(result?.status ?? 'none'))
        }
      >
        archive project conversations
      </button>
      <button
        type="button"
        onClick={() =>
          void workbench
            .archiveProjectsConversations(['project:7', 'remote-project-key'], { force: true })
            .then(result => setLastArchiveResult(result?.status ?? 'none'))
        }
      >
        force archive project conversations
      </button>
    </div>
  )
}

export function ArchiveRemoteRuntimeTaskProbe() {
  const workbench = useWorkbench()
  const taskTitles =
    workbench.state.runtimeWork?.projects.flatMap(project =>
      project.deviceWorkspaces.flatMap(workspace => workspace.tasks.map(task => task.title))
    ) ?? []
  return (
    <div>
      <span data-testid="archive-remote-task-titles">{taskTitles.join('|')}</span>
      <button
        type="button"
        onClick={() =>
          void workbench.archiveRuntimeTask({
            deviceId: 'remote-device',
            workspacePath: '/srv/Wegent',
            taskId: 'remote-task',
          })
        }
      >
        archive remote task
      </button>
    </div>
  )
}
