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

import { createWorkbenchServices } from './WorkbenchProvider.services.test-support'
export function renderWorkbench(children: React.ReactNode, services = createWorkbenchServices()) {
  return render(
    <WorkbenchProvider user={{ id: 1, user_name: 'alice', email: 'a@b.c' }} services={services}>
      <WorkbenchProbeSessionProvider>{children}</WorkbenchProbeSessionProvider>
    </WorkbenchProvider>
  )
}

export function renderWorkbenchForUser(
  children: React.ReactNode,
  user: User,
  services = createWorkbenchServices()
) {
  return render(
    <WorkbenchProvider user={user} services={services}>
      <WorkbenchProbeSessionProvider>{children}</WorkbenchProbeSessionProvider>
    </WorkbenchProvider>
  )
}

export function renderStrictWorkbench(
  children: React.ReactNode,
  services = createWorkbenchServices()
) {
  return render(
    <StrictMode>
      <WorkbenchProvider user={{ id: 1, user_name: 'alice', email: 'a@b.c' }} services={services}>
        {children}
      </WorkbenchProvider>
    </StrictMode>
  )
}

export function renderWorkbenchWithDefaultServices(children: React.ReactNode) {
  const cloudConnectionValue: CloudConnectionContextValue = {
    ...DISCONNECTED_STATE,
    isConnected: false,
    serviceKey: 'test-disconnected',
    connectWithAuthorization: vi.fn(),
    refreshUser: vi.fn(),
    disconnect: vi.fn(),
  }

  return render(
    <CloudConnectionContext.Provider value={cloudConnectionValue}>
      <WorkbenchProvider user={LOCAL_USER}>
        <WorkbenchProbeSessionProvider>{children}</WorkbenchProbeSessionProvider>
      </WorkbenchProvider>
    </CloudConnectionContext.Provider>
  )
}

type WorkbenchProbeSessionValue = {
  workbench: ReturnType<typeof useWorkbench>
  paneSession: ReturnType<typeof useWorkbenchPaneSession>
  currentRuntimeTask: RuntimeTaskAddress | null
}

export const WorkbenchProbeSessionContext = createContext<WorkbenchProbeSessionValue | null>(null)

export function WorkbenchProbeSessionProvider({ children }: { children: React.ReactNode }) {
  const workbench = useWorkbench()
  const { state: workbenchState } = workbench
  const routeRuntimeTask = useRuntimeTaskRouteRestoration()
  const currentRuntimeTask = workbenchState.currentRuntimeTask ?? routeRuntimeTask

  return (
    <WorkbenchProbePaneSession
      key={getWorkbenchPaneKey({
        currentRuntimeTask,
        currentProject: workbenchState.currentProject,
        standaloneChatKey: workbenchState.standaloneChatKey,
      })}
      workbench={workbench}
      currentRuntimeTask={currentRuntimeTask}
    >
      {children}
    </WorkbenchProbePaneSession>
  )
}

export function WorkbenchProbePaneSession({
  children,
  workbench,
  currentRuntimeTask,
}: {
  children: React.ReactNode
  workbench: ReturnType<typeof useWorkbench>
  currentRuntimeTask: RuntimeTaskAddress | null
}) {
  const paneSession = useWorkbenchPaneSession({
    currentRuntimeTask,
  })

  return (
    <WorkbenchProbeSessionContext.Provider value={{ workbench, paneSession, currentRuntimeTask }}>
      {children}
    </WorkbenchProbeSessionContext.Provider>
  )
}

export function useWorkbenchProbeSession() {
  const value = useContext(WorkbenchProbeSessionContext)
  if (!value) {
    throw new Error('useWorkbenchProbeSession must be used within WorkbenchProbeSessionProvider')
  }
  return value
}
