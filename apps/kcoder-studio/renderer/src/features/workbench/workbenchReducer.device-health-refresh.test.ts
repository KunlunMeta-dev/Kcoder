import { expect, test } from 'vitest'
import { initialWorkbenchState, workbenchReducer } from './workbenchReducer'
import type { RuntimeDeviceWorkspace } from '@/types/api'

test.each([undefined, 'Workspace directory is unavailable'])(
  'full device health refresh reconciles cached workspace availability while preserving directory errors (%s)',
  error => {
    const offline = { id: 1, device_id: 'local', name: 'Local', status: 'offline' as const, is_default: true }
    const workspace: RuntimeDeviceWorkspace = {
      deviceId: 'local', workspacePath: '/owned/project', deviceStatus: 'offline',
      available: false, mapped: true, tasks: [], ...(error ? { error } : {}),
    }
    const peer: RuntimeDeviceWorkspace = {
      deviceId: 'peer', workspacePath: '/owned/peer', deviceStatus: 'offline',
      available: false, tasks: [],
    }
    const original = {
      ...initialWorkbenchState,
      devices: [offline],
      runtimeWork: {
        projects: [{ project: { id: 7, name: 'Owned project' }, deviceWorkspaces: [workspace] }],
        chats: [peer], totalTasks: 0,
      },
    }
    const updated = workbenchReducer(original, {
      type: 'devices_refreshed', devices: [{ ...offline, status: 'online' }],
    })
    expect(updated.devices[0].status).toBe('online')
    expect(updated.runtimeWork?.projects[0].deviceWorkspaces[0]).toMatchObject({
      deviceStatus: 'online', available: !error, ...(error ? { error } : {}),
    })
    expect(updated.runtimeWork?.chats[0]).toBe(peer)
    expect(workspace.deviceStatus).toBe('offline')

    const empty = workbenchReducer(original, { type: 'devices_refreshed', devices: [] })
    expect(empty.runtimeWork).toBe(original.runtimeWork)
  }
)

test('bootstrap without a current device result keeps the latest reducer-owned devices and selection', () => {
  const device = { id: 2, device_id: 'manual-current', name: 'Manual', status: 'online' as const, is_default: true }
  const state = { ...initialWorkbenchState, devices: [device], standaloneDeviceId: device.device_id }
  const updated = workbenchReducer(state, {
    type: 'bootstrapped', user: { id: 1, user_name: 'owner', email: 'owner@example.com' },
    defaultTeam: null, projects: [],
  })
  expect(updated.devices).toBe(state.devices)
  expect(updated.standaloneDeviceId).toBe(device.device_id)
  expect(updated.isBootstrapping).toBe(false)
})
