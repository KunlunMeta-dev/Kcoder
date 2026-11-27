import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ProjectWorkControls } from '@/components/chat/ChatInput'
import { captureAccountContextRevision } from '@/kcoder/accountContextEvents'
import { useStableEvent } from '@/features/workbench/useStableEvent'
import { useWorkbenchPaneContext } from '@/features/workbench/useWorkbench'
import type { ProjectWithTasks } from '@/types/api'
import type { EnvironmentDiffMode } from '@/api/environment'
import type { EnvironmentInfo } from '@/types/environment'
import type { WorkspaceTarget } from '@/types/workspace-files'
import { isGitWorkspaceProject } from '@/lib/projectClassification'
import { normalizeRuntimeWorkspacePath, runtimeProjectUiId } from '@/lib/runtime-project'
import { isCloudDevice } from '@/lib/device-selection'
import { isAbortError } from '@/lib/async-errors'
import { findWorkbenchDevice } from '@/lib/workbench-device'
import {
  resolveProjectRuntimeWorkspaceTarget,
  resolveRuntimeWorkspaceContext,
  resolveWorkspaceTarget,
  workspaceTargetKey,
} from '@/lib/workspace-target'
import type { WorkbenchPaneIdentity } from './workbenchPaneIdentity'
import { useRetainedPageVisible } from './retainedPageState'

export interface WorkbenchPaneEnvironment {
  workspaceProject: ProjectWithTasks | null
  workspaceTarget: WorkspaceTarget | null
  workspaceTargetError: string | null
  environmentInfo: EnvironmentInfo
  projectWork: ProjectWorkControls
  refreshEnvironmentInfo: () => Promise<void>
  commitEnvironmentChanges: (message: string) => Promise<void>
  commitAndPushEnvironmentChanges: (message: string) => Promise<void>
  pushEnvironmentChanges: () => Promise<void>
  loadEnvironmentDiff?: (
    workspaceTarget: WorkspaceTarget,
    mode?: EnvironmentDiffMode
  ) => Promise<string>
  listEnvironmentBranches: () => Promise<string[]>
  checkoutEnvironmentBranch: (branchName: string) => Promise<void>
  createEnvironmentBranch: (branchName: string) => Promise<void>
}

