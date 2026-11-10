import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  createTestGatewayRuntime,
  FakeGatewayClient,
  localGatewayServer,
} from '../../gatewayRuntime.test-support'
import { forwardAcceptedNotification } from './notifications'
import { emitRuntimeEvent } from '../../gatewayServiceBridge'
import { notifyAccountContextChange } from '../../accountContextEvents'
import type { GatewayRuntimeCore } from './core'
vi.mock('../../gatewayServiceBridge', async original => ({
  ...(await original<typeof import('../../gatewayServiceBridge')>()),
  emitRuntimeEvent: vi.fn(),
}))
const runtimes: ReturnType<typeof createTestGatewayRuntime>[] = []
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.dispose()
  vi.clearAllMocks()
})
async function setup() {
  const client = new FakeGatewayClient('exact-parent')
  const runtime = createTestGatewayRuntime('owned-token', {
    loadServers: async () => [localGatewayServer()],
    createClient: () => client,
  })
  runtimes.push(runtime)
  const created = (await runtime.request('runtime.tasks.create', {
    taskId: 'exact-parent-draft',
    executionRequest: { prompt: 'Owned fixture' },
  })) as { taskId: string }
  const core = runtime as unknown as GatewayRuntimeCore
  const task = core.tasks.get(created.taskId)!
  const address = {
    runtime: 'kcoder' as const,
    deviceId: task.serverId,
    taskId: task.taskId,
    threadId: task.threadId,
    workspacePath: task.workspacePath,
  }
  const run = { parentSessionId: task.threadId, agentId: 'exact-child', runId: 'original-run' }
  const calls: { method: string; params: Record<string, unknown> }[] = []
  const original = client.request.bind(client)
  const summary = {
    agentId: run.agentId,
    status: 'completed',
    acceptingMessages: false,
    queueDepth: 0,
    backgroundRun: run,
  }
  client.request = async <T>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
    if (method.startsWith('agent/')) {
      calls.push({ method, params })
      if (method === 'agent/list') return { threadId: task.threadId, agents: [summary] } as T
      if (method === 'agent/stream/subscribe')
        return {
          threadId: task.threadId,
          agentId: run.agentId,
          runId: run.runId,
          subscriptionId: params.subscriptionId,
          sequence: 1,
          active: false,
          status: 'completed',
          messages: [],
        } as T
      if (method === 'agent/live/read')
        return {
          threadId: task.threadId,
          agentId: run.agentId,
          backgroundRun: run,
          active: false,
          unchanged: false,
          revision: 1,
          phase: 'completed',
          content: 'Actual protocol frame',
          truncated: false,
        } as T
      return {
        threadId: task.threadId,
        agentId: run.agentId,
        backgroundRun: run,
        kind: 'output',
        path: '/owned/native/original-run/output.md',
        name: 'output.md',
        modifiedAt: null,
        content: 'Actual protocol frame',
        offset: 0,
        revision: 'original-file',
        size: 21,
        truncated: false,
      } as T
    }
    return original<T>(method, params)
  }
  return { client, runtime, core, address, run, calls, summary }
}
// Actual finite Gateway routing is exercised; Native frames are deterministic
// protocol fixtures, not worker execution or native permission acceptance.
describe('exact member Gateway boundary', () => {
  test('passes the full original key and validates registered native replies', async () => {
    const f = await setup()
    const data = { address: f.address, agentId: f.run.agentId, expectedBackgroundRun: f.run }
    await f.runtime.request('runtime.tasks.agent_list', data)
    await f.runtime.request('runtime.tasks.agent_live_read', data)
    await f.runtime.request('runtime.tasks.agent_artifact_read', {
      ...data,
      kind: 'output',
      offset: 0,
    })
    await f.runtime.request('runtime.tasks.agent_stream_subscribe', {
      ...data,
      subscriptionId: 'exact-observer',
    })
    const selected = f.calls.filter(call => call.method !== 'agent/list')
    expect(selected.map(call => call.params.expectedBackgroundRun)).toEqual(
      selected.map(() => f.run)
    )
    expect(
      f.core.agentConversationSubscriptions.get('exact-observer')?.expectedBackgroundRun
    ).toEqual(f.run)
  })
  test('old host or nonresident original parent is unavailable without resume/create fallback', async () => {
    const f = await setup()
    const data = { address: f.address, agentId: f.run.agentId, expectedBackgroundRun: f.run }
    clientCapabilities(f.client, false)
    await expect(f.runtime.request('runtime.tasks.agent_live_read', data)).rejects.toMatchObject({
      code: -32038,
    })
    expect(f.calls).toHaveLength(0)
    clientCapabilities(f.client, true)
    f.core.clientByTask.delete(f.address.taskId)
    const before = f.client.requests.length
    await expect(f.runtime.request('runtime.tasks.agent_live_read', data)).rejects.toMatchObject({
      code: -32038,
    })
    expect(
      f.client.requests
        .slice(before)
        .some(call => ['thread/start', 'thread/resume', 'turn/start'].includes(call.method))
    ).toBe(false)
  })
  test('conflicting target,parent,workspace or member cannot use an original connection', async () => {
    const f = await setup()
    for (const address of [
      { ...f.address, deviceId: 'peer' },
      { ...f.address, threadId: 'other-parent' },
      { ...f.address, workspacePath: '/wrong' },
    ])
      await expect(
        f.runtime.request('runtime.tasks.agent_live_read', {
          address,
          agentId: f.run.agentId,
          expectedBackgroundRun: f.run,
        })
      ).rejects.toMatchObject({ code: -32038 })
    await expect(
      f.runtime.request('runtime.tasks.agent_live_read', {
        address: f.address,
        agentId: 'other-child',
        expectedBackgroundRun: f.run,
      })
    ).rejects.toMatchObject({ code: -32038 })
    expect(f.calls).toHaveLength(0)
  })
  test('mismatched native run response is not exposed as the selected member', async () => {
    const f = await setup()
    const original = f.client.request.bind(f.client)
    f.client.request = async <T>(
      method: string,
      params: Record<string, unknown> = {}
    ): Promise<T> =>
      method === 'agent/live/read'
        ? ({
            threadId: f.run.parentSessionId,
            agentId: f.run.agentId,
            backgroundRun: { ...f.run, runId: 'new-run' },
            active: false,
            unchanged: false,
            revision: 1,
            phase: 'completed',
            content: 'Wrong run content',
            truncated: false,
          } as T)
        : original<T>(method, params)
    await expect(
      f.runtime.request('runtime.tasks.agent_live_read', {
        address: f.address,
        agentId: f.run.agentId,
        expectedBackgroundRun: f.run,
      })
    ).rejects.toMatchObject({ code: -32038 })
  })
  test('native close and wrong-run deltas close only the exact observer', async () => {
    for (const changed of [false, true]) {
      const f = await setup()
      const data = {
        address: f.address,
        agentId: f.run.agentId,
        expectedBackgroundRun: f.run,
        subscriptionId: 'exact-observer',
      }
      await f.runtime.request('runtime.tasks.agent_stream_subscribe', data)
      vi.mocked(emitRuntimeEvent).mockClear()
      const message = changed
        ? {
            threadId: f.run.parentSessionId,
            agentId: f.run.agentId,
            subscriptionId: data.subscriptionId,
            runId: 'new-run',
            sequence: 2,
            method: 'item/delta',
            params: {},
          }
        : {
            threadId: f.run.parentSessionId,
            agentId: f.run.agentId,
            subscriptionId: data.subscriptionId,
            expectedBackgroundRun: f.run,
            reasonCode: 'run_changed',
          }
      await forwardAcceptedNotification.call(
        f.core,
        changed ? 'agent/stream/event' : 'agent/stream/closed',
        message,
        f.address.deviceId,
        f.client
      )
      expect(f.core.agentConversationSubscriptions.has(data.subscriptionId)).toBe(false)
      expect(emitRuntimeEvent).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          payload: expect.objectContaining({
            data: expect.objectContaining({
              type: 'disconnected',
              reason: 'agent_run_changed',
              runId: f.run.runId,
            }),
          }),
        })
      )
      expect(f.calls.some(call => call.method === 'agent/stop')).toBe(false)
    }
  })
  test('late account result cannot cross the original observation fence', async () => {
    const f = await setup()
    let release!: (value: unknown) => void
    f.client.request = async <T>(): Promise<T> =>
      new Promise(done => {
        release = done as (value: unknown) => void
      })
    const pending = f.runtime.request('runtime.tasks.agent_live_read', {
      address: f.address,
      agentId: f.run.agentId,
      expectedBackgroundRun: f.run,
    })
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    notifyAccountContextChange(f.address.deviceId)
    release({ threadId: f.run.parentSessionId, agentId: f.run.agentId, backgroundRun: f.run })
    await expect(pending).rejects.toMatchObject({ code: -32038 })
  })
})
function clientCapabilities(client: FakeGatewayClient, exact: boolean) {
  client.supportsExperimental = cap => cap !== 'agentExactRunV1' || exact
}

