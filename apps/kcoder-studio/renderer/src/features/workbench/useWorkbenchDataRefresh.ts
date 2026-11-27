import { subscribeRuntimeWorkChanged } from '@/kcoder/runtimeWorkEvents'
import { isWorkspaceScanCancelled } from '@/kcoder/workspaceScanError'
import { isAbortError } from '@/lib/async-errors'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Dispatch } from 'react'
import type { DeviceListOptions } from '@/api/devices'
import type { ExecutorClient } from '@/api/executorAccess'
import { getPreferredStandaloneDeviceId } from '@/lib/device-selection'
import type {
  DeviceInfo,
  ProjectWithTasks,
  RuntimeTaskAddress,
  RuntimeWorkListResponse,
  User,
} from '@/types/api'
import type { DockerRemoteDeviceCommandResponse } from '@/types/devices'
import type { CloudRuntimeState, CloudWorkCheckKey, WorkbenchState } from '@/types/workbench'
import {
  EMPTY_CLOUD_RUNTIME_STATE,
  EMPTY_RUNTIME_WORK,
  filterDisconnectedRemoteRuntimeWork,
  finishCloudRuntimeSync,
  mergeDeviceLists,
  mergeRuntimeWorkLists,
  nowMs,
  readCachedDeviceList,
  resolveDeviceListWithCache,
  selectCloudWorkStatus,
  selectRuntimeWorkView,
  selectVisibleDevices,
  startCloudRuntimeSync,
  timedWorkbenchBootstrapRequest,
} from './workbenchCloudStatus'
import type { WorkbenchAction } from './workbenchReducer'
import { debugRuntimeSidebarState, summarizeRuntimeWorkTaskIds } from './runtimeSidebarDiagnostics'
import {
  getRememberedStandaloneDeviceId,
  getRuntimeTaskRouteKey,
  removeRuntimeTasks,
} from './workbenchRuntimeHelpers'
import type { WorkbenchServices } from './workbenchServices'
import { useStableEvent } from './useStableEvent'
import {
  readCachedRemoteRuntimeWork,
  reconcileCachedRemoteRuntimeWork,
  writeCachedRemoteRuntimeWork,
} from './remoteRuntimeWorkCache'
import { normalizeRuntimeWorkspacePath, runtimeProjectUiId } from '@/lib/runtime-project'
import { subscribeRuntimeTaskUnarchived } from './runtimeArchiveEvents'
import { isSameRuntimeTaskIdentity } from './workbenchRuntimeHelpers'
import { mergePartialRuntimeWork, shouldRetainArchivedRuntimeTask } from './partialRuntimeWork'
import { runtimeWorkActivityWatermark, stampRuntimeWorkSnapshot } from './runtimeWorkActivity'
import type { RemoteRuntimeWorkCacheScope } from './remoteRuntimeWorkCache'

interface UseWorkbenchDataRefreshOptions {
  user: User
  state: WorkbenchState
  dispatch: Dispatch<WorkbenchAction>
  executorClient: ExecutorClient
  services: WorkbenchServices
  // Account-scoped cache namespace for remote work lists. Absent or null
  // disables the persistent cache so data never leaks across accounts or
  // anonymous sessions.
  remoteCacheScope?: RemoteRuntimeWorkCacheScope | null
}

interface LocalRuntimeReadSource {
  userId: User['id']
  executorClient: ExecutorClient
  invalidation: object
  reconciled?: { context: object; invalidation: object }
  pending?: { context: object; invalidation: object; settled: Promise<void> }
}

function createCloudRuntimeStateWithCache(runtimeWork: RuntimeWorkListResponse): CloudRuntimeState {
  if (runtimeWork.projects.length === 0 && runtimeWork.chats.length === 0) {
    return EMPTY_CLOUD_RUNTIME_STATE
  }
  return {
    availability: 'stale',
    current: null,
    lastGood: {
      revision: 0,
      devices: [],
      runtimeWork,
      teams: [],
      fetchedAt: null,
      checks: {
        teams: { status: 'idle', updatedAt: null, error: null },
        devices: { status: 'idle', updatedAt: null, error: null },
        runtimeWork: { status: 'stale', updatedAt: null, error: null },
      },
    },
    inFlightRevision: null,
    lastTrigger: null,
    nextRevision: 1,
  }
}

function removeRuntimeTasksFromCloudState(
  state: CloudRuntimeState,
  addresses: RuntimeTaskAddress[]
): CloudRuntimeState {
  const removeFromSnapshot = (snapshot: CloudRuntimeState['current']) =>
    snapshot
      ? {
          ...snapshot,
          runtimeWork: removeRuntimeTasks(snapshot.runtimeWork, addresses),
        }
      : null
  return {
    ...state,
    availability:
      state.inFlightRevision == null ? state.availability : state.lastGood ? 'stale' : 'idle',
    current: removeFromSnapshot(state.current),
    lastGood: removeFromSnapshot(state.lastGood),
    inFlightRevision: null,
  }
}

