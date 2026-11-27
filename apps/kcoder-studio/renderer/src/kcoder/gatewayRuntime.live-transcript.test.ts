import { expect, test, vi } from 'vitest'
import { subscribeLocalExecutorEvents } from '@/host/localExecutor'
import { notifyAccountContextChange } from './accountContextEvents'
import { createTestGatewayRuntime, FakeGatewayClient, localGatewayServer } from './gatewayRuntime.test-support'
import { GatewayRpcError } from './gatewayRpc'

const address = { deviceId: 'local', taskId: 'kcoder:local:original-live', threadId: 'original-live', workspacePath: '/workspace' }
async function fixture(configure?: (client: FakeGatewayClient) => void) {
  const clients: FakeGatewayClient[] = []
  const server = localGatewayServer()
  const runtime = createTestGatewayRuntime('token', { loadServers: async () => [server], createClient: () => {
    const client = new FakeGatewayClient('original-live'); client.threadResumeSupported = true
    client.persistedThreads = [{ id: 'original-live', cwd: '/workspace', status: 'running' }]
    configure?.(client)
    clients.push(client); return client
  } })
  await runtime.request('runtime.tasks.list', {})
  return { runtime, clients, server }
}
const attach = { ...address, attachToLiveTurn: true }
const canonicalPeerSource = { targetId: 'native-original', workspaceId: 'workspace-original', threadId: address.threadId }

test('a canonical source constraint is installed before every original resume and saved-history read', async () => {
  const order: string[] = []
  const f = await fixture(client => {
    Object.assign(client, { expectSessionAddress: (expected: unknown) => {
      expect(expected).toEqual(canonicalPeerSource); order.push('expect')
    } })
    const request = client.request.bind(client)
    client.request = async (method, params) => { order.push(method); return request(method, params) }
  })
  order.length = 0
  await f.runtime.request('runtime.tasks.transcript', { ...attach, expectedSessionAddress: canonicalPeerSource })
  const resume = order.indexOf('thread/resume'), read = order.indexOf('thread/read')
  expect(resume).toBeGreaterThan(0); expect(read).toBeGreaterThan(resume)
  expect(order[resume - 1]).toBe('expect')
  expect(order.slice(resume + 1, read)).toContain('expect')
})

test('an old client cannot drop the canonical peer source constraint to resume a same-ID task', async () => {
  const f = await fixture()
  await expect(f.runtime.request('runtime.tasks.transcript', { ...attach, expectedSessionAddress: canonicalPeerSource }))
    .rejects.toThrow('SESSION_ADDRESS_EXPECTATION_UNSUPPORTED')
  expect(f.clients.flatMap(client => client.requests).filter(row => ['thread/resume', 'thread/read', 'turn/start'].includes(row.method))).toEqual([])
})

test('view attachment before history loading checks the original canonical target before any resume', async () => {
  const f = await fixture(client => {
    Object.assign(client, { expectSessionAddress: () => { throw new Error('original-native-target-replaced') } })
  })
  await expect(f.runtime.request('runtime.tasks.view.attach', {
    address: { ...address, expectedSessionAddress: canonicalPeerSource }, viewId: 'original-peer-source',
  })).rejects.toThrow('original-native-target-replaced')
  expect(f.clients.flatMap(client => client.requests).filter(row =>
    ['thread/resume', 'gateway/thread/attach', 'turn/start'].includes(row.method))).toEqual([])
})

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

const nativeOwnerBusy = () => new GatewayRpcError(
  'session is already active in another app-server: /owned/original-live.jsonl', -32022)

test('a live Native owner permits a saved original snapshot without repeated resume or control calls', async () => {
  const f = await fixture(client => { client.resumeFailure = nativeOwnerBusy() })
  const baseline = f.clients.flatMap(client => client.requests).length
  const [first, second] = await Promise.all([
    f.runtime.request('runtime.tasks.transcript', attach),
    f.runtime.request('runtime.tasks.transcript', attach),
  ])
  expect(first).toMatchObject({ taskId: address.taskId, workspacePath: '/workspace', historyReadOnly: true,
    messages: [{ role: 'user', content: '之前的问题' }] })
  expect(second.historyReadOnly).toBe(true)
  expect(first.running).toBeUndefined()
  await f.runtime.request('runtime.tasks.transcript', { ...attach, refresh: true })
  await expect(f.runtime.request('runtime.tasks.send', { address, message: 'must remain unsent' }))
    .rejects.toThrow('NATIVE_SESSION_OWNED_ELSEWHERE')
  const requests = f.clients.flatMap(client => client.requests).slice(baseline)
  expect(requests.filter(request => request.method === 'thread/resume')).toHaveLength(1)
  expect(requests.filter(request => ['thread/start', 'turn/start', 'agent/list', 'asyncQuestion/list'].includes(request.method))).toEqual([])
  expect(requests.filter(request => request.method === 'thread/read')).toHaveLength(3)
  expect(f.runtime.clientByTask.has(address.taskId)).toBe(false)
})