test('exact member commands preserve the native run and use only its resident connection', async () => {
  const f = await setup()
  const native: {method: string; params: Record<string, unknown>}[] = []
  f.client.request = async <T>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
    native.push({ method, params })
    if (method === 'agent/steer') return {
      agentId: f.run.agentId, clientMessageId: params.clientMessageId, messageId: 'native-message',
      status: 'queued_live', queued: true, expectedBackgroundRun: params.expectedBackgroundRun,
    } as T
    if (method === 'agent/message/read') return {
      threadId: f.run.parentSessionId, agentId: f.run.agentId, clientMessageId: params.clientMessageId,
      receiptEpoch: 0, receipt: { clientMessageId: params.clientMessageId, messageId: 'native-message',
        status: 'queued_live', bodySummary: 'Bounded instruction', acceptedAtMs: 1, backgroundRun: f.run },
    } as T
    return { threadId: f.run.parentSessionId, agentId: f.run.agentId, stopped: true,
      status: 'stopped', expectedBackgroundRun: params.expectedBackgroundRun } as T
  }
  const params = { address: f.address, agentId: f.run.agentId, expectedBackgroundRun: f.run,
    clientMessageId: 'cmd:0:one', message: 'Bounded instruction' }
  await expect(f.runtime.request('runtime.tasks.agent_steer', params)).resolves.toMatchObject({
    expectedBackgroundRun: f.run, clientMessageId: 'cmd:0:one', accepted: true,
  })
  await expect(f.runtime.request('runtime.tasks.agent_message_read', params)).resolves.toMatchObject({
    receipt: { backgroundRun: f.run, messageId: 'native-message' },
  })
  await expect(f.runtime.request('runtime.tasks.agent_stop', params)).resolves.toMatchObject({
    expectedBackgroundRun: f.run, stopped: true,
  })
  expect(native).toHaveLength(3)
  expect(native.every(call => JSON.stringify(call.params.expectedBackgroundRun) === JSON.stringify(f.run))).toBe(true)
  f.core.clientByTask.clear()
  await expect(f.runtime.request('runtime.tasks.agent_steer', params)).rejects.toMatchObject({ code: -32038 })
  expect(native).toHaveLength(3)
})

test('an old host and mismatched control receipt never enable a constrained command', async () => {
  const f = await setup()
  f.client.supportsExperimental = name => name !== 'agentExactControlV1'
  const params = { address: f.address, agentId: f.run.agentId, expectedBackgroundRun: f.run,
    clientMessageId: 'cmd:0:one', message: 'Bounded instruction' }
  await expect(f.runtime.request('runtime.tasks.agent_steer', params)).rejects.toMatchObject({ code: -32038 })
  expect(f.calls).toHaveLength(0)
  f.client.supportsExperimental = () => true
  f.client.request = async <T>(): Promise<T> => ({ agentId: f.run.agentId, status: 'queued_live', queued: true,
    clientMessageId: 'cmd:0:one', expectedBackgroundRun: { ...f.run, runId: 'another-run' } }) as T
  await expect(f.runtime.request('runtime.tasks.agent_steer', params)).rejects.toMatchObject({ code: -32038 })
})
