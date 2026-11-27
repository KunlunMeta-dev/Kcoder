import { describe, expect, test, vi } from 'vitest'
import { createExecutorClientFromApis } from './executorAccess'
import { createDeviceApi } from './devices'
import { createHttpClient } from './http'
import type { DeviceInfo, RuntimeWorkListResponse } from '@/types/api'

function createDevice(overrides: Partial<DeviceInfo> = {}): DeviceInfo {
  return {
    id: 1,
    device_id: 'device-1',
    name: 'Executor',
    status: 'online',
    is_default: true,
    device_type: 'cloud',
    capabilities: ['runtime-work', 'device-commands'],
    executor_version: '1.8.5',
    ...overrides,
  }
}

function createRuntimeWork(): RuntimeWorkListResponse {
  return {
    projects: [],
    chats: [],
    totalTasks: 0,
  }
}

function createApis(devices: DeviceInfo[] = [createDevice()]) {
  const deviceApi = {
    listDevices: vi.fn().mockResolvedValue(devices),
    getHomeDirectory: vi.fn().mockResolvedValue('/Users/me'),
    getProjectWorkspaceRoot: vi.fn().mockResolvedValue('/Users/me/Documents'),
    listDirectories: vi.fn().mockResolvedValue(['/Users/me/project']),
    createDirectory: vi.fn().mockResolvedValue(undefined),
    executeCommand: vi.fn().mockResolvedValue({
      success: true,
      stdout: 'ok',
      stderr: '',
      exit_code: 0,
    }),
    upgradeDevice: vi.fn().mockResolvedValue({ accepted: true }),
    listSkills: vi.fn().mockResolvedValue([]),
    listWorkspaceEntries: vi.fn().mockResolvedValue({
      path: '/Users/me/project',
      entries: [],
    }),
    readWorkspaceTextFile: vi.fn().mockResolvedValue({
      path: '/Users/me/project/README.md',
      name: 'README.md',
      content: 'hello',
      truncated: false,
      size: 5,
    }),
  }
  const runtimeWorkApi = {
    listRuntimeWork: vi.fn().mockResolvedValue(createRuntimeWork()),
    prepareDeviceWorkspace: vi.fn(),
    deleteDeviceWorkspace: vi.fn(),
    getRuntimeTranscript: vi.fn(),
    searchRuntimeWork: vi.fn(),
    revertRuntimeFileChanges: vi.fn(),
    sendRuntimeMessage: vi.fn(),
    rollbackRuntimeTask: vi.fn(),
    compactRuntimeTask: vi.fn(),
    openRuntimeWorkspace: vi.fn(),
    renameRuntimeWorkspace: vi.fn(),
    removeRuntimeWorkspace: vi.fn(),
    archiveRuntimeTask: vi.fn(),
    renameRuntimeTask: vi.fn(),
    listArchivedConversations: vi.fn(),
    archiveConversation: vi.fn(),
    archiveProjectConversations: vi.fn(),
    archiveAllConversations: vi.fn(),
    unarchiveConversation: vi.fn(),
    deleteArchivedConversation: vi.fn(),
    deleteArchivedConversationsBulk: vi.fn(),
    cancelRuntimeTask: vi.fn(),
    createRuntimeTask: vi.fn(),
    forkRuntimeTask: vi.fn(),
  }
  return { deviceApi, runtimeWorkApi }
}

