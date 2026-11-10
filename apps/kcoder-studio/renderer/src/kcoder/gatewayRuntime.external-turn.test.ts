import { expect, test, vi } from 'vitest'
import { reduceWorkbenchMessages } from '@wegent/chat-core'
import { createRuntimeChatStream } from '@/api/runtime/runtimeChatStream'
import { createRuntimeTaskStreamHandlers } from '@/features/workbench/runtimePaneMessages'
import { subscribeRuntimeEvent } from './gatewayServiceBridge'
import type { WorkbenchMessage } from '@/types/workbench'
import type { LocalExecutorEvent } from '@/host/localExecutor'
import { createTestGatewayRuntime, FakeGatewayClient, localGatewayServer } from './gatewayRuntime.test-support'

// Controlled original protocol events, with the same renderer used for an SDK turn.
test.each(['before process events', 'after process events'])('an idle viewer renders external input committed %s once and in turn order', async timing => {
  const address = { deviceId: 'local', taskId: 'kcoder:local:original', threadId: 'original', workspacePath: '/workspace' }
  const runtime = createTestGatewayRuntime('token', {
    loadServers: async () => [localGatewayServer()],
    createClient: () => {
      const client = new FakeGatewayClient(address.threadId)
      client.threadResumeSupported = true
      client.persistedThreads = [{ id: address.threadId, cwd: address.workspacePath, status: 'idle' }]
      return client
    },
  })
  await runtime.request('runtime.tasks.list', {})
  let messages: WorkbenchMessage[] = []
  const stream = createRuntimeChatStream({
    subscribe: handler => subscribeRuntimeEvent<LocalExecutorEvent>('local-executor:event', event => handler(event.payload)),
    request: async <T>() => undefined as T,
  })
  const unsubscribe = stream.subscribe(createRuntimeTaskStreamHandlers(address, {
    onMessageAction: action => { messages = reduceWorkbenchMessages(messages, action) },
  }))
  try {
    await runtime.request('runtime.tasks.transcript', { ...address, attachToLiveTurn: true })
    const owner = runtime.clientByTask.get(address.taskId) as FakeGatewayClient
    let sequence = 1
    const frame = (method: string, extra: Record<string, unknown>) => owner.emitNotification(method, {
      serverId: 'original-server', threadId: address.threadId, turnId: 'external-turn',
      attemptId: 'external-attempt', sequence: sequence++, ...extra,
    })
    const committedUser = {
      item: {
        id: 'canonical-input', type: 'userMessage', content: {
          id: 'canonical-input', clientMessageId: 'original-client-input', turnId: 'external-turn',
          role: 'user', content: 'External original input', timestampMs: 1700000000000,
        },
      },
    }
    frame('turn/started', { turn: { id: 'external-turn', status: 'inProgress' } })
    if (timing === 'before process events') frame('item/started', committedUser)
    frame('item/event', { event: { type: 'assistant_thinking_delta', text: 'Visible original thinking' } })
    frame('item/started', { item: { id: 'read-one', type: 'toolCall', name: 'read', input: { path: '/workspace/owned.md' } } })
    frame('item/completed', { item: { id: 'read-one', type: 'toolCall', name: 'read', status: 'completed', output: 'Owned file contents' } })
    frame('item/delta', { itemId: 'answer', delta: { text: 'Original final answer' } })
    if (timing === 'after process events') frame('item/started', committedUser)
    frame('item/started', committedUser)
    frame('turn/completed', { turn: { id: 'external-turn', status: 'completed' } })
    await vi.waitFor(() => expect(messages.at(-1)).toMatchObject({ role: 'assistant', content: 'Original final answer', status: 'done' }))
    expect(messages.map(message => message.role)).toEqual(['user', 'assistant'])
    expect(messages[0]).toMatchObject({ id: 'original-client-input', content: 'External original input' })
    expect(JSON.stringify(messages[1])).toContain('Visible original thinking')
    expect(JSON.stringify(messages[1])).toContain('Owned file contents')
    expect(owner.requests.some(request => ['turn/start', 'thread/start'].includes(request.method))).toBe(false)
    expect(owner.closed).toBe(false)
  } finally { unsubscribe() }
})
