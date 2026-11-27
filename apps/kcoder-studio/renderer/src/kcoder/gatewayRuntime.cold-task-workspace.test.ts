import { expect, test } from 'vitest'
import { createTestGatewayRuntime, FakeGatewayClient, localGatewayServer } from './gatewayRuntime.test-support'
import { notifyAccountContextChange } from './accountContextEvents'
import { GatewayRpcError } from './gatewayRpc'
import { WorkspaceScanCancelledError } from './workspaceScanError'

const originalWorkspace = '/native/home/Documents/KCoder/owned-studio-task'
const originalTask = { deviceId: 'cross-studio', taskId: 'kcoder:cross-studio:BKMwR', threadId: 'BKMwR' }

function fixture(configure?: (serverId: string, path: string | undefined, client: FakeGatewayClient) => void) {
  const origin = Object.assign(localGatewayServer({ id: 'cross-studio', workspacePath: '/saved/default' }), {
    workspaceHints: { version: 1, paths: [originalWorkspace] },
  })
  const other = localGatewayServer({ id: 'cross-tui', workspacePath: '/other/target' })
  const clients: Array<{ serverId: string; path: string | undefined; client: FakeGatewayClient }> = []
  localStorage.setItem('kcoder-studio:selected-server', other.id)
  const runtime = createTestGatewayRuntime('fixture-token', {
    loadServers: async () => [origin, other],
    createClient: (serverId, _token, _channel, path) => {
      const client = new FakeGatewayClient(null)
      client.threadResumeSupported = true
      if (serverId === origin.id && path === originalWorkspace)
        client.persistedThreads = [{ id: originalTask.threadId, cwd: originalWorkspace, status: 'idle' }]
      configure?.(serverId, path, client)
      clients.push({ serverId, path, client })
      return client
    },
  })
  return { runtime, clients, origin, other }
}

test('a cold ordinary task URL restores its origin target and unregistered Native workspace after a source jump', async () => {
  const f = fixture()
  expect(f.runtime.tasks.size).toBe(0)
  const transcript = await f.runtime.request('runtime.tasks.transcript', {
    ...originalTask, attachToLiveTurn: true,
  })
  expect(transcript).toMatchObject({ taskId: originalTask.taskId, workspacePath: originalWorkspace,
    messages: [{ role: 'user', content: '之前的问题' }] })
  const reads = f.clients.flatMap(({ serverId, path, client }) => client.requests
    .filter(request => ['thread/resume', 'thread/read', 'thread/read/indexed'].includes(request.method))
    .map(request => ({ serverId, path, ...request })))
  expect(reads).toHaveLength(2)
  expect(reads.every(row => row.serverId === originalTask.deviceId && row.path === originalWorkspace &&
    row.params.threadId === originalTask.threadId)).toBe(true)
  expect(f.clients.flatMap(row => row.client.requests)
    .filter(request => ['thread/start', 'turn/start', 'runtime.models.list'].includes(request.method))).toEqual([])
})

test('cold task discovery rejects a conflicting route origin before any Native request', async () => {
  const f = fixture()
  await expect(f.runtime.request('runtime.tasks.transcript', { ...originalTask,
    deviceId: f.other.id, attachToLiveTurn: true })).rejects.toThrow('ORIGINAL_TASK_IDENTITY_CHANGED')
  expect(f.clients).toEqual([])
})

test('nested and compatibility target selectors cannot override an ordinary task URL origin', async () => {
  for (const conflict of [{ address: { deviceId: 'cross-tui' } }, { device_id: 'cross-tui' }]) {
    const f = fixture()
    await expect(f.runtime.request('runtime.tasks.transcript', { ...originalTask, ...conflict,
      attachToLiveTurn: true })).rejects.toThrow('ORIGINAL_TASK_IDENTITY_CHANGED')
    expect(f.clients).toEqual([])
  }
})

test('a truncated Native workspace hint inventory cannot assert a unique original task', async () => {
  const f = fixture()
  Object.assign(f.origin.workspaceHints, { truncated: true })
  await expect(f.runtime.request('runtime.tasks.transcript', { ...originalTask,
    attachToLiveTurn: true })).rejects.toThrow('ORIGINAL_TASK_INDEX_UNAVAILABLE')
  expect(f.clients.flatMap(row => row.client.requests)
    .filter(request => ['thread/resume', 'thread/read', 'turn/start'].includes(request.method))).toEqual([])
})

test('a selected-target navigation while the cold index loads cannot cancel the freshly verified origin task', async () => {
  let navigated = false
  const f = fixture((serverId, path, client) => {
    if (serverId !== originalTask.deviceId || path !== originalWorkspace) return
    const request = client.request.bind(client)
    client.request = async (method, params) => {
      const result = await request(method, params)
      if (method === 'thread/list' && !navigated) {
        navigated = true
        f.runtime.invalidateWorkspaceScans()
      }
      return result
    }
  })
  await expect(f.runtime.request('runtime.tasks.transcript', { ...originalTask,
    attachToLiveTurn: true })).resolves.toMatchObject({ taskId: originalTask.taskId, workspacePath: originalWorkspace })
})

