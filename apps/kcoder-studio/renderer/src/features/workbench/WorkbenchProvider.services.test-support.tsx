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
  createDevice,
  createProject,
  createRuntimeGoal,
  createRuntimeWork,
  createTurnFileChanges,
} from './WorkbenchProvider.factories.test-support'
export function createRuntimeWorkApiMock(overrides: Record<string, unknown> = {}) {
  return {
    listRuntimeWork: vi.fn().mockResolvedValue(createRuntimeWork()),
    upsertDeviceWorkspace: vi.fn(),
    prepareDeviceWorkspace: vi.fn(),
    getRuntimeTranscript: vi.fn(async (address: RuntimeTaskAddress) => ({
      taskId: address.taskId,
      workspacePath: '/workspace/project-alpha',
      runtime: 'claude_code',
      messages: [],
    })),
    sendRuntimeMessage: vi.fn().mockResolvedValue({
      accepted: true,
      taskId: 'runtime-a',
    }),
    interruptAndSendRuntimeMessage: vi.fn().mockResolvedValue({
      accepted: true,
      taskId: 'runtime-a',
    }),
    compactRuntimeTask: vi.fn().mockResolvedValue({
      accepted: true,
      taskId: 'runtime-a',
    }),
    editLastUserMessage: vi.fn().mockResolvedValue({
      accepted: true,
      taskId: 'runtime-a',
    }),
    guideRuntimeTask: vi.fn().mockResolvedValue({
      accepted: true,
      success: true,
      taskId: 'runtime-a',
      guidanceId: 'guide-1',
    }),
    openRuntimeWorkspace: vi.fn().mockResolvedValue({
      accepted: true,
      deviceId: 'device-1',
      workspacePath: '/workspace/direct-codex',
      runtime: 'codex',
    }),
    upsertLocalRuntimeProject: vi.fn().mockResolvedValue({
      accepted: true,
      deviceId: 'device-1',
      projectKey: 'multi-project',
      name: 'web',
      roots: ['/workspace/web', '/workspace/api'],
      runtime: 'codex',
    }),
    renameRuntimeWorkspace: vi.fn().mockResolvedValue({
      accepted: true,
      deviceId: 'device-1',
      workspacePath: '/workspace/project-alpha',
      runtime: 'codex',
    }),
    removeRuntimeWorkspace: vi.fn().mockResolvedValue({
      accepted: true,
      deviceId: 'device-1',
      workspacePath: '/workspace/project-alpha',
      runtime: 'codex',
    }),
    syncRuntimeRemoteProjects: vi.fn().mockResolvedValue({
      accepted: true,
      deviceId: 'device-1',
    }),
    activateRuntimeProject: vi.fn().mockResolvedValue({
      accepted: true,
      deviceId: 'device-1',
    }),
    deleteWorktree: vi.fn().mockResolvedValue({ success: true }),
    previewWorktreeArchive: vi.fn().mockResolvedValue({
      success: true,
      deviceId: 'device-1',
      preview: {
        path: '/workspace/project-alpha',
        state: 'active',
        revision: 1,
        contentToken: 'test-token',
        dirty: false,
        untrackedFileCount: 0,
        ignoredEntryCount: 0,
        dirtySubmoduleCount: 0,
        nestedRepositoryCount: 0,
        baselineKnown: true,
        commitsSinceCreation: 0,
        requiresConfirmation: false,
        archiveAllowed: true,
        blockingReasons: [],
      },
    }),
    archiveWorktree: vi.fn().mockResolvedValue({ success: true }),
    restoreWorktree: vi.fn().mockResolvedValue({ success: true }),
    forgetWorktree: vi.fn().mockResolvedValue({ success: true }),
    bindRuntimeTaskImSessions: vi.fn(),
    getImNotificationSettings: vi.fn().mockResolvedValue({
      global: { enabled: false, sessionKey: null, session: null },
      runtimeTaskSubscriptions: [],
    }),
    updateGlobalImNotification: vi.fn(),
    subscribeRuntimeTaskNotifications: vi.fn(),
    unsubscribeRuntimeTaskNotifications: vi.fn(),
    archiveRuntimeTask: vi.fn(),
    archiveConversation: vi.fn().mockResolvedValue({
      accepted: true,
      taskId: 'runtime-a',
      workspacePath: '/workspace/project-alpha',
      runtime: 'codex',
    }),
    archiveProjectConversations: vi.fn().mockResolvedValue({
      accepted: true,
      requestedCount: 1,
      acceptedCount: 1,
      results: [],
    }),
    archiveAllConversations: vi.fn().mockResolvedValue({
      accepted: true,
      requestedCount: 1,
      acceptedCount: 1,
      results: [],
    }),
    cancelRuntimeTask: vi.fn().mockResolvedValue({
      accepted: true,
      taskId: 'runtime-a',
    }),
    revertRuntimeFileChanges: vi.fn().mockResolvedValue({
      fileChanges: {
        ...createTurnFileChanges(),
        status: 'reverted',
        reverted_at: '2026-06-05T00:00:00.000Z',
      },
    }),
    createRuntimeTask: vi.fn().mockResolvedValue({
      accepted: true,
      deviceId: 'device-1',
      taskId: 'runtime-created',
      workspacePath: '/workspace/project-alpha',
      runtime: 'claude_code',
    }),
    getRuntimeGoal: vi.fn().mockResolvedValue({
      accepted: true,
      goal: null,
    }),
    setRuntimeGoal: vi.fn().mockImplementation(request =>
      Promise.resolve({
        accepted: true,
        goal: createRuntimeGoal({
          objective: request.objective ?? '现有目标',
          status: request.status ?? 'active',
        }),
      })
    ),
    clearRuntimeGoal: vi.fn().mockResolvedValue({
      accepted: true,
      goal: null,
    }),
    forkRuntimeTask: vi.fn(),
    ...overrides,
  }
}