describe('executor access layer', () => {
  test('cold executor lookups already share the HTTP directory read while commands remain independent', async () => {
    let finish!: (response: Response) => void
    const directory = new Promise<Response>(resolve => { finish = resolve })
    let directories = 0
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, options) => {
      if (options?.method === 'GET') {
        directories++
        return directories === 1 ? directory : new Response(JSON.stringify({ items: [createDevice()] }))
      }
      const command = JSON.parse(String(options?.body))
      return new Response(JSON.stringify({ success: true, stderr: '', exit_code: 0,
        stdout: command.command_key === 'workspace_tree' ? { path: '/workspace', entries: [] } : 'main' }))
    })
    const deviceApi = createDeviceApi(createHttpClient({ baseUrl: 'https://executor.test/api', getToken: () => 'owned-fixture' }))
    const client = createExecutorClientFromApis({ transportKind: 'backend-relay', deviceApi,
      runtimeWorkApi: createApis().runtimeWorkApi })
    const requests = Promise.all([
      client.commands.executeCommand('device-1', { command_key: 'git_branch', cwd: '/workspace' }),
      client.commands.executeCommand('device-1', { command_key: 'git_branch', cwd: '/workspace' }),
      client.files.listWorkspaceEntries('device-1', '/workspace'),
    ])
    try {
      expect(directories).toBe(1)
      finish(new Response(JSON.stringify({ items: [createDevice()] })))
      await requests
      expect(fetch.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(3)
      await client.commands.listDevices()
      expect(directories).toBe(2)
    } finally {
      finish(new Response(JSON.stringify({ items: [createDevice()] })))
      await requests.catch(() => undefined)
      fetch.mockRestore()
    }
  })

  test('an executor refresh with a new credential never joins the previous credential HTTP read', async () => {
    let token = 'owned-first'
    const releases: Array<(response: Response) => void> = []
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(resolve => { releases.push(resolve) }))
    const client = createExecutorClientFromApis({ transportKind: 'backend-relay',
      deviceApi: createDeviceApi(createHttpClient({ baseUrl: 'https://executor.test/api', getToken: () => token })),
      runtimeWorkApi: createApis().runtimeWorkApi })
    const first = client.commands.listDevices()
    token = 'owned-second'
    const second = client.commands.listDevices()
    const requests = Promise.all([first, second])
    try {
      expect(fetch).toHaveBeenCalledTimes(2)
      expect(fetch.mock.calls.map(([, options]) => (options?.headers as Record<string, string>).Authorization))
        .toEqual(['Bearer owned-first', 'Bearer owned-second'])
      releases[1](new Response(JSON.stringify({ items: [createDevice({ name: 'Second owner' })] })))
      await expect(second).resolves.toEqual([createDevice({ name: 'Second owner' })])
      releases[0](new Response(JSON.stringify({ items: [createDevice({ name: 'First owner' })] })))
      await expect(first).resolves.toEqual([createDevice({ name: 'First owner' })])
      expect(client.registry.list().map(entry => entry.name)).toEqual(['Second owner'])
    } finally {
      releases.forEach(release => release(new Response(JSON.stringify({ items: [] }))))
      await requests.catch(() => undefined)
      fetch.mockRestore()
    }
  })

  test('refreshes the registry from the configured transport device list', async () => {
    const { deviceApi, runtimeWorkApi } = createApis()
    const client = createExecutorClientFromApis({
      transportKind: 'backend-relay',
      deviceApi,
      runtimeWorkApi,
    })

    await expect(client.commands.listDevices()).resolves.toEqual([createDevice()])
    expect(client.registry.list()).toEqual([
      expect.objectContaining({
        deviceId: 'device-1',
        transportKind: 'backend-relay',
        capabilities: ['runtime-work', 'device-commands'],
      }),
    ])
  })

  test('routes file access through the executor file capability', async () => {
    const { deviceApi, runtimeWorkApi } = createApis()
    const client = createExecutorClientFromApis({
      transportKind: 'local-ipc',
      deviceApi,
      runtimeWorkApi,
    })

    await expect(
      client.files.listWorkspaceEntries('device-1', '/Users/me/project')
    ).resolves.toEqual({
      path: '/Users/me/project',
      entries: [],
    })
    await expect(
      client.files.readWorkspaceTextFile('device-1', '/Users/me/project/README.md')
    ).resolves.toMatchObject({ content: 'hello' })

    expect(deviceApi.listWorkspaceEntries).toHaveBeenCalledWith('device-1', '/Users/me/project')
    expect(deviceApi.readWorkspaceTextFile).toHaveBeenCalledWith(
      'device-1',
      '/Users/me/project/README.md'
    )
  })

  test('normalizes unknown devices into executor-not-found errors', async () => {
    const { deviceApi, runtimeWorkApi } = createApis()
    const client = createExecutorClientFromApis({
      transportKind: 'backend-relay',
      deviceApi,
      runtimeWorkApi,
    })

    await expect(client.commands.getHomeDirectory('missing-device')).rejects.toThrow(
      'executor-not-found:missing-device'
    )
    expect(deviceApi.getHomeDirectory).not.toHaveBeenCalled()
  })

  test('loads a missing executor through the targeted resolver', async () => {
    const { deviceApi, runtimeWorkApi } = createApis()
    const resolveDevice = vi.fn().mockResolvedValue(
      createDevice({
        id: 2,
        device_id: 'cloud-device',
        name: 'Cloud Device',
      })
    )
    const client = createExecutorClientFromApis({
      transportKind: 'backend-relay',
      deviceApi,
      runtimeWorkApi,
      resolveDevice,
    })

    await client.commands.executeCommand('cloud-device', {
      command_key: 'git_branch',
      cwd: '/workspace/cloud',
    })

    expect(resolveDevice).toHaveBeenCalledWith('cloud-device')
    expect(deviceApi.executeCommand).toHaveBeenCalledWith('cloud-device', {
      command_key: 'git_branch',
      cwd: '/workspace/cloud',
    })
  })

  test('normalizes offline devices into executor-offline errors', async () => {
    const { deviceApi, runtimeWorkApi } = createApis([createDevice({ status: 'offline' })])
    const client = createExecutorClientFromApis({
      transportKind: 'backend-relay',
      deviceApi,
      runtimeWorkApi,
    })

    await expect(client.commands.getHomeDirectory('device-1')).rejects.toThrow(
      'executor-offline:device-1'
    )
    expect(deviceApi.getHomeDirectory).not.toHaveBeenCalled()
  })

  test('passes aggregate runtime work calls to the runtime transport', async () => {
    const { runtimeWorkApi, deviceApi } = createApis()
    const client = createExecutorClientFromApis({
      transportKind: 'backend-relay',
      deviceApi,
      runtimeWorkApi,
    })

    await expect(client.runtime.listRuntimeWork()).resolves.toEqual(createRuntimeWork())
    expect(runtimeWorkApi.listRuntimeWork).toHaveBeenCalledTimes(1)
  })
})