test('two authorized workspaces containing the same original ID remain ambiguous and cannot be resumed', async () => {
  const duplicate = '/native/another-workspace'
  const f = fixture((serverId, path, client) => {
    if (serverId === originalTask.deviceId && path === duplicate)
      client.persistedThreads = [{ id: originalTask.threadId, cwd: duplicate, status: 'idle' }]
  })
  f.origin.workspaceHints.paths.push(duplicate)
  await expect(f.runtime.request('runtime.tasks.transcript', { ...originalTask,
    attachToLiveTurn: true })).rejects.toThrow('ORIGINAL_TASK_INDEX_AMBIGUOUS')
  expect(f.clients.flatMap(row => row.client.requests)
    .filter(request => ['thread/resume', 'thread/read', 'turn/start'].includes(request.method))).toEqual([])
})

test('an account change while reading the real origin index cannot publish or resume a stale task', async () => {
  const f = fixture((serverId, path, client) => {
    if (serverId !== originalTask.deviceId || path !== originalWorkspace) return
    const request = client.request.bind(client)
    client.request = async (method, params) => {
      const result = await request(method, params)
      if (method === 'thread/list') notifyAccountContextChange(originalTask.deviceId)
      return result
    }
  })
  await expect(f.runtime.request('runtime.tasks.transcript', { ...originalTask,
    attachToLiveTurn: true })).rejects.toBeInstanceOf(WorkspaceScanCancelledError)
  expect(f.runtime.tasks.has(originalTask.taskId)).toBe(false)
  expect(f.clients.flatMap(row => row.client.requests)
    .filter(request => ['thread/resume', 'thread/read', 'turn/start'].includes(request.method))).toEqual([])
})

test('same target ID with a replaced command cannot publish an old workspace lookup', async () => {
  let changed = false
  const f = fixture((serverId, path, client) => {
    if (serverId !== originalTask.deviceId || path !== originalWorkspace) return
    const request = client.request.bind(client)
    client.request = async (method, params) => {
      const result = await request(method, params)
      if (method === 'thread/list' && !changed) { changed = true; f.origin.command = '/replacement/native' }
      return result
    }
  })
  await expect(f.runtime.request('runtime.tasks.transcript', { ...originalTask,
    attachToLiveTurn: true })).rejects.toThrow('ORIGINAL_TASK_TARGET_CHANGED')
  expect(f.runtime.tasks.has(originalTask.taskId)).toBe(false)
  expect(f.clients.flatMap(row => row.client.requests)
    .filter(request => ['thread/resume', 'thread/read', 'turn/start'].includes(request.method))).toEqual([])
})

test('a Native index row cannot substitute another cwd for the authorized workspace hint', async () => {
  const f = fixture((serverId, path, client) => {
    if (serverId === originalTask.deviceId && path === originalWorkspace)
      client.persistedThreads = [{ id: originalTask.threadId, cwd: '/foreign/workspace', status: 'idle' }]
  })
  await expect(f.runtime.request('runtime.tasks.transcript', { ...originalTask,
    attachToLiveTurn: true })).rejects.toThrow('ORIGINAL_TASK_INDEX_BINDING_CHANGED')
  expect(f.runtime.tasks.has(originalTask.taskId)).toBe(false)
})

test('cold original-source hydration preserves the canonical expectation and Native history-only result', async () => {
  const expected = { targetId: 'native-original', workspaceId: 'workspace-original', threadId: originalTask.threadId }
  const order: string[] = []
  const f = fixture((serverId, path, client) => {
    if (serverId !== originalTask.deviceId || path !== originalWorkspace) return
    client.resumeFailure = new GatewayRpcError('session is already active in another app-server: /owned/BKMwR.jsonl', -32022)
    Object.assign(client, { expectSessionAddress: (value: unknown) => { expect(value).toEqual(expected); order.push('expect') } })
    const request = client.request.bind(client)
    client.request = async (method, params) => { order.push(method); return request(method, params) }
  })
  const result = await f.runtime.request('runtime.tasks.transcript', { ...originalTask,
    expectedSessionAddress: expected, attachToLiveTurn: true })
  expect(result).toMatchObject({ taskId: originalTask.taskId, workspacePath: originalWorkspace,
    historyReadOnly: true, messages: [{ role: 'user', content: '之前的问题' }] })
  expect(order[order.indexOf('thread/resume') - 1]).toBe('expect')
  expect(order.slice(order.indexOf('thread/resume') + 1, order.indexOf('thread/read'))).toContain('expect')
  expect(f.runtime.clientByTask.has(originalTask.taskId)).toBe(false)
})