export function useWorkbenchPaneEnvironment({
  pane,
  projectWork,
  environmentRefreshActive = false,
  visible = true,
  detailsVisible,
}: {
  pane: WorkbenchPaneIdentity
  projectWork: ProjectWorkControls
  environmentRefreshActive?: boolean
  visible?: boolean
  detailsVisible?: () => boolean
}): WorkbenchPaneEnvironment {
  const pageVisible = useRetainedPageVisible()
  const displayVisible = visible && pageVisible
  const readDetails = useStableEvent(() => displayVisible && detailsVisible?.() === true)
  const {
    state,
    getProjectWorkspaceRoot,
    loadEnvironmentInfo,
    loadEnvironmentDiff,
    commitEnvironmentChanges,
    commitAndPushEnvironmentChanges,
    pushEnvironmentChanges,
    listEnvironmentBranches,
    checkoutEnvironmentBranch,
    createEnvironmentBranch,
  } = useWorkbenchPaneContext()
  const [environmentInfo, setEnvironmentInfo] = useState<EnvironmentInfo>({
    additions: '',
    deletions: '',
    executionTarget: 'local',
  })
  const [workspaceTarget, setWorkspaceTarget] = useState<WorkspaceTarget | null>(null)
  const [workspaceTargetError, setWorkspaceTargetError] = useState<string | null>(null)
  const [workspaceTargetResolving, setWorkspaceTargetResolving] = useState(false)
  const environmentInfoRequestSequence = useRef(0)
  const previousEnvironmentRefreshActive = useRef(false)
  const devicesRef = useRef(state.devices)
  devicesRef.current = state.devices
  const currentRuntimeTask = pane.currentRuntimeTask
  const currentProject = pane.currentProject
  const runtimeWorkspaceContext = useMemo(
    () =>
      resolveRuntimeWorkspaceContext({
        currentRuntimeTask,
        projects: state.projects,
        runtimeWork: state.runtimeWork,
      }),
    [currentRuntimeTask, state.projects, state.runtimeWork]
  )
  const activeConversationProject = currentProject ?? runtimeWorkspaceContext?.project ?? null
  const selectedWorkspaceProject = projectWork.currentProjectId
    ? (projectWork.projects.find(project => project.id === projectWork.currentProjectId) ??
      state.projects.find(project => project.id === projectWork.currentProjectId) ??
      null)
    : null
  const workspaceProject = useMemo(() => {
    if (currentRuntimeTask) {
      return runtimeWorkspaceContext?.project ?? null
    }
    return (
      selectedWorkspaceProject ??
      activeConversationProject ??
      state.projects.find(project => project.config?.mode === 'workspace') ??
      null
    )
  }, [
    activeConversationProject,
    currentRuntimeTask,
    runtimeWorkspaceContext?.project,
    selectedWorkspaceProject,
    state.projects,
  ])
  const workspaceRootsKey = useMemo(() => {
    if (!workspaceProject) return ''
    const projectWork = state.runtimeWork?.projects.find(
      item => String(runtimeProjectUiId(item.project)) === String(workspaceProject.id)
    )
    const projectRoots =
      projectWork?.project.roots
        ?.map(root => normalizeRuntimeWorkspacePath(root.path))
        .filter(Boolean) ?? []
    const roots =
      projectRoots.length > 0
        ? [...new Set(projectRoots)]
        : [
            ...new Set(
              (projectWork?.deviceWorkspaces ?? [])
                .map(workspace => normalizeRuntimeWorkspacePath(workspace.workspacePath))
                .filter(Boolean)
            ),
          ]
    return JSON.stringify(roots)
  }, [state.runtimeWork, workspaceProject])
  const workspaceRoots = useMemo<string[]>(
    () => (workspaceRootsKey ? JSON.parse(workspaceRootsKey) : []),
    [workspaceRootsKey]
  )
  const workspaceTargetResolverApi = useMemo(
    () => ({ getProjectWorkspaceRoot }),
    [getProjectWorkspaceRoot]
  )
  const runtimeWorkspaceTarget = runtimeWorkspaceContext?.workspaceTarget ?? null
  const runtimeWorkspaceTargetKey = workspaceTargetKey(runtimeWorkspaceTarget)
  const projectRuntimeWorkspaceTarget = useMemo(
    () =>
      currentRuntimeTask
        ? null
        : resolveProjectRuntimeWorkspaceTarget({
            currentProject: workspaceProject,
            runtimeWork: state.runtimeWork,
            selectedDeviceWorkspaceId: projectWork.selectedDeviceWorkspaceId,
          }),
    [currentRuntimeTask, projectWork.selectedDeviceWorkspaceId, state.runtimeWork, workspaceProject]
  )
  const projectRuntimeWorkspaceTargetKey = workspaceTargetKey(projectRuntimeWorkspaceTarget)
  const activeWorkspaceTarget = currentRuntimeTask
    ? runtimeWorkspaceTarget
    : (projectRuntimeWorkspaceTarget ?? workspaceTarget)
  const activeWorkspaceTargetKey = workspaceTargetKey(activeWorkspaceTarget)
  const environmentMatchesActiveWorkspace = Boolean(
    activeWorkspaceTarget &&
    environmentInfo.workspacePath === activeWorkspaceTarget.path &&
    environmentInfo.deviceId === activeWorkspaceTarget.deviceId
  )
  const isGitProject = environmentMatchesActiveWorkspace
    ? environmentInfo.isGitRepository !== false
    : Boolean(workspaceProject && isGitWorkspaceProject(workspaceProject))
  const workspaceProjectKey = workspaceProject ? String(workspaceProject.id) : ''
  const activeConversationProjectKey = activeConversationProject
    ? String(activeConversationProject.id)
    : ''
  const currentRuntimeTaskKey = currentRuntimeTask
    ? `${currentRuntimeTask.deviceId}:${currentRuntimeTask.taskId}:${
        currentRuntimeTask.workspacePath ?? ''
      }`
    : ''
  const environmentContextRef = useRef({ workspaceProject, activeWorkspaceTarget })
  const hasEnvironmentProject = Boolean(workspaceProject)
  const environmentWorkspaceReady = !hasEnvironmentProject || Boolean(activeWorkspaceTarget)
  const gitActionsAvailable =
    !environmentMatchesActiveWorkspace || environmentInfo.isGitRepository !== false

  useEffect(() => {
    environmentContextRef.current = { workspaceProject, activeWorkspaceTarget }
    return () => {
      environmentContextRef.current = { workspaceProject: null, activeWorkspaceTarget: null }
    }
  }, [activeWorkspaceTarget, workspaceProject])

  useEffect(() => {
    let cancelled = false

    if (currentRuntimeTask) {
      setWorkspaceTarget(current =>
        workspaceTargetKey(current) === runtimeWorkspaceTargetKey ? current : runtimeWorkspaceTarget
      )
      setWorkspaceTargetError(runtimeWorkspaceTarget ? null : 'Workspace is not ready')
      setWorkspaceTargetResolving(false)
      return () => {
        cancelled = true
      }
    }

    if (projectRuntimeWorkspaceTarget) {
      setWorkspaceTarget(current =>
        workspaceTargetKey(current) === projectRuntimeWorkspaceTargetKey
          ? current
          : projectRuntimeWorkspaceTarget
      )
      setWorkspaceTargetError(null)
      setWorkspaceTargetResolving(false)
      return () => {
        cancelled = true
      }
    }

    setWorkspaceTargetResolving(true)
    setWorkspaceTarget(null)
    setWorkspaceTargetError(null)
    resolveWorkspaceTarget({
      currentProject: workspaceProject,
      api: workspaceTargetResolverApi,
    })
      .then(target => {
        if (!cancelled) {
          setWorkspaceTarget(current =>
            workspaceTargetKey(current) === workspaceTargetKey(target) ? current : target
          )
          setWorkspaceTargetError(null)
          setWorkspaceTargetResolving(false)
        }
      })
      .catch(error => {
        if (!cancelled) {
          setWorkspaceTarget(null)
          setWorkspaceTargetError(
            error instanceof Error ? error.message : 'Failed to resolve workspace'
          )
          setWorkspaceTargetResolving(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [
    currentRuntimeTask,
    projectRuntimeWorkspaceTarget,
    projectRuntimeWorkspaceTargetKey,
    runtimeWorkspaceTarget,
    runtimeWorkspaceTargetKey,
    workspaceProject,
    workspaceTargetResolverApi,
  ])

  const loadCurrentEnvironmentInfo = useCallback(
    async ({ force, showLoading, includePullRequestUrl = readDetails() }: {
      force: boolean
      showLoading: boolean
      includePullRequestUrl?: boolean
    }) => {
      const requestId = environmentInfoRequestSequence.current + 1
      environmentInfoRequestSequence.current = requestId

      if (workspaceTargetResolving) {
        if (showLoading) {
          setEnvironmentInfo(info => ({ ...info, loading: true }))
        }
        return
      }

      if (!environmentWorkspaceReady) {
        setEnvironmentInfo(info => ({
          ...info,
          loading: false,
          error: workspaceTargetError ?? 'Workspace is not ready',
        }))
        return
      }

      if (showLoading) {
        setEnvironmentInfo(info =>
          info.workspacePath === activeWorkspaceTarget?.path &&
          info.deviceId === activeWorkspaceTarget?.deviceId
            ? { ...info, loading: true }
            : {
                additions: '',
                deletions: '',
                executionTarget: info.executionTarget,
                deviceId: activeWorkspaceTarget?.deviceId,
                workspacePath: activeWorkspaceTarget?.path,
                workspaceRoots,
                loading: true,
              }
        )
      }
      try {
        const {
          workspaceProject: latestWorkspaceProject,
          activeWorkspaceTarget: latestActiveWorkspaceTarget,
        } = environmentContextRef.current
        const info = await loadEnvironmentInfo(latestWorkspaceProject, latestActiveWorkspaceTarget, {
          ...(force ? { force: true } : {}),
          includePullRequestUrl,
        })
        if (environmentInfoRequestSequence.current === requestId) {
          const actualDevice = findWorkbenchDevice(
            devicesRef.current,
            latestActiveWorkspaceTarget?.deviceId ?? info.deviceId
          )
          const next: EnvironmentInfo = {
            ...info,
            workspaceRoots,
            executionTarget: actualDevice
              ? isCloudDevice(actualDevice)
                ? 'cloud'
                : 'local'
              : info.executionTarget,
            loading: false,
          }
          // Background polls usually return the same values; keep the previous
          // object so the pane does not re-render every poll.
          setEnvironmentInfo(previous => (sameEnvironmentInfo(previous, next) ? previous : next))
        }
      } catch (error) {
        if (environmentInfoRequestSequence.current === requestId) {
          setEnvironmentInfo(info => ({
            ...info,
            loading: false,
            ...(!isAbortError(error)
              ? { error: error instanceof Error ? error.message : 'Failed to load environment info' } : {}),
          }))
        }
      }
    },
    [
      activeWorkspaceTarget?.deviceId,
      activeWorkspaceTarget?.path,
      environmentWorkspaceReady,
      loadEnvironmentInfo,
      readDetails,
      workspaceRoots,
      workspaceTargetError,
      workspaceTargetResolving,
    ]
  )

  const refreshEnvironmentInfo = useCallback(
    () => loadCurrentEnvironmentInfo({ force: true, showLoading: true, includePullRequestUrl: true }),
    [loadCurrentEnvironmentInfo]
  )

  useEffect(() => {
    if (!displayVisible || (!activeConversationProjectKey && !currentRuntimeTaskKey)) return
    void loadCurrentEnvironmentInfo({ force: false, showLoading: true })
    return () => { environmentInfoRequestSequence.current++ }
  }, [
    displayVisible,
    activeConversationProjectKey,
    activeWorkspaceTargetKey,
    currentRuntimeTaskKey,
    loadCurrentEnvironmentInfo,
    workspaceProjectKey,
  ])

  useEffect(() => {
    const wasRefreshActive = previousEnvironmentRefreshActive.current
    previousEnvironmentRefreshActive.current = environmentRefreshActive

    if (!environmentRefreshActive) {
      if (wasRefreshActive) {
        void loadCurrentEnvironmentInfo({ force: true, showLoading: false })
      }
      return
    }

    if (!displayVisible) return
    let stopped = false
    let timerId: number
    const refreshVisible = async () => {
      if (document.visibilityState === 'visible')
        await loadCurrentEnvironmentInfo({ force: false, showLoading: false })
      if (!stopped) timerId = window.setTimeout(refreshVisible, 5000)
    }
    timerId = window.setTimeout(refreshVisible, 5000)
    return () => {
      stopped = true
      window.clearTimeout(timerId)
    }
  }, [environmentRefreshActive, loadCurrentEnvironmentInfo, displayVisible])

  const loadLatestEnvironmentInfo = useStableEvent(loadCurrentEnvironmentInfo)
  const changeEnvironment = useCallback(async (
    change: (project: ProjectWithTasks | null, target: WorkspaceTarget) => Promise<void>
  ) => {
    const { workspaceProject: project, activeWorkspaceTarget: current } = environmentContextRef.current
    if (!current) throw new Error(workspaceTargetError ?? 'Workspace is not ready')
    const target = { ...current }, account = captureAccountContextRevision()
    environmentInfoRequestSequence.current++
    try { await change(project, target) }
    finally {
      const latest = environmentContextRef.current.activeWorkspaceTarget
      if (latest?.deviceId === target.deviceId && latest.path === target.path && account(target.deviceId))
        void loadLatestEnvironmentInfo({ force: true, showLoading: true })
    }
  }, [loadLatestEnvironmentInfo, workspaceTargetError])

  const commitPaneEnvironmentChanges = useCallback(
    (message: string) => changeEnvironment((project, target) => commitEnvironmentChanges(project, message, target)),
    [changeEnvironment, commitEnvironmentChanges]
  )
  const commitAndPushPaneEnvironmentChanges = useCallback(
    (message: string) => changeEnvironment((project, target) => commitAndPushEnvironmentChanges(project, message, target)),
    [changeEnvironment, commitAndPushEnvironmentChanges]
  )
  const pushPaneEnvironmentChanges = useCallback(
    () => changeEnvironment((project, target) => pushEnvironmentChanges(project, target)),
    [changeEnvironment, pushEnvironmentChanges]
  )

  const listPaneEnvironmentBranches = useCallback(() => {
    const {
      workspaceProject: latestWorkspaceProject,
      activeWorkspaceTarget: latestActiveWorkspaceTarget,
    } = environmentContextRef.current
    if (!latestActiveWorkspaceTarget) {
      return Promise.reject(new Error(workspaceTargetError ?? 'Workspace is not ready'))
    }
    return listEnvironmentBranches(latestWorkspaceProject, latestActiveWorkspaceTarget)
  }, [listEnvironmentBranches, workspaceTargetError])

  const checkoutPaneEnvironmentBranch = useCallback(
    (branch: string) => changeEnvironment((project, target) => checkoutEnvironmentBranch(project, branch, target)),
    [changeEnvironment, checkoutEnvironmentBranch]
  )
  const createPaneEnvironmentBranch = useCallback(
    (branch: string) => changeEnvironment((project, target) => createEnvironmentBranch(project, branch, target)),
    [changeEnvironment, createEnvironmentBranch]
  )

  return {
    workspaceProject,
    workspaceTarget: activeWorkspaceTarget,
    workspaceTargetError,
    environmentInfo,
    projectWork: {
      ...projectWork,
      isGitProject,
      branchName: environmentInfo.branchName,
      branchLoading: environmentInfo.loading,
      onRefreshBranch: undefined,
      onListBranches:
        activeWorkspaceTarget && gitActionsAvailable ? listPaneEnvironmentBranches : undefined,
      onCheckoutBranch: gitActionsAvailable ? checkoutPaneEnvironmentBranch : undefined,
      onCreateBranch: gitActionsAvailable ? createPaneEnvironmentBranch : undefined,
    },
    refreshEnvironmentInfo,
    commitEnvironmentChanges: commitPaneEnvironmentChanges,
    commitAndPushEnvironmentChanges: commitAndPushPaneEnvironmentChanges,
    pushEnvironmentChanges: pushPaneEnvironmentChanges,
    loadEnvironmentDiff:
      activeWorkspaceTarget && gitActionsAvailable
        ? (target, mode) => loadEnvironmentDiff(workspaceProject, target, mode)
        : undefined,
    listEnvironmentBranches: listPaneEnvironmentBranches,
    checkoutEnvironmentBranch: checkoutPaneEnvironmentBranch,
    createEnvironmentBranch: createPaneEnvironmentBranch,
  }
}

/** Value equality for polled environment snapshots. */
export function sameEnvironmentInfo(left: EnvironmentInfo, right: EnvironmentInfo): boolean {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)] as Array<
    keyof EnvironmentInfo
  >)
  for (const key of keys) {
    const a = left[key]
    const b = right[key]
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length || a.some((value, index) => value !== b[index])) return false
    } else if (a !== b) return false
  }
  return true
}
