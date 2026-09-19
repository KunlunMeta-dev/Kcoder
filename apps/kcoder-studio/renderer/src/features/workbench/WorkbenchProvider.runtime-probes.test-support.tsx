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
} from './WorkbenchProvider.factories.test-support'
import { useWorkbenchProbeSession } from './WorkbenchProvider.render.test-support'
export function RuntimeOpenProbe() {
  const { workbench, paneSession, currentRuntimeTask } = useWorkbenchProbeSession()
  const taskLifecycle = useRuntimeTaskLifecycle(currentRuntimeTask)
  const [fileChangesDiff, setFileChangesDiff] = useState('')
  const [fileChangesStatus, setFileChangesStatus] = useState('')
  const fileChangesMessage = paneSession.messages.find(message => message.fileChanges)
  const fileChangesSubtaskId = fileChangesMessage?.subtaskId
  const fileChangesSummary = fileChangesMessage?.fileChanges
  return (
    <div>
      <span data-testid="current-runtime-task-address">
        {currentRuntimeTask
          ? `${currentRuntimeTask.deviceId}:${currentRuntimeTask.taskId}`
          : 'none'}
      </span>
      <span data-testid="runtime-open-messages">
        {paneSession.messages.map(message => message.content).join('|')}
      </span>
      <span data-testid="runtime-open-message-ids">
        {paneSession.messages.map(message => message.id).join('|')}
      </span>
      <span data-testid="runtime-open-message-created-at">
        {paneSession.messages.map(message => message.createdAt).join('|')}
      </span>
      <span data-testid="runtime-open-goal-flags">
        {paneSession.messages
          .filter(message => message.runtimeGoalRequest === true)
          .map(message => `goal:${message.content}`)
          .join('|') || 'none'}
      </span>
      <span data-testid="runtime-message-statuses">
        {paneSession.messages.map(message => `${message.role}:${message.status}`).join('|')}
      </span>
      <span data-testid="runtime-content-truncation">
        {paneSession.messages
          .map(
            message => `${message.id}:${message.contentTruncated === true ? 'truncated' : 'full'}`
          )
          .join('|')}
      </span>
      <span data-testid="runtime-transcript-loading">
        {paneSession.transcriptLoading ? 'loading' : 'idle'}
      </span>
      <span data-testid="runtime-transcript-has-more">
        {paneSession.transcriptHasMoreBefore ? 'more' : 'done'}
      </span>
      <span data-testid="runtime-open-blocks">
        {paneSession.messages
          .flatMap(message => message.blocks ?? [])
          .map(block => {
            if (block.type === 'tool') return `tool:${block.toolName}:${block.status}`
            if (block.type === 'thinking') return `thinking:${block.content}:${block.status}`
            return `text:${block.content}:${block.status}`
          })
          .join('|')}
      </span>
      <span data-testid="runtime-open-block-times">
        {paneSession.messages
          .flatMap(message => message.blocks ?? [])
          .map(block => block.createdAt)
          .join('|')}
      </span>
      <span data-testid="runtime-open-file-changes">
        {paneSession.messages
          .map(message => {
            if (!message.fileChanges) return ''
            const paths = message.fileChanges.files.map(file => file.path).join(',')
            const counts = `${message.fileChanges.file_count}:${message.fileChanges.additions}:${message.fileChanges.deletions}`
            return [paths, counts].filter(Boolean).join(':')
          })
          .join('|')}
      </span>
      <span data-testid="runtime-open-error">{workbench.state.error ?? ''}</span>
      <span data-testid="runtime-goal-objective">{paneSession.goal?.objective ?? 'none'}</span>
      <span data-testid="runtime-goal-status">{paneSession.goal?.status ?? 'none'}</span>
      <span data-testid="current-runtime-task-running">
        {taskLifecycle?.derived.isRunning ? 'running' : 'idle'}
      </span>
      <span data-testid="runtime-file-changes-diff">{fileChangesDiff}</span>
      <span data-testid="runtime-file-changes-status">{fileChangesStatus}</span>
      <button
        type="button"
        onClick={() => {
          if (fileChangesSubtaskId) {
            void workbench
              .loadTurnFileChangesDiff(
                fileChangesSubtaskId,
                paneSession.messages,
                undefined,
                currentRuntimeTask
              )
              .then(result => setFileChangesDiff(result.diff))
          }
        }}
      >
        review runtime file changes
      </button>
      <button
        type="button"
        onClick={() => {
          if (fileChangesSubtaskId && fileChangesSummary) {
            void workbench
              .loadTurnFileChangesDiff(
                fileChangesSubtaskId,
                [],
                fileChangesSummary,
                currentRuntimeTask
              )
              .then(result => setFileChangesDiff(result.diff))
          }
        }}
      >
        review runtime file changes from stale messages
      </button>
      <button
        type="button"
        onClick={() => {
          if (fileChangesSubtaskId) {
            void workbench
              .revertTurnFileChanges(
                fileChangesSubtaskId,
                paneSession.messages,
                undefined,
                currentRuntimeTask
              )
              .then(fileChanges => setFileChangesStatus(fileChanges.status))
          }
        }}
      >
        revert runtime file changes
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
        open runtime a
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
      <button type="button" onClick={() => void paneSession.pauseCurrentResponse()}>
        stop current response
      </button>
      <button type="button" onClick={paneSession.editCurrentGoal}>
        edit runtime goal
      </button>
      <button type="button" onClick={() => void paneSession.clearCurrentGoal()}>
        clear runtime goal
      </button>
      <span data-testid="runtime-goal-error">{paneSession.error ?? 'none'}</span>
      <button type="button" onClick={() => paneSession.setInput('更新后的目标')}>
        set edited runtime goal
      </button>
      <button type="button" onClick={() => void paneSession.send()}>
        send runtime goal
      </button>
      <MessageList
        messages={paneSession.messages}
        isWaitingForAssistant={paneSession.status.isWaitingForAssistantIndicator}
      />
      <button type="button" onClick={() => void paneSession.loadMoreTranscriptBefore()}>
        load older
      </button>
    </div>
  )
}