function removeRuntimeProjectFromCloudState(
  state: CloudRuntimeState,
  projectId: number,
  workspace?: { deviceId: string; workspacePath: string }
): CloudRuntimeState {
  const removeFromSnapshot = (snapshot: CloudRuntimeState['current']) =>
    snapshot
      ? {
          ...snapshot,
          runtimeWork: removeRuntimeProject(snapshot.runtimeWork, projectId, workspace),
        }
      : null
  return {
    ...state,
    availability:
      state.inFlightRevision == null ? state.availability : state.lastGood ? 'stale' : 'idle',
    current: removeFromSnapshot(state.current),
    lastGood: removeFromSnapshot(state.lastGood),
  }
}

function mergeRuntimeTaskAddresses(
  current: RuntimeTaskAddress[],
  incoming: RuntimeTaskAddress[]
): RuntimeTaskAddress[] {
  const addresses = new Map(current.map(address => [getRuntimeTaskRouteKey(address), address]))
  incoming.forEach(address => addresses.set(getRuntimeTaskRouteKey(address), address))
  return [...addresses.values()]
}

function removeRuntimeProject(
  runtimeWork: RuntimeWorkListResponse,
  projectId: number,
  workspace?: { deviceId: string; workspacePath: string }
): RuntimeWorkListResponse {
  const projects = runtimeWork.projects.filter(
    project => runtimeProjectUiId(project.project) !== projectId
  )
  const normalizedDeviceId = workspace?.deviceId.trim()
  const normalizedWorkspacePath = workspace
    ? normalizeRuntimeWorkspacePath(workspace.workspacePath)
    : null
  const chats =
    normalizedDeviceId && normalizedWorkspacePath
      ? runtimeWork.chats.filter(
          chat =>
            chat.deviceId.trim() !== normalizedDeviceId ||
            normalizeRuntimeWorkspacePath(chat.workspacePath) !== normalizedWorkspacePath
        )
      : runtimeWork.chats
  const totalTasks =
    projects.reduce(
      (projectTotal, project) =>
        projectTotal +
        project.deviceWorkspaces.reduce(
          (workspaceTotal, workspace) => workspaceTotal + workspace.tasks.length,
          0
        ),
      0
    ) + chats.reduce((workspaceTotal, workspace) => workspaceTotal + workspace.tasks.length, 0)
  return { ...runtimeWork, projects, chats, totalTasks }
}

