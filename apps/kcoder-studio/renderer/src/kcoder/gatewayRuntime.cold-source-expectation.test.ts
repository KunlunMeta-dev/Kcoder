import { expect, test, vi } from 'vitest'
import { createTestGatewayRuntime, FakeGatewayClient, localGatewayServer } from './gatewayRuntime.test-support'
import { GatewayRpcError } from './gatewayRpc'
import { captureAccountContextRevision, notifyAccountContextChange } from './accountContextEvents'
import { bindSessionAddressExpectation, rememberSessionAddressExpectation } from './gateway/runtime/sessionAddressExpectation'
import { WorkspaceScanCancelledError } from './workspaceScanError'

const task = { deviceId: 'origin', taskId: 'kcoder:origin:original', threadId: 'original' }
const cwd = '/native/original-workspace'
const expected = { targetId: 'original-native', workspaceId: 'original-workspace', threadId: task.threadId }
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

test('a canonical cold read constrains a plain attachment first resume before its index is published', async () => {
  const firstIndex = deferred()
  let indexes = 0
  const resumed: unknown[] = []
  const origin = Object.assign(localGatewayServer({ id: task.deviceId, workspacePath: '/saved/default' }), {
    workspaceHints: { version: 1, paths: [cwd] },
  })
  const runtime = createTestGatewayRuntime('fixture-token', {
    loadServers: async () => [origin],
    createClient: (_serverId, _token, _channel, path) => {
      const client = new FakeGatewayClient(null)
      client.threadResumeSupported = true
      if (path !== cwd) return client
      client.persistedThreads = [{ id: task.threadId, cwd, status: 'idle' }]
      let constraint: unknown
      Object.assign(client, { expectSessionAddress: (value: unknown) => { constraint = value } })
      const request = client.request.bind(client)
      client.request = async (method, params) => {
        if (method === 'thread/list') {
          indexes++
          await firstIndex.promise
        }
        if (method === 'thread/resume') {
          resumed.push(constraint)
          throw new GatewayRpcError('session is already active in another app-server: /owned/original.jsonl', -32022)
        }
        return request(method, params)
      }
      return client
    },
  })
  const plain = runtime.request('runtime.tasks.view.attach', { address: task, viewId: 'plain-first' })
  const plainOutcome = plain.catch(error => error)
  await vi.waitFor(() => expect(indexes).toBe(1))
  const canonical = runtime.request('runtime.tasks.transcript', {
    ...task, expectedSessionAddress: expected, attachToLiveTurn: true,
  })
  const canonicalOutcome = canonical.catch(error => error)
  try {
    // The canonical request joins the unfinished inventory; it narrows the shared attachment first.
    expect(indexes).toBe(1)
    firstIndex.resolve()
    await vi.waitFor(() => expect(resumed).toHaveLength(1))
    expect(resumed).toEqual([expected])
    expect(await plainOutcome).toMatchObject({ message: 'NATIVE_SESSION_OWNED_ELSEWHERE' })
    expect(await canonicalOutcome).toMatchObject({ historyReadOnly: true })
    expect(indexes).toBe(1)
  } finally {
    firstIndex.resolve()
    await Promise.allSettled([plainOutcome, canonicalOutcome])
  }
})

test('an old request fence cannot rebind its source selector to a replacement account with the same task ID', async () => {
  const server = localGatewayServer({ id: task.deviceId })
  const runtime = createTestGatewayRuntime('fixture-token', { loadServers: async () => [server] })
  const selector = { taskId: task.taskId, serverId: task.deviceId, threadId: task.threadId }
  const oldAccount = captureAccountContextRevision()
  rememberSessionAddressExpectation(runtime, selector, expected, oldAccount)
  notifyAccountContextChange(task.deviceId)
  const replacement = { ...expected, targetId: 'replacement-native', workspaceId: 'replacement-workspace' }
  rememberSessionAddressExpectation(runtime, selector, replacement)
  expect(() => rememberSessionAddressExpectation(runtime, selector, expected, oldAccount))
    .toThrow('SESSION_ADDRESS_EXPECTATION_OWNER_CHANGED')
  const observed: unknown[] = []
  const client = Object.assign(new FakeGatewayClient(null), {
    expectSessionAddress: (value: unknown) => observed.push(value),
  })
  bindSessionAddressExpectation(runtime, selector, client)
  expect(observed).toEqual([replacement])
})

test('a same-account conflicting selector is refused without clearing the original narrowing constraint', async () => {
  const runtime = createTestGatewayRuntime('fixture-token')
  const selector = { taskId: task.taskId, serverId: task.deviceId, threadId: task.threadId }
  rememberSessionAddressExpectation(runtime, selector, expected)
  const conflict = { ...expected, workspaceId: 'conflicting-workspace' }
  expect(() => rememberSessionAddressExpectation(runtime, selector, conflict))
    .toThrow('SESSION_ADDRESS_EXPECTATION_CONFLICT')
  // A later plain task descriptor/attachment supplies no new selector.
  rememberSessionAddressExpectation(runtime, selector, undefined)
  const observed: unknown[] = []
  const client = Object.assign(new FakeGatewayClient(null), {
    expectSessionAddress: (value: unknown) => observed.push(value),
  })
  bindSessionAddressExpectation(runtime, selector, client)
  expect(observed).toEqual([expected])
})

test('an account change before the first awaited server index rejects the old request before any Native connection', async () => {
  const gate = deferred()
  const clients: FakeGatewayClient[] = []
  const runtime = createTestGatewayRuntime('fixture-token', {
    loadServers: async () => { await gate.promise; return [localGatewayServer({ id: task.deviceId })] },
    createClient: () => { const client = new FakeGatewayClient(null); clients.push(client); return client },
  })
  const loading = runtime.request('runtime.tasks.transcript', {
    ...task, expectedSessionAddress: expected, attachToLiveTurn: true,
  })
  const outcome = loading.catch(error => error)
  notifyAccountContextChange(task.deviceId)
  gate.resolve()
  const result = await outcome
  expect(result).toBeInstanceOf(WorkspaceScanCancelledError)
  expect(clients).toEqual([])
  const replacement = { ...expected, targetId: 'new-scope-native' }
  const selector = { taskId: task.taskId, serverId: task.deviceId, threadId: task.threadId }
  rememberSessionAddressExpectation(runtime, selector, replacement)
  const observed: unknown[] = []
  const client = Object.assign(new FakeGatewayClient(null), {
    expectSessionAddress: (value: unknown) => observed.push(value),
  })
  bindSessionAddressExpectation(runtime, selector, client)
  expect(observed).toEqual([replacement])
})
