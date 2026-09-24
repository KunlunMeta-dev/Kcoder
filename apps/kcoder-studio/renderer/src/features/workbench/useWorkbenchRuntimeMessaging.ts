import { captureAccountContextRevision } from '@/kcoder/accountContextEvents'
import { workflowApi } from '@/features/workflows/workflowApi'
import { safeErrorDiagnostic } from '@/lib/error-diagnostics'
import { useCallback } from 'react'
import type { Dispatch } from 'react'
import { ApiError } from '@/api/http'
import { KCODER_STUDIO_CLIENT_ORIGIN } from '@/api/backend/backendServices'
import type { ExecutorClient } from '@/api/executorAccess'
import i18n from '@/i18n'
import { localModelIdFromModelName } from '@/features/model-settings/localModelSettings'
import { appendCodeCommentContexts } from '@/lib/code-comment-context'
import { getPreferredStandaloneDeviceId } from '@/lib/device-selection'
import {
  KCODER_STUDIO_MIN_EXECUTOR_VERSION,
  isDeviceBelowStudioVersion,
  isStudioCompatibleDevice,
} from '@/lib/device-capabilities'
import { supportsGitWorktreeExecution } from '@/lib/projectClassification'
import { localRuntimeAttachments, remoteAttachmentIds } from '@/lib/runtime-attachments'
import { normalizeRuntimeWorkspacePath, runtimeProjectUiId } from '@/lib/runtime-project'
import {
  findWorkbenchDevice,
  getActiveWorkbenchDeviceId,
  getWorkbenchDeviceDisplayName,
  getWorkbenchDeviceUnavailableDisplayName,
  isWorkbenchDeviceOnline,
} from '@/lib/workbench-device'
import type {
  Attachment,
  ChatSendPayload,
  ModelSelectionConfig,
  ModelOptions,
  ProjectWithTasks,
  RuntimeGuidanceRequest,
  RuntimeRollbackRequest,
  RuntimeTaskSummary,
  RuntimeDeviceWorkspace,
  RuntimeSendRequest,
  RuntimeTaskAddress,
  RuntimeTaskCreateRequest,
  RuntimeSubagentSteerRequest,
  RuntimeSubagentSteerResponse,
  RuntimeSubagentArtifactRequest,
  RuntimeSubagentArtifactResponse,
  SkillRef,
  TurnFileChangesSummary,
  UnifiedModel,
} from '@/types/api'
import type { WorkbenchMessage, WorkbenchState } from '@/types/workbench'
import { normalizeTurnFileChanges } from './turnFileChanges'
import type {
  CreateProjectRuntimeTaskOptions,
  CreateTemporaryRuntimeTaskOptions,
  RuntimePaneActionOptions,
  RuntimePaneGuidanceResult,
  SendCurrentInputOptions,
} from './workbenchContextTypes'
import { getRuntimeTaskChatScopeKey, normalizeGuidanceError } from './workbenchProviderHelpers'
import type { WorkbenchAction } from './workbenchReducer'
import { createRuntimeTaskActivity } from './runtimeWorkActivity'
import {
  EMPTY_MESSAGE_TASK_TITLE,
  STANDALONE_PROJECT_ID,
  buildRuntimeTaskTitle,
  createConversationWorkspace,
  createRuntimeTaskId,
  createRuntimeTaskIdFromSeed,
  findProjectDeviceWorkspace,
  getCommandStdoutObject,
  isRecord,
  isSameRuntimeTaskIdentity,
} from './workbenchRuntimeHelpers'
import type { WorkbenchRuntimeTasks } from './useWorkbenchRuntimeTasks'
import { findFileChangesBySubtaskId } from './runtimePaneMessages'
import type { RuntimeTaskLifecycleStore } from './runtimeTaskLifecycle'
import {
  inferRuntimeName,
  resolveAutomaticModel,
  selectedModelExecutionFields,
} from './runtimeModelSelection'
import type { WorkbenchServices } from './workbenchServices'

interface RuntimeMessagingAttachmentSelection {
  attachments: Attachment[]
  resetAttachments: (submittedIds?: readonly number[]) => void
}

interface RuntimeMessagingModelSelection {
  models: UnifiedModel[]
  selectedModel: UnifiedModel | null
  selectedModelOptions: ModelOptions
  getSelectedModel?: () => UnifiedModel | null
  isSelectedModelUnavailable?: () => boolean
  getModelSelectionMode?: () => import('@/types/model-selection').ModelSelectionMode | undefined
  getSelectedModelOptions?: () => ModelOptions
  setSelectionForScope?: (
    scopeKey: string,
    model: UnifiedModel | null,
    options?: ModelOptions
  ) => void
}

interface RuntimeMessagingSkillSelection {
  selectedSkills: SkillRef[]
}

interface UseWorkbenchRuntimeMessagingOptions {
  state: WorkbenchState
  dispatch: Dispatch<WorkbenchAction>
  executorClient: ExecutorClient
  services: WorkbenchServices
  runtimeTasks: WorkbenchRuntimeTasks
  lifecycleStore: RuntimeTaskLifecycleStore
  projectExecutionMode: string
  projectWorktreeBranch: string | null
  isOptionsLocked: boolean
  attachmentSelection: RuntimeMessagingAttachmentSelection
  modelSelection: RuntimeMessagingModelSelection
  skillSelection: RuntimeMessagingSkillSelection
  refreshWorkLists: () => Promise<void>
  rememberExecutionDevice: (deviceId: string) => void
}

function isConfiguredLocalModel(model: UnifiedModel | null): boolean {
  if (!model) return false
  return localModelIdFromModelName(model.name) !== null
}

function isLocalDeviceTarget(
  devices: WorkbenchState['devices'],
  deviceId?: string | null
): boolean {
  if (!deviceId) return false
  const device = findWorkbenchDevice(devices, deviceId)
  return device?.device_type === 'local'
}

export function runtimeThreadId(address?: RuntimeTaskAddress | null): string | null {
  if (typeof address?.threadId === 'string' && address.threadId.trim()) {
    return address.threadId
  }
  const handle = address?.runtimeHandle
  if (!isRecord(handle)) return null
  const threadId = handle.sessionId ?? handle.session_id ?? handle.threadId ?? handle.thread_id
  return typeof threadId === 'string' && threadId.trim() ? threadId : null
}

