import { useCallback, useEffect, useRef } from 'react'
import type { Dispatch } from 'react'
import type { ExecutorClient } from '@/api/executorAccess'
import { useTranslation } from '@/hooks/useTranslation'
import { findFailedRuntimeDraft } from '@/lib/failed-runtime-draft'
import { buildRuntimeTaskRoute, navigateTo } from '@/lib/navigation'
import { runtimeProjectToProject, runtimeProjectUiId } from '@/lib/runtime-project'
import type {
  ProjectWithTasks,
  RuntimeGoalSetRequest,
  RuntimeTaskAddress,
  RuntimeTaskForkTarget,
  RuntimeTranscriptRequest,
  RuntimeWorkSearchRequest,
  User,
} from '@/types/api'
import type {
  RuntimePaneTranscript,
  RuntimePaneTranscriptLoadOptions,
  WorkbenchState,
} from '@/types/workbench'
import {
  createRuntimeTaskStreamHandlers,
  runtimeAddressDebug,
  runtimeMessagesToWorkbenchMessages,
  runtimeTranscriptDebug,
  type RuntimeTaskStreamHandlers,
} from './runtimePaneMessages'
import type { WorkbenchAction } from './workbenchReducer'
import {
  getRuntimeTaskRouteKey,
  isSameRuntimeTaskAddress,
  isSameRuntimeTaskIdentity,
  projectTaskAddresses,
  writeLastProjectId,
} from './workbenchRuntimeHelpers'
import type { WorkbenchServices } from './workbenchServices'
import type {
  ArchiveRuntimeTaskOptions,
  ArchiveRuntimeTaskResult,
  ArchiveRuntimeConversationsResult,
} from './workbenchContextTypes'
import { evictRuntimeConversation } from './runtimeConversationCache'
import type { RuntimeTaskLifecycleStore } from './runtimeTaskLifecycle'

interface UseWorkbenchRuntimeTasksOptions {
  user: User
  state: WorkbenchState
  dispatch: Dispatch<WorkbenchAction>
  executorClient: ExecutorClient
  services: WorkbenchServices
  lifecycleStore: RuntimeTaskLifecycleStore
  markRuntimeTasksArchived: (addresses: RuntimeTaskAddress[]) => void
  refreshWorkLists: () => Promise<void>
}

const runtimeTranscriptRequests = new Map<string, Promise<RuntimePaneTranscript>>()