test.each(['success', 'failure'])('a superseded cold lookup retains its own result after a newer directory %s', async outcome => {
  let finish!: (devices: DeviceInfo[]) => void
  const first = new Promise<DeviceInfo[]>(resolve => { finish = resolve })
  const oldDevice = createDevice({ device_id: 'old-device', name: 'Old lookup' })
  const currentDevice = createDevice({ device_id: 'new-device', name: 'Current directory' })
  const apis = createApis()
  apis.deviceApi.listDevices.mockImplementationOnce(() => first)
  if (outcome === 'success') apis.deviceApi.listDevices.mockResolvedValueOnce([currentDevice])
  else apis.deviceApi.listDevices.mockRejectedValueOnce(new Error('Owned directory unavailable'))
  const client = createExecutorClientFromApis({ transportKind: 'backend-relay', ...apis })
  const lookup = client.registry.resolve('old-device')
  try {
    const refresh = client.commands.listDevices()
    if (outcome === 'success') await refresh
    else await expect(refresh).rejects.toThrow('Owned directory unavailable')
    finish([oldDevice])
    await expect(lookup).resolves.toMatchObject({ deviceId: 'old-device', name: 'Old lookup' })
    expect(client.registry.list().map(entry => entry.deviceId)).toEqual(outcome === 'success' ? ['new-device'] : [])
    expect(apis.deviceApi.listDevices).toHaveBeenCalledTimes(2)
  } finally { finish([oldDevice]); await lookup.catch(() => undefined) }
})

test('a cold lookup need not wait for a later directory but cannot publish over that pending read', async () => {
  let first!: (devices: DeviceInfo[]) => void, second!: (devices: DeviceInfo[]) => void
  const original = new Promise<DeviceInfo[]>(resolve => { first = resolve })
  const newer = new Promise<DeviceInfo[]>(resolve => { second = resolve })
  const apis = createApis()
  apis.deviceApi.listDevices.mockImplementationOnce(() => original).mockImplementationOnce(() => newer)
  const client = createExecutorClientFromApis({ transportKind: 'backend-relay', ...apis })
  const lookup = client.registry.resolve('old-device')
  const refresh = client.commands.listDevices()
  try {
    first([createDevice({ device_id: 'old-device' })])
    await expect(lookup).resolves.toMatchObject({ deviceId: 'old-device' })
    expect(client.registry.list()).toEqual([])
    second([createDevice({ device_id: 'new-device' })])
    await refresh
    expect(client.registry.list().map(entry => entry.deviceId)).toEqual(['new-device'])
  } finally {
    first([]); second([])
    await Promise.allSettled([lookup, refresh])
  }
})