export function useWorkbenchRuntimeMessaging({
  state,
  dispatch,
  executorClient,
  services,
  runtimeTasks,
  lifecycleStore,
  projectExecutionMode,
  projectWorktreeBranch,
  isOptionsLocked,
  attachmentSelection,
  modelSelection,
  skillSelection,
  refreshWorkLists,
  rememberExecutionDevice,
}: UseWorkbenchRuntimeMessagingOptions) {
  const reportError = useCallback(
    (error: string, options?: RuntimePaneActionOptions) => {
      if (options?.onError) {
        options.onError(error)
        return
      }
      dispatch({ type: 'error_set', error })
    },
    [dispatch]
  )

  const reportSendBlocked = useCallback(
    (error: string, details?: Record<string, unknown>, options?: RuntimePaneActionOptions) => {
      console.warn('[KCoder Studio] send blocked:', safeErrorDiagnostic(error), details ?? {})
      reportError(error, options)
    },
    [reportError]
  )

  const sendRuntimePaneMessage = useCallback(
    async (request: RuntimeSendRequest, options?: RuntimePaneActionOptions): Promise<boolean> => {
      lifecycleStore.sendRequested(request.address)
      try {
        const response = await executorClient.runtime.sendRuntimeMessage(request)
        if (!response.accepted) {
          throw new Error(response.error || i18n.t('workbench.runtime_send_failed'))
        }
        lifecycleStore.sendAccepted(request.address)
        // Acceptance can arrive after completion; do not infer running state from this acknowledgement.
        dispatch({
          type: 'runtime_task_activity',
          activity: createRuntimeTaskActivity(request.address),
        })
        return true
      } catch (error) {
        lifecycleStore.sendRejected(request.address)
        console.warn('[KCoder Studio] Runtime send failed', {
          taskId: request.address.taskId,
          deviceId: request.address.deviceId,
          workspacePath: request.address.workspacePath ?? null,
          addressKeys: Object.keys(request.address as unknown as Record<string, unknown>).sort(),
          error: safeErrorDiagnostic(error),
        })
        reportError(
          error instanceof Error ? error.message : i18n.t('workbench.runtime_send_failed'),
          options
        )
        return false
      }
    },
    [dispatch, executorClient, lifecycleStore, reportError]
  )

  const interruptAndSendRuntimePaneMessage = useCallback(
    async (request: RuntimeSendRequest, options?: RuntimePaneActionOptions): Promise<boolean> => {
      lifecycleStore.sendRequested(request.address)
      try {
        const response = await executorClient.runtime.interruptAndSendRuntimeMessage(request)
        if (!response.accepted)
          throw new Error(response.error || i18n.t('workbench.runtime_interrupt_send_failed'))
        lifecycleStore.sendAccepted(request.address)
        void refreshWorkLists().catch(error => {
          console.warn('[KCoder Studio] Interrupt-and-send accepted but work list refresh failed', {
            taskId: response.taskId ?? request.address.taskId,
            error: safeErrorDiagnostic(error),
          })
        })
        return true
      } catch (error) {
        lifecycleStore.sendRejected(request.address)
        reportError(
          error instanceof Error
            ? error.message
            : i18n.t('workbench.runtime_interrupt_send_failed'),
          options
        )
        return false
      }
    },
    [executorClient, lifecycleStore, refreshWorkLists, reportError]
  )

  const editLastUserMessage = useCallback(
    async (request: RuntimeRollbackRequest): Promise<boolean> => {
      lifecycleStore.sendRequested(request.address)
      try {
        const response = await executorClient.runtime.rollbackRuntimeTask(request)
        if (!response.accepted) {
          throw new Error(response.error || i18n.t('workbench.runtime_edit_failed'))
        }
        lifecycleStore.sendAccepted(request.address)
        try {
          await refreshWorkLists()
        } catch (error) {
          console.warn('[KCoder Studio] Runtime rollback accepted but work list refresh failed', {
            taskId: response.taskId ?? request.address.taskId,
            error: safeErrorDiagnostic(error),
          })
        }
        return true
      } catch (error) {
        lifecycleStore.sendRejected(request.address)
        console.warn('[KCoder Studio] Runtime rollback for last user message failed', {
          taskId: request.address.taskId,
          deviceId: request.address.deviceId,
          workspacePath: request.address.workspacePath ?? null,
          addressKeys: Object.keys(request.address as unknown as Record<string, unknown>).sort(),
          error: safeErrorDiagnostic(error),
        })
        dispatch({
          type: 'error_set',
          error: error instanceof Error ? error.message : i18n.t('workbench.runtime_edit_failed'),
        })
        return false
      }
    },
    [dispatch, executorClient, lifecycleStore, refreshWorkLists]
  )

  const sendRuntimePaneGuidance = useCallback(
    async (request: RuntimeGuidanceRequest): Promise<RuntimePaneGuidanceResult> => {
      try {
        const response = await executorClient.runtime.guideRuntimeTask(request)
        if (response.accepted === false || response.success === false) {
          return {
            sent: false,
            code: response.code,
            error: response.error || i18n.t('workbench.runtime_guidance_failed'),
          }
        }
        void refreshWorkLists().catch(error => {
          console.warn('[KCoder Studio] Runtime guidance accepted but work list refresh failed', {
            taskId: response.taskId ?? response.task_id ?? request.address.taskId,
            error: safeErrorDiagnostic(error),
          })
        })
        return {
          sent: true,
          turnId: response.turnId ?? response.turn_id,
          code: response.code,
          error: response.error,
        }
      } catch (error) {
        console.warn('[KCoder Studio] Runtime guidance failed', {
          taskId: request.address.taskId,
          deviceId: request.address.deviceId,
          workspacePath: request.address.workspacePath ?? null,
          error: safeErrorDiagnostic(error),
        })
        reportError(
          normalizeGuidanceError(
            error instanceof Error ? error.message : i18n.t('workbench.runtime_guidance_failed')
          )
        )
        return {
          sent: false,
          error:
            error instanceof Error ? error.message : i18n.t('workbench.runtime_guidance_failed'),
        }
      }
    },
    [executorClient, refreshWorkLists, reportError]
  )

  const steerRuntimePaneSubagent = useCallback(
    async (request: RuntimeSubagentSteerRequest): Promise<RuntimeSubagentSteerResponse> => {
      return executorClient.runtime.steerRuntimeSubagent(request)
    },
    [executorClient]
  )

  const readRuntimePaneSubagentArtifact = useCallback(
    async (request: RuntimeSubagentArtifactRequest): Promise<RuntimeSubagentArtifactResponse> => {
      return executorClient.runtime.readSubagentArtifact(request)
    },
    [executorClient]
  )

  const compactRuntimePaneTask = useCallback(
    async (address: RuntimeTaskAddress, options?: RuntimePaneActionOptions): Promise<boolean> => {
      lifecycleStore.sendRequested(address)
      try {
        const response = await executorClient.runtime.compactRuntimeTask({ address })
        if (!response.accepted) {
          throw new Error(response.error || i18n.t('workbench.runtime_compaction_failed'))
        }
        lifecycleStore.sendAccepted(address)
        try {
          await refreshWorkLists()
        } catch (error) {
          console.warn('[KCoder Studio] Runtime compact accepted but work list refresh failed', {
            taskId: response.taskId ?? address.taskId,
            error: safeErrorDiagnostic(error),
          })
        }
        lifecycleStore.executorSettled(address)
        return true
      } catch (error) {
        lifecycleStore.sendRejected(address)
        console.warn('[KCoder Studio] Runtime compact failed', {
          taskId: address.taskId,
          deviceId: address.deviceId,
          workspacePath: address.workspacePath ?? null,
          error: safeErrorDiagnostic(error),
        })
        reportError(
          error instanceof Error ? error.message : i18n.t('workbench.runtime_compaction_failed'),
          options
        )
        return false
      }
    },
    [executorClient, lifecycleStore, refreshWorkLists, reportError]
  )

  const cancelRuntimePaneTask = useCallback(
    async (address: RuntimeTaskAddress, options?: RuntimePaneActionOptions): Promise<boolean> => {
      lifecycleStore.stopRequested(address)
      try {
        const ack = await executorClient.runtime.cancelRuntimeTask(address)
        if (!ack.accepted) {
          lifecycleStore.stopRejected(address)
          reportError(
            normalizeGuidanceError(ack.error ?? i18n.t('workbench.runtime_cancel_failed')),
            options
          )
          return false
        }
        await refreshWorkLists()
        return true
      } catch (error) {
        lifecycleStore.stopRejected(address)
        reportError(
          normalizeGuidanceError(
            error instanceof Error ? error.message : i18n.t('workbench.runtime_cancel_failed')
          ),
          options
        )
        return false
      }
    },
    [executorClient, lifecycleStore, refreshWorkLists, reportError]
  )

  const buildSendPayload = useCallback(
    (
      message: string,
      sourceAttachments?: Attachment[],
      projectOverride?: ProjectWithTasks | null
    ): { payload: ChatSendPayload; activeDeviceId?: string } | null => {
      if (modelSelection.isSelectedModelUnavailable?.()) {
        reportSendBlocked(i18n.t('workbench.model_disabled_unavailable'))
        return null
      }
      if (!state.defaultTeam) return null
      const activeProject = projectOverride === undefined ? state.currentProject : projectOverride
      const selectedProjectWorkspace = findProjectDeviceWorkspace(
        state.runtimeWork,
        activeProject?.id,
        state.selectedDeviceWorkspaceId
      )
      const activeDeviceId =
        activeProject && selectedProjectWorkspace
          ? selectedProjectWorkspace.deviceId
          : getActiveWorkbenchDeviceId({
              currentProject: activeProject,
              standaloneDeviceId: getPreferredStandaloneDeviceId(
                state.devices,
                state.standaloneDeviceId
              ),
            })

      const payload: ChatSendPayload = {
        team_id: state.defaultTeam.id,
        project_id: activeProject?.id ?? STANDALONE_PROJECT_ID,
        client_origin: KCODER_STUDIO_CLIENT_ORIGIN,
        device_id: activeDeviceId,
        task_type: 'code',
        message,
      }
      const selectedModel =
        modelSelection.getSelectedModel?.() ??
        modelSelection.selectedModel ??
        resolveAutomaticModel(modelSelection.models)
      const selectedModelOptions =
        modelSelection.getSelectedModelOptions?.() ?? modelSelection.selectedModelOptions

      if (
        activeProject &&
        projectExecutionMode === 'git_worktree' &&
        supportsGitWorktreeExecution(activeProject)
      ) {
        const branch = projectWorktreeBranch?.trim()
        payload.execution = {
          workspace: {
            source: 'git_worktree',
            ...(branch ? { branch } : {}),
          },
        }
      }

      const executionModel = selectedModelExecutionFields(
        selectedModel,
        selectedModelOptions,
        modelSelection.getModelSelectionMode?.()
      )
      debugRuntimeCreateFlow('model-options-resolved', {
        selectedModel: selectedModel?.name ?? null,
        selectedModelType: selectedModel?.type ?? null,
        selectedModelOptions: summarizeModelOptions(selectedModelOptions),
        executionModelOptions: summarizeModelOptions(executionModel.modelOptions),
      })
      if (executionModel.modelSelectionMode)
        payload.model_selection_mode = executionModel.modelSelectionMode
      if (selectedModel) {
        payload.force_override_bot_model = executionModel.modelId
        if (executionModel.modelType) {
          payload.force_override_bot_model_type = executionModel.modelType
        }
      }
      if (executionModel.modelOptions && Object.keys(executionModel.modelOptions).length > 0) {
        payload.model_options = executionModel.modelOptions
      }

      if (!isOptionsLocked && skillSelection.selectedSkills.length > 0) {
        payload.additional_skills = skillSelection.selectedSkills
      }

      const payloadAttachments = sourceAttachments ?? attachmentSelection.attachments
      if (payloadAttachments.length > 0) {
        const attachmentIds = remoteAttachmentIds(payloadAttachments)
        const localAttachments = localRuntimeAttachments(payloadAttachments)
        if (attachmentIds.length > 0) {
          payload.attachment_ids = attachmentIds
        }
        if (localAttachments.length > 0) {
          payload.attachments = localAttachments
        }
        if (!message) {
          payload.title = EMPTY_MESSAGE_TASK_TITLE
        }
      }

      return { payload, activeDeviceId }
    },
    [
      attachmentSelection.attachments,
      isOptionsLocked,
      modelSelection,
      projectExecutionMode,
      projectWorktreeBranch,
      skillSelection.selectedSkills,
      reportSendBlocked,
      state.currentProject,
      state.defaultTeam,
      state.devices,
      state.runtimeWork,
      state.selectedDeviceWorkspaceId,
      state.standaloneDeviceId,
    ]
  )

  const sendPreparedRuntimeMessage = useCallback(
    async (
      displayMessage: string,
      payload: ChatSendPayload,
      activeDeviceId?: string,
      options?: Pick<
        SendCurrentInputOptions,
        | 'clientMessageId'
        | 'initialGoal'
        | 'sessionMode'
        | 'workflowDefinitionId'
        | 'turnMode'
        | 'settingsTemplate'
        | 'onError'
        | 'onRuntimeTaskOptimisticOpen'
        | 'additionalContext'
      > & {
        collaborationMode?: 'default' | 'plan'
        deliveryId?: string
        cloudProjectId?: string
        ephemeral?: boolean
        openInMainPane?: boolean
        refreshWorkListsOnResolve?: boolean
        sideSource?: RuntimeTaskAddress | null
      }
    ): Promise<RuntimeTaskAddress | false> => {
      if (modelSelection.isSelectedModelUnavailable?.()) {
        reportSendBlocked(i18n.t('workbench.model_disabled_unavailable'))
        return false
      }
      const projectId = payload.project_id && payload.project_id > 0 ? payload.project_id : null
      const selectedModel =
        modelSelection.getSelectedModel?.() ??
        modelSelection.selectedModel ??
        resolveAutomaticModel(modelSelection.models)
      const selectedModelOptions =
        modelSelection.getSelectedModelOptions?.() ?? modelSelection.selectedModelOptions
      const runtime = inferRuntimeName(selectedModel)
      const taskSeed = createRuntimeTaskId(runtime)
      const taskId = createRuntimeTaskIdFromSeed(taskSeed)
      const selectedProjectWorkspace = findProjectDeviceWorkspace(
        state.runtimeWork,
        projectId,
        state.selectedDeviceWorkspaceId
      )
      const selectedRuntimeProject = projectId
        ? state.runtimeWork?.projects.find(item => runtimeProjectUiId(item.project) === projectId)
            ?.project
        : null
      const selectedRuntimeProjectWork = projectId
        ? state.runtimeWork?.projects.find(item => runtimeProjectUiId(item.project) === projectId)
        : null
      const configuredRuntimeRoots =
        selectedRuntimeProject?.roots?.map(root => root.path.trim()).filter(Boolean) ?? []
      const runtimeWorkspaceRoots =
        selectedRuntimeProject?.source === 'local_project'
          ? Array.from(
              new Set(
                (configuredRuntimeRoots.length > 0
                  ? configuredRuntimeRoots
                  : (selectedRuntimeProjectWork?.deviceWorkspaces.map(
                      workspace => workspace.workspacePath
                    ) ?? [])
                )
                  .map(normalizeRuntimeWorkspacePath)
                  .filter(Boolean)
              )
            )
          : []
      let runtimeTaskTarget: Pick<
        RuntimeTaskCreateRequest,
        'projectId' | 'deviceWorkspaceId' | 'deviceId' | 'workspacePath'
      >
      let optimisticDeviceId: string
      if (options?.sideSource?.deviceId && options.sideSource.workspacePath) {
        optimisticDeviceId = options.sideSource.deviceId
        runtimeTaskTarget = {
          deviceId: options.sideSource.deviceId,
          workspacePath: options.sideSource.workspacePath,
        }
      } else if (projectId) {
        if (!selectedProjectWorkspace) {
          reportSendBlocked(i18n.t('workbench.runtime_choose_location'), undefined, options)
          return false
        }
        optimisticDeviceId = selectedProjectWorkspace.deviceId
        runtimeTaskTarget =
          selectedProjectWorkspace.id != null &&
          selectedProjectWorkspace.workspaceSource !== 'local' &&
          !services.cloudBackgroundApi
            ? {
                projectId,
                deviceWorkspaceId: selectedProjectWorkspace.id,
                deviceId: selectedProjectWorkspace.deviceId,
                workspacePath: selectedProjectWorkspace.workspacePath,
              }
            : {
                deviceId: selectedProjectWorkspace.deviceId,
                workspacePath: selectedProjectWorkspace.workspacePath,
              }
      } else {
        let workspacePath = state.standaloneWorkspacePath
        if (!workspacePath && activeDeviceId) {
          try {
            workspacePath = await createConversationWorkspace(
              executorClient.commands,
              activeDeviceId,
              displayMessage,
              taskId
            )
          } catch (error) {
            reportSendBlocked(
              error instanceof Error
                ? error.message
                : i18n.t('workbench.runtime_workspace_create_failed'),
              undefined,
              options
            )
            return false
          }
        }
        if (!activeDeviceId || !workspacePath) {
          reportSendBlocked(i18n.t('workbench.runtime_choose_workspace'), undefined, options)
          return false
        }
        optimisticDeviceId = activeDeviceId
        runtimeTaskTarget = {
          deviceId: activeDeviceId,
          workspacePath,
        }
      }

      if (
        isConfiguredLocalModel(selectedModel) &&
        !isLocalDeviceTarget(state.devices, optimisticDeviceId)
      ) {
        reportSendBlocked(i18n.t('workbench.local_model_cloud_device_blocked'), undefined, options)
        return false
      }

      const createRequest: RuntimeTaskCreateRequest = {
        ...runtimeTaskTarget,
        taskId,
        teamId: payload.team_id,
        runtime,
        message: payload.message,
        ...(options?.clientMessageId ? { clientMessageId: options.clientMessageId } : {}),
        title: buildRuntimeTaskTitle(displayMessage, payload.title),
        modelId: payload.force_override_bot_model,
        modelSelectionMode: payload.model_selection_mode,
        modelType: payload.force_override_bot_model_type ?? null,
        modelOptions: {
          ...(payload.model_options ?? {}),
          ...(options && 'collaborationMode' in options && options.collaborationMode
            ? { collaborationMode: options.collaborationMode }
            : {}),
        },
        modelSelection:
          payload.model_selection_mode === 'follow_target_default'
            ? { modelName: '', modelType: null, options: selectedModelOptions }
            : selectedModel
              ? {
                  modelName: selectedModel.name,
                  modelType: selectedModel.type,
                  options: selectedModelOptions,
                }
              : null,
        additionalSkills: payload.additional_skills ?? [],
        attachmentIds: payload.attachment_ids ?? [],
        attachments: payload.attachments ?? [],
        execution: payload.execution,
        ...(selectedRuntimeProject?.source === 'local_project'
          ? {
              runtimeProjectKey: selectedRuntimeProject.key,
              runtimeProjectName: selectedRuntimeProject.name,
              runtimeWorkspaceRoots,
            }
          : {}),
        ...(options?.ephemeral ? { ephemeral: true } : {}),
        ...(options?.sideSource ? { sideSource: options.sideSource } : {}),
        ...(options?.initialGoal ? { initialGoal: options.initialGoal } : {}),
        ...(options?.workflowDefinitionId ? { workflowDefinitionId: options.workflowDefinitionId } : {}),
        ...(options?.sessionMode ? { sessionMode: options.sessionMode } : {}),
        ...(options?.settingsTemplate ? { settingsTemplate: options.settingsTemplate } : {}),
        ...(options?.turnMode ? { turnMode: options.turnMode } : {}),
        ...(options?.deliveryId ? { deliveryId: options.deliveryId } : {}),
        ...(options?.cloudProjectId ? { cloudProjectId: options.cloudProjectId } : {}),
        ...(options?.additionalContext ? { additionalContext: options.additionalContext } : {}),
      }
      debugRuntimeCreateFlow('create-request-built', {
        taskId,
        runtime,
        modelId: createRequest.modelId ?? null,
        modelType: createRequest.modelType ?? null,
        modelOptions: summarizeModelOptions(createRequest.modelOptions),
      })
      const createModelSelection = modelSelectionFromCreateRequest(createRequest)
      const createRuntimeHandle = createModelSelection
        ? { modelSelection: createModelSelection }
        : undefined
      const optimisticAddress: RuntimeTaskAddress = {
        deviceId: optimisticDeviceId,
        taskId,
        workspacePath:
          'workspacePath' in runtimeTaskTarget ? runtimeTaskTarget.workspacePath : undefined,
        ...(createRuntimeHandle ? { runtimeHandle: createRuntimeHandle } : {}),
      }
      modelSelection.setSelectionForScope?.(
        getRuntimeTaskChatScopeKey(optimisticAddress),
        payload.model_selection_mode === 'follow_target_default' ? null : selectedModel,
        selectedModelOptions
      )
      const optimisticWorkspacePath =
        ('workspacePath' in runtimeTaskTarget ? runtimeTaskTarget.workspacePath : undefined) ??
        selectedProjectWorkspace?.workspacePath
      const optimisticWorkspace =
        optimisticWorkspacePath && optimisticDeviceId
          ? buildOptimisticRuntimeWorkspace({
              baseWorkspace: selectedProjectWorkspace,
              devices: state.devices,
              deviceId: optimisticDeviceId,
              workspacePath: optimisticWorkspacePath,
              projectId,
            })
          : null
      const runtimeProject = projectId
        ? (state.projects.find(project => project.id === projectId) ?? state.currentProject)
        : null

      if (optimisticAddress.deviceId) rememberExecutionDevice(optimisticAddress.deviceId)
      debugRuntimeCreateFlow('create-optimistic-open', {
        taskId,
        runtime,
        projectId,
        optimisticAddress: runtimeAddressLog(optimisticAddress),
        hasSelectedProjectWorkspace: Boolean(selectedProjectWorkspace),
        optimisticWorkspacePath: optimisticWorkspacePath ?? null,
      })
      lifecycleStore.sendRequested(optimisticAddress)
      if (options?.initialGoal) {
        lifecycleStore.goalStatusReceived(optimisticAddress, options.initialGoal.status ?? 'active')
      }
      options?.onRuntimeTaskOptimisticOpen?.(optimisticAddress)
      if (options?.openInMainPane !== false) {
        runtimeTasks.openRuntimeTaskView(optimisticAddress, runtimeProject, { navigate: true })
      }
      if (optimisticWorkspace && optimisticWorkspacePath && !options?.ephemeral) {
        dispatch({
          type: 'runtime_task_optimistic_upserted',
          project: runtimeProject,
          workspace: optimisticWorkspace,
          task: buildOptimisticRuntimeTask({
            taskId: optimisticAddress.taskId,
            workspacePath: optimisticWorkspacePath,
            title: createRequest.title ?? buildRuntimeTaskTitle(displayMessage, payload.title),
            runtime,
            modelSelection: createModelSelection,
          }),
        })
      }
      try {
        if (createRequest.sessionMode === 'workflow_draft' && !createRequest.workflowDefinitionId) {
          const accountValid = captureAccountContextRevision()
          const definition = await workflowApi.create(optimisticDeviceId, displayMessage.trim().slice(0, 120), '')
          if (!accountValid(optimisticDeviceId)) throw new Error(i18n.t('workflowCanvas.scopeChanged'))
          createRequest.workflowDefinitionId = definition.id
        }
        const response = await executorClient.runtime.createRuntimeTask(createRequest)
        if (!response.accepted) {
          throw new Error(response.error || i18n.t('workbench.runtime_send_failed'))
        }
        attachmentSelection.resetAttachments(
          attachmentSelection.attachments.map(attachment => attachment.id)
        )
        const address: RuntimeTaskAddress = {
          deviceId: response.deviceId || optimisticAddress.deviceId,
          taskId: response.taskId || optimisticAddress.taskId,
          workspacePath: response.workspacePath || optimisticAddress.workspacePath,
          runtimeHandle: response.runtimeHandle ?? optimisticAddress.runtimeHandle,
          ...(response.taskId || optimisticAddress.taskId
            ? { taskId: response.taskId || optimisticAddress.taskId }
            : {}),
        }
        debugRuntimeCreateFlow('create-resolved', {
          taskId: address.taskId,
          runtime,
          projectId,
          accepted: response.accepted,
          optimisticAddress: runtimeAddressLog(optimisticAddress),
          resolvedAddress: runtimeAddressLog(address),
          sameIdentity: isSameRuntimeTaskIdentity(optimisticAddress, address),
          responseHasWorkspacePath: Boolean(response.workspacePath),
          responseHasTaskId: Boolean(response.taskId),
        })
        const resolvedWorkspacePath = address.workspacePath ?? optimisticWorkspacePath
        const resolvedSameIdentity = isSameRuntimeTaskIdentity(optimisticAddress, address)
        const optimisticTaskStillSelected = runtimeTasks.isCurrentRuntimeTask(optimisticAddress)
        if (!resolvedSameIdentity) {
          dispatch({ type: 'runtime_task_optimistic_removed', address: optimisticAddress })
        }
        if (resolvedWorkspacePath && !options?.ephemeral) {
          dispatch({
            type: 'runtime_task_optimistic_upserted',
            project: runtimeProject,
            workspace: buildOptimisticRuntimeWorkspace({
              baseWorkspace: optimisticWorkspace,
              devices: state.devices,
              deviceId: address.deviceId,
              workspacePath: resolvedWorkspacePath,
              projectId,
            }),
            task: buildOptimisticRuntimeTask({
              taskId: address.taskId,
              workspacePath: resolvedWorkspacePath,
              title: createRequest.title ?? buildRuntimeTaskTitle(displayMessage, payload.title),
              runtime,
              modelSelection: createModelSelection,
            }),
          })
        }
        if (!resolvedSameIdentity) {
          lifecycleStore.rename(optimisticAddress, address)
          modelSelection.setSelectionForScope?.(
            getRuntimeTaskChatScopeKey(address),
            payload.model_selection_mode === 'follow_target_default' ? null : selectedModel,
            selectedModelOptions
          )
          if (address.deviceId) rememberExecutionDevice(address.deviceId)
          debugRuntimeCreateFlow('create-final-open', {
            taskId: address.taskId,
            runtime,
            previousAddress: runtimeAddressLog(optimisticAddress),
            finalAddress: runtimeAddressLog(address),
          })
          options?.onRuntimeTaskOptimisticOpen?.(address, {
            previousAddress: optimisticAddress,
          })
          if (options?.openInMainPane !== false && optimisticTaskStillSelected) {
            runtimeTasks.openRuntimeTaskView(address, runtimeProject, { navigate: true })
          }
        }
        lifecycleStore.sendAccepted(address)
        if (options?.refreshWorkListsOnResolve !== false) {
          await refreshWorkLists()
        }
        if (options?.openInMainPane !== false && runtimeTasks.isCurrentRuntimeTask(address)) {
          dispatch({ type: 'blank_chat_committed' })
        }
        return address
      } catch (error) {
        const message =
          error instanceof Error ? error.message : i18n.t('workbench.runtime_send_failed')
        lifecycleStore.sendRejected(optimisticAddress)
        if (optimisticWorkspace && optimisticWorkspacePath && !options?.ephemeral) {
          dispatch({
            type: 'runtime_task_optimistic_upserted',
            project: runtimeProject,
            workspace: optimisticWorkspace,
            task: buildOptimisticRuntimeTask({
              taskId: optimisticAddress.taskId,
              workspacePath: optimisticWorkspacePath,
              title: createRequest.title ?? buildRuntimeTaskTitle(displayMessage, payload.title),
              runtime,
              status: 'failed',
              error: message,
            }),
          })
        } else {
          dispatch({ type: 'runtime_task_optimistic_removed', address: optimisticAddress })
        }
        // Failed creation has no backend thread. Keep the failure record, but do not
        // route the next input through this optimistic address as a follow-up turn.
        if (runtimeTasks.isCurrentRuntimeTask(optimisticAddress)) {
          runtimeTasks.clearCurrentRuntimeTaskView()
        }
        reportError(message, options)
        return false
      }
    },
    [
      attachmentSelection,
      dispatch,
      executorClient,
      lifecycleStore,
      modelSelection,
      refreshWorkLists,
      rememberExecutionDevice,
      reportError,
      reportSendBlocked,
      runtimeTasks,
      services.cloudBackgroundApi,
      state.currentProject,
      state.devices,
      state.projects,
      state.runtimeWork,
      state.selectedDeviceWorkspaceId,
      state.standaloneWorkspacePath,
    ]
  )

  const sendCurrentInput = useCallback(
    async (inputOverride?: string, options?: SendCurrentInputOptions) => {
      if (modelSelection.isSelectedModelUnavailable?.()) {
        reportSendBlocked(i18n.t('workbench.model_disabled_unavailable'))
        return false
      }
      const rawInput = inputOverride ?? ''
      const trimmedMessage = rawInput.trim()
      const effectiveCodeCommentContexts = options?.codeCommentContexts ?? []
      const hasAttachments = attachmentSelection.attachments.length > 0
      const hasCodeComments = effectiveCodeCommentContexts.length > 0
      if (!trimmedMessage && !hasAttachments && !hasCodeComments) {
        reportSendBlocked(
          i18n.t('workbench.runtime_content_or_attachment_required'),
          undefined,
          options
        )
        return false
      }
      const message =
        trimmedMessage || (hasCodeComments ? i18n.t('workbench.code_comment_fallback') : '')
      const payloadMessage = appendCodeCommentContexts(message, effectiveCodeCommentContexts)
      const runtimeSelectedModel =
        modelSelection.getSelectedModel?.() ??
        modelSelection.selectedModel ??
        resolveAutomaticModel(modelSelection.models)
      const runtimeSelectedModelOptions =
        modelSelection.getSelectedModelOptions?.() ?? modelSelection.selectedModelOptions
      const runtimeModelFields = selectedModelExecutionFields(
        runtimeSelectedModel,
        runtimeSelectedModelOptions,
        modelSelection.getModelSelectionMode?.()
      )

      if (state.currentRuntimeTask) {
        if (hasCodeComments) {
          reportSendBlocked(
            i18n.t('workbench.runtime_code_comments_unsupported'),
            undefined,
            options
          )
          return false
        }
        if (lifecycleStore.getTask(state.currentRuntimeTask)?.derived.isRunning) {
          reportSendBlocked(i18n.t('workbench.runtime_task_running_message'), undefined, options)
          return false
        }
        if (
          isConfiguredLocalModel(runtimeSelectedModel) &&
          !isLocalDeviceTarget(state.devices, state.currentRuntimeTask.deviceId)
        ) {
          reportSendBlocked(
            i18n.t('workbench.local_model_cloud_device_blocked'),
            undefined,
            options
          )
          return false
        }
        const currentAttachments = attachmentSelection.attachments
        const attachmentIds = remoteAttachmentIds(currentAttachments)
        const attachments = localRuntimeAttachments(currentAttachments)
        const sent = await sendRuntimePaneMessage(
          {
            address: state.currentRuntimeTask,
            message: payloadMessage,
            ...(options?.clientMessageId ? { clientMessageId: options.clientMessageId } : {}),
            ...runtimeModelFields,
            ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
            ...(attachments.length > 0 ? { attachments } : {}),
            ...(options?.additionalContext ? { additionalContext: options.additionalContext } : {}),
          },
          options
        )
        if (sent) {
          attachmentSelection.resetAttachments(currentAttachments.map(attachment => attachment.id))
        }
        return sent
      }

      const prepared = buildSendPayload(payloadMessage)
      if (!prepared) {
        reportSendBlocked(
          i18n.t('workbench.runtime_default_team_missing'),
          {
            hasDefaultTeam: Boolean(state.defaultTeam),
          },
          options
        )
        return false
      }
      if (prepared.activeDeviceId) {
        const activeDevice = findWorkbenchDevice(state.devices, prepared.activeDeviceId)
        if (!isWorkbenchDeviceOnline(activeDevice)) {
          const deviceName =
            getWorkbenchDeviceUnavailableDisplayName(activeDevice) ||
            i18n.t('workbench.current_device')
          const status = activeDevice
            ? i18n.t(
                ['online', 'busy', 'offline'].includes(activeDevice.status)
                  ? `workbench.project_device_status_${activeDevice.status}`
                  : 'workbench.project_device_status_unavailable'
              )
            : i18n.t('workbench.project_device_status_unavailable')
          reportSendBlocked(
            i18n.t('workbench.runtime_device_resume_online', { device: deviceName, status }),
            {
              activeDeviceId: prepared.activeDeviceId,
              deviceStatus: activeDevice?.status ?? null,
            },
            options
          )
          return false
        }
        if (activeDevice && isDeviceBelowStudioVersion(activeDevice)) {
          const deviceName = getWorkbenchDeviceDisplayName(activeDevice, prepared.activeDeviceId)
          reportSendBlocked(
            i18n.t('workbench.runtime_device_upgrade', {
              device: deviceName,
              version: KCODER_STUDIO_MIN_EXECUTOR_VERSION,
            }),
            {
              activeDeviceId: prepared.activeDeviceId,
              executorVersion: activeDevice.executor_version ?? null,
            },
            options
          )
          return false
        }
      } else if (!state.currentProject) {
        const hasOnlineCompatibleDevice = state.devices.some(
          device => device.status === 'online' && isStudioCompatibleDevice(device)
        )
        if (!hasOnlineCompatibleDevice) {
          reportSendBlocked(
            i18n.t('workbench.runtime_compatible_device_required', {
              version: KCODER_STUDIO_MIN_EXECUTOR_VERSION,
            }),
            {
              deviceCount: state.devices.length,
            },
            options
          )
          return false
        }
      }

      const sent = await sendPreparedRuntimeMessage(
        message,
        prepared.payload,
        prepared.activeDeviceId,
        {
          initialGoal: options?.initialGoal,
          sessionMode: options?.sessionMode,
          workflowDefinitionId: options?.workflowDefinitionId,
          turnMode: options?.turnMode,
          onError: options?.onError,
          onRuntimeTaskOptimisticOpen: options?.onRuntimeTaskOptimisticOpen,
          clientMessageId: options?.clientMessageId,
          additionalContext: options?.additionalContext,
        }
      )
      if (sent) {
        attachmentSelection.resetAttachments(
          attachmentSelection.attachments.map(attachment => attachment.id)
        )
      }
      return sent
    },
    [
      attachmentSelection,
      buildSendPayload,
      lifecycleStore,
      modelSelection,
      reportSendBlocked,
      sendPreparedRuntimeMessage,
      sendRuntimePaneMessage,
      state.currentProject,
      state.currentRuntimeTask,
      state.defaultTeam,
      state.devices,
    ]
  )

  const retryFailedMessage = useCallback(
    async (
      messageId: string,
      messagesOverride?: WorkbenchMessage[],
      retryUserMessageOverride?: WorkbenchMessage,
      retryModelConfiguration: 'snapshot' | 'current' = 'snapshot',
      options?: RuntimePaneActionOptions
    ): Promise<boolean> => {
      if (modelSelection.isSelectedModelUnavailable?.()) {
        reportSendBlocked(i18n.t('workbench.model_disabled_unavailable'), undefined, options)
        return false
      }
      const messageSource = messagesOverride ?? []
      const failedMessageIndex = messageSource.findIndex(
        message =>
          message.id === messageId && message.role === 'assistant' && message.status === 'failed'
      )
      if (failedMessageIndex === -1) {
        dispatch({ type: 'error_set', error: i18n.t('workbench.runtime_retry_failure_missing') })
        return false
      }

      const failedMessage = messageSource[failedMessageIndex]
      const failedAttempt =
        failedMessage.attemptId ?? failedMessage.subtaskId ?? failedMessage.turnId
      const failedTurn = failedMessage.turnId ?? failedAttempt
      const retryFromTurnId = failedTurn?.match(/^(turn-\d+)(?:-retry-[0-9a-f-]+)?$/)?.[1]
      if (retryModelConfiguration === 'current' && (!retryFromTurnId || !/^turn-\d+(?:-retry-[0-9a-f-]+)?$/.test(failedAttempt ?? ''))) {
        reportSendBlocked(i18n.t('workbench.failed_turn_current_identity_required'), undefined, options)
        return false
      }


      const previousUserMessage =
        retryUserMessageOverride?.role === 'user'
          ? retryUserMessageOverride
          : [...messageSource]
              .slice(0, failedMessageIndex)
              .reverse()
              .find(message => message.role === 'user')
      if (!previousUserMessage && !retryFromTurnId) {
        dispatch({ type: 'error_set', error: i18n.t('workbench.runtime_retry_user_missing') })
        return false
      }

      if (state.currentRuntimeTask) {
        const runtimeSelectedModel =
          modelSelection.getSelectedModel?.() ??
          modelSelection.selectedModel ??
          resolveAutomaticModel(modelSelection.models)
        const runtimeSelectedModelOptions =
          modelSelection.getSelectedModelOptions?.() ?? modelSelection.selectedModelOptions
        if (
          isConfiguredLocalModel(runtimeSelectedModel) &&
          !isLocalDeviceTarget(state.devices, state.currentRuntimeTask.deviceId)
        ) {
          reportSendBlocked(i18n.t('workbench.local_model_cloud_device_blocked'), undefined, options)
          return false
        }
        const previousAttachments = retryFromTurnId ? [] : (previousUserMessage?.attachments ?? [])
        const attachmentIds = remoteAttachmentIds(previousAttachments)
        const attachments = localRuntimeAttachments(previousAttachments)
        return sendRuntimePaneMessage({
          address: state.currentRuntimeTask,
          message: retryFromTurnId ? '' : previousUserMessage!.content,
          ...(retryFromTurnId
            ? { retryFromTurnId, retryFromAttemptId: failedAttempt, ...(retryModelConfiguration === 'current' ? { retryModelConfiguration } : {}) }
            : {
                clientMessageId: previousUserMessage!.id,
                // The message identity was already committed by the failed
                // attempt: declare this as a new attempt so the server does not
                // refuse it as a duplicate submission.
                resubmit: true,
              }),
          ...(!retryFromTurnId || retryModelConfiguration === 'current'
            ? selectedModelExecutionFields(runtimeSelectedModel, runtimeSelectedModelOptions)
            : {}),
          ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
          ...(attachments.length > 0 ? { attachments } : {}),
        }, options)
      }

      reportSendBlocked(i18n.t('workbench.runtime_retry_task_missing'))
      return false
    },
    [
      dispatch,
      modelSelection,
      reportSendBlocked,
      sendRuntimePaneMessage,
      state.currentRuntimeTask,
      state.devices,
    ]
  )

  const createTemporaryRuntimeTask = useCallback(
    async (
      input: string,
      options?: CreateTemporaryRuntimeTaskOptions
    ): Promise<RuntimeTaskAddress | false> => {
      if (modelSelection.isSelectedModelUnavailable?.()) {
        reportSendBlocked(i18n.t('workbench.model_disabled_unavailable'))
        return false
      }
      const message = input.trim()
      if (!message) {
        reportSendBlocked(i18n.t('workbench.runtime_content_required'), undefined, options)
        return false
      }
      if (!options?.source || !runtimeThreadId(options.source)) {
        reportSendBlocked(
          i18n.t('workbench.runtime_temporary_requires_conversation'),
          undefined,
          options
        )
        return false
      }

      const prepared = buildSendPayload(message, options?.attachments, options?.project)
      if (!prepared) {
        reportSendBlocked(
          i18n.t('workbench.runtime_default_team_missing'),
          { hasDefaultTeam: Boolean(state.defaultTeam) },
          options
        )
        return false
      }

      const selectedModel =
        modelSelection.getSelectedModel?.() ??
        modelSelection.selectedModel ??
        resolveAutomaticModel(modelSelection.models)
      if (
        prepared.activeDeviceId &&
        isConfiguredLocalModel(selectedModel) &&
        !isLocalDeviceTarget(state.devices, prepared.activeDeviceId)
      ) {
        reportSendBlocked(i18n.t('workbench.local_model_cloud_device_blocked'), undefined, options)
        return false
      }

      return sendPreparedRuntimeMessage(message, prepared.payload, prepared.activeDeviceId, {
        onError: options?.onError,
        onRuntimeTaskOptimisticOpen: options?.onRuntimeTaskOptimisticOpen,
        ephemeral: true,
        sideSource: options?.source,
        openInMainPane: false,
        refreshWorkListsOnResolve: false,
      })
    },
    [
      buildSendPayload,
      modelSelection,
      reportSendBlocked,
      sendPreparedRuntimeMessage,
      state.defaultTeam,
      state.devices,
    ]
  )

  const createProjectRuntimeTask = useCallback(
    async (
      input: string,
      options: CreateProjectRuntimeTaskOptions
    ): Promise<RuntimeTaskAddress | false> => {
      const message = input.trim()
      if (!message) {
        reportSendBlocked(i18n.t('workbench.runtime_content_required'), undefined, options)
        return false
      }

      const prepared = buildSendPayload(message, options.attachments, options.project)
      if (!prepared) {
        reportSendBlocked(
          i18n.t('workbench.runtime_default_team_missing'),
          { hasDefaultTeam: Boolean(state.defaultTeam) },
          options
        )
        return false
      }
      if (prepared.activeDeviceId) {
        const activeDevice = findWorkbenchDevice(state.devices, prepared.activeDeviceId)
        if (!isWorkbenchDeviceOnline(activeDevice)) {
          const deviceName =
            getWorkbenchDeviceUnavailableDisplayName(activeDevice) ||
            i18n.t('workbench.current_device')
          reportSendBlocked(
            i18n.t('workbench.runtime_device_unavailable', { device: deviceName }),
            undefined,
            options
          )
          return false
        }
        if (activeDevice && isDeviceBelowStudioVersion(activeDevice)) {
          reportSendBlocked(
            i18n.t('workbench.runtime_device_upgrade', {
              device: getWorkbenchDeviceDisplayName(activeDevice, prepared.activeDeviceId),
              version: KCODER_STUDIO_MIN_EXECUTOR_VERSION,
            }),
            undefined,
            options
          )
          return false
        }
      }

      return sendPreparedRuntimeMessage(message, prepared.payload, prepared.activeDeviceId, {
        initialGoal: options.initialGoal,
        collaborationMode: options.collaborationMode,
        deliveryId: options.deliveryId,
        cloudProjectId: options.cloudProjectId,
        onError: options.onError,
        openInMainPane: false,
      })
    },
    [
      buildSendPayload,
      reportSendBlocked,
      sendPreparedRuntimeMessage,
      state.defaultTeam,
      state.devices,
    ]
  )

  const loadTurnFileChangesDiff = useCallback(
    async (
      subtaskId: string,
      messagesOverride?: WorkbenchMessage[],
      fileChangesOverride?: TurnFileChangesSummary,
      runtimeTaskOverride?: RuntimeTaskAddress | null
    ) => {
      const messageSource = messagesOverride ?? []
      const runtimeTask = runtimeTaskOverride ?? state.currentRuntimeTask
      const runtimeFileChanges = runtimeTask
        ? (fileChangesOverride ?? findFileChangesBySubtaskId(messageSource, subtaskId))
        : undefined
      if (runtimeFileChanges?.diff) return { diff: runtimeFileChanges.diff, truncated: false }
      if (runtimeFileChanges) {
        const response = await executorClient.commands.executeCommand(
          runtimeFileChanges.device_id,
          {
            command_key: 'turn_file_changes_review',
            taskId: runtimeTask!.taskId,
            threadId: runtimeTask!.threadId,
            path: runtimeFileChanges.workspace_path,
            args: [runtimeFileChanges.artifact_id],
            timeout_seconds: 30,
            max_output_bytes: 5 * 1024 * 1024,
          }
        )
        const stdout = getCommandStdoutObject(response.stdout)
        if (
          !response.success ||
          !stdout ||
          stdout.success !== true ||
          typeof stdout.diff !== 'string'
        ) {
          throw new Error(
            String(
              stdout?.error || response.error || response.stderr || 'File changes review failed'
            )
          )
        }
        return { diff: stdout.diff, truncated: stdout.diffTruncated === true }
      }
      if (runtimeTask) {
        throw new Error('Runtime file changes artifact is unavailable')
      }

      const loadDiff = services.taskApi.getTurnFileChangesDiff
      if (!loadDiff) throw new Error('File changes review is unavailable')
      const response = await loadDiff(subtaskId)
      return { diff: response.diff, truncated: false }
    },
    [executorClient, services.taskApi, state.currentRuntimeTask]
  )

  const revertTurnFileChanges = useCallback(
    async (
      subtaskId: string,
      messagesOverride?: WorkbenchMessage[],
      fileChangesOverride?: TurnFileChangesSummary,
      runtimeTaskOverride?: RuntimeTaskAddress | null
    ): Promise<TurnFileChangesSummary> => {
      const messageSource = messagesOverride ?? []
      const runtimeTask = runtimeTaskOverride ?? state.currentRuntimeTask
      const runtimeFileChanges = runtimeTask
        ? (fileChangesOverride ?? findFileChangesBySubtaskId(messageSource, subtaskId))
        : undefined
      if (runtimeFileChanges && runtimeTask) {
        try {
          const response = await executorClient.runtime.revertRuntimeFileChanges({
            address: runtimeTask,
            fileChanges: runtimeFileChanges,
          })
          const fileChanges = normalizeTurnFileChanges(
            response.fileChanges ?? response.file_changes
          )
          if (!fileChanges) {
            throw new Error('Invalid file changes response')
          }
          return {
            ...fileChanges,
            diff: runtimeFileChanges.diff,
            revertible: runtimeFileChanges.revertible ?? true,
          }
        } catch (error) {
          if (error instanceof ApiError && isRecord(error.detail)) {
            const fileChanges = normalizeTurnFileChanges(error.detail.file_changes)
            if (fileChanges) {
              return {
                ...fileChanges,
                diff: runtimeFileChanges.diff,
                revertible: runtimeFileChanges.revertible ?? true,
              }
            }
          }
          throw error
        }
      }
      if (runtimeTask) {
        throw new Error('Runtime file changes artifact is unavailable')
      }
      const revert = services.taskApi.revertTurnFileChanges
      if (!revert) throw new Error('File changes revert is unavailable')
      try {
        const response = await revert(subtaskId)
        const fileChanges = normalizeTurnFileChanges(response.file_changes)
        if (!fileChanges) {
          throw new Error('Invalid file changes response')
        }
        return fileChanges
      } catch (error) {
        if (error instanceof ApiError && isRecord(error.detail)) {
          const fileChanges = normalizeTurnFileChanges(error.detail.file_changes)
          if (fileChanges) {
            return fileChanges
          }
        }
        throw error
      }
    },
    [executorClient, services.taskApi, state.currentRuntimeTask]
  )

  const pauseCurrentResponse = useCallback(async () => {
    if (!state.currentRuntimeTask) return

    const ack = await executorClient.runtime.cancelRuntimeTask(state.currentRuntimeTask)
    if (!ack.accepted) {
      dispatch({
        type: 'error_set',
        error: normalizeGuidanceError(ack.error ?? i18n.t('workbench.runtime_cancel_failed')),
      })
      return
    }
    await refreshWorkLists()
  }, [dispatch, executorClient, refreshWorkLists, state.currentRuntimeTask])

  const shortenCurrentWait = useCallback(async () => {
    if (!state.currentRuntimeTask) return

    const ack = await executorClient.runtime.shortenWaitRuntimeTask(state.currentRuntimeTask)
    if (!ack.accepted) {
      dispatch({
        type: 'error_set',
        error: normalizeGuidanceError(ack.error ?? i18n.t('workbench.runtime_shorten_wait_failed')),
      })
    }
  }, [dispatch, executorClient, state.currentRuntimeTask])

  return {
    sendRuntimePaneMessage,
    interruptAndSendRuntimePaneMessage,
    sendRuntimePaneGuidance,
    steerRuntimePaneSubagent,
    readRuntimePaneSubagentArtifact,
    compactRuntimePaneTask,
    editLastUserMessage,
    cancelRuntimePaneTask,
    sendCurrentInput,
    createTemporaryRuntimeTask,
    createProjectRuntimeTask,
    retryFailedMessage,
    pauseCurrentResponse,
    shortenCurrentWait,
    loadTurnFileChangesDiff,
    revertTurnFileChanges,
  }
}

