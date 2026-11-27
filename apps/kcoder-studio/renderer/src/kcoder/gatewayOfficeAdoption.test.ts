import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { clearTestTransports, installTestTransport } from '@/test/runtime-transport'
import { KCoderGatewayRuntime } from './gatewayRuntime'
import { FakeGatewayClient } from './gateway/runtime/contractFixture.test-support'
import { notifyAccountContextChange } from './accountContextEvents'
import { subscribeRuntimeWorkChanged } from './runtimeWorkEvents'

const runtimes = new Set<KCoderGatewayRuntime>()
const request = {
  contractVersion: 'parallel-v1',
  requestId: 'original-request',
  operationId: 'office-original',
  scope: {
    accountId: 'owner',
    targetId: 'native',
    workspaceId: 'workspace',
    identityGeneration: '1',
    targetRevision: '1',
  },
  timeoutMs: 30000,
  payload: {
    id: 'builtin.office-task',
    version: '2',
    startTask: true,
    inputs: { request: '介绍北京' },
  },
}
const accepted = () => ({
  contractVersion: 'parallel-v1',
  requestId: request.requestId,
  operationId: request.operationId,
  status: 'completed',
  entityRevision: null,
  error: null,
  observedAt: '2026-10-29T00:00:00Z',
  result: { nativeTask: { threadId: 'actual-office-thread', turnId: 'turn-1', state: 'running' } },
})
function fixture() {
  const client = new FakeGatewayClient(null),
    original = client.request.bind(client)
  let finish!: (value: unknown) => void
  const calls = vi.spyOn(client, 'request').mockImplementation(async (method, params = {}) =>
    method === 'integrations/assistant/adopt'
      ? new Promise(resolve => {
          finish = resolve
        })
      : original(method, params)
  )
  const runtime = new KCoderGatewayRuntime('owned-test-token', {
    loadServers: async () => [
      { id: 'local', label: 'Local', description: '', transport: 'local', workspacePath: '/owned' },
    ],
    createClient: () => client,
  })
  runtimes.add(runtime)
  return {
    runtime,
    client,
    calls,
    finish: (value: unknown) => finish(value),
    adopt: () =>
      runtime.request('runtime.integrations.request', {
        serverId: 'local',
        workspacePath: '/owned',
        method: 'integrations/assistant/adopt',
        params: request,
      }),
  }
}
beforeEach(() => {
  localStorage.clear()
  installTestTransport(() => undefined)
})
afterEach(async () => {
  await Promise.all([...runtimes].map(runtime => runtime.disposeAsync()))
  runtimes.clear()
  vi.restoreAllMocks()
  clearTestTransports()
})

test('early lifecycle and Ask approval follow real acceptance on the original command client', async () => {
  const f = fixture(),
    changed = vi.fn(),
    unsubscribe = subscribeRuntimeWorkChanged(changed)
  try {
    const result = f.adopt()
    await vi.waitFor(() =>
      expect(f.calls.mock.calls.some(([method]) => method === 'integrations/assistant/adopt')).toBe(
        true
      )
    )
    f.client.dispatchEvent(
      new CustomEvent('notification', {
        detail: {
          method: 'turn/started',
          params: {
            threadId: 'actual-office-thread',
            turnId: 'turn-1',
            attemptId: 'actual-attempt',
            serverId: 'native-process',
            sequence: 1,
          },
        },
      })
    )
    f.client.dispatchEvent(
      new CustomEvent('request', {
        detail: {
          id: 2000001,
          method: 'approval/request',
          params: {
            threadId: 'actual-office-thread',
            turnId: 'turn-1',
            approvalId: 'approval-2000001',
            appServerEpoch: 'native-epoch',
            serverId: 'native-process',
            action: { type: 'tool', name: 'tool_search', input: { query: 'OfficeDocument' } },
          },
        },
      })
    )
    await Promise.resolve()
    expect(f.client.responses).toEqual([])
    f.finish(accepted())
    await result
    await vi.waitFor(() => expect(f.runtime.pendingQuestionByKey.size).toBe(1))
    const task = f.runtime.tasks.get('kcoder:local:actual-office-thread')!
    expect(task).toMatchObject({
      threadId: 'actual-office-thread',
      title: '介绍北京',
      running: true,
      studioWorkMode: 'kworker',
    })
    expect(task.runtimeHandle.memoryTaskSnapshot).toMatchObject({
      attemptId: 'actual-attempt',
      serverInstanceId: 'native-process',
    })
    expect(f.runtime.clientByTask.get(task.taskId)).toBe(f.client)
    expect(changed).toHaveBeenCalled()
    expect(f.client.responses).toEqual([], 'registration cannot approve a tool')
    expect(
      f.calls.mock.calls.filter(([method]) => ['thread/start', 'turn/start'].includes(method))
    ).toEqual([])
    expect(f.runtime.pendingQuestionByKey.values().next().value?.client).toBe(f.client)
  } finally {
    unsubscribe()
  }
})
test('a wrong original operation never registers a task', async () => {
  const f = fixture(),
    result = f.adopt()
  await vi.waitFor(() =>
    expect(f.calls.mock.calls.some(([method]) => method === 'integrations/assistant/adopt')).toBe(
      true
    )
  )
  f.finish({ ...accepted(), operationId: 'other-office-op' })
  await expect(result).rejects.toThrow('INTEGRATION_REPLY_INVALID')
  expect(f.runtime.tasks.size).toBe(0)
  expect(f.runtime.clientByTask.size).toBe(0)
})
test('a replaced account cannot register a late Native acceptance', async () => {
  const f = fixture(),
    result = f.adopt(),
    rejected = result.then(
      () => null,
      error => error
    )
  await vi.waitFor(() =>
    expect(f.calls.mock.calls.some(([method]) => method === 'integrations/assistant/adopt')).toBe(
      true
    )
  )
  notifyAccountContextChange('local')
  f.finish(accepted())
  expect(await rejected).toBeInstanceOf(Error)
  expect(f.runtime.tasks.size).toBe(0)
  expect(f.runtime.clientByTask.size).toBe(0)
})

test('terminal Native acceptance is listed as finished, while a peer client cannot be replaced', async () => {
  const f = fixture(),
    result = f.adopt()
  await vi.waitFor(() =>
    expect(f.calls.mock.calls.some(([method]) => method === 'integrations/assistant/adopt')).toBe(
      true
    )
  )
  const reply = accepted()
  reply.result.nativeTask.state = 'completed'
  f.finish(reply)
  await result
  const task = f.runtime.tasks.get('kcoder:local:actual-office-thread')!
  expect(task).toMatchObject({ running: false })
  const peer = new FakeGatewayClient(null)
  f.runtime.clientByTask.set(task.taskId, peer)
  const second = f.adopt()
  await vi.waitFor(() =>
    expect(
      f.calls.mock.calls.filter(([method]) => method === 'integrations/assistant/adopt')
    ).toHaveLength(2)
  )
  f.finish(accepted())
  await expect(second).rejects.toThrow('INTEGRATION_TASK_OWNER_CHANGED')
  expect(f.runtime.clientByTask.get(task.taskId)).toBe(peer)
  expect(peer.closed).toBe(false)
})
