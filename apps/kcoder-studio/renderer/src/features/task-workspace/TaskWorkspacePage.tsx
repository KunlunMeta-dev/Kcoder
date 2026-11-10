import { TaskChannelBindingControl } from '@/features/connectivity/TaskChannelBindingControl'
import { WorkspacePageHeader } from '@/components/layout/WorkspacePageHeader'
import { usePageSurfaceTransition } from '@/components/layout/pageTransitionAnimation'
import { currentHostDeviceId } from '@/features/runtime-target/currentHostTarget'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Monitor, RefreshCw } from 'lucide-react'
import { useWorkbench } from '@/features/workbench/useWorkbench'
import { workbenchModelTarget } from '@/features/workbench/workbenchModelTarget'
import { getRuntimeTaskWorkspacePath } from '@/features/workbench/workbenchRuntimeHelpers'
import { SettingsSelect } from '@/components/settings/SettingsSelect'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { TaskCapabilityScopeRecords } from './capability-scope/TaskCapabilityScopeRecords'
import { TaskPendingInteractions } from './interactions/TaskPendingInteractions'
import { NativeTaskWorkspace } from './NativeTaskWorkspace'
import { TaskMemberViewer } from './members/TaskMemberViewer'
import { TaskGoalViewer } from './goals/TaskGoalViewer'
import type { TaskGoalReference } from '@/kcoder/taskGoalObservation'
import { TaskWorkflowViewer } from './runs/TaskWorkflowViewer'
import {
  fixedWorkflowDefinition,
  type FixedWorkflowRun,
} from '@/features/workflows/fixedWorkflowRun'
import { TaskArtifactViewer } from './artifacts/TaskArtifactViewer'
import { nativeTaskArtifactPhase } from './artifacts/fixedArtifacts'
import { nativeOfficeReadExport } from '@/features/runtime-governance/nativeOfficeFiles'
import { useRuntimeTaskLifecycle } from '@/features/workbench/runtimeTaskLifecycle'
import type { IntegrationEntityRef } from '../../../../shared/generated/contracts'
import type { RuntimeTaskAddress } from '@/types/api'
import type { BackgroundRunKey } from '../../../../shared/generated/contracts'
import type { TaskWorkspaceTarget } from '@/kcoder/taskWorkspaceTransport'
import { nativeThreadAddress } from './navigation'
import { workspacePathKey } from '@/lib/workspace-path-identity'
import { useContinuousWorks } from './useContinuousWorks'
import { useWorkControl } from './useWorkControl'
import { withRefreshBudget } from './refreshBudget'