export function RuntimeModelCompatibilityProbe() {
  const workbench = useWorkbench()
  const modelRows = workbench.projectChat.models.map(model => {
    const disabledReason = model.compatibilityDisabledReason ?? 'enabled'
    return `${model.name}:${model.compatibilityDisabled ? disabledReason : 'enabled'}`
  })

  return (
    <div>
      <span data-testid="runtime-model-compatibility">{modelRows.join('|')}</span>
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
        open runtime a
      </button>
    </div>
  )
}

export function RuntimeModelSelectionProbe() {
  const workbench = useWorkbench()
  const mimoModel = workbench.projectChat.models.find(model => model.name === 'local-model:mimo')

  return (
    <div>
      <span data-testid="selected-model">{workbench.projectChat.selectedModel?.name ?? ''}</span>
      <span data-testid="active-model">{workbench.projectChat.activeModel?.name ?? ''}</span>
      <span data-testid="selected-mode">
        {workbench.projectChat.selectedModelOptions.collaborationMode ?? 'default'}
      </span>
      <button
        type="button"
        onClick={() => {
          if (mimoModel) workbench.projectChat.setSelectedModel(mimoModel)
        }}
      >
        select mimo
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
        open runtime a
      </button>
    </div>
  )
}

export function FollowUpProbe() {
  const { workbench, paneSession, currentRuntimeTask } = useWorkbenchProbeSession()
  const imageAttachment = createImageAttachment()
  const localImageAttachment = createLocalImageAttachment()
  const firstQueuedMessage = paneSession.queuedMessages[0]
  const gptModel =
    workbench.projectChat.models.find(model => model.name === 'gpt-5-2025-08-07') ?? null

  return (
    <div>
      <span data-testid="composer-input">{paneSession.input}</span>
      <span data-testid="queued-messages">
        {paneSession.queuedMessages
          .map(message => `${message.status}:${message.content}`)
          .join('|')}
      </span>
      <span data-testid="queued-message-ids">
        {paneSession.queuedMessages.map(message => message.id).join('|')}
      </span>
      <span data-testid="queued-message-created-at">
        {paneSession.queuedMessages.map(message => message.createdAt).join('|')}
      </span>
      <span data-testid="queued-errors">
        {paneSession.queuedMessages.map(message => message.error ?? '').join('|')}
      </span>
      <span data-testid="queued-notices">
        {paneSession.queuedMessages.map(message => message.notice ?? '').join('|')}
      </span>
      <span data-testid="runtime-attachment-count">{workbench.projectChat.attachments.length}</span>
      <span data-testid="code-comment-context-count">{paneSession.codeCommentContexts.length}</span>
      <span data-testid="follow-up-current-runtime-task">
        {currentRuntimeTask
          ? `${currentRuntimeTask.deviceId}:${currentRuntimeTask.taskId}`
          : 'none'}
      </span>
      <span data-testid="follow-up-models">
        {workbench.projectChat.models.map(model => model.name).join('|')}
      </span>
      <span data-testid="follow-up-model-statuses">
        {workbench.projectChat.models
          .map(model => `${model.name}:${model.compatibilityDisabledReason ?? 'enabled'}`)
          .join('|')}
      </span>
      <span data-testid="follow-up-selected-model">
        {workbench.projectChat.selectedModel?.name ?? ''}
      </span>
      <span data-testid="follow-up-collaboration-mode">
        {workbench.projectChat.selectedModelOptions.collaborationMode ?? 'default'}
      </span>
      <span data-testid="guidance-messages">
        {paneSession.guidanceMessages
          .map(message => `${message.status}:${message.content}`)
          .join('|')}
      </span>
      <span data-testid="follow-up-messages">
        {paneSession.messages.map(message => `${message.role}:${message.content}`).join('|')}
      </span>
      <span data-testid="follow-up-pane-busy">{paneSession.status.isBusy ? 'busy' : 'idle'}</span>
      <button type="button" onClick={() => paneSession.setInput('继续修')}>
        set follow-up
      </button>
      <button type="button" onClick={() => paneSession.setInput('执行ls')}>
        set ls follow-up
      </button>
      <button
        data-testid="follow-up-add-code-comment"
        type="button"
        onClick={() =>
          paneSession.addCodeComment({
            id: 'comment-1',
            filePath: '/workspace/project-alpha/src/main.ts',
            fileName: 'main.ts',
            startLine: 1,
            endLine: 1,
            selectedText: 'const value = 1',
            comment: 'keep this context',
            createdAt: '2026-07-19T00:00:00.000Z',
          })
        }
      >
        add code comment
      </button>
      <button type="button" onClick={() => void paneSession.setCurrentGoal()}>
        set follow-up goal
      </button>
      <button
        type="button"
        onClick={() => {
          if (gptModel) workbench.projectChat.setSelectedModel(gptModel)
        }}
      >
        select gpt model
      </button>
      <button
        type="button"
        onClick={() => workbench.projectChat.setSelectedModelOption('collaborationMode', 'plan')}
      >
        enable follow-up plan mode
      </button>
      <button
        type="button"
        onClick={() => workbench.projectChat.setSelectedModelOption('collaborationMode', 'default')}
      >
        disable follow-up plan mode
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
        open follow-up runtime a
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
        open follow-up runtime b
      </button>
      <button
        type="button"
        onClick={() =>
          void workbench.archiveRuntimeTask({
            deviceId: 'device-1',
            workspacePath: '/workspace/project-alpha',
            taskId: 'runtime-a',
          })
        }
      >
        archive follow-up runtime a
      </button>
      <button type="button" onClick={() => workbench.selectProject(null)}>
        return standalone follow-up
      </button>
      <button type="button" onClick={() => workbench.startNewChat()}>
        sidebar new follow-up chat
      </button>
      <button type="button" onClick={() => void paneSession.send()}>
        send follow-up
      </button>
      <button
        type="button"
        onClick={() => void paneSession.send(undefined, { guideWhenBusy: true })}
      >
        send follow-up as guidance
      </button>
      <button
        data-testid="follow-up-interrupt-and-send"
        type="button"
        onClick={() => void paneSession.send(undefined, { interruptWhenBusy: true })}
      >
        interrupt and send follow-up
      </button>
      <button
        type="button"
        onClick={() =>
          void paneSession.sendRequestUserInputResponse(
            {
              answers: {
                implement: { answers: ['是的，执行此计划'] },
              },
            },
            { appendUserMessage: true, forceDefaultCollaborationMode: true }
          )
        }
      >
        submit implementation confirmation
      </button>
      <button type="button" onClick={() => void workbench.refreshWorkLists()}>
        refresh work lists
      </button>
      <button
        type="button"
        onClick={() => {
          if (firstQueuedMessage) paneSession.editQueuedMessage(firstQueuedMessage.id)
        }}
      >
        edit first queued
      </button>
      <button
        type="button"
        onClick={() => {
          if (firstQueuedMessage) void paneSession.sendQueuedAsGuidance(firstQueuedMessage.id)
        }}
      >
        guide first queued
      </button>
      <button
        data-testid="queued-interrupt-and-send-first"
        type="button"
        onClick={() => {
          if (firstQueuedMessage) void paneSession.interruptAndSendQueued(firstQueuedMessage.id)
        }}
      >
        interrupt first queued
      </button>
    </div>
  )
}

