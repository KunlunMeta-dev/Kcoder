import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { useWorkbench, useWorkbenchPaneContext } from '@/features/workbench/useWorkbench'
import { runtimeThreadId } from '@/features/workbench/useWorkbenchRuntimeMessaging'
import { selectedModelExecutionFields } from '@/features/workbench/runtimeModelSelection'
import { studioWorkMode } from '@/features/workbench/studioWorkMode'
import {
  captureAccountContextRevision,
  listenAccountContextChanges,
} from '@/kcoder/accountContextEvents'
import { invokeRuntimeCommand } from '@/kcoder/gatewayServiceBridge'
import type { RuntimeTaskAddress } from '@/types/api'
import type { TaskDeliveryRecipient } from '../../../../shared/generated/contracts'
import type { ComparisonTask, CreateComparisonTaskInput } from './controller'
import { knownTaskRecipient } from './taskRecipient'
import type { TaskReviewOperationsContext } from './TaskReviewOperations'

export function useTaskReviewContext(
  address: RuntimeTaskAddress | null,
  settingsTemplate?: string
): TaskReviewOperationsContext | undefined {
  const { t } = useTranslation('taskComparison')
  const {
    services,
    state: workbenchState,
    openRuntimeTask,
    refreshWorkLists,
    appendRuntimeTaskDraft,
  } = useWorkbench()
  const { state, projectChat } = useWorkbenchPaneContext()
  const [accountRevision, setAccountRevision] = useState(0)
  useEffect(
    () =>
      listenAccountContextChanges(target => {
        if (target === address?.deviceId) setAccountRevision(value => value + 1)
      }),
    [address?.deviceId]
  )
  const target = useMemo(
    () => (address ? knownTaskRecipient(state.runtimeWork, address) : null),
    [address, state.runtimeWork]
  )
  const threadId = runtimeThreadId(target)
  const scope = JSON.stringify([
    state.user?.id,
    address?.deviceId,
    address?.taskId,
    threadId,
    target?.workspacePath,
    accountRevision,
  ])
  const latest = useRef(scope)
  useLayoutEffect(() => {
    latest.current = scope
    return () => {
      if (latest.current === scope) latest.current = ''
    }
  }, [scope])
  const availableTasks = useMemo(() => {
    const workspaces = [
      ...(state.runtimeWork?.chats ?? []),
      ...(state.runtimeWork?.projects.flatMap(project => project.deviceWorkspaces) ?? []),
    ]
    const tasks: ComparisonTask[] = []
    for (const workspace of workspaces)
      for (const task of workspace.tasks) {
        const thread = runtimeThreadId({ ...task, deviceId: workspace.deviceId })
        if (task.runtime === 'kcoder' && thread && task.workspacePath)
          tasks.push({
            deviceId: workspace.deviceId,
            taskId: task.taskId,
            threadId: thread,
            workspacePath: task.workspacePath,
            title: task.title,
          })
      }
    return tasks
  }, [state.runtimeWork])
  const selectedModel = projectChat.selectedModel
  const modelOptions = projectChat.selectedModelOptions
  const mode = projectChat.getModelSelectionMode?.()
  const isUnavailable = projectChat.isSelectedModelUnavailable?.() === true
  const creationWorkMode = studioWorkMode(
    address?.runtimeHandle?.studioWorkMode ?? target?.runtimeHandle?.studioWorkMode
  )
  const createTask = useCallback(
    async (input: CreateComparisonTaskInput): Promise<ComparisonTask> => {
      const validAccount = captureAccountContextRevision()
      const team = workbenchState.defaultTeam
      if (
        !team ||
        !services.runtimeWorkApi ||
        !selectedModel ||
        isUnavailable ||
        latest.current !== scope ||
        !validAccount(input.deviceId)
      )
        throw new Error(t('errors.creation_unavailable'))
      const fields = selectedModelExecutionFields(selectedModel, { ...modelOptions }, mode)
      const response = await services.runtimeWorkApi.createRuntimeTask({
        ...fields,
        taskId: input.creationRequestId,
        clientMessageId: input.creationRequestId,
        deviceId: input.deviceId,
        workspacePath: input.workspacePath,
        teamId: team.id,
        runtime: 'kcoder',
        message: input.prompt,
        title: input.title,
        studioWorkMode: creationWorkMode,
        sessionMode: 'default',
        ...(settingsTemplate ? { settingsTemplate } : {}),
        modelSelection:
          mode === 'follow_target_default'
            ? { modelName: '', modelType: null, options: modelOptions }
            : {
                modelName: selectedModel.name,
                modelType: selectedModel.type,
                options: modelOptions,
              },
      })
      if (latest.current !== scope || !validAccount(input.deviceId))
        throw new Error(t('errors.scope_changed'))
      const thread = runtimeThreadId({
        deviceId: response.deviceId,
        taskId: response.taskId,
        runtimeHandle: response.runtimeHandle,
      })
      if (
        !response.accepted ||
        !thread ||
        response.deviceId !== input.deviceId ||
        response.workspacePath !== input.workspacePath
      )
        throw new Error(t('errors.task_mismatch'))
      await refreshWorkLists()
      if (latest.current !== scope || !validAccount(input.deviceId))
        throw new Error(t('errors.scope_changed'))
      return {
        deviceId: response.deviceId,
        taskId: response.taskId,
        threadId: thread,
        workspacePath: response.workspacePath,
        title: input.title,
      }
    },
    [
      services.runtimeWorkApi,
      selectedModel,
      isUnavailable,
      scope,
      modelOptions,
      mode,
      workbenchState.defaultTeam,
      creationWorkMode,
      settingsTemplate,
      t,
      refreshWorkLists,
    ]
  )
  const context = useMemo<TaskReviewOperationsContext | undefined>(() => {
    if (!target || !threadId || !target.workspacePath) return undefined
    const validAccount = captureAccountContextRevision()
    const owner = { taskId: target.taskId, threadId, deviceId: target.deviceId, scope }
    const isCurrent = () => latest.current === scope && validAccount(owner.deviceId)
    const request = (method: string, params: Record<string, unknown>) => {
      if (!isCurrent()) return Promise.reject(new Error(t('errors.scope_changed')))
      return invokeRuntimeCommand<unknown>('local_executor_request', {
        method,
        params: {
          ...params,
          comparisonOwnerTaskId: owner.taskId,
          ownerThreadId: owner.threadId,
          sourcePath: target.workspacePath,
        },
      })
    }
    return {
      owner,
      sourcePath: target.workspacePath,
      availableTasks,
      isCurrent,
      request,
      ...(selectedModel && workbenchState.defaultTeam && !isUnavailable && services.runtimeWorkApi
        ? {
            createTask,
            creationSummary: t('creationSummary', {
              model: selectedModel.displayName || selectedModel.name,
            }),
          }
        : {}),
      onOpenTask(task) {
        if (isCurrent()) void openRuntimeTask(task)
      },
      ...(appendRuntimeTaskDraft
        ? {
            onAddToTaskDraft(text: string, recipient: TaskDeliveryRecipient) {
              if (!isCurrent() || !appendRuntimeTaskDraft(recipient, text))
                throw new Error(t('errors.task_mismatch'))
              const known = knownTaskRecipient(state.runtimeWork, recipient)
              if (!known) throw new Error(t('errors.task_mismatch'))
              void openRuntimeTask(known)
            },
          }
        : {}),
    }
  }, [
    target,
    threadId,
    scope,
    availableTasks,
    selectedModel,
    isUnavailable,
    services.runtimeWorkApi,
    workbenchState.defaultTeam,
    createTask,
    t,
    openRuntimeTask,
    appendRuntimeTaskDraft,
    state.runtimeWork,
  ])
  return context
}