export function TaskWorkspacePage() {
  const {
    state,
    services,
    openRuntimeTask,
    refreshWorkLists,
    startNewChat,
    selectStandaloneDevice,
  } = useWorkbench()
  const [member, setMember] = useState<{
    address: RuntimeTaskAddress
    run: BackgroundRunKey
    parentLabel: string
  }>()
  const { t } = useTranslation('taskWorkspace')
  const [goal, setGoal] = useState<{ address: RuntimeTaskAddress; reference: TaskGoalReference }>()
  const [workflow, setWorkflow] = useState<{
    target: TaskWorkspaceTarget
    reference: FixedWorkflowRun
    address?: RuntimeTaskAddress
  }>()
  const [artifacts, setArtifacts] = useState<{
    target: TaskWorkspaceTarget
    threadId: string
    references: IntegrationEntityRef[]
    address?: RuntimeTaskAddress
  }>()
  const pageSurface = usePageSurfaceTransition<HTMLDivElement>(
    artifacts
      ? `artifacts:${artifacts.threadId}`
      : workflow
        ? `workflow:${workflow.reference.runId}`
        : goal
          ? `goal:${goal.reference.threadId}:${goal.reference.goalId}`
          : member
            ? `member:${member.run.parentSessionId}:${member.run.agentId}`
            : 'board'
  )
  const artifactLifecycle = useRuntimeTaskLifecycle(artifacts?.address)
  const artifactPhase = nativeTaskArtifactPhase(
    artifactLifecycle?.task?.turnStatus,
    artifactLifecycle?.derived.isBusy ?? false
  )
  const current = workbenchModelTarget(state)
  const [requested, setRequested] = useState<string>()
  const serverId = state.devices.some(device => device.device_id === requested)
    ? requested!
    : (currentHostDeviceId(state.devices) ?? '')
  const [refreshing, setRefreshing] = useState(false)
  const [workRefreshRevision, setWorkRefreshRevision] = useState(0)
  const [refreshFailed, setRefreshFailed] = useState(false)
  const refreshGeneration = useRef(0)
  const refreshingOwner = useRef<number | null>(null)
  const refreshTasks = useCallback(async () => {
    const owner = refreshGeneration.current
    if (!serverId || refreshingOwner.current === owner) return
    refreshingOwner.current = owner
    setRefreshing(true)
    setRefreshFailed(false)
    try {
      // A target whose app-server is gone must not hold the affordance disabled
      // forever: the read is bounded, and the failure stays visible afterwards.
      await withRefreshBudget(refreshWorkLists())
    } catch {
      if (owner === refreshGeneration.current) setRefreshFailed(true)
    } finally {
      if (refreshingOwner.current === owner) refreshingOwner.current = null
      if (owner === refreshGeneration.current) {
        setRefreshing(false)
        setWorkRefreshRevision(value => value + 1)
      }
    }
  }, [serverId, refreshWorkLists])
  useEffect(() => {
    const generation = refreshGeneration
    generation.current++
    void refreshTasks()
    return () => {
      generation.current++
    }
  }, [refreshTasks, current.workspacePath])
  const workspaces = state.runtimeWork
    ? [
        ...state.runtimeWork.chats,
        ...state.runtimeWork.projects.flatMap(project => project.deviceWorkspaces),
      ]
    : []
  const targetWorkspaces = workspaces.filter(workspace => workspace.deviceId === serverId)
  const workPaths = targetWorkspaces.flatMap(workspace =>
    workspace.tasks.map(task => getRuntimeTaskWorkspacePath(workspace, task))
  )
  const workControl = useWorkControl(serverId)
  const workObservations = useContinuousWorks(
    serverId,
    workPaths,
    refreshing || Boolean(member || goal || workflow || artifacts),
    workRefreshRevision
  )
  const workUnavailable = Object.values(workObservations).some(
    value => value.status === 'unavailable'
  )
  const workPartial = Object.values(workObservations).some(value => value.status === 'partial')
  const tasks = targetWorkspaces.flatMap(workspace =>
    workspace.tasks
      .filter(task => typeof task.threadId === 'string' && task.threadId.length > 0)
      .flatMap(task => {
        const workspacePath = getRuntimeTaskWorkspacePath(workspace, task)
        const observation = workObservations[workspacePathKey(workspacePath)]
        const works = observation?.items.filter(work => work.threadId === task.threadId) ?? []
        const incomplete =
          !observation ||
          observation.status === 'loading' ||
          observation.status === 'partial' ||
          observation.status === 'unavailable'
        const board = {
          task,
          targetLabel:
            workspace.deviceName ||
            state.devices.find(device => device.device_id === serverId)?.name ||
            t('board.currentTarget'),
          stale:
            refreshFailed ||
            !workspace.available ||
            workspace.deviceStatus === 'offline' ||
            state.devices.find(device => device.device_id === serverId)?.status === 'offline' ||
            workspace.threadListSyncFailed === true ||
            workspace.threadsComplete === false ||
            (workspace.threadListIssueCount ?? 0) > 0 ||
            Boolean(workspace.error),
          workScanIncomplete: incomplete,
        }
        if (!works.length)
          return [{ threadId: task.threadId!, title: task.title, workspacePath, board }]
        return works.map(work => ({
          threadId: task.threadId!,
          workId: work.workId,
          title: work.title || task.title,
          workspacePath,
          board: { ...board, task: { ...task, updatedAt: work.updatedAtMs ?? null }, work },
        }))
      })
  )
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <WorkspacePageHeader
        title={t('title')}
        backLabel={t('back')}
        actions={
          <>
            {' '}
            <Button
              variant="ghost"
              size="sm"
              // Kept actionable during a bounded refresh: a dead target must never
              // leave the user without a next step. Duplicate clicks are ignored.
              disabled={!serverId}
              aria-busy={refreshing}
              data-testid="task-workspace-refresh-tasks"
              onClick={() => void refreshTasks()}
            >
              <RefreshCw aria-hidden="true" className="h-4 w-4" />
              {t('refresh')}
            </Button>
            <SettingsSelect
              density="compact"
              icon={<Monitor aria-hidden="true" />}
              aria-label={t('targetLabel')}
              value={serverId}
              onChange={event => {
                setRequested(event.target.value)
                setMember(undefined)
                setArtifacts(undefined)
                setWorkflow(undefined)
                setGoal(undefined)
              }}
            >
              {!serverId && <option value="">{t('noTarget')}</option>}
              {state.devices.map(device => (
                <option key={device.device_id} value={device.device_id}>
                  {device.name}
                </option>
              ))}
            </SettingsSelect>{' '}
          </>
        }
      />
      {refreshFailed && (
        <p
          role="status"
          className="px-6 py-3 text-sm text-text-secondary"
          data-testid="task-workspace-task-list-error"
        >
          {t('errors.unavailable')}
        </p>
      )}
      {(workPartial || workUnavailable) && !refreshFailed && (
        <p role="status" className="px-6 py-3 text-sm text-text-secondary">
          {t(workUnavailable ? 'board.workUnavailable' : 'board.workPartial')}
        </p>
      )}
      {member && member.address.deviceId === serverId && (
        <TaskMemberViewer
          api={services?.runtimeWorkApi}
          address={member.address}
          run={member.run}
          parentLabel={member.parentLabel}
          onClose={() => setMember(undefined)}
          onOpenParent={address => {
            void openRuntimeTask(address)
          }}
        />
      )}
      <div ref={pageSurface} className="min-h-0 flex-1 overflow-y-auto">
        {serverId && artifacts?.target.serverId === serverId ? (
          <TaskArtifactViewer
            target={artifacts.target}
            threadId={artifacts.threadId}
            references={artifacts.references}
            phase={artifactPhase}
            readExport={nativeOfficeReadExport}
            onClose={() => setArtifacts(undefined)}
          />
        ) : serverId && workflow?.target.serverId === serverId ? (
          <TaskWorkflowViewer
            target={workflow.target}
            reference={workflow.reference}
            onClose={() => setWorkflow(undefined)}
            onOpenThread={
              workflow.address
                ? () => {
                    void openRuntimeTask(workflow.address!)
                  }
                : undefined
            }
          />
        ) : serverId && goal?.address.deviceId === serverId ? (
          <TaskGoalViewer
            address={goal.address}
            reference={goal.reference}
            onClose={() => setGoal(undefined)}
            onOpenParent={() => {
              void openRuntimeTask(goal.address)
            }}
          />
        ) : serverId ? (
          <NativeTaskWorkspace
            target={{
              serverId,
              workspacePath: serverId === current.deviceId ? current.workspacePath : undefined,
            }}
            control={workControl}
            tasks={tasks}
            listingState={
              refreshFailed
                ? 'unavailable'
                : refreshing && !state.runtimeWork
                  ? 'loading'
                  : state.runtimeWork
                    ? 'ready'
                    : 'unavailable'
            }
            onNewTask={() => {
              if (serverId === current.deviceId) startNewChat()
              else selectStandaloneDevice(serverId)
            }}
            renderSourceRecords={(target, threadId, onSelectedTarget) => (
              <TaskCapabilityScopeRecords
                target={target}
                threadId={threadId}
                onSelectedTarget={onSelectedTarget}
              />
            )}
            renderPendingInteractions={(target, threadId) => {
              const address = nativeThreadAddress(workspaces, target, { kind: 'thread', threadId })
              return address ? (
                <TaskPendingInteractions
                  embedded
                  address={address}
                  onOpenParent={original => {
                    void openRuntimeTask(original)
                  }}
                />
              ) : (
                <p className="text-sm text-text-secondary">{t('interactionsUnknown')}</p>
              )
            }}
            onOpenArtifacts={(references, target, threadId) => {
              setMember(undefined)
              setWorkflow(undefined)
              setGoal(undefined)
              setArtifacts({
                target: { ...target },
                threadId,
                references: structuredClone(references),
                address: nativeThreadAddress(workspaces, target, { kind: 'thread', threadId }),
              })
            }}
            onOpenAgentRun={
              services?.runtimeWorkApi
                ? (reference, target) => {
                    const run = reference.backgroundRun
                    if (
                      run.parentSessionId !== reference.threadId ||
                      run.agentId !== reference.agentId
                    )
                      return
                    const address = nativeThreadAddress(workspaces, target, {
                      kind: 'thread',
                      threadId: reference.threadId,
                    })
                    if (!address) return
                    const parent = tasks.find(
                      task =>
                        task.threadId === address.threadId &&
                        task.workspacePath === address.workspacePath
                    )
                    setMember({
                      address,
                      run: { ...run },
                      parentLabel: parent?.title ?? reference.threadId,
                    })
                  }
                : undefined
            }
            canOpenReference={(reference, target) =>
              reference.kind === 'workflow_run'
                ? Boolean(fixedWorkflowDefinition(reference))
                : Boolean(
                    nativeThreadAddress(
                      workspaces,
                      target,
                      reference.kind === 'goal'
                        ? { kind: 'thread', threadId: reference.threadId }
                        : reference
                    )
                  )
            }
            renderTaskActions={(target, threadId) => {
              const address = nativeThreadAddress(workspaces, target, { kind: 'thread', threadId })
              return address ? <TaskChannelBindingControl compact key={JSON.stringify(address)} address={address} /> : null
            }}
            onOpenReference={(reference, target) => {
              if (reference.kind === 'goal') {
                const address = nativeThreadAddress(workspaces, target, {
                  kind: 'thread',
                  threadId: reference.threadId,
                })
                if (address) {
                  setMember(undefined)
                  setArtifacts(undefined)
                  setWorkflow(undefined)
                  setGoal({ address, reference: structuredClone(reference) })
                }
                return
              }
              if (reference.kind === 'workflow_run' && fixedWorkflowDefinition(reference)) {
                setGoal(undefined)
                setMember(undefined)
                setArtifacts(undefined)
                setWorkflow({
                  target: { ...target },
                  reference: structuredClone(reference),
                  address: nativeThreadAddress(workspaces, target, {
                    kind: 'thread',
                    threadId: reference.threadId,
                  }),
                })
                return
              }
              const address = nativeThreadAddress(workspaces, target, reference)
              if (address) void openRuntimeTask(address)
            }}
          />
        ) : (
          <p className="p-6 text-sm text-text-muted">{t('noTarget')}</p>
        )}
      </div>
    </div>
  )
}
