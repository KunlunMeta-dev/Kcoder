import type { ModelCatalogTarget } from '@/api/models'
import type { WorkbenchState } from '@/types/workbench'
import { findProjectMetadataDeviceWorkspace } from './workbenchRuntimeHelpers'

export function workbenchModelTarget(state: WorkbenchState): ModelCatalogTarget {
  if (state.currentRuntimeTask?.deviceId) {
    return {
      deviceId: state.currentRuntimeTask.deviceId,
      taskId: state.currentRuntimeTask.taskId,
      workspacePath: state.currentRuntimeTask.workspacePath ?? undefined,
    }
  }
  const workspace = findProjectMetadataDeviceWorkspace(
    state.runtimeWork,
    state.currentProject?.id,
    state.selectedDeviceWorkspaceId
  )
  if (workspace) return { deviceId: workspace.deviceId, workspacePath: workspace.workspacePath }
  return state.currentProject
    ? {}
    : {
        deviceId: state.standaloneDeviceId ?? undefined,
        workspacePath: state.standaloneWorkspacePath ?? undefined,
      }
}