function buildOptimisticRuntimeWorkspace({
  baseWorkspace,
  devices,
  deviceId,
  workspacePath,
  projectId,
}: {
  baseWorkspace?: RuntimeDeviceWorkspace | null
  devices: WorkbenchState['devices']
  deviceId: string
  workspacePath: string
  projectId: number | null
}): RuntimeDeviceWorkspace {
  const device = findWorkbenchDevice(devices, deviceId)
  return {
    ...baseWorkspace,
    projectId: projectId ?? baseWorkspace?.projectId,
    deviceId,
    deviceName: device?.name ?? baseWorkspace?.deviceName ?? deviceId,
    deviceStatus: device?.status ?? baseWorkspace?.deviceStatus ?? null,
    workspacePath,
    workspaceKind: baseWorkspace?.workspaceKind ?? (projectId ? 'workspace' : 'chat'),
    mapped: baseWorkspace?.mapped ?? Boolean(projectId),
    available: baseWorkspace?.available ?? (device ? device.status !== 'offline' : true),
    tasks: [],
  }
}

function buildOptimisticRuntimeTask({
  taskId,
  workspacePath,
  title,
  runtime,
  status = 'creating',
  error,
  modelSelection,
}: {
  taskId: string
  workspacePath: string
  title: string
  runtime: RuntimeTaskSummary['runtime']
  status?: 'creating' | 'failed'
  error?: string | null
  modelSelection?: ModelSelectionConfig | null
}): RuntimeTaskSummary {
  const now = new Date().toISOString()
  return {
    taskId,
    ...(taskId ? { taskId } : {}),
    workspacePath,
    title,
    runtime,
    createdAt: now,
    updatedAt: now,
    running: status === 'creating',
    status,
    optimistic: true,
    ...(error ? { error } : {}),
    ...(modelSelection ? { modelSelection } : {}),
  }
}

