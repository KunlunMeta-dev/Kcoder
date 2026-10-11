import { afterEach, describe, expect, test, vi } from 'vitest'
import { emitRuntimeEvent } from '../../gatewayServiceBridge'
import { forwardAcceptedNotification } from './notifications'
import type { GatewayRuntimeCore } from './core'
import { notifyAccountContextChange } from '../../accountContextEvents'
import {
  createTestGatewayRuntime,
  FakeGatewayClient,
  localGatewayServer,
} from '../../gatewayRuntime.test-support'

vi.mock('../../gatewayServiceBridge', async importOriginal => ({
  ...(await importOriginal<typeof import('../../gatewayServiceBridge')>()),
  emitRuntimeEvent: vi.fn(),
}))

/** QA: model-independent addressed RPC routing, capability safety and stale account observations.
 * Isolated in-memory clients; no model execution, filesystem writes or external resources.
 * Test missing capability, wrong target, account switch and exact stop run identity.
 */
describe('subagent addressed Gateway host contract', () => {
  const runtimes: ReturnType<typeof createTestGatewayRuntime>[] = []
  afterEach(() => {
    for (const runtime of runtimes.splice(0)) runtime.dispose()
    vi.clearAllMocks()
  })
  async function setup() {
    const client = new FakeGatewayClient('thread-agent-host')
    client.agentSummaries = [
      { agentId: 'actual-agent', status: 'running', acceptingMessages: true, queueDepth: 0 },
    ]
    const runtime = createTestGatewayRuntime('token', {
      loadServers: async () => [localGatewayServer()],
      createClient: () => client,
    })
    runtimes.push(runtime)
    const task = (await runtime.request('runtime.tasks.create', {
      taskId: 'agent-host-draft',
      executionRequest: { prompt: 'delegate' },
    })) as { taskId: string }
    const requests: Array<{ method: string; params: Record<string, unknown> }> = []
    const original = client.request.bind(client)
    client.request = async <T>(
      method: string,
      params: Record<string, unknown> = {}
    ): Promise<T> => {
      if (
        [
          'agent/live/read',
          'agent/message/read',
          'agent/messages/list',
          'agent/messages/archive',
          'agent/stop',
          'agent/artifact/read',
          'agent/stream/subscribe',
          'agent/stream/unsubscribe',
        ].includes(method)
      ) {
        requests.push({ method, params })
        return {
          agentId: params.agentId,
          threadId: params.threadId,
          content: 'public text',
          offset: 0,
          revision: 'snapshot',
          retainedCount: 0,
          retainedLimit: 256,
          receiptEpoch: 0,
          receipts: [],
        } as T
      }
      return original<T>(method, params)
    }
    return { client, runtime, task, requests }
  }
  test('exposes explicit capabilities and discovers actual identities', async () => {
    const { runtime, task } = await setup()
    await expect(
      runtime.request('runtime.tasks.agent_list', { taskId: task.taskId })
    ).resolves.toMatchObject({
      agents: [{ agentId: 'actual-agent' }],
      capabilities: { publicTranscript: true, receipts: true, live: true },
      journalScope: expect.any(String),
    })
  })
  test('artifact-only older targets still discover workers with controls disabled', async () => {
    const { runtime, task, client } = await setup()
    client.supportsExperimental = cap => cap === 'agentArtifactsV1'
    await expect(
      runtime.request('runtime.tasks.agent_list', { taskId: task.taskId })
    ).resolves.toMatchObject({
      agents: [{ agentId: 'actual-agent' }],
      capabilities: {
        artifacts: true,
        publicTranscript: false,
        receipts: false,
        live: false,
        steering: false,
        stop: false,
      },
    })
  })
  test('uses actual agent identity with safe byte cursor and snapshot CAS', async () => {
    const { runtime, task, requests } = await setup()
    await runtime.request('runtime.tasks.agent_artifact_read', {
      taskId: task.taskId,
      agentId: 'actual-agent',
      kind: 'transcript',
      offset: 65536,
      limit: 65536,
      revision: 'snapshot',
    })
    expect(requests).toEqual([
      {
        method: 'agent/artifact/read',
        params: {
          threadId: 'thread-agent-host',
          agentId: 'actual-agent',
          kind: 'transcript',
          offset: 65536,
          limit: 65536,
          revision: 'snapshot',
        },
      },
    ])
  })
  test('old targets cannot expose private transcript; output remains readable', async () => {
    const { runtime, task, client, requests } = await setup()
    client.supportsExperimental = cap => cap !== 'agentArtifactPagesV1'
    await expect(
      runtime.request('runtime.tasks.agent_artifact_read', {
        taskId: task.taskId,
        agentId: 'actual-agent',
        kind: 'transcript',
      })
    ).rejects.toThrow('safe public')
    await runtime.request('runtime.tasks.agent_artifact_read', {
      taskId: task.taskId,
      agentId: 'actual-agent',
      kind: 'output',
      offset: 900,
      tail: true,
    })
    expect(requests).toEqual([
      {
        method: 'agent/artifact/read',
        params: { threadId: 'thread-agent-host', agentId: 'actual-agent', kind: 'output' },
      },
    ])
  })
  test('rejects cross-target requests before any agent observation', async () => {
    const { runtime, task, requests } = await setup()
    await expect(
      runtime.request('runtime.tasks.agent_artifact_read', {
        address: { taskId: task.taskId, deviceId: 'another-target' },
        agentId: 'actual-agent',
        kind: 'output',
      })
    ).rejects.toThrow('target identity conflict')
    expect(requests).toEqual([])
  })
  test('lookup/list/archive carry client ID and exact epoch through the existing journal', async () => {
    const { runtime, task, requests } = await setup()
    const address = { taskId: task.taskId, agentId: 'actual-agent' }
    await runtime.request('runtime.tasks.agent_message_read', {
      ...address,
      clientMessageId: 'cmd:3:test',
    })
    await runtime.request('runtime.tasks.agent_messages_list', {
      ...address,
      offset: 64,
      receiptEpoch: 3,
    })
    await runtime.request('runtime.tasks.agent_messages_archive', {
      ...address,
      expectedEpoch: 3,
      confirmedMessageIds: ['server-message'],
    })
    expect(requests.map(value => value.params)).toEqual([
      { threadId: 'thread-agent-host', agentId: 'actual-agent', clientMessageId: 'cmd:3:test' },
      {
        threadId: 'thread-agent-host',
        agentId: 'actual-agent',
        offset: 64,
        limit: 64,
        receiptEpoch: 3,
      },
      {
        threadId: 'thread-agent-host',
        agentId: 'actual-agent',
        expectedEpoch: 3,
        confirmedMessageIds: ['server-message'],
      },
    ])
  })
  test('stop carries actual background run CAS and fails closed without capability', async () => {
    const { runtime, task, client, requests } = await setup()
    const expectedBackgroundRun = {
      parentSessionId: 'parent',
      agentId: 'actual-agent',
      runId: 'run-1',
    }
    await runtime.request('runtime.tasks.agent_stop', {
      taskId: task.taskId,
      agentId: 'actual-agent',
      expectedBackgroundRun,
    })
    expect(requests[0].params.expectedBackgroundRun).toEqual(expectedBackgroundRun)
    client.supportsExperimental = cap => cap !== 'agentStopV1'
    await expect(
      runtime.request('runtime.tasks.agent_stop', {
        taskId: task.taskId,
        agentId: 'actual-agent',
        expectedBackgroundRun,
      })
    ).rejects.toThrow('agentStopV1')
    expect(requests).toHaveLength(1)
  })
  test('stale account response is rejected without exposing public content', async () => {
    const { runtime, task, client } = await setup()
    const original = client.request.bind(client)
    client.request = async <T>(
      method: string,
      params: Record<string, unknown> = {}
    ): Promise<T> => {
      const result = await original<T>(method, params)
      if (method === 'agent/live/read') notifyAccountContextChange(localGatewayServer().id)
      return result
    }
    await expect(
      runtime.request('runtime.tasks.agent_live_read', {
        taskId: task.taskId,
        agentId: 'actual-agent',
      })
    ).rejects.toThrow('identity changed')
  })
  test('registers child subscriptions before admission and filters foreign notifications', async () => {
    const { runtime, task, client, requests } = await setup()
    const address = { taskId: task.taskId, deviceId: localGatewayServer().id }
    await runtime.request('runtime.tasks.agent_stream_subscribe', {
      address,
      agentId: 'actual-agent',
      subscriptionId: 'owned-sub',
    })
    const frame = {
      threadId: 'thread-agent-host',
      agentId: 'actual-agent',
      subscriptionId: 'owned-sub',
      runId: 'run',
      sequence: 1,
      method: 'item/delta',
      params: { itemId: 'answer', delta: { text: 'child text' } },
    }
    const core = runtime as unknown as GatewayRuntimeCore
    await forwardAcceptedNotification.call(
      core,
      'agent/stream/event',
      { ...frame, agentId: 'other-child' },
      address.deviceId,
      client
    )
    await forwardAcceptedNotification.call(
      core,
      'agent/stream/event',
      frame,
      address.deviceId,
      new FakeGatewayClient('thread-agent-host')
    )
    expect(emitRuntimeEvent).not.toHaveBeenCalled()
    await forwardAcceptedNotification.call(
      core,
      'agent/stream/event',
      frame,
      address.deviceId,
      client
    )
    expect(emitRuntimeEvent).toHaveBeenCalledOnce()
    expect(emitRuntimeEvent).toHaveBeenCalledWith(expect.any(String), {
      event: 'response.subagent.conversation',
      payload: {
        deviceId: address.deviceId,
        taskId: task.taskId,
        data: { ...frame, type: 'event' },
      },
    })
    await expect(
      runtime.request('runtime.tasks.agent_stream_unsubscribe', {
        address: { ...address, deviceId: 'foreign' },
        subscriptionId: 'owned-sub',
      })
    ).rejects.toThrow('identity conflict')
    await runtime.request('runtime.tasks.agent_stream_unsubscribe', {
      address,
      subscriptionId: 'owned-sub',
    })
    expect(requests.at(-1)).toEqual({
      method: 'agent/stream/unsubscribe',
      params: { subscriptionId: 'owned-sub' },
    })
    await forwardAcceptedNotification.call(
      core,
      'agent/stream/event',
      frame,
      address.deviceId,
      client
    )
    expect(emitRuntimeEvent).toHaveBeenCalledOnce()
  })
  test('releases observation on connection close without stopping the child', async () => {
    const { runtime, task, client, requests } = await setup()
    const address = { taskId: task.taskId, deviceId: localGatewayServer().id }
    await runtime.request('runtime.tasks.agent_stream_subscribe', {
      address,
      agentId: 'actual-agent',
      subscriptionId: 'closing-sub',
    })
    client.close()
    await vi.waitFor(() =>
      expect(emitRuntimeEvent).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          event: 'response.subagent.conversation',
          payload: expect.objectContaining({
            data: expect.objectContaining({ type: 'disconnected', subscriptionId: 'closing-sub' }),
          }),
        })
      )
    )
    await expect(
      runtime.request('runtime.tasks.agent_stream_unsubscribe', {
        address,
        subscriptionId: 'closing-sub',
      })
    ).resolves.toMatchObject({ unsubscribed: false })
    expect(requests.some(value => value.method === 'agent/stop')).toBe(false)
  })
  test('fails closed on an older target without child streaming capability', async () => {
    const { runtime, task, client, requests } = await setup()
    client.supportsExperimental = cap => cap !== 'agentConversationStreamV1'
    await expect(
      runtime.request('runtime.tasks.agent_stream_subscribe', {
        address: { taskId: task.taskId, deviceId: localGatewayServer().id },
        agentId: 'actual-agent',
        subscriptionId: 'unsupported',
      })
    ).rejects.toThrow('agentConversationStreamV1')
    expect(requests).toHaveLength(0)
  })
})
