import type {
  DeviceInfo,
  ProjectWithTasks,
  RuntimeDeviceWorkspace,
  RuntimeWorkListResponse,
} from '@/types/api'
import { isExecutorVersionCompatible } from './device-capabilities'
import { runtimeProjectUiId } from './runtime-project'

export type ProjectWorkspaceOptionKind = 'empty' | 'single' | 'multi'

export interface ProjectWorkspaceOption {
  kind: ProjectWorkspaceOptionKind
  project: ProjectWithTasks
  workspaces: RuntimeDeviceWorkspace[]
  workspace: RuntimeDeviceWorkspace | null
  selectable: boolean
}

interface BuildProjectWorkspaceOptionsInput {
  projects: ProjectWithTasks[]
  devices: DeviceInfo[]
  runtimeWork: RuntimeWorkListResponse | null | undefined
}

function deviceById(devices: DeviceInfo[]) {
  return new Map(devices.map(device => [device.device_id, device]))
}

function runtimeWorkspacesByProjectId(runtimeWork: RuntimeWorkListResponse | null | undefined) {
  return new Map(
    (runtimeWork?.projects ?? []).map(item => {
      const primaryOrder = new Map(
        (item.project.roots ?? []).map((root, index) => [normalizeWorkspacePath(root.path), index])
      )
      const workspaces = item.deviceWorkspaces
        .map((workspace, index) => ({ workspace, index }))
        .sort((left, right) => {
          const leftOrder = primaryOrder.get(normalizeWorkspacePath(left.workspace.workspacePath))
          const rightOrder = primaryOrder.get(normalizeWorkspacePath(right.workspace.workspacePath))
          if (leftOrder == null && rightOrder == null) return left.index - right.index
          if (leftOrder == null) return 1
          if (rightOrder == null) return -1
          return leftOrder - rightOrder
        })
        .map(item => item.workspace)
      return [runtimeProjectUiId(item.project), workspaces]
    })
  )
}

function normalizeWorkspacePath(path: string): string {
  const trimmed = path.trim()
  if (!trimmed || trimmed === '/') return trimmed || '/'
  return trimmed.replace(/[\\/]+$/, '')
}

export function isSelectableProjectWorkspace(
  workspace: RuntimeDeviceWorkspace | null | undefined,
  devices: DeviceInfo[] = []
): workspace is RuntimeDeviceWorkspace {
  if (!workspace) return false
  if (!workspace.available) return false

  const device = deviceById(devices).get(workspace.deviceId)
  if (device && !isExecutorVersionCompatible(device.executor_version)) {
    return false
  }

  const status = workspace.deviceStatus ?? device?.status
  return status === 'online' || status === 'busy'
}

export function buildProjectWorkspaceOptions({
  projects,
  devices,
  runtimeWork,
}: BuildProjectWorkspaceOptionsInput): ProjectWorkspaceOption[] {
  const workspacesByProjectId = runtimeWorkspacesByProjectId(runtimeWork)

  return projects.map(project => {
    const workspaces = workspacesByProjectId.get(project.id) ?? []
    if (workspaces.length === 0) {
      return {
        kind: 'empty',
        project,
        workspaces,
        workspace: null,
        selectable: false,
      }
    }

    if (workspaces.length === 1) {
      const workspace = workspaces[0]
      return {
        kind: 'single',
        project,
        workspaces,
        workspace,
        selectable: isSelectableProjectWorkspace(workspace, devices),
      }
    }

    return {
      kind: 'multi',
      project,
      workspaces,
      workspace: null,
      selectable: false,
    }
  })
}