export function useWorkbenchRuntimeTasks({
  user,
  state,
  dispatch,
  executorClient,
  services,
  lifecycleStore,
  markRuntimeTasksArchived,
  refreshWorkLists,
}: UseWorkbenchRuntimeTasksOptions) {
  const { t } = useTranslation('common')
  const openedRuntimeTaskKeysRef = useRef<Set<string>>(new Set())
  const currentRuntimeTaskRef = useRef<RuntimeTaskAddress | null>(null)

  useEffect(() => {
    currentRuntimeTaskRef.current = state.currentRuntimeTask
  }, [state.currentRuntimeTask])

  const openRuntimeTaskView = useCallback(
    (
      address: RuntimeTaskAddress,
      project: ProjectWithTasks | null,
      options?: { markOpened?: boolean; navigate?: boolean }
    ) => {
      const reopeningCurrentTask = isSameRuntimeTaskIdentity(currentRuntimeTaskRef.current, address)
      currentRuntimeTaskRef.current = address
      if (options?.markOpened !== false) {
        openedRuntimeTaskKeysRef.current.add(getRuntimeTaskRouteKey(address))
      }
      dispatch({
        type: 'runtime_task_opened',
        address,
        project,
      })
      console.info('[KCoder Studio] Runtime task view opened', {
        address: runtimeAddressDebug(address),
        reopeningCurrentTask,
        navigate: options?.navigate === true,
      })
      if (options?.navigate) {
        navigateTo(buildRuntimeTaskRoute(address))
      }
    },
    [dispatch]
  )

  const isCurrentRuntimeTask = useCallback(
    (address: RuntimeTaskAddress) =>
      isSameRuntimeTaskIdentity(currentRuntimeTaskRef.current, address),
    []
  )

  const clearCurrentRuntimeTaskView = useCallback(() => {
    currentRuntimeTaskRef.current = null
    dispatch({ type: 'current_task_cleared' })
    navigateTo('/')
  }, [dispatch])

  const loadRuntimeTranscriptForPane = useCallback(
    async (
      address: RuntimeTaskAddress,
      options: RuntimePaneTranscriptLoadOptions = {}
    ): Promise<RuntimePaneTranscript> => {
      const transcriptRequest: RuntimeTranscriptRequest = { ...address, ...options }
      const transcriptKey = runtimeTranscriptRequestKey(address, options)
      const inFlightTranscript = runtimeTranscriptRequests.get(transcriptKey)
      if (inFlightTranscript) {
        return inFlightTranscript
      }

      const request = executorClient.runtime
        .getRuntimeTranscript(transcriptRequest)
        .then(transcript => {
          if (!Array.isArray(transcript.messages)) {
            console.error(
              '[KCoder Studio] Runtime pane transcript response missing messages array',
              {
                address: runtimeAddressDebug(address),
                response: runtimeTranscriptDebug(transcript),
                transcriptKey,
              }
            )
          }

          return {
            messages: runtimeMessagesToWorkbenchMessages(
              Array.isArray(transcript.messages) ? transcript.messages : []
            ),
            running: typeof transcript.running === 'boolean' ? transcript.running : undefined,
            contextUsage: transcript.contextUsage ?? null,
            turnNavigation: Array.isArray(transcript.turnNavigation)
              ? transcript.turnNavigation
              : [],
            fullContent: transcript.fullContent === true,
            historyReset: transcript.historyReset === true,
            rangeStart: typeof transcript.rangeStart === 'number' ? transcript.rangeStart : null,
            rangeEnd: typeof transcript.rangeEnd === 'number' ? transcript.rangeEnd : null,
            hasMoreBefore: Boolean(transcript.hasMoreBefore),
            beforeCursor: transcript.beforeCursor ?? null,
            hasMoreAfter: Boolean(transcript.hasMoreAfter),
            afterCursor: transcript.afterCursor ?? null,
          }
        })
        .finally(() => {
          if (runtimeTranscriptRequests.get(transcriptKey) === request) {
            runtimeTranscriptRequests.delete(transcriptKey)
          }
        })
      runtimeTranscriptRequests.set(transcriptKey, request)
      return request
    },
    [executorClient]
  )

  const subscribeRuntimeTaskStream = useCallback(
    (address: RuntimeTaskAddress, handlers: RuntimeTaskStreamHandlers) =>
      services.chatStream.subscribe(createRuntimeTaskStreamHandlers(address, handlers)),
    [services.chatStream]
  )

  const openRuntimeTask = useCallback(
    async (address: RuntimeTaskAddress) => {
      const runtimeProjectWork = state.runtimeWork?.projects.find(item =>
        item.deviceWorkspaces.some(
          workspace =>
            workspace.deviceId === address.deviceId &&
            workspace.tasks.some(task => task.taskId === address.taskId)
        )
      )
      const project = runtimeProjectWork
        ? (state.projects.find(
            item => item.id === runtimeProjectUiId(runtimeProjectWork.project)
          ) ?? runtimeProjectToProject(runtimeProjectWork))
        : null

      writeLastProjectId(user.id, project?.id ?? null)
      openRuntimeTaskView(address, project, {
        markOpened: !openedRuntimeTaskKeysRef.current.has(getRuntimeTaskRouteKey(address)),
        navigate: true,
      })
    },
    [openRuntimeTaskView, state.projects, state.runtimeWork, user.id]
  )

  const clearCurrentRuntimeTaskIfArchived = useCallback(
    (addresses: RuntimeTaskAddress[]) => {
      if (
        !addresses.some(address => isSameRuntimeTaskAddress(currentRuntimeTaskRef.current, address))
      ) {
        return
      }
      clearCurrentRuntimeTaskView()
    },
    [clearCurrentRuntimeTaskView]
  )

  const archiveRuntimeConversations = useCallback(
    async (
      addresses: RuntimeTaskAddress[],
      fallbackError: string
    ): Promise<ArchiveRuntimeConversationsResult> => {
      const archiveTargets = uniqueRuntimeTaskAddresses(addresses)
      if (archiveTargets.length === 0) return { status: 'archived' }
      const results = await Promise.all(
        archiveTargets.map(async address => {
          try {
            // Failed optimistic entries have no backend thread to archive.
            if (findFailedRuntimeDraft(state.runtimeWork, address)) {
              dispatch({ type: 'runtime_task_optimistic_removed', address })
              return { address, response: { accepted: true, error: undefined } }
            }
            return { address, response: await executorClient.runtime.archiveConversation(address) }
          } catch (error) {
            return { address, error }
          }
        })
      )
      const archivedAddresses = results.flatMap(result =>
        result.response?.accepted ? [result.address] : []
      )
      if (archivedAddresses.length > 0) {
        archivedAddresses.forEach(evictRuntimeConversation)
        archivedAddresses.forEach(address => lifecycleStore.remove(address))
        markRuntimeTasksArchived(archivedAddresses)
        clearCurrentRuntimeTaskIfArchived(archivedAddresses)
        await refreshWorkLists()
      }
      const failedResult = results.find(result => !result.response?.accepted)
      if (!failedResult) return { status: 'archived' }
      const error =
        failedResult.response?.error ||
        (failedResult.error instanceof Error ? failedResult.error.message : fallbackError)
      dispatch({
        type: 'error_set',
        error,
      })
      return { status: 'failed', error }
    },
    [
      clearCurrentRuntimeTaskIfArchived,
      dispatch,
      executorClient,
      lifecycleStore,
      markRuntimeTasksArchived,
      refreshWorkLists,
      state.runtimeWork,
    ]
  )

  const archiveRuntimeTask = useCallback(
    async (
      address: RuntimeTaskAddress,
      options: ArchiveRuntimeTaskOptions = {}
    ): Promise<ArchiveRuntimeTaskResult> => {
      console.debug('[KCoder Studio] Runtime archive task start', {
        address: runtimeAddressDebug(address),
        force: Boolean(options.force),
      })
      const result = await archiveRuntimeConversations([address], 'Failed to archive runtime task')
      console.debug('[KCoder Studio] Runtime archive task finished', {
        address: runtimeAddressDebug(address),
        status: result.status,
      })
      return result
    },
    [archiveRuntimeConversations]
  )

  const renameRuntimeTask = useCallback(
    async (address: RuntimeTaskAddress, title: string) => {
      const response = await executorClient.runtime.renameRuntimeTask({ address, title })
      if (!response.accepted) {
        dispatch({ type: 'error_set', error: response.error || 'Failed to rename runtime task' })
        return
      }
      await refreshWorkLists()
    },
    [dispatch, executorClient, refreshWorkLists]
  )

  const archiveProjectConversations = useCallback(
    async (
      runtimeProjectKey: string,
      options: ArchiveRuntimeTaskOptions = {}
    ): Promise<ArchiveRuntimeConversationsResult> => {
      const addresses = projectTaskAddresses(state.runtimeWork, [runtimeProjectKey])
      console.debug('[KCoder Studio] Runtime archive project start', {
        runtimeProjectKey,
        addresses: addresses.map(runtimeAddressDebug),
        force: Boolean(options.force),
      })
      const result = await archiveRuntimeConversations(addresses, 'Failed to archive project')
      console.debug('[KCoder Studio] Runtime archive project finished', {
        runtimeProjectKey,
        status: result.status,
        archivedAddresses: addresses.length,
      })
      return result
    },
    [archiveRuntimeConversations, state.runtimeWork]
  )

  const archiveProjectsConversations = useCallback(
    async (
      runtimeProjectKeys: string[],
      options: ArchiveRuntimeTaskOptions = {}
    ): Promise<ArchiveRuntimeConversationsResult> => {
      const uniqueProjectKeys = [...new Set(runtimeProjectKeys.filter(Boolean))]
      if (uniqueProjectKeys.length === 0) return { status: 'archived' }

      const archivedAddresses = projectTaskAddresses(state.runtimeWork, uniqueProjectKeys)
      console.debug('[KCoder Studio] Runtime archive projects start', {
        runtimeProjectKeys: uniqueProjectKeys,
        addresses: archivedAddresses.map(runtimeAddressDebug),
        force: Boolean(options.force),
      })
      const result = await archiveRuntimeConversations(
        archivedAddresses,
        'Failed to archive project conversations'
      )
      console.debug('[KCoder Studio] Runtime archive projects finished', {
        runtimeProjectKeys: uniqueProjectKeys,
        status: result.status,
        archivedAddresses: archivedAddresses.length,
      })
      return result
    },
    [archiveRuntimeConversations, state.runtimeWork]
  )

  const archiveChatConversations = useCallback(
    async (
      addresses: RuntimeTaskAddress[],
      options: ArchiveRuntimeTaskOptions = {}
    ): Promise<ArchiveRuntimeConversationsResult> => {
      if (addresses.length === 0) return { status: 'archived' }

      console.debug('[KCoder Studio] Runtime archive chats start', {
        addresses: addresses.map(runtimeAddressDebug),
        force: Boolean(options.force),
      })
      const result = await archiveRuntimeConversations(
        addresses,
        'Failed to archive chat conversations'
      )
      console.debug('[KCoder Studio] Runtime archive chats finished', {
        status: result.status,
        archivedAddresses: addresses.length,
      })
      return result
    },
    [archiveRuntimeConversations]
  )

  const searchRuntimeWork = useCallback(
    async (request: RuntimeWorkSearchRequest) => executorClient.runtime.searchRuntimeWork(request),
    [executorClient]
  )

  const forkCurrentRuntimeTask = useCallback(
    async (
      target: RuntimeTaskForkTarget,
      options: { lastTurnId?: string; title?: string } = {}
    ) => {
      if (!state.currentRuntimeTask) {
        dispatch({ type: 'error_set', error: 'No runtime task is selected' })
        return
      }

      try {
        const response = await executorClient.runtime.forkRuntimeTask({
          source: state.currentRuntimeTask,
          target,
          ...options,
        })
        if (!response.accepted) {
          dispatch({ type: 'error_set', error: response.error || 'Failed to fork runtime task' })
          return
        }

        await refreshWorkLists()
        await openRuntimeTask(response.target)
      } catch (error) {
        dispatch({
          type: 'error_set',
          error: error instanceof Error ? error.message : 'Failed to fork runtime task',
        })
      }
    },
    [dispatch, executorClient, openRuntimeTask, refreshWorkLists, state.currentRuntimeTask]
  )

  const getRuntimeGoal = useCallback(
    async (address: RuntimeTaskAddress) => executorClient.runtime.getRuntimeGoal({ address }),
    [executorClient]
  )

  const getRuntimeSessionModes = useCallback(
    async (request: import('@/types/api').RuntimeSessionModesRequest) => {
      const inspect = executorClient.runtime.getRuntimeSessionModes
      if (!inspect) throw new Error('当前运行时不支持执行模式查询')
      return inspect(request)
    },
    [executorClient]
  )

  const setRuntimeGoal = useCallback(
    async (request: RuntimeGoalSetRequest) => {
      const response = await executorClient.runtime.setRuntimeGoal(request)
      if (!response.accepted) {
        dispatch({
          type: 'error_set',
          error: response.error || t('workbench.goal_set_failed', 'Failed to set goal'),
        })
      }
      return response
    },
    [dispatch, executorClient, t]
  )

  const clearRuntimeGoal = useCallback(
    async (address: RuntimeTaskAddress) => {
      const response = await executorClient.runtime.clearRuntimeGoal({ address })
      if (!response.accepted) {
        dispatch({
          type: 'error_set',
          error: response.error || t('workbench.goal_clear_failed', 'Failed to delete goal'),
        })
      }
      return response
    },
    [dispatch, executorClient, t]
  )

  return {
    openRuntimeTaskView,
    isCurrentRuntimeTask,
    clearCurrentRuntimeTaskView,
    loadRuntimeTranscriptForPane,
    subscribeRuntimeTaskStream,
    openRuntimeTask,
    renameRuntimeTask,
    archiveRuntimeTask,
    archiveProjectConversations,
    archiveProjectsConversations,
    archiveChatConversations,
    searchRuntimeWork,
    forkCurrentRuntimeTask,
    getRuntimeGoal,
    getRuntimeSessionModes,
    setRuntimeGoal,
    clearRuntimeGoal,
  }
}

function uniqueRuntimeTaskAddresses(addresses: RuntimeTaskAddress[]): RuntimeTaskAddress[] {
  const uniqueAddresses = new Map(
    addresses.map(address => [getRuntimeTaskRouteKey(address), address])
  )
  return [...uniqueAddresses.values()]
}

function runtimeTranscriptRequestKey(
  address: RuntimeTaskAddress,
  options: RuntimePaneTranscriptLoadOptions
): string {
  return JSON.stringify({
    address: getRuntimeTaskRouteKey(address),
    limit: options.limit ?? null,
    beforeCursor: options.beforeCursor ?? null,
    afterCursor: options.afterCursor ?? null,
    refresh: options.refresh ?? null,
    includeFullContent: options.includeFullContent ?? null,
  })
}

export type WorkbenchRuntimeTasks = ReturnType<typeof useWorkbenchRuntimeTasks>
