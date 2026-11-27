import { expect, test } from 'vitest'
import { createTestGatewayRuntime, FakeGatewayClient, localGatewayServer } from './gatewayRuntime.test-support'
import { GatewayRpcError } from './gatewayRpc'

const original = { deviceId: 'origin', taskId: 'kcoder:origin:original', threadId: 'original' }
const cwd = '/native/actual-workspace'

function fixture(readOnly = false) {
  const clients: FakeGatewayClient[] = []
  const runtime = createTestGatewayRuntime('fixture-token', {
    loadServers: async () => [localGatewayServer({ id: original.deviceId, workspacePath: cwd })],
    createClient: () => {
      const client = new FakeGatewayClient(null)
      client.threadResumeSupported = true
      client.persistedThreads = [{ id: original.threadId, cwd, status: 'idle' }]
      if (readOnly) client.resumeFailure = new GatewayRpcError('session is already active in another app-server: /owned/original.jsonl', -32022)
      clients.push(client)
      return client
    },
  })
  return { runtime, clients }
}

test('successful cold Native read projects the verified original address even when the caller has only its task URL', async () => {
  const f = fixture()
  const result = await f.runtime.request('runtime.tasks.transcript', {
    deviceId: original.deviceId, taskId: original.taskId,
  })
  expect(result).toMatchObject({ resolvedAddress: { ...original, workspacePath: cwd,
    runtimeHandle: { threadId: original.threadId } } })
  expect(f.clients.flatMap(client => client.requests).filter(row => row.method === 'thread/read'))
    .toEqual([{ method: 'thread/read', params: { threadId: original.threadId, limit: 50 } }])
})

test('a saved-history-only Native read returns address metadata without promoting its readonly owner', async () => {
  const f = fixture(true)
  const result = await f.runtime.request('runtime.tasks.transcript', { ...original, attachToLiveTurn: true })
  expect(result).toMatchObject({ historyReadOnly: true,
    resolvedAddress: { ...original, workspacePath: cwd } })
  expect(f.runtime.clientByTask.has(original.taskId)).toBe(false)
  expect(f.clients.flatMap(client => client.requests).filter(row => row.method === 'turn/start')).toEqual([])
})

test('an existing presentation alias keeps its previous transcript behavior without receiving a new address projection', async () => {
  const f = fixture()
  await f.runtime.request('runtime.tasks.list', {})
  f.runtime.canonicalTaskByRequested.set('original-creation-alias', original.taskId)
  const result = await f.runtime.request('runtime.tasks.transcript', {
    deviceId: original.deviceId, taskId: 'original-creation-alias',
  })
  expect(result).toMatchObject({ taskId: original.taskId, messages: [{ role: 'user', content: '之前的问题' }] })
  expect(result).not.toHaveProperty('resolvedAddress')
})