export function useWorkbenchDataRefresh({
  user,
  state,
  dispatch,
  executorClient,
  services,
  remoteCacheScope,
}: UseWorkbenchDataRefreshOptions) {
  const cacheTargetId = remoteCacheScope?.targetId
  const cachePrincipalId = remoteCacheScope?.principalId
  const cacheScope = useMemo(() => cacheTargetId === undefined || cachePrincipalId === undefined
    ? null : { targetId: cacheTargetId, principalId: cachePrincipalId }, [cacheTargetId, cachePrincipalId])

  const initialCachedRemoteRuntimeWork = useMemo(
    () => readCachedRemoteRuntimeWork(cacheScope),
    [cacheScope]
  )
  const dataSource = useMemo(() => ({ userId: user.id, executorClient, scope: cacheScope }),
    [executorClient, cacheScope, user.id])
  const hasCloudBackgroundApi = Boolean(services.cloudBackgroundApi)
  const cachedRemoteRuntimeWorkRef = useRef({
    scope: cacheScope,
    runtimeWork: initialCachedRemoteRuntimeWork,
  })
  const [cloudRuntimeState, setCloudRuntimeState] = useState<CloudRuntimeState>(() =>
    hasCloudBackgroundApi
      ? createCloudRuntimeStateWithCache(initialCachedRemoteRuntimeWork)
      : EMPTY_CLOUD_RUNTIME_STATE
  )
  const cloudRuntimeStateRef = useRef<CloudRuntimeState>(cloudRuntimeState)
  const cloudSource = useMemo(() => ({ api: services.cloudBackgroundApi, dataSource }),
    [services.cloudBackgroundApi, dataSource])
  const cloudSourceRef = useRef(cloudSource)
  const runtimeWorkRef = useRef(state.runtimeWork)
  const localRuntimeWorkRef = useRef<RuntimeWorkListResponse | null>(state.runtimeWork)
  const localRuntimeSourceRef = useRef<LocalRuntimeReadSource>({ userId: user.id, executorClient, invalidation: {} })
  const workRefreshRevision = useRef(0)
  const deviceReadRevision = useRef(0)
  const refreshMounted = useRef(true)
  const archivedRuntimeTaskAddressesRef = useRef<RuntimeTaskAddress[]>([])
  const removedRuntimeProjectsRef = useRef<
    Array<{
      projectId: number
      workspace?: { deviceId: string; workspacePath: string }
    }>
  >([])
  const ownsDataSource = useCallback(() => refreshMounted.current && cloudSourceRef.current.dataSource === dataSource,
    [dataSource])
  useEffect(() => {
    const source = localRuntimeSourceRef.current
    if (source.userId !== user.id || source.executorClient !== executorClient) {
      // A new owner or executor must never inherit partial rows from the previous source.
      localRuntimeWorkRef.current = null
      runtimeWorkRef.current = null
      archivedRuntimeTaskAddressesRef.current = []
      removedRuntimeProjectsRef.current = []
      localRuntimeSourceRef.current = { userId: user.id, executorClient, invalidation: {} }
    }
    refreshMounted.current = true
    return () => {
      refreshMounted.current = false
      workRefreshRevision.current += 1
    }
  }, [user.id, executorClient])
  const devicesRef = useRef(state.devices)
  useEffect(
    () =>
      subscribeRuntimeTaskUnarchived(address => {
        archivedRuntimeTaskAddressesRef.current = archivedRuntimeTaskAddressesRef.current.filter(
          archived => !isSameRuntimeTaskIdentity(archived, address)
        )
      }),
    [user.id]
  )
  const cloudWorkStatus = useMemo(
    () => selectCloudWorkStatus(cloudRuntimeState),
    [cloudRuntimeState]
  )

  const updateCloudRuntimeState = useCallback((next: CloudRuntimeState) => {
    cloudRuntimeStateRef.current = next
    setCloudRuntimeState(next)
  }, [])

  useEffect(() => { cloudSourceRef.current = cloudSource }, [cloudSource])

  useEffect(() => {
    runtimeWorkRef.current = state.runtimeWork
    devicesRef.current = state.devices
  }, [state.devices, state.runtimeWork])

  useEffect(() => {
    const runtimeWork = cachedRemoteRuntimeWorkRef.current.scope === cacheScope
      ? cachedRemoteRuntimeWorkRef.current.runtimeWork : initialCachedRemoteRuntimeWork
    cachedRemoteRuntimeWorkRef.current = {
      scope: cacheScope,
      runtimeWork,
    }
    archivedRuntimeTaskAddressesRef.current = []
    removedRuntimeProjectsRef.current = []
    updateCloudRuntimeState(
      hasCloudBackgroundApi
        ? createCloudRuntimeStateWithCache(runtimeWork)
        : EMPTY_CLOUD_RUNTIME_STATE
    )
  }, [dataSource, hasCloudBackgroundApi, initialCachedRemoteRuntimeWork, cacheScope, updateCloudRuntimeState])

  useEffect(() => {
    const nextCloudState = hasCloudBackgroundApi
      ? createCloudRuntimeStateWithCache(cachedRemoteRuntimeWorkRef.current.runtimeWork)
      : EMPTY_CLOUD_RUNTIME_STATE
    updateCloudRuntimeState(nextCloudState)

    const currentRuntimeWork = runtimeWorkRef.current
    if (currentRuntimeWork) {
      dispatch({
        type: 'runtime_work_refreshed',
        runtimeWork: hasCloudBackgroundApi
          ? selectRuntimeWorkView(currentRuntimeWork, nextCloudState, devicesRef.current)
          : filterDisconnectedRemoteRuntimeWork(currentRuntimeWork),
      })
    }
  }, [dispatch, executorClient, hasCloudBackgroundApi, services.cloudBackgroundApi, updateCloudRuntimeState, user.id])

  const markRuntimeTasksArchived = useCallback(
    (addresses: RuntimeTaskAddress[]) => {
      if (addresses.length === 0 || !ownsDataSource()) return
      const archivedAddresses = mergeRuntimeTaskAddresses(
        archivedRuntimeTaskAddressesRef.current,
        addresses
      )
      archivedRuntimeTaskAddressesRef.current = archivedAddresses
      const runtimeWork = writeCachedRemoteRuntimeWork(
        cacheScope,
        removeRuntimeTasks(cachedRemoteRuntimeWorkRef.current.runtimeWork, archivedAddresses),
        devicesRef.current
      )
      cachedRemoteRuntimeWorkRef.current = { scope: cacheScope, runtimeWork }
      updateCloudRuntimeState(
        removeRuntimeTasksFromCloudState(cloudRuntimeStateRef.current, archivedAddresses)
      )
      dispatch({ type: 'runtime_tasks_archived', addresses: archivedAddresses })
    },
    [dispatch, ownsDataSource, cacheScope, updateCloudRuntimeState]
  )

  const releaseConfirmedArchivedRuntimeTasks = useCallback(
    (runtimeWork: RuntimeWorkListResponse) => {
      archivedRuntimeTaskAddressesRef.current = archivedRuntimeTaskAddressesRef.current.filter(
        address => shouldRetainArchivedRuntimeTask(runtimeWork, address)
      )
    },
    []
  )

  const selectVisibleRuntimeWork = useCallback(
    (
      localRuntimeWork: RuntimeWorkListResponse,
      nextCloudState: CloudRuntimeState,
      devices?: DeviceInfo[]
    ) => {
      const runtimeWork = selectRuntimeWorkView(localRuntimeWork, nextCloudState, devices)
      const visibleRuntimeWork = hasCloudBackgroundApi
        ? runtimeWork
        : filterDisconnectedRemoteRuntimeWork(runtimeWork)
      return removeRuntimeTasks(visibleRuntimeWork, archivedRuntimeTaskAddressesRef.current)
    },
    [hasCloudBackgroundApi]
  )

  const filterRemovedRuntimeProjects = useCallback(
    (runtimeWork: RuntimeWorkListResponse): RuntimeWorkListResponse =>
      removedRuntimeProjectsRef.current.reduce(
        (current, removed) => removeRuntimeProject(current, removed.projectId, removed.workspace),
        runtimeWork
      ),
    []
  )

  const refreshCloudBackgroundData = useCallback(
    async (
      baseDevices: DeviceInfo[],
      baseRuntimeWork: RuntimeWorkListResponse,
      options?: {
        projects: ProjectWithTasks[]
        standaloneDeviceId: string | null
        trigger?: 'bootstrap' | 'manual-refresh' | 'device-event'
      }
    ) => {
      const backgroundApi = services.cloudBackgroundApi
      const source = cloudSource
      const current = () => ownsDataSource() && cloudSourceRef.current === source && source.api === backgroundApi
      if (!current()) return
      const activeChecks: CloudWorkCheckKey[] = []
      if (backgroundApi?.listTeams) activeChecks.push('teams')
      if (backgroundApi?.listDevices) activeChecks.push('devices')
      if (backgroundApi?.listRuntimeWork) activeChecks.push('runtimeWork')

      if (activeChecks.length === 0) return
      if (cloudRuntimeStateRef.current.inFlightRevision != null) {
        if (options?.trigger !== 'manual-refresh' || !backgroundApi?.listDevices) return
        const inFlightRevision = cloudRuntimeStateRef.current.inFlightRevision
        const devicesResult = await timedWorkbenchBootstrapRequest(
          'cloudDevices',
          backgroundApi.listDevices()
        )
        if (
          !current() ||
          devicesResult.status !== 'fulfilled' ||
          cloudRuntimeStateRef.current.inFlightRevision !== inFlightRevision
        ) {
          return
        }
        const devices = resolveDeviceListWithCache(
          mergeDeviceLists(baseDevices, devicesResult.value)
        )
        dispatch({
          type: 'devices_refreshed',
          devices,
          standaloneDeviceId: getPreferredStandaloneDeviceId(
            devices,
            options?.standaloneDeviceId ?? null
          ),
        })
        return
      }

      const cloudActivityWatermark = runtimeWorkActivityWatermark()
      const startedState = startCloudRuntimeSync(
        cloudRuntimeStateRef.current,
        options?.trigger ?? 'manual-refresh',
        activeChecks
      )
      updateCloudRuntimeState(startedState)
      const revision = startedState.inFlightRevision

      const teamsRequest = backgroundApi?.listTeams
        ? timedWorkbenchBootstrapRequest('cloudTeams', backgroundApi.listTeams())
        : Promise.resolve(undefined)
      const devicesRequest = backgroundApi?.listDevices
        ? timedWorkbenchBootstrapRequest('cloudDevices', backgroundApi.listDevices())
        : Promise.resolve(undefined)
      const runtimeWorkRequest = backgroundApi?.listRuntimeWork
        ? timedWorkbenchBootstrapRequest('cloudRuntimeWork', backgroundApi.listRuntimeWork())
        : Promise.resolve(undefined)
      const devicesResult = await devicesRequest

      if (
        current() &&
        revision != null &&
        cloudRuntimeStateRef.current.inFlightRevision === revision &&
        devicesResult?.status === 'fulfilled'
      ) {
        const devices = resolveDeviceListWithCache(
          mergeDeviceLists(baseDevices, devicesResult.value)
        )
        dispatch({
          type: 'devices_refreshed',
          devices,
          standaloneDeviceId: getPreferredStandaloneDeviceId(
            devices,
            options?.standaloneDeviceId ?? null
          ),
        })
      }

      const [teamsResult, runtimeWorkResult] = await Promise.all([teamsRequest, runtimeWorkRequest])

      if (
        !current() ||
        revision == null ||
        cloudRuntimeStateRef.current.inFlightRevision !== revision
      ) {
        return
      }

      const latestLocalRuntimeWork = localRuntimeWorkRef.current ?? baseRuntimeWork
      const filteredRuntimeWorkResult =
        runtimeWorkResult?.status === 'fulfilled'
          ? {
              status: 'fulfilled' as const,
              value: filterRemovedRuntimeProjects(
                stampRuntimeWorkSnapshot(runtimeWorkResult.value, cloudActivityWatermark)
              ),
            }
          : runtimeWorkResult
      if (filteredRuntimeWorkResult?.status === 'fulfilled') {
        releaseConfirmedArchivedRuntimeTasks(
          mergeRuntimeWorkLists(latestLocalRuntimeWork, filteredRuntimeWorkResult.value, {
            devices: [
              ...baseDevices,
              ...(devicesResult?.status === 'fulfilled' ? devicesResult.value : []),
            ],
          })
        )
      }

      const reconciledRuntimeWorkResult =
        filteredRuntimeWorkResult?.status === 'fulfilled'
          ? {
              status: 'fulfilled' as const,
              value: reconcileCachedRemoteRuntimeWork(
                cachedRemoteRuntimeWorkRef.current.runtimeWork,
                removeRuntimeTasks(
                  filteredRuntimeWorkResult.value,
                  archivedRuntimeTaskAddressesRef.current
                ),
                devicesResult?.status === 'fulfilled' ? devicesResult.value : undefined
              ),
            }
          : runtimeWorkResult
      if (reconciledRuntimeWorkResult?.status === 'fulfilled') {
        cachedRemoteRuntimeWorkRef.current = {
          scope: cacheScope,
          runtimeWork: writeCachedRemoteRuntimeWork(
            cacheScope,
            reconciledRuntimeWorkResult.value,
            devicesResult?.status === 'fulfilled' ? devicesResult.value : undefined
          ),
        }
      }

      const nextCloudState = finishCloudRuntimeSync(cloudRuntimeStateRef.current, revision, {
        teams: teamsResult,
        devices: devicesResult,
        runtimeWork: reconciledRuntimeWorkResult,
      })
      updateCloudRuntimeState(nextCloudState)

      const devices = resolveDeviceListWithCache(selectVisibleDevices(baseDevices, nextCloudState))
      const runtimeWork = selectVisibleRuntimeWork(latestLocalRuntimeWork, nextCloudState, devices)

      dispatch({
        type: 'lists_refreshed',
        projects: options?.projects ?? [],
        devices,
        runtimeWork,
        standaloneDeviceId: getPreferredStandaloneDeviceId(
          devices,
          options?.standaloneDeviceId ?? null
        ),
      })
    },
    [
      dispatch,
      cloudSource,
      filterRemovedRuntimeProjects,
      selectVisibleRuntimeWork,
      services.cloudBackgroundApi,
      ownsDataSource,
      cacheScope,
      releaseConfirmedArchivedRuntimeTasks,
      updateCloudRuntimeState,
    ]
  )

  const loadDevicesForRefresh = useCallback(
    async (options?: DeviceListOptions & { useCacheFallback?: boolean }) => {
      const source = localRuntimeSourceRef.current
      if (!refreshMounted.current || source.userId !== user.id || source.executorClient !== executorClient)
        return null
      const revision = ++deviceReadRevision.current
      const isCurrent = () => refreshMounted.current && localRuntimeSourceRef.current === source &&
        deviceReadRevision.current === revision
      let devices: DeviceInfo[]
      let fromCache = false
      try {
        devices = await (options?.health
          ? executorClient.commands.listDevices({ health: options.health })
          : executorClient.commands.listDevices())
      } catch (error) {
        if (!isCurrent() || isWorkspaceScanCancelled(error) || error instanceof DOMException && error.name === 'AbortError')
          return null
        if (options?.useCacheFallback === false) throw error
        const cachedDevices = readCachedDeviceList()
        if (cachedDevices.length === 0) throw error
        devices = cachedDevices
        fromCache = true
      }
      if (!isCurrent()) return null
      // Callers recheck after their remaining awaits, before publishing or caching devices.
      const completeSnapshot = options?.health !== 'selected' ||
        !devices.some(device => device.capabilities?.includes('kcoder-gateway'))
      return { devices, isCurrent, fromCache, completeSnapshot }
    },
    [executorClient, user.id]
  )

  const refreshWorkLists = useCallback((options?: { requireRuntimeWork?: boolean; refreshDevices?: boolean }) => {
    const source = localRuntimeSourceRef.current
    const context = cloudSource
    const sameSource = () => ownsDataSource() && localRuntimeSourceRef.current === source &&
      cloudSourceRef.current === context
    if (!sameSource()) {
      return options?.requireRuntimeWork
        ? Promise.reject(new Error('Runtime work source changed before refresh'))
        : Promise.resolve()
    }
    const invalidation = source.invalidation
    const read = async () => {
      const revision = ++workRefreshRevision.current
      const activityWatermark = runtimeWorkActivityWatermark()
      const current = () =>
        sameSource() && refreshMounted.current && workRefreshRevision.current === revision
      const [devicesResult, runtimeWorkResult] = await Promise.all([
        // Thread events do not invalidate the device directory. Device events and
        // explicit refreshes retain their own authoritative device reads.
        options?.refreshDevices === false ? Promise.resolve(undefined) : loadDevicesForRefresh(),
        executorClient.runtime
          .listRuntimeWork(partial => {
            if (!current()) return
            const merged = filterRemovedRuntimeProjects(
              mergePartialRuntimeWork(
                localRuntimeWorkRef.current ?? EMPTY_RUNTIME_WORK,
                stampRuntimeWorkSnapshot(partial, activityWatermark)
              )
            )
            localRuntimeWorkRef.current = merged
            dispatch({
              type: 'runtime_work_refreshed',
              runtimeWork: selectVisibleRuntimeWork(
                merged,
                cloudRuntimeStateRef.current,
                devicesRef.current
              ),
            })
          })
          .catch(error => {
            if (options?.requireRuntimeWork) throw error
            return undefined
          }),
      ])
      const deviceRead = devicesResult?.isCurrent() ? devicesResult : null
      if (!current() || options?.requireRuntimeWork && options.refreshDevices !== false && !deviceRead) {
        if (options?.requireRuntimeWork) throw new Error('Runtime work refresh was superseded')
        return
      }
      // Only the final visible projection may refresh the device cache.
      const devices = deviceRead ? resolveDeviceListWithCache(deviceRead.devices, false) : devicesRef.current
      const visibleDevices = deviceRead
        ? resolveDeviceListWithCache(selectVisibleDevices(devices, cloudRuntimeStateRef.current), !deviceRead.fromCache)
        : devices
      const filteredRuntimeWorkResult = runtimeWorkResult
        ? filterRemovedRuntimeProjects(
            mergePartialRuntimeWork(
              localRuntimeWorkRef.current ?? EMPTY_RUNTIME_WORK,
              stampRuntimeWorkSnapshot(runtimeWorkResult, activityWatermark),
              false
            )
          )
        : undefined
      if (filteredRuntimeWorkResult) {
        localRuntimeWorkRef.current = filteredRuntimeWorkResult
      }
      const localRuntimeWork =
        filteredRuntimeWorkResult ?? localRuntimeWorkRef.current ?? EMPTY_RUNTIME_WORK
      if (filteredRuntimeWorkResult && !services.cloudBackgroundApi?.listRuntimeWork) {
        releaseConfirmedArchivedRuntimeTasks(filteredRuntimeWorkResult)
      }
      const runtimeWork = filteredRuntimeWorkResult
        ? selectVisibleRuntimeWork(localRuntimeWork, cloudRuntimeStateRef.current, visibleDevices)
        : hasCloudBackgroundApi
          ? localRuntimeWork
          : filterDisconnectedRemoteRuntimeWork(localRuntimeWork)
      debugRuntimeSidebarState('refresh-resolved', () => ({
        source: filteredRuntimeWorkResult ? 'executor' : 'current-state',
        executorTaskIds: summarizeRuntimeWorkTaskIds(filteredRuntimeWorkResult ?? null),
        visibleTaskIds: summarizeRuntimeWorkTaskIds(runtimeWork),
      }))
      if (deviceRead) dispatch({
        type: 'lists_refreshed',
        projects: state.projects,
        devices: visibleDevices,
        runtimeWork,
        standaloneDeviceId: getPreferredStandaloneDeviceId(visibleDevices, state.standaloneDeviceId),
      })
      else if (filteredRuntimeWorkResult) dispatch({ type: 'runtime_work_refreshed', runtimeWork })
      if (filteredRuntimeWorkResult) source.reconciled = { context, invalidation }
      if (deviceRead) {
        void refreshCloudBackgroundData(devices, localRuntimeWork, {
          projects: state.projects,
          standaloneDeviceId: state.standaloneDeviceId,
          trigger: 'manual-refresh',
        }).catch(() => undefined)
      }
    }
    const reading = read()
    const settled = reading.catch(() => undefined)
    const pending = { context, invalidation, settled }
    source.pending = pending
    void settled.then(() => { if (source.pending === pending) source.pending = undefined })
    return reading
  }, [
    dispatch,
    cloudSource,
    executorClient,
    loadDevicesForRefresh,
    filterRemovedRuntimeProjects,
    refreshCloudBackgroundData,
    ownsDataSource,
    hasCloudBackgroundApi,
    releaseConfirmedArchivedRuntimeTasks,
    selectVisibleRuntimeWork,
    services.cloudBackgroundApi,
    state.projects,
    state.standaloneDeviceId,
  ])

  const refreshCurrentWork = useStableEvent(async () => {
    const source = localRuntimeSourceRef.current
    const context = cloudSourceRef.current
    const current = () => refreshMounted.current && localRuntimeSourceRef.current === source && cloudSourceRef.current === context
    const reconciled = () => source.reconciled?.context === context && source.reconciled.invalidation === source.invalidation
    // An older read cannot cover a newer notification, especially a terminal event.
    while (source.pending?.context === context && source.pending.invalidation === source.invalidation)
      await source.pending.settled
    if (!current() || reconciled()) return
    const reading = refreshWorkLists({ refreshDevices: false, requireRuntimeWork: true })
    const revision = workRefreshRevision.current
    try {
      await reading
    } catch (error) {
      if (current() && revision === workRefreshRevision.current && !isAbortError(error) && !isWorkspaceScanCancelled(error)) throw error
    }
  })

  useEffect(() => {
    let cancelled = false
    let stopHealthCheck: (() => void) | undefined
    const startedAt = nowMs()
    const slowTimer = window.setTimeout(() => {
      if (!cancelled) {
        console.warn('[KCoder Studio] Workbench shell bootstrap is still running after 5000ms.')
      }
    }, 5000)

    async function bootstrap() {
      const [defaultTeamResult, devicesResult] = await Promise.all([
        timedWorkbenchBootstrapRequest('defaultTeam', services.teamApi.getDefaultWorkbenchTeam()),
        timedWorkbenchBootstrapRequest(
          'devices',
          loadDevicesForRefresh({ health: 'selected' })
        ),
      ])

      if (cancelled) return
      window.clearTimeout(slowTimer)

      const elapsedMs = Math.round(nowMs() - startedAt)
      if (elapsedMs > 5000) {
        console.warn(
          `[KCoder Studio] Workbench shell bootstrap completed slowly in ${elapsedMs}ms.`,
          {
            defaultTeam: defaultTeamResult.status,
            devices: devicesResult.status,
          }
        )
      }

      const deviceRead = devicesResult.status === 'fulfilled' && devicesResult.value?.isCurrent()
        ? devicesResult.value : null
      const devices = deviceRead
        ? resolveDeviceListWithCache(deviceRead.devices, !deviceRead.fromCache && deviceRead.completeSnapshot)
        : devicesRef.current
      const standaloneDeviceId = deviceRead ? getRememberedStandaloneDeviceId(user, devices) : undefined

      // Do not force-clear currentProject / runtimeWork here. a CLI launch may
      // open a workspace while bootstrap is still in flight; wiping those fields would
      // leave the UI selected against a stale local-device alias with no online device.
      dispatch({
        type: 'bootstrapped',
        user,
        defaultTeam: defaultTeamResult.status === 'fulfilled' ? defaultTeamResult.value : null,
        projects: [],
        devices: deviceRead ? devices : undefined,
        standaloneDeviceId,
      })

      // Refresh display health once the shell is visible, without gating task loading.
      if (deviceRead && devices.some(device => device.capabilities?.includes('kcoder-gateway'))) {
        const checkHealth = () => {
          if (cancelled || document.visibilityState === 'hidden') return
          document.removeEventListener('visibilitychange', checkHealth)
          void timedWorkbenchBootstrapRequest(
            'deviceHealth',
            loadDevicesForRefresh({ useCacheFallback: false })
          ).then(result => {
            if (cancelled || result.status !== 'fulfilled' || !result.value?.isCurrent() || result.value.devices.length === 0) return
            const refreshedDevices = resolveDeviceListWithCache(result.value.devices, !result.value.fromCache)
            dispatch({
              type: 'devices_refreshed',
              devices: selectVisibleDevices(refreshedDevices, cloudRuntimeStateRef.current),
            })
          })
        }
        stopHealthCheck = () => document.removeEventListener('visibilitychange', checkHealth)
        document.addEventListener('visibilitychange', checkHealth)
        checkHealth()
      }

      void timedWorkbenchBootstrapRequest('runtimeWork', refreshCurrentWork()).then(() => {
        if (cancelled) return
        void refreshCloudBackgroundData(devices, localRuntimeWorkRef.current ?? EMPTY_RUNTIME_WORK, {
          projects: [],
          standaloneDeviceId: standaloneDeviceId ?? null,
          trigger: 'bootstrap',
        }).catch(() => undefined)
      })

      if (defaultTeamResult.status === 'rejected') {
        dispatch({
          type: 'error_set',
          error:
            defaultTeamResult.reason instanceof Error
              ? defaultTeamResult.reason.message
              : 'KCoder Studio default team is not configured',
        })
      }
    }

    void bootstrap()
    return () => {
      cancelled = true
      stopHealthCheck?.()
      window.clearTimeout(slowTimer)
    }
  }, [
    dispatch,
    loadDevicesForRefresh,
    refreshCloudBackgroundData,
    refreshCurrentWork,
    services.teamApi,
    user,
  ])

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let running = false
    let pending = false
    let disposed = false
    const schedule = () => {
      if (disposed) return
      pending = true
      if (running || timer !== undefined) return
      timer = setTimeout(() => {
        timer = undefined
        pending = false
        running = true
        void refreshCurrentWork().catch(error =>
          console.warn(
            '[KCoder] Scheduled work list refresh failed',
            error instanceof Error ? error.name : 'unknown'
          )
        ).finally(() => {
          running = false
          if (pending && !disposed) schedule()
        })
      }, 100)
    }
    const source = localRuntimeSourceRef.current
    const unsubscribe = subscribeRuntimeWorkChanged(() => {
      source.invalidation = {}
      schedule()
    })
    return () => {
      disposed = true
      unsubscribe()
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [executorClient, user.id, refreshCurrentWork])

  const markRuntimeProjectRemoved = useCallback(
    (projectId: number, workspace?: { deviceId: string; workspacePath: string }) => {
      const normalizedWorkspace = workspace
        ? {
            deviceId: workspace.deviceId.trim(),
            workspacePath: normalizeRuntimeWorkspacePath(workspace.workspacePath),
          }
        : undefined
      removedRuntimeProjectsRef.current = [
        ...removedRuntimeProjectsRef.current.filter(removed => removed.projectId !== projectId),
        { projectId, workspace: normalizedWorkspace },
      ]
      if (localRuntimeWorkRef.current) {
        localRuntimeWorkRef.current = removeRuntimeProject(
          localRuntimeWorkRef.current,
          projectId,
          normalizedWorkspace
        )
      }
      cachedRemoteRuntimeWorkRef.current = {
        ...cachedRemoteRuntimeWorkRef.current,
        runtimeWork: removeRuntimeProject(
          cachedRemoteRuntimeWorkRef.current.runtimeWork,
          projectId,
          normalizedWorkspace
        ),
      }
      updateCloudRuntimeState(
        removeRuntimeProjectFromCloudState(
          cloudRuntimeStateRef.current,
          projectId,
          normalizedWorkspace
        )
      )
    },
    [updateCloudRuntimeState]
  )

  const clearRuntimeProjectRemoval = useCallback(
    (workspace: { deviceId: string; workspacePath: string }) => {
      const normalizedDeviceId = workspace.deviceId.trim()
      const normalizedWorkspacePath = normalizeRuntimeWorkspacePath(workspace.workspacePath)
      removedRuntimeProjectsRef.current = removedRuntimeProjectsRef.current.filter(
        removed =>
          !removed.workspace ||
          removed.workspace.deviceId !== normalizedDeviceId ||
          removed.workspace.workspacePath !== normalizedWorkspacePath
      )
    },
    []
  )

  const refreshDevices = useCallback(
    async (options?: { useCacheFallback?: boolean; trigger?: 'device-event' }) => {
      const read = await loadDevicesForRefresh(options)
      if (!read?.isCurrent()) return
      const devices = resolveDeviceListWithCache(read.devices, !read.fromCache)
      dispatch({
        type: 'devices_refreshed',
        devices,
        standaloneDeviceId: getPreferredStandaloneDeviceId(devices, state.standaloneDeviceId),
      })
      void refreshCloudBackgroundData(devices, localRuntimeWorkRef.current ?? EMPTY_RUNTIME_WORK, {
        projects: state.projects,
        standaloneDeviceId: state.standaloneDeviceId,
        trigger: options?.trigger ?? 'manual-refresh',
      }).catch(() => undefined)
    },
    [
      dispatch,
      loadDevicesForRefresh,
      refreshCloudBackgroundData,
      state.projects,
      state.standaloneDeviceId,
    ]
  )

  const getRemoteDeviceStartupCommand =
    useCallback(async (): Promise<DockerRemoteDeviceCommandResponse> => {
      const createCommand = services.deviceApi.createDockerRemoteDeviceCommand
      if (!createCommand) {
        throw new Error('当前连接不支持生成云设备启动脚本')
      }
      return createCommand({ client_origin: window.location.origin })
    }, [services.deviceApi])

  return {
    cloudWorkStatus,
    markRuntimeTasksArchived,
    markRuntimeProjectRemoved,
    clearRuntimeProjectRemoval,
    refreshWorkLists,
    refreshDevices,
    getRemoteDeviceStartupCommand,
  }
}