export function modelSelectionFromCreateRequest(
  request: RuntimeTaskCreateRequest
): ModelSelectionConfig | null {
  if (request.modelSelectionMode === 'follow_target_default') {
    return {
      modelName: '',
      modelType: null,
      options: request.modelSelection?.options ?? request.modelOptions ?? {},
    }
  }
  if (request.modelSelection?.modelName) {
    return request.modelSelection
  }

  if (!request.modelId) {
    return null
  }

  return {
    modelName: request.modelId,
    modelType: request.modelType ?? null,
    options: request.modelOptions ?? {},
  }
}

function runtimeAddressLog(address: RuntimeTaskAddress): Record<string, unknown> {
  return {
    deviceId: address.deviceId,
    taskId: address.taskId,
    workspacePath: address.workspacePath ?? null,
    hasRuntimeHandle: Boolean(address.runtimeHandle),
    runtimeHandleKeys: address.runtimeHandle ? Object.keys(address.runtimeHandle).sort() : [],
  }
}

function debugRuntimeCreateFlow(event: string, details: Record<string, unknown>) {
  if (!isRuntimeDebugEnabled()) return
  console.debug('[KCoder Studio] Runtime create flow', {
    event,
    ...details,
  })
}

function summarizeModelOptions(modelOptions: ModelOptions | undefined): Record<string, unknown> {
  if (!modelOptions) return {}
  return {
    keys: Object.keys(modelOptions),
    collaborationMode: modelOptions.collaborationMode ?? modelOptions.collaboration_mode ?? null,
    reasoning: modelOptions.reasoning ?? null,
    summary: modelOptions.summary ?? null,
    speed: modelOptions.speed ?? modelOptions.service_tier ?? null,
  }
}

function isRuntimeDebugEnabled(): boolean {
  return globalThis.localStorage?.getItem('wework:debug-runtime') === '1'
}