export function RuntimeTaskSkillsProbe() {
  const workbench = useWorkbench()
  return (
    <div>
      <button
        type="button"
        onClick={() =>
          void workbench.openRuntimeTask({
            deviceId: 'runtime-device',
            workspacePath: '/workspace/runtime-device',
            taskId: 'runtime-skill-task',
          })
        }
      >
        open runtime skill task
      </button>
      <button type="button" onClick={() => void workbench.projectChat.listLocalSkills()}>
        list local skills
      </button>
      <button type="button" onClick={() => void workbench.projectChat.listLocalApps()}>
        list local apps
      </button>
    </div>
  )
}

export function StartSkillChatProbe() {
  const workbench = useWorkbench()
  const [result, setResult] = useState('not-started')

  return (
    <div>
      <span data-testid="available-skill-names">
        {workbench.projectChat.skills.map(skill => skill.name).join('|')}
      </span>
      <span data-testid="selected-skill-refs">
        {workbench.projectChat.selectedSkills
          .map(skill => `${skill.namespace}:${skill.name}:${String(skill.is_public)}`)
          .join('|')}
      </span>
      <span data-testid="skill-chat-key">{workbench.state.standaloneChatKey}</span>
      <span data-testid="skill-chat-start-result">{result}</span>
      <span data-testid="skill-chat-input">{workbench.projectChat.input}</span>
      <button
        type="button"
        onClick={() =>
          void Promise.resolve(workbench.startNewSkillChat(['sites:sites-building'])).then(
            started => setResult(started ? 'started' : 'missing')
          )
        }
      >
        start sites chat
      </button>
      <button
        type="button"
        onClick={() =>
          void Promise.resolve(
            workbench.startNewSkillChat(['sites:sites-building'], { allowLocalSkills: false })
          ).then(started => setResult(started ? 'started' : 'missing'))
        }
      >
        start backend sites chat
      </button>
    </div>
  )
}
