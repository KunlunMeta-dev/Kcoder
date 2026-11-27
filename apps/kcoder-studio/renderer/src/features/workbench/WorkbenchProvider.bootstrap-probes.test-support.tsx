/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable react-refresh/only-export-components */
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

export function BootstrapProbe() {
  const workbench = useWorkbench()
  return (
    <div>
      <span data-testid="boot-state">
        {workbench.state.isBootstrapping ? 'loading' : workbench.state.user?.user_name}
      </span>
      <span data-testid="startup-ready">{workbench.isStartupReady ? 'ready' : 'loading'}</span>
      <span data-testid="project-count">{workbench.state.projects.length}</span>
      <span data-testid="runtime-total">{workbench.state.runtimeWork?.totalTasks ?? 0}</span>
      <span data-testid="device-ids">
        {workbench.state.devices.map(device => device.device_id).join('|')}
      </span>
      <button type="button" onClick={() => void workbench.refreshDevices()}>
        Refresh devices
      </button>
    </div>
  )
}

export function CloudWorkStatusProbe() {
  const { cloudWorkStatus } = useWorkbench()
  return (
    <div>
      <span data-testid="cloud-work-availability">{cloudWorkStatus.availability}</span>
      <span data-testid="cloud-work-devices-check">{cloudWorkStatus.checks.devices}</span>
      <span data-testid="cloud-work-error">{cloudWorkStatus.error ?? ''}</span>
    </div>
  )
}

export function DeviceStatusProbe() {
  const workbench = useWorkbench()
  return <span data-testid="device-status">{workbench.state.devices[0]?.status ?? 'missing'}</span>
}

export function RuntimeRunningTasksProbe() {
  const lifecycle = useRuntimeTaskLifecycleStoreSnapshot()
  const runningTaskIds = [...lifecycle.runningTaskKeys].map(key => key.split('\0')[1])
  const { refreshWorkLists } = useWorkbench()
  return <>
    <span data-testid="runtime-running-task-ids">{runningTaskIds.join('|') || 'none'}</span>
    <button onClick={() => void refreshWorkLists()}>refresh work lists</button>
  </>
}

export const TOP_LEVEL_STREAM_ADDRESS: RuntimeTaskAddress = {
  deviceId: 'device-1',
  workspacePath: '/workspace/project-alpha',
  taskId: 'runtime-a',
}

export function RuntimeTopLevelStreamLifecycleProbe() {
  const { subscribeRuntimeTaskStream } = useWorkbench()
  const lifecycle = useRuntimeTaskLifecycle(TOP_LEVEL_STREAM_ADDRESS)

  useEffect(
    () =>
      subscribeRuntimeTaskStream(TOP_LEVEL_STREAM_ADDRESS, {
        onMessageAction: () => undefined,
      }),
    [subscribeRuntimeTaskStream]
  )

  return (
    <span data-testid="top-level-runtime-stream-lifecycle">
      {lifecycle?.derived.isRunning ? 'running' : 'idle'}:{lifecycle?.turn.phase ?? 'missing'}
    </span>
  )
}

export function RemoteRuntimeCacheProbe() {
  const runtimeWork = useWorkbench().state.runtimeWork
  const workspaces = runtimeWork?.projects.flatMap(project => project.deviceWorkspaces) ?? []
  return (
    <div>
      <span data-testid="cached-runtime-project-names">
        {runtimeWork?.projects.map(project => project.project.name).join('|') ?? ''}
      </span>
      <span data-testid="cached-runtime-task-titles">
        {workspaces.flatMap(workspace => workspace.tasks.map(task => task.title)).join('|')}
      </span>
      <span data-testid="cached-runtime-workspace-availability">
        {workspaces.map(workspace => String(workspace.available)).join('|')}
      </span>
      <span data-testid="cached-runtime-device-names">
        {workspaces.map(workspace => workspace.deviceName).join('|')}
      </span>
    </div>
  )
}