test('a failed original snapshot remains a read failure and never becomes an empty successful transcript', async () => {
  const f = await fixture(client => { client.resumeFailure = nativeOwnerBusy(); client.threadReadFailures = 1 })
  await expect(f.runtime.request('runtime.tasks.transcript', attach)).rejects.toThrow('persisted thread not found')
  expect(f.clients.flatMap(client => client.requests).filter(request => request.method === 'thread/resume')).toHaveLength(1)
  expect(f.runtime.clientByTask.has(address.taskId)).toBe(false)
})

test('other Native resume refusals do not grant the saved-history fallback', async () => {
  const f = await fixture(client => { client.resumeFailure = new GatewayRpcError('RUNTIME_PRIVATE_THREAD_REQUEST_CHANGED', -32022) })
  await expect(f.runtime.request('runtime.tasks.transcript', attach)).rejects.toThrow('RUNTIME_PRIVATE_THREAD_REQUEST_CHANGED')
  expect(f.clients.flatMap(client => client.requests).filter(request => request.method === 'thread/read')).toEqual([])
})

test('closing the last snapshot view allows an explicit reopen to acquire its original session', async () => {
  let busy = true
  const f = await fixture(client => { client.resumeFailure = busy ? nativeOwnerBusy() : null })
  await expect(f.runtime.request('runtime.tasks.view.attach', { address, viewId: 'snapshot-view' }))
    .rejects.toThrow('NATIVE_SESSION_OWNED_ELSEWHERE')
  await f.runtime.request('runtime.tasks.transcript', attach)
  await f.runtime.request('runtime.tasks.view.release', { address, viewId: 'snapshot-view' })
  busy = false
  const reopened = await f.runtime.request('runtime.tasks.transcript', attach)
  expect(reopened.historyReadOnly).toBeUndefined()
  expect(f.runtime.clientByTask.has(address.taskId)).toBe(true)
  expect(f.clients.flatMap(client => client.requests).filter(request => request.method === 'thread/resume')).toHaveLength(2)
})

test('a reconnect that encounters another Native owner refreshes history and rechecks question actionability', async ({ onTestFinished }) => {
  let busy = false
  const f = await fixture(client => { client.resumeFailure = busy ? nativeOwnerBusy() : null })
  await f.runtime.request('runtime.tasks.transcript', attach)
  await expect(f.runtime.request('runtime.asyncQuestion.supports', address)).resolves.toMatchObject({
    supported: true, threadId: address.threadId,
  })
  const refreshes: Record<string, unknown>[] = []
  onTestFinished(await subscribeLocalExecutorEvents(event => {
    if (event.event === 'async-question:refresh') refreshes.push(event.payload)
  }))
  const previous = f.runtime.clientByTask.get(address.taskId) as FakeGatewayClient
  busy = true
  previous.close()
  await vi.waitFor(() => {
    expect(f.clients.flatMap(client => client.requests).filter(request => request.method === 'thread/resume')).toHaveLength(2)
    expect(f.runtime.disconnectRecoveryByTask.size).toBe(0)
  })
  const snapshot = await f.runtime.request('runtime.tasks.transcript', attach)
  expect(snapshot.historyReadOnly).toBe(true)
  expect(refreshes).toEqual([{
    taskId: address.taskId, serverId: address.deviceId,
    threadId: address.threadId, workspacePath: address.workspacePath,
  }])
  await expect(f.runtime.request('runtime.asyncQuestion.supports', address))
    .rejects.toThrow('NATIVE_SESSION_OWNED_ELSEWHERE')
  expect(f.clients.flatMap(client => client.requests).filter(request =>
    request.method.startsWith('asyncQuestion/'))).toEqual([])
  expect(f.runtime.clientByTask.has(address.taskId)).toBe(false)
  expect(f.clients.flatMap(client => client.requests).filter(request => request.method === 'thread/resume')).toHaveLength(2)
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
