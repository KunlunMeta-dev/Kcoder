import { afterEach, expect, test } from 'vitest'
import { listen } from '@tauri-apps/api/event'
import {
  createTestGatewayRuntime,
  FakeGatewayClient,
  localGatewayServer,
} from './gatewayRuntime.test-support'
import { toolPathPreviews } from './toolPathPreview'

const releases: Array<() => void> = []
afterEach(() => releases.splice(0).forEach(release => release()))

test.each([
  'live',
  'watermark-replay',
  'terminal-race',
  'old-capability',
  'resume-rejected',
] as const)(
  'fresh renderer resume reconciles %s before releasing queued progress',
  async scenario => {
    const observed: Array<{ event: string; payload: { subtaskId?: string } }> = []
    const unlisten = await listen('local-executor:event', event =>
      observed.push(event.payload as (typeof observed)[number])
    )
    releases.push(unlisten, toolPathPreviews.acquire('local', 'kcoder:local:late-thread'))
    let runtimeClient!: FakeGatewayClient
    const runtime = createTestGatewayRuntime('token', {
      loadServers: async () => [localGatewayServer()],
      createClient: () => {
        const client = new FakeGatewayClient('late-thread')
        client.threadResumeSupported = true
        client.persistedThreads = [{ id: 'late-thread', cwd: '/workspace', status: 'running' }]
        const supports = client.supportsExperimental.bind(client)
        client.supportsExperimental = name =>
          name === 'threadStreamContextV1' ? scenario !== 'old-capability' : supports(name)
        const original = client.request.bind(client)
        client.request = async <T>(
          method: string,
          params: Record<string, unknown> = {}
        ): Promise<T> => {
          if (method !== 'thread/resume') return original<T>(method, params)
          runtimeClient = client
          if (scenario === 'watermark-replay')
            client.emitNotification('turn/started', {
              serverId: 'instance',
              threadId: 'late-thread',
              turnId: 'old-turn',
              attemptId: 'old-attempt',
              sequence: 19,
            })
          client.emitNotification('item/event', {
            serverId: 'instance',
            threadId: 'late-thread',
            turnId: 'live-turn',
            sequence: 21,
            event: {
              type: 'tool_input_progress',
              id: 'write',
              name: 'write',
              chars: 24,
              lines: { generatedLines: 3 },
            },
          })
          if (scenario === 'resume-rejected') throw new Error('fixture resume rejected')
          if (scenario === 'terminal-race')
            client.emitNotification('turn/completed', {
              serverId: 'instance',
              threadId: 'late-thread',
              turnId: 'live-turn',
              sequence: 22,
              turn: { id: 'live-turn', status: 'completed' },
            })
          return {
            thread: { id: 'late-thread', status: 'running' },
            streamContext: {
              serverId: 'instance',
              throughSequence: 20,
              activeTurn: {
                id: 'live-turn',
                threadId: 'late-thread',
                attemptId: 'live-attempt',
                status: 'running',
              },
            },
          } as T
        }
        return client
      },
    })
    await runtime.request('runtime.tasks.list', {})
    const resumed = runtime.request('runtime.tasks.agent_list', {
      taskId: 'kcoder:local:late-thread',
    })
    if (scenario === 'resume-rejected')
      await expect(resumed).rejects.toThrow('fixture resume rejected')
    else await resumed
    await new Promise(resolve => setTimeout(resolve, 0))
    const inputs = toolPathPreviews.readInputs('local', 'kcoder:local:late-thread')
    expect(inputs).toHaveLength(scenario === 'live' || scenario === 'watermark-replay' ? 1 : 0)
    if (scenario === 'live' || scenario === 'watermark-replay')
      expect(inputs[0].lines?.generatedLines).toBe(3)
    const projected = observed.filter(
      value => value.event === 'response.created' || value.event === 'response.completed'
    )
    if (scenario === 'old-capability' || scenario === 'resume-rejected')
      expect(projected).toEqual([])
    else {
      expect(projected[0]).toMatchObject({
        event: 'response.created',
        payload: { subtaskId: 'live-attempt' },
      })
      if (scenario === 'watermark-replay') expect(projected).toHaveLength(1)
      if (scenario === 'terminal-race')
        expect(projected.map(value => value.event)).toEqual([
          'response.created',
          'response.completed',
        ])
    }
    expect(runtimeClient).toBeDefined()
  }
)
