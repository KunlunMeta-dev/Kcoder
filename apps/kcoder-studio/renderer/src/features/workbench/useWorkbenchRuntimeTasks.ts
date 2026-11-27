import { createRandomUuid } from '@/lib/random-id'
import { useCallback, useLayoutEffect, useRef } from 'react'
import { captureAccountContextRevision } from '@/kcoder/accountContextEvents'
import type { Dispatch } from 'react'
import type { ExecutorClient } from '@/api/executorAccess'
import { useTranslation } from '@/hooks/useTranslation'
import { findFailedRuntimeDraft } from '@/lib/failed-runtime-draft'
import { buildRuntimeTaskRoute, navigateTo } from '@/lib/navigation'
import { runtimeProjectToProject, runtimeProjectUiId } from '@/lib/runtime-project'
import { sameWorkspacePath } from '@/lib/workspace-path-identity'
import type {
  ProjectWithTasks,
  RuntimeGoalSetRequest,
  RuntimeTaskAddress,
  RuntimeTaskCreationReadResponse,
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
  findRuntimeTask,
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
import { mergeResolvedRuntimeTaskAddress } from './runtimeTaskAddressResolution'
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

interface PendingRuntimeTranscript {
  promise: Promise<{ transcript: RuntimePaneTranscript; resolvedAddress?: RuntimeTaskAddress }>
  isCurrentOwner: (targetId: string) => boolean
}
const runtimeTranscriptRequests = new WeakMap<
  ExecutorClient,
  Map<string, PendingRuntimeTranscript>
>()

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
  const currentExecutorRef = useRef(executorClient)
  const currentStateRef = useRef(state)
  const readerActiveRef = useRef(true)
  const configurationEpochRef = useRef({ all: 0, targets: new Map<string, number>() })
  useLayoutEffect(() => {
    readerActiveRef.current = true
    const changed = (event: Event) => {
      const target = (event as CustomEvent<{ targetId?: unknown }>).detail?.targetId
      const epoch = configurationEpochRef.current
      // Legacy notices identify no target. An overflow also retires every pending result.
      if (
        typeof target !== 'string' ||
        !target ||
        target.length > 4096 ||
        (epoch.targets.size >= 256 && !epoch.targets.has(target))
      ) {
        configurationEpochRef.current = { all: epoch.all + 1, targets: new Map() }
      } else epoch.targets.set(target, (epoch.targets.get(target) ?? 0) + 1)
    }
    if (typeof window !== 'undefined') window.addEventListener('kcoder:servers-changed', changed)
    return () => {
      readerActiveRef.current = false
      if (typeof window !== 'undefined')
        window.removeEventListener('kcoder:servers-changed', changed)
    }
  }, [])
  useLayoutEffect(() => {
    currentExecutorRef.current = executorClient
    currentStateRef.current = state
  }, [executorClient, state])

  useLayoutEffect(() => {
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
      address = {
        ...address,
        ...(address.expectedSessionAddress
          ? { expectedSessionAddress: { ...address.expectedSessionAddress } }
          : {}),
        ...(address.runtimeHandle ? { runtimeHandle: { ...address.runtimeHandle } } : {}),
      }
      const task = findRuntimeTask(state.runtimeWork, address)
      const originalPrefix = `kcoder:${address.deviceId}:`
      const originalThreadId = address.taskId.startsWith(originalPrefix)
        ? address.taskId.slice(originalPrefix.length)
        : ''
      const originalKCoderAddress =
        Boolean(originalThreadId) && (!address.threadId || address.threadId === originalThreadId)
      const attachToLiveTurn =
        isSameRuntimeTaskIdentity(currentRuntimeTaskRef.current, address) &&
        (originalKCoderAddress ||
          (task?.runtime === 'kcoder' && task.threadId === address.threadId))
      const transcriptRequest: RuntimeTranscriptRequest = {
        ...address,
        ...options,
        ...(attachToLiveTurn
          ? {
              attachToLiveTurn: true,
              ...(originalKCoderAddress ? { threadId: originalThreadId } : {}),
            }
          : {}),
      }
      const transcriptKey = runtimeTranscriptRequestKey(address, options, attachToLiveTurn)
      let requests = runtimeTranscriptRequests.get(executorClient)
      if (!requests) {
        requests = new Map()
        runtimeTranscriptRequests.set(executorClient, requests)
      }
      const isCurrentAccount = captureAccountContextRevision()
      const configurationEpoch = configurationEpochRef.current.all
      const targetEpoch = configurationEpochRef.current.targets.get(address.deviceId) ?? 0
      const isCurrentOwner = (targetId: string) =>
        readerActiveRef.current &&
        targetId === address.deviceId &&
        configurationEpochRef.current.all === configurationEpoch &&
        (configurationEpochRef.current.targets.get(targetId) ?? 0) === targetEpoch &&
        isCurrentAccount(targetId)
      const assertCurrent = () => {
        if (!isCurrentOwner(address.deviceId) || currentExecutorRef.current !== executorClient)
          throw new DOMException('Conversation executor or account changed', 'AbortError')
      }
      const finish = (result: Awaited<PendingRuntimeTranscript['promise']>) => {
        assertCurrent()
        if (
          result.resolvedAddress &&
          !mergeResolvedRuntimeTaskAddress(address, result.resolvedAddress)
        )
          throw new Error('RUNTIME_TRANSCRIPT_ADDRESS_CHANGED')
        // A history-only snapshot cannot upgrade the restored view into a sender.
        if (attachToLiveTurn && result.resolvedAddress && !result.transcript.historyReadOnly) {
          const current = currentRuntimeTaskRef.current
          const resolved =
            current && mergeResolvedRuntimeTaskAddress(current, result.resolvedAddress)
          if (
            current &&
            isSameRuntimeTaskIdentity(current, address) &&
            resolved &&
            resolved !== current
          ) {
            dispatch({
              type: 'runtime_task_address_resolved',
              original: address,
              address: result.resolvedAddress,
            })
          }
        }
        return result.transcript
      }
      const inFlightTranscript = requests.get(transcriptKey)
      if (
        inFlightTranscript &&
        options.refresh !== true &&
        inFlightTranscript.isCurrentOwner(address.deviceId)
      ) {
        return finish(await inFlightTranscript.promise)
      }

      const request = executorClient.runtime
        .getRuntimeTranscript(transcriptRequest)
        .then(transcript => {
          if (!isCurrentAccount(address.deviceId))
            throw new DOMException('Conversation account changed', 'AbortError')
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

          const normalized: RuntimePaneTranscript = {
            resolvedAddress: transcript.resolvedAddress,
            historyReadOnly: transcript.historyReadOnly === true,
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
          return { resolvedAddress: transcript.resolvedAddress, transcript: normalized }
        })
        .finally(() => {
          if (requests.get(transcriptKey)?.promise === request) {
            requests.delete(transcriptKey)
          }
        })
      requests.set(transcriptKey, { promise: request, isCurrentOwner })
      return finish(await request)
    },
    [dispatch, executorClient, state.runtimeWork]
  )

  const subscribeRuntimeTaskStream = useCallback(
    (address: RuntimeTaskAddress, handlers: RuntimeTaskStreamHandlers) =>
      services.chatStream.subscribe(createRuntimeTaskStreamHandlers(address, handlers)),
    [services.chatStream]
  )

  const openRuntimeTask = useCallback(
    async (address: RuntimeTaskAddress, options?: { navigate?: boolean }) => {
      const project = projectForRuntimeTask(state.projects, state.runtimeWork, address)

      writeLastProjectId(user.id, project?.id ?? null)
      openRuntimeTaskView(address, project, {
        markOpened: !openedRuntimeTaskKeysRef.current.has(getRuntimeTaskRouteKey(address)),
        navigate: options?.navigate !== false,
      })
    },
    [openRuntimeTaskView, state.projects, state.runtimeWork, user.id]
  )

  const recoverRuntimeTask = useCallback(
    async (address: RuntimeTaskAddress, open = false): Promise<RuntimeTaskCreationReadResponse> => {
      const draft = findFailedRuntimeDraft(currentStateRef.current.runtimeWork, address)
      if (!draft || !address.workspacePath) throw new Error(t('workbench.failed_task_changed'))
      const isCurrentAccount = captureAccountContextRevision()
      const viewBefore = recoveryViewKey(currentStateRef.current)
      const assertCurrent = () => {
        const latest = findFailedRuntimeDraft(currentStateRef.current.runtimeWork, address)
        if (
          !isCurrentAccount(address.deviceId) ||
          currentExecutorRef.current !== executorClient ||
          !latest ||
          latest.updatedAt !== draft.updatedAt ||
          latest.creationRequest?.clientRequestId !== draft.creationRequest?.clientRequestId ||
          latest.creationRequest?.clientMessageId !== draft.creationRequest?.clientMessageId ||
          latest.creationRequest?.outcome !== draft.creationRequest?.outcome ||
          (open && recoveryViewKey(currentStateRef.current) !== viewBefore)
        )
          throw new DOMException('Original task recovery owner changed', 'AbortError')
      }
      assertCurrent()
      const result = await executorClient.runtime.readRuntimeTaskCreation({
        deviceId: address.deviceId,
        workspacePath: address.workspacePath,
        clientRequestId: draft.creationRequest?.clientRequestId ?? draft.taskId,
        clientMessageId: draft.creationRequest?.clientMessageId,
      })
      assertCurrent()
      if (result.status !== 'ready') return result
      if (
        result.address.deviceId !== address.deviceId ||
        !sameWorkspacePath(result.address.workspacePath, address.workspacePath) ||
        !result.address.threadId ||
        result.address.taskId !== `kcoder:${address.deviceId}:${result.address.threadId}`
      )
        throw new Error(t('workbench.failed_task_changed'))
      if (open) {
        // Read the original history before retiring any confirmed local failure.
        // Neither this lookup nor opening the view resubmits the initial input.
        await executorClient.runtime.getRuntimeTranscript(result.address)
        assertCurrent()
        const project = projectForRuntimeTask(state.projects, state.runtimeWork, address)
        writeLastProjectId(user.id, project?.id ?? null)
        if (result.initialMessage.status !== 'unknown')
          dispatch({ type: 'runtime_task_optimistic_removed', address })
        openRuntimeTaskView(result.address, project, { navigate: true })
      }
      return result
    },
    [dispatch, executorClient, openRuntimeTaskView, state.projects, state.runtimeWork, t, user.id]
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
            // Discard only the local projection; an unresolved backend task
            // must not be archived or cancelled through this draft address.
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
    async (address: RuntimeTaskAddress, title: string, options?: { throwOnRejection?: boolean }) => {
      const response = await executorClient.runtime.renameRuntimeTask({ address, title })
      if (!response.accepted) {
        const message = response.error || 'Failed to rename runtime task'
        if (options?.throwOnRejection) throw new Error(message)
        dispatch({ type: 'error_set', error: message })
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

  const pendingForks = useRef(new Map<string, { id: string; attempt: object }>())
  const forkCurrentRuntimeTask = useCallback(
    async (
      target: RuntimeTaskForkTarget,
      options: { lastTurnId?: string; title?: string; onError?: (error: string) => void } = {}
    ) => {
      const source = state.currentRuntimeTask
      if (!source) throw new Error(t('workbench.runtime_retry_task_missing'))
      const isCurrentView = () => readerActiveRef.current &&
        currentExecutorRef.current === executorClient &&
        isSameRuntimeTaskIdentity(currentStateRef.current.currentRuntimeTask, source)
      const key = JSON.stringify([
        source.deviceId, source.taskId, target.deviceId, target.workspacePath, options.lastTurnId, options.title,
      ])
      const pending = pendingForks.current.get(key)
      const clientRequestId = pending?.id ?? createRandomUuid()
      const attempt = {}
      const accountStillCurrent = captureAccountContextRevision()
      pendingForks.current.set(key, { id: clientRequestId, attempt })
      // A rejected promise retains the identity. Only acceptance starts a new fork operation.
      const response = await executorClient.runtime.forkRuntimeTask({
        source, target, clientRequestId,
        ...(options.lastTurnId ? { lastTurnId: options.lastTurnId } : {}),
        ...(options.title ? { title: options.title } : {}),
      })
      if (!accountStillCurrent(source.deviceId)) throw new DOMException('Fork account changed', 'AbortError')
      // A newer same-intent attempt may be reconciling this request through its receipt.
      if (pendingForks.current.get(key)?.attempt !== attempt) return
      if (!response.accepted) throw new Error(response.error || t('workbench.task_fork_failed'))
      pendingForks.current.delete(key)
      if (!isCurrentView()) return
      if (response.warning) options.onError?.(response.warning)
      try { await refreshWorkLists() } catch { /* An index refresh cannot undo an accepted fork. */ }
      if (!isCurrentView()) return
      try { await openRuntimeTask(response.target) } catch {
        options.onError?.(t('workbench.fork_created_open_failed'))
      }
    },
    [executorClient, openRuntimeTask, refreshWorkLists, state.currentRuntimeTask, t]
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
    (request: RuntimeGoalSetRequest) => executorClient.runtime.setRuntimeGoal(request),
    [executorClient]
  )

  const clearRuntimeGoal = useCallback(
    (address: RuntimeTaskAddress) => executorClient.runtime.clearRuntimeGoal({ address }),
    [executorClient]
  )

  return {
    openRuntimeTaskView,
    isCurrentRuntimeTask,
    clearCurrentRuntimeTaskView,
    loadRuntimeTranscriptForPane,
    subscribeRuntimeTaskStream,
    openRuntimeTask,
    recoverRuntimeTask,
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

function projectForRuntimeTask(
  projects: WorkbenchState['projects'],
  runtimeWork: WorkbenchState['runtimeWork'],
  address: RuntimeTaskAddress
) {
  const projectWork = runtimeWork?.projects.find(item =>
    item.deviceWorkspaces.some(
      workspace =>
        workspace.deviceId === address.deviceId &&
        (!address.workspacePath ||
          sameWorkspacePath(workspace.workspacePath, address.workspacePath)) &&
        workspace.tasks.some(task => task.taskId === address.taskId)
    )
  )
  return projectWork
    ? (projects.find(item => item.id === runtimeProjectUiId(projectWork.project)) ??
        runtimeProjectToProject(projectWork))
    : null
}

function uniqueRuntimeTaskAddresses(addresses: RuntimeTaskAddress[]): RuntimeTaskAddress[] {
  const uniqueAddresses = new Map(
    addresses.map(address => [getRuntimeTaskRouteKey(address), address])
  )
  return [...uniqueAddresses.values()]
}

function runtimeTranscriptRequestKey(
  address: RuntimeTaskAddress,
  options: RuntimePaneTranscriptLoadOptions,
  attachToLiveTurn: boolean
): string {
  return JSON.stringify({
    address: getRuntimeTaskRouteKey(address),
    expectedSessionAddress: address.expectedSessionAddress ?? null,
    attachToLiveTurn,
    limit: options.limit ?? null,
    beforeCursor: options.beforeCursor ?? null,
    afterCursor: options.afterCursor ?? null,
    refresh: options.refresh ?? null,
    includeFullContent: options.includeFullContent ?? null,
  })
}

export type WorkbenchRuntimeTasks = ReturnType<typeof useWorkbenchRuntimeTasks>

function recoveryViewKey(state: WorkbenchState): string {
  return JSON.stringify([
    window.location.href,
    state.currentProject?.id,
    state.currentRuntimeTask ? getRuntimeTaskRouteKey(state.currentRuntimeTask) : null,
    state.selectedDeviceWorkspaceId,
    state.standaloneDeviceId,
    state.standaloneWorkspacePath,
    state.standaloneChatKey,
  ])
}