test.each(['success', 'failure'])('a late detail lookup cannot rewrite the registry after a newer refresh %s', async outcome => {
  let finish!: (device: DeviceInfo) => void
  const detail = new Promise<DeviceInfo>(resolve => { finish = resolve })
  const oldDevice = createDevice({ device_id: 'old-device', name: 'Old detail' })
  const currentDevice = createDevice({ device_id: 'new-device', name: 'Current directory' })
  const apis = createApis()
  const resolveDevice = vi.fn(() => detail)
  const client = createExecutorClientFromApis({ transportKind: 'backend-relay', ...apis, resolveDevice })
  await client.commands.listDevices()
  const lookup = client.registry.resolve('old-device')
  try {
    await vi.waitFor(() => expect(resolveDevice).toHaveBeenCalledTimes(1))
    if (outcome === 'success') apis.deviceApi.listDevices.mockResolvedValueOnce([currentDevice])
    else apis.deviceApi.listDevices.mockRejectedValueOnce(new Error('Owned directory unavailable'))
    const refresh = client.commands.listDevices()
    if (outcome === 'success') await refresh
    else await expect(refresh).rejects.toThrow('Owned directory unavailable')
    finish(oldDevice)
    await expect(lookup).resolves.toMatchObject({ deviceId: 'old-device', name: 'Old detail' })
    expect(client.registry.list().map(entry => entry.deviceId))
      .toEqual([outcome === 'success' ? 'new-device' : 'device-1'])
    expect(resolveDevice).toHaveBeenCalledTimes(1)
    expect(apis.deviceApi.listDevices).toHaveBeenCalledTimes(2)
  } finally { finish(oldDevice); await lookup.catch(() => undefined) }
})
test('source retirement during executor resolution prevents dispatch, while accepted write receipts remain intact', async () => {
  const apis = createApis()
  let source = {}
  const deviceApi = {
    ...apis.deviceApi,
    captureReadSource() {
      expect(this).toBe(deviceApi)
      const owner = source
      return () => source === owner
    },
  }
  let finishDirectory!: (devices: DeviceInfo[]) => void
  deviceApi.listDevices.mockImplementationOnce(() => new Promise(resolve => { finishDirectory = resolve }))
  const client = createExecutorClientFromApis({ ...apis, deviceApi, transportKind: 'local-ipc' })
  const pending = client.commands.executeCommand('device-1', { command_key: 'git_branch' })
  const outcome = pending.catch(error => error)
  source = {}
  finishDirectory([createDevice()])
  expect(await outcome).toMatchObject({ name: 'AbortError' })
  expect(deviceApi.executeCommand).not.toHaveBeenCalled()
  let finishWrite!: (value: { success: boolean; stdout: string; stderr: string; exit_code: number }) => void
  deviceApi.executeCommand.mockImplementationOnce(() => new Promise(resolve => { finishWrite = resolve }))
  const write = client.commands.executeCommand('device-1', { command_key: 'git_commit_all' })
  await vi.waitFor(() => expect(deviceApi.executeCommand).toHaveBeenCalledOnce())
  source = {}
  const receipt = { success: true, stdout: 'owned receipt', stderr: '', exit_code: 0 }
  finishWrite(receipt)
  await expect(write).resolves.toBe(receipt)
})

test.each(['home', 'file', 'search'] as const)('%s lookup cannot dispatch into a replacement source after directory resolution', async operation => {
  const apis = createApis()
  const searchRuntimeWorkspace = vi.fn().mockResolvedValue({ matches: [] })
  let current = true
  let finish!: (devices: DeviceInfo[]) => void
  apis.deviceApi.listDevices.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const client = createExecutorClientFromApis({ ...apis, transportKind: 'local-ipc',
    deviceApi: { ...apis.deviceApi, captureReadSource: () => () => current },
    runtimeWorkApi: { ...apis.runtimeWorkApi, searchRuntimeWorkspace },
  })
  const read = operation === 'home' ? client.commands.getHomeDirectory('device-1')
    : operation === 'file' ? client.files.readWorkspaceTextFile('device-1', '/workspace/README.md')
      : client.files.searchWorkspaceEntries!('device-1', '/workspace', 'owned')
  const result = read.catch(error => error)
  try {
    current = false
    finish([createDevice()])
    expect(await result).toMatchObject({ name: 'AbortError' })
    expect(apis.deviceApi.getHomeDirectory).not.toHaveBeenCalled()
    expect(apis.deviceApi.readWorkspaceTextFile).not.toHaveBeenCalled()
    expect(searchRuntimeWorkspace).not.toHaveBeenCalled()
  } finally { finish([createDevice()]); await result }
})

test.each([false, true])('directory failure retired=%s is published only by its original source', async retired => {
  const apis = createApis()
  let current = true
  let fail!: (error: Error) => void
  apis.deviceApi.listDevices.mockImplementationOnce(() => new Promise((_, reject) => { fail = reject }))
  const client = createExecutorClientFromApis({ ...apis, transportKind: 'local-ipc',
    deviceApi: { ...apis.deviceApi, captureReadSource: () => () => current },
  })
  const error = new Error('owned current directory failure')
  const read = client.commands.getHomeDirectory('device-1').catch(error => error)
  current = !retired
  fail(error)
  if (retired) expect(await read).toMatchObject({ name: 'AbortError' })
  else expect(await read).toBe(error)
  expect(apis.deviceApi.getHomeDirectory).not.toHaveBeenCalled()
})

