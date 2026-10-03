import type { DeviceInfo, RuntimeWorkListResponse } from '@/types/api'
import { vi } from 'vitest'
import type { ProjectChatControls, ProjectWorkControls } from '../ChatInput'
export function projectChatControls(
  overrides: Partial<ProjectChatControls> = {}
): ProjectChatControls {
  return {
    models: [],
    skills: [],
    selectedModel: null,
    selectedModelOptions: {},
    selectedSkills: [],
    attachments: [],
    uploadingFiles: new Map(),
    errors: new Map(),
    isOptionsLocked: false,
    setSelectedModel: vi.fn(),
    setSelectedModelOption: vi.fn(),
    toggleSkill: vi.fn(),
    handleFileSelect: vi.fn().mockResolvedValue(undefined),
    removeAttachment: vi.fn().mockResolvedValue(undefined),
    listLocalSkills: vi.fn().mockResolvedValue([]),
    listLocalApps: vi.fn().mockResolvedValue([]),
    ...overrides,
  }
}

export const REMOTE_WORKSPACE_TARGET = {
  deviceId: 'remote-device',
  path: '/workspace/project',
  source: 'project',
  workspaceSource: 'remote',
} as const

export function projectWorkControls(
  overrides: Partial<ProjectWorkControls> = {}
): ProjectWorkControls {
  const devices =
    overrides.devices?.map(device => ({
      ...device,
      bind_shell: device.bind_shell ?? 'claudecode',
      executor_version:
        device.bind_shell === 'openclaw'
          ? device.executor_version
          : (device.executor_version ?? '1.8.5'),
    })) ?? []
  const currentProject =
    overrides.currentProject ??
    overrides.projects?.find(project => project.id === overrides.currentProjectId) ??
    null

  return {
    projects: [],
    devices,
    currentProject,
    currentProjectId: undefined,
    currentStandaloneDeviceId: null,
    onSelectProject: vi.fn(),
    onSelectStandaloneDevice: vi.fn(),
    ...overrides,
    devices,
  }
}

export function runtimeWork(
  items: Array<{
    id: number
    name: string
    workspaceId?: number | null
    deviceId?: string
    deviceName?: string
    deviceStatus?: DeviceInfo['status']
    available?: boolean
    workspacePath?: string
  }>
): RuntimeWorkListResponse {
  return {
    projects: items.map(item => ({
      project: { id: item.id, name: item.name },
      deviceWorkspaces: [
        {
          id: item.workspaceId ?? item.id * 10,
          projectId: item.id,
          deviceId: item.deviceId ?? 'device-online',
          deviceName: item.deviceName ?? 'Online Device',
          deviceStatus: item.deviceStatus ?? 'online',
          available: item.available ?? true,
          workspacePath: item.workspacePath ?? `/workspace/${item.name}`,
          mapped: true,
          tasks: [],
        },
      ],
    })),
    chats: [],
    totalTasks: 0,
  }
}
