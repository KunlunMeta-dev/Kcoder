import { beforeEach, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ config: vi.fn(), snapshot: vi.fn(), request: vi.fn() }))
vi.mock('./gateway-verification', () => ({ gatewayVerificationConfig: mocks.config }))
vi.mock('@/lib/debugPanel', () => ({ getWorkbenchDebugSnapshot: mocks.snapshot }))
vi.mock('@/tauri/localExecutor', () => ({ requestLocalExecutor: mocks.request }))

import { getActiveToolsCatalog } from './gateway-tools-catalog'

const task = (taskId = 'owned-task') => ({
  workbench: {
    currentRuntimeTask: { taskId, deviceId: 'local', threadId: 'thread', workspacePath: '/owned' },
  },
})

beforeEach(() => {
  vi.resetAllMocks()
  mocks.config.mockReturnValue({ origin: 'http://127.0.0.1:43210' })
  mocks.snapshot.mockReturnValue(task())
  mocks.request.mockResolvedValue({ scope: 'thread', cachePolicy: 'no-store', tools: [] })
})

test('catalog observation is unavailable outside explicit Gateway verification', async () => {
  mocks.config.mockReturnValue(null)
  await expect(getActiveToolsCatalog()).rejects.toThrow('Gateway verification is not active')
  expect(mocks.request).not.toHaveBeenCalled()
})

test('catalog observation requires the current active task', async () => {
  mocks.snapshot.mockReturnValue({ workbench: { currentRuntimeTask: null } })
  await expect(getActiveToolsCatalog()).rejects.toThrow('No active Gateway task')
  expect(mocks.request).not.toHaveBeenCalled()
})

test('only the active task selects the existing read-only catalog method', async () => {
  const result = await getActiveToolsCatalog()
  expect(mocks.request).toHaveBeenCalledWith('runtime.tools.catalog', {
    taskId: 'owned-task',
    serverId: 'local',
  })
  expect(result).toMatchObject({
    taskId: 'owned-task',
    serverId: 'local',
    catalog: { scope: 'thread', cachePolicy: 'no-store' },
  })
})

test('a task switch while reading invalidates the observation', async () => {
  mocks.snapshot.mockReturnValueOnce(task()).mockReturnValueOnce(task('new-task'))
  await expect(getActiveToolsCatalog()).rejects.toThrow('Active Gateway task changed')
})

test('leaving verification while reading invalidates the observation', async () => {
  mocks.config.mockReturnValueOnce({ origin: 'http://127.0.0.1:43210' }).mockReturnValueOnce(null)
  await expect(getActiveToolsCatalog()).rejects.toThrow('Active Gateway task changed')
})
