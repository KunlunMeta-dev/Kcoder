import { expect, test } from 'vitest'
import { runtimeProjectUiId } from '@/lib/runtime-project'
import { initialWorkbenchState, workbenchReducer } from './workbenchReducer'

const workspacePath = 'C:\\Users\\qa\\projects\\opened'
const deviceId = 'local'
const opened = () => workbenchReducer(initialWorkbenchState, {
  type: 'runtime_workspace_opened', deviceId, workspacePath, label: 'Opened from CLI',
})
const authoritative = (stateDeviceId = deviceId, key = workspacePath) => ({
  projects: [{
    project: { id: 987654, stateDeviceId, key, name: 'Opened from CLI' },
    deviceWorkspaces: [{ deviceId: stateDeviceId, workspacePath, available: true, tasks: [] }],
    totalTasks: 0,
  }],
  chats: [], totalTasks: 0,
})

test.each(['runtime_work_refreshed', 'lists_refreshed'] as const)(
  'CLI workspace selection survives %s assigning the authoritative project UI id', type => {
    const selected = opened()
    const runtimeWork = authoritative()
    expect(selected.currentProject).not.toBeNull()
    expect(selected.currentProject?.id).not.toBe(runtimeProjectUiId(runtimeWork.projects[0].project))
    const refreshed = workbenchReducer(selected, type === 'runtime_work_refreshed'
      ? { type, runtimeWork }
      : { type, runtimeWork, projects: [], devices: [] })
    expect(refreshed.currentProject).toMatchObject({
      id: 987654, name: 'Opened from CLI',
      config: { execution: { deviceId }, workspace: { localPath: workspacePath } },
    })
    expect(refreshed.standaloneWorkspacePath).toBe(workspacePath)
    expect(refreshed.currentRuntimeTask).toBeNull()
  }
)

test.each([
  authoritative('another-target'),
  authoritative(deviceId, 'another-project'),
  { projects: [], chats: [], totalTasks: 0 },
])('a removed CLI project cannot select a different target or project', runtimeWork => {
  const refreshed = workbenchReducer(opened(), { type: 'runtime_work_refreshed', runtimeWork })
  expect(refreshed.currentProject).toBeNull()
})
