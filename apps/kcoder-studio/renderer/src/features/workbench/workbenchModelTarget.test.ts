import { expect, test } from 'vitest'
import { initialWorkbenchState } from './workbenchReducer'
import { workbenchModelTarget } from './workbenchModelTarget'

test('conversation ownership takes precedence over a stale local standalone selection', () => {
  expect(
    workbenchModelTarget({
      ...initialWorkbenchState,
      standaloneDeviceId: 'local',
      currentRuntimeTask: { deviceId: 'ssh', taskId: 'task', workspacePath: '/remote/project' },
    })
  ).toEqual({ deviceId: 'ssh', taskId: 'task', workspacePath: '/remote/project' })
})

test('standalone chats carry their selected target and workspace', () => {
  expect(
    workbenchModelTarget({
      ...initialWorkbenchState,
      standaloneDeviceId: 'ssh',
      standaloneWorkspacePath: '/remote/new-project',
    })
  ).toEqual({ deviceId: 'ssh', workspacePath: '/remote/new-project' })
})

test('projects use the selected workspace target instead of the standalone default', () => {
  const workspace = {
    id: 2,
    projectId: 1,
    deviceId: 'ssh',
    deviceName: 'SSH',
    deviceStatus: 'online' as const,
    workspacePath: '/remote/project',
    mapped: true,
    available: true,
    tasks: [],
  }
  expect(
    workbenchModelTarget({
      ...initialWorkbenchState,
      standaloneDeviceId: 'local',
      currentProject: { id: 1 } as NonNullable<typeof initialWorkbenchState.currentProject>,
      selectedDeviceWorkspaceId: 2,
      runtimeWork: {
        projects: [{ project: { id: 1, name: 'Remote' }, deviceWorkspaces: [workspace] }],
        chats: [],
        totalTasks: 0,
      },
    })
  ).toEqual({ deviceId: 'ssh', workspacePath: '/remote/project' })
})
