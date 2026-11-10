import { expect, test, vi } from 'vitest'
import { notifyAccountContextChange } from './accountContextEvents'
import { createTestGatewayRuntime, FakeGatewayClient, localGatewayServer } from './gatewayRuntime.test-support'

const address = { deviceId: 'local', taskId: 'kcoder:local:original-live', threadId: 'original-live', workspacePath: '/workspace' }
async function fixture() {
  const clients: FakeGatewayClient[] = []
  const server = localGatewayServer()
  const runtime = createTestGatewayRuntime('token', { loadServers: async () => [server], createClient: () => {
    const client = new FakeGatewayClient('original-live'); client.threadResumeSupported = true
    client.persistedThreads = [{ id: 'original-live', cwd: '/workspace', status: 'running' }]
    clients.push(client); return client
  } })
  await runtime.request('runtime.tasks.list', {})
  return { runtime, clients, server }
}
const attach = { ...address, attachToLiveTurn: true }
test('explicit live transcript resumes the exact original task and retains its normal owner', async () => {
  const f = await fixture()
  await f.runtime.request('runtime.tasks.transcript', attach)
  const owner = f.runtime.clientByTask.get(address.taskId) as FakeGatewayClient
  expect(owner.requests).toContainEqual({ method: 'thread/resume', params: { threadId: address.threadId } })
  expect(owner.closed).toBe(false)
  expect(owner.requests.filter(r => r.method === 'thread/start' || r.method === 'turn/start')).toEqual([])
  await f.runtime.request('runtime.tasks.transcript', attach)
  expect(f.runtime.clientByTask.get(address.taskId)).toBe(owner)
  expect(owner.requests.filter(r => r.method === 'thread/resume')).toHaveLength(1)
})
test('ordinary transcript reads do not claim a live owner', async () => {
  const f = await fixture()
  await f.runtime.request('runtime.tasks.transcript', address)
  expect(f.runtime.clientByTask.has(address.taskId)).toBe(false)
  expect(f.clients.flatMap(c => c.requests).filter(r => r.method === 'thread/resume')).toEqual([])
})
test('a path-free task link resolves its original workspace from the authenticated index', async () => {
  const f = await fixture()
  const route = { deviceId: attach.deviceId, taskId: attach.taskId,
    threadId: attach.threadId, attachToLiveTurn: true }
  const transcript = await f.runtime.request('runtime.tasks.transcript', route)
  const owner = f.runtime.clientByTask.get(address.taskId) as FakeGatewayClient
  expect(transcript.workspacePath).toBe(address.workspacePath)
  expect(owner.requests).toContainEqual({ method: 'thread/resume', params: { threadId: address.threadId } })
  expect(owner.requests.some(request => request.method === 'thread/start' || request.method === 'turn/start')).toBe(false)
})
test.each(['device', 'thread', 'workspace'] as const)('live transcript rejects a mismatched %s before resume', async mismatch => {
  const f = await fixture()
  const changed = { ...attach, ...(mismatch === 'device' ? { deviceId: 'foreign' } : mismatch === 'thread' ? { threadId: 'foreign' } : { workspacePath: '/foreign' }) }
  await expect(f.runtime.request('runtime.tasks.transcript', changed)).rejects.toThrow('LIVE_TRANSCRIPT_ORIGINAL_OWNER_UNAVAILABLE')
  expect(f.runtime.clientByTask.has(address.taskId)).toBe(false)
  expect(f.clients.flatMap(c => c.requests).filter(r => r.method === 'thread/resume')).toEqual([])
})
test.each(['target', 'account', 'closed', 'failed'] as const)('late %s resume cannot install an original owner', async change => {
  const f = await fixture()
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const original = f.runtime.createClient
  let candidate!: FakeGatewayClient
  Object.assign(f.runtime, { createClient: (...args: Parameters<typeof original>) => {
    candidate = original(...args) as FakeGatewayClient; candidate.resumeGate = gate
    if (change === 'failed') candidate.resumeFailure = new Error('explicit resume rejected')
    return candidate
  } })
  const pending = f.runtime.request('runtime.tasks.transcript', attach)
  const rejected = expect(pending).rejects.toThrow(change === 'failed' ? /explicit resume rejected/ : /ownership changed during resume|Workspace scan invalidated/)
  await vi.waitFor(() => expect(candidate?.requests.some(r => r.method === 'thread/resume')).toBe(true))
  if (change === 'target') f.server.command = '/replaced-target'
  if (change === 'account') notifyAccountContextChange('local')
  if (change === 'closed') candidate.close()
  release(); await rejected
  expect(f.runtime.clientByTask.has(address.taskId)).toBe(false)
  expect(candidate.closed).toBe(true)
})
test('after reconnect an actual approval stays with the newly resumed original owner', async () => {
  const f = await fixture()
  await f.runtime.request('runtime.tasks.transcript', attach)
  const previous = f.runtime.clientByTask.get(address.taskId) as FakeGatewayClient
  previous.close()
  await vi.waitFor(() => expect(f.runtime.clientByTask.get(address.taskId)).toBeDefined())
  const owner = f.runtime.clientByTask.get(address.taskId) as FakeGatewayClient
  expect(owner).not.toBe(previous)
  owner.dispatchEvent(new CustomEvent('request', { detail: { id: 2000001, method: 'approval/request', params: {
    serverId: 'original-instance', threadId: address.threadId, turnId: 'original-turn', approvalId: 'original-approval',
    action: { type: 'tool', name: 'owned-original', input: { operationId: 'original-operation' } }, reason: 'Original explicit action',
  } } }))
  await vi.waitFor(() => expect(f.runtime.pendingQuestionByKey.has(`${address.taskId}\0${2000001}`)).toBe(true))
  await f.runtime.request('runtime.tasks.send', { taskId: address.taskId, requestUserInputResponse: {
    requestId: 2000001, itemId: 'original-approval', answers: { 'original-approval': { answers: ['Allow once'] } },
  } })
  expect(owner.responses).toContainEqual({ id: 2000001, result: { decision: 'accept', approvalId: 'original-approval', threadId: address.threadId, turnId: 'original-turn' } })
  expect(previous.responses).toEqual([])
  expect(owner.requests.some(r => r.method === 'turn/start' || r.method === 'thread/start')).toBe(false)
})

