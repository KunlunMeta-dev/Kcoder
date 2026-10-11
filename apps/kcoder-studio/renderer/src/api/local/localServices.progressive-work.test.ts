import { afterEach, expect, test, vi } from 'vitest'
import { createLocalAppServices } from './localServices'
import type { RuntimeWorkListResponse } from '@/types/api'
import { registerGatewayCommandTransport } from '@/kcoder/gatewayServiceBridge'
import { WorkspaceScanCancelledError } from '@/kcoder/workspaceScanError'

afterEach(() => {
  document.head.innerHTML = ''
  vi.restoreAllMocks()
})

test.each([true, false])(
  'rejects list errors but logs only non-cancellation failures (cancelled=%s)',
  async cancelled => {
    const error = cancelled
      ? Object.assign(new Error('Workspace scan invalidated'), {
          name: 'AbortError',
          code: 'KCODER_WORKSPACE_SCAN_CANCELLED',
        })
      : new Error('Workspace scan invalidated')
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const services = createLocalAppServices({
      ensure: async () => ({ ready: true, running: true, deviceId: 'first' }),
      request: vi.fn().mockRejectedValue(error),
      subscribe: async () => () => {},
    })
    await expect(services.runtimeWorkApi.listRuntimeWork()).rejects.toBe(error)
    expect(log).toHaveBeenCalledTimes(cancelled ? 0 : 1)
  }
)

test('preserves cancellation identity through the production Gateway command bridge', async () => {
  const failure = new WorkspaceScanCancelledError()
  const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  const unregister = registerGatewayCommandTransport((command, rawArgs) => {
    expect(command).toBe('local_executor_request')
    expect(rawArgs).toMatchObject({ method: 'runtime.tasks.list' })
    return Promise.reject(failure)
  })
  try {
    const services = createLocalAppServices({
      ensure: async () => ({ ready: true, running: true, deviceId: 'first' }),
      subscribe: async () => () => {},
    })
    await expect(services.runtimeWorkApi.listRuntimeWork()).rejects.toBe(failure)
    expect(log).not.toHaveBeenCalled()
  } finally {
    unregister()
  }
})

test('adapts Gateway progressive snapshots while preserving each project target', async () => {
  document.head.innerHTML = '<meta name="kcoder-rpc-token" content="fixture">'
  const workspace = (deviceId: string) => ({
    deviceId,
    deviceName: deviceId,
    workspacePath: `/${deviceId}`,
    projectKey: `project-${deviceId}`,
    projectSource: 'local_project',
    available: true,
    tasks: [{ taskId: `${deviceId}-task`, title: deviceId }],
  })
  const request = vi
    .fn()
    .mockResolvedValueOnce({
      scanId: 'scan',
      revision: 1,
      complete: false,
      workspaces: [workspace('first')],
    })
    .mockResolvedValueOnce({
      scanId: 'scan',
      revision: 2,
      complete: true,
      workspaces: [workspace('first'), workspace('second')],
    })
  const services = createLocalAppServices({
    subscribe: async () => () => {},
    ensure: async () => ({ running: true, ready: true, deviceId: 'first' }),
    request,
  })
  const partial: RuntimeWorkListResponse[] = []
  const complete = await services.runtimeWorkApi.listRuntimeWork(value => partial.push(value))
  expect(partial).toHaveLength(1)
  expect(
    partial[0].projects.flatMap(project => project.deviceWorkspaces).map(item => item.deviceId)
  ).toEqual(['first'])
  expect(
    complete.projects.flatMap(project => project.deviceWorkspaces).map(item => item.deviceId)
  ).toEqual(['first', 'second'])
  expect(request.mock.calls.map(call => call.slice(0, 2))).toEqual([
    ['runtime.tasks.list', { progressive: true }],
    ['runtime.tasks.list', { progressive: true, scanId: 'scan', afterRevision: 1 }],
  ])
})