test('source validation and dispatch share one synchronous boundary after directory discovery', async () => {
  const apis = createApis()
  let current = true
  let outerOwner = true
  const captureReadSource = vi.fn(() => {
    const retireAfterCheck = outerOwner
    outerOwner = false
    return () => {
      // Retire immediately after the outer dispatch fence, not a registry read.
      if (retireAfterCheck) queueMicrotask(() => { current = false })
      return current
    }
  })
  apis.deviceApi.getHomeDirectory.mockImplementationOnce(async () => {
    expect(current).toBe(true)
    return '/owned-source-home'
  })
  const client = createExecutorClientFromApis({ ...apis, transportKind: 'local-ipc',
    deviceApi: { ...apis.deviceApi, captureReadSource },
  })
  await expect(client.commands.getHomeDirectory('device-1')).resolves.toBe('/owned-source-home')
  expect(captureReadSource).toHaveBeenCalled()
  expect(current).toBe(false)
})

function sourceRegistry(apis = createApis(), resolveDevice?: (id: string) => Promise<DeviceInfo | null>) {
  let source = 0
  const captureReadSource = () => {
    const original = source
    return () => original === source
  }
  const client = createExecutorClientFromApis({ ...apis, transportKind: 'local-ipc', resolveDevice,
    deviceApi: { ...apis.deviceApi, captureReadSource },
  })
  return { apis, client, retire: () => { source++ } }
}

test.each(['online', 'offline'] as const)('a warm %s registry snapshot cannot survive its original source', async status => {
  const f = sourceRegistry(createApis([createDevice({ status, name: 'Original' })]))
  await f.client.commands.listDevices()
  f.retire()
  const stale = f.client.registry.list()
  f.apis.deviceApi.listDevices.mockResolvedValue([createDevice({ name: 'Replacement' })])
  const home = await f.client.commands.getHomeDirectory('device-1').catch(error => error)
  expect(stale).toEqual([])
  expect(home).toBe('/Users/me')
  expect(f.client.registry.list().map(entry => entry.name)).toEqual(['Replacement'])
  await f.client.commands.getHomeDirectory('device-1')
  expect(f.apis.deviceApi.listDevices).toHaveBeenCalledTimes(2)
})

test.each(['success', 'failure'] as const)('a retired pending directory %s cannot publish or hold the replacement registry', async outcome => {
  const f = sourceRegistry()
  let finish!: (devices: DeviceInfo[]) => void, fail!: (error: Error) => void
  f.apis.deviceApi.listDevices.mockImplementationOnce(() => new Promise((resolve, reject) => { finish = resolve; fail = reject }))
  const old = f.client.commands.listDevices().then(value => value, error => error)
  try {
    f.retire()
    f.apis.deviceApi.listDevices.mockResolvedValueOnce([createDevice({ name: 'Replacement' })])
    await expect(f.client.commands.listDevices()).resolves.toEqual([createDevice({ name: 'Replacement' })])
    if (outcome === 'success') finish([createDevice({ name: 'Original' })])
    else fail(new Error('old source directory failure'))
    expect(await old).toMatchObject({ name: 'AbortError' })
    expect(f.client.registry.list().map(entry => entry.name)).toEqual(['Replacement'])
  } finally { finish([]); await old }
})

test('a retired targeted lookup cannot return or repopulate an original source entry', async () => {
  let finish!: (device: DeviceInfo) => void
  const detail = vi.fn(() => new Promise<DeviceInfo>(resolve => { finish = resolve }))
  const f = sourceRegistry(createApis([]), detail)
  const old = f.client.registry.resolve('device-1').catch(error => error)
  try {
    await vi.waitFor(() => expect(detail).toHaveBeenCalledOnce())
    f.retire()
    f.apis.deviceApi.listDevices.mockResolvedValueOnce([createDevice({ name: 'Replacement' })])
    await f.client.commands.listDevices()
    finish(createDevice({ name: 'Original detail' }))
    expect(await old).toMatchObject({ name: 'AbortError' })
    expect(f.client.registry.list().map(entry => entry.name)).toEqual(['Replacement'])
  } finally { finish(createDevice()); await old }
})

test('a formerly online target missing from the replacement directory cannot dispatch', async () => {
  const f = sourceRegistry()
  await f.client.commands.listDevices()
  f.retire()
  f.apis.deviceApi.listDevices.mockResolvedValueOnce([])
  await expect(f.client.commands.getHomeDirectory('device-1')).rejects.toThrow('executor-not-found:device-1')
  expect(f.apis.deviceApi.getHomeDirectory).not.toHaveBeenCalled()
  expect(f.client.registry.list()).toEqual([])
})
