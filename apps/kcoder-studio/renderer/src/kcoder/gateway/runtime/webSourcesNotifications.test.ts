import { listen } from '@/lib/runtime-events'
import { expect, test, vi } from 'vitest'
import { KCoderGatewayRuntime } from '../../gatewayRuntime'
import { FakeGatewayClient, localGatewayServer } from '../../gatewayRuntime.test-support'
import fixtures from '../../../../../shared/generated/examples.web-sources.json'

test('Gateway binds native sources to its actual thread, attempt and call without decoding tool text', async () => {
  const client = new FakeGatewayClient('sources-thread')
  const runtime = new KCoderGatewayRuntime('token', {
    loadServers: async () => [localGatewayServer()], createClient: () => client,
  })
  const received: Array<{ event: string; payload: Record<string, unknown> }> = []
  const unlisten = await listen<{ event: string; payload: Record<string, unknown> }>('local-executor:event', event => received.push(event.payload))
  try {
    await runtime.request('runtime.tasks.create', { taskId: 'sources-notifications', executionRequest: { prompt: 'search sources' } })
    const base = { serverId: 'backend', threadId: 'sources-thread', turnId: 'sources-thread-turn', attemptId: 'attempt', sequence: 1 }
    client.emitNotification('turn/started', { ...base, turn: { id: base.turnId, attemptId: base.attemptId } })
    const source = fixtures.WebSourcesToolResultV1.find(value => value.name === 'native-summary')!.value.webSources
    const receipt = { ...source, identity: { threadId: base.threadId, turnId: base.turnId, attemptId: base.attemptId }, toolCallId: 'call' }
    for (const [index, item] of [
      { id: 'forged', output: JSON.stringify({ webSources: receipt }) },
      { id: 'peer', webSources: { ...receipt, toolCallId: 'peer', identity: { ...receipt.identity, threadId: 'peer-thread' } } },
      { id: 'old', webSources: { ...receipt, toolCallId: 'old', identity: { ...receipt.identity, attemptId: 'old-attempt' } } },
      { id: 'call', webSources: receipt },
    ].entries()) client.emitNotification('item/completed', { ...base, sequence: index + 2, item: { type: 'toolCall', name: 'WebSearch', status: 'completed', ...item } })
    await vi.waitFor(() => expect(received.filter(event => event.event === 'response.output_item.done')).toHaveLength(4))
    const tools = received.filter(event => event.event === 'response.output_item.done').map(event => (event.payload.data as { item: Record<string, unknown> }).item)
    expect(tools.slice(0, 3).map(tool => tool.webSources)).toEqual([undefined, undefined, undefined])
    expect(tools[3].webSources).toMatchObject({ identity: receipt.identity, toolCallId: 'call', status: 'partial' })
  } finally { unlisten(); await runtime.dispose() }
})