export function createWorkbenchServices(
  overrides: Partial<WorkbenchServices> = {}
): WorkbenchServices {
  const base = {
    teamApi: {
      getDefaultWorkbenchTeam: vi.fn().mockResolvedValue({ id: 2, name: 'coder', is_active: true }),
    },
    modelApi: { listModels: vi.fn().mockResolvedValue({ data: [] }) },
    skillApi: {
      listSkills: vi.fn().mockResolvedValue([]),
      getTeamSkills: vi.fn().mockResolvedValue({ skills: [], preload_skills: [] }),
    },
    projectApi: {
      listProjects: vi.fn().mockResolvedValue({ items: [createProject()] }),
      getProject: vi.fn(),
      createProject: vi.fn(),
      updateProject: vi.fn(),
      deleteProject: vi.fn(),
    },
    taskApi: {
      getTurnFileChangesDiff: vi.fn(),
      revertTurnFileChanges: vi.fn(),
    },
    deviceApi: {
      listDevices: vi.fn().mockResolvedValue([createDevice()]),
      getHomeDirectory: vi.fn(),
      getProjectWorkspaceRoot: vi.fn(),
      listDirectories: vi.fn(),
      createDirectory: vi.fn(),
      executeCommand: vi.fn(),
      upgradeDevice: vi.fn(),
      listSkills: vi.fn().mockResolvedValue([]),
    },
    runtimeWorkApi: createRuntimeWorkApiMock(),
    chatStream: {
      subscribe: vi.fn(() => vi.fn()),
    },
  } as unknown as WorkbenchServices

  return {
    ...base,
    ...overrides,
    projectApi: { ...base.projectApi, ...overrides.projectApi },
    taskApi: { ...base.taskApi, ...overrides.taskApi },
    deviceApi: { ...base.deviceApi, ...overrides.deviceApi },
    chatStream: { ...base.chatStream, ...overrides.chatStream },
  } as WorkbenchServices
}

export function hasRuntimeStreamHandler(handlers: ChatStreamHandlers): boolean {
  return Boolean(
    handlers.onChatStart ||
    handlers.onChatChunk ||
    handlers.onChatDone ||
    handlers.onChatError ||
    handlers.onBlockCreated ||
    handlers.onBlockUpdated
  )
}