test.each(['target', 'workspace'] as const)('late transcript rejects the same thread after its %s is replaced', async change => {
  const f = await fixture()
  await f.runtime.request('runtime.tasks.transcript', attach)
  const owner = f.runtime.clientByTask.get(address.taskId) as FakeGatewayClient
  let release!: () => void
  let reading = false
  const gate = new Promise<void>(resolve => { release = resolve })
  const original = owner.request.bind(owner)
  owner.request = async <T>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
    if (method === 'thread/read') { reading = true; await gate }
    return original<T>(method, params)
  }
  const pending = f.runtime.request('runtime.tasks.transcript', attach)
  const rejected = expect(pending).rejects.toThrow('LIVE_TRANSCRIPT_ORIGINAL_OWNER_UNAVAILABLE')
  await vi.waitFor(() => expect(reading).toBe(true))
  const current = f.runtime.tasks.get(address.taskId)!
  f.runtime.tasks.set(address.taskId, { ...current, ...(change === 'target' ? { serverId: 'foreign' } : { workspacePath: '/foreign' }) })
  release(); await rejected
  expect(f.runtime.tasks.get(address.taskId)?.threadId).toBe(address.threadId)
  expect(f.runtime.tasks.get(address.taskId)?.serverId).toBe(change === 'target' ? 'foreign' : 'local')
  expect(f.runtime.tasks.get(address.taskId)?.workspacePath).toBe(change === 'workspace' ? '/foreign' : '/workspace')
})
