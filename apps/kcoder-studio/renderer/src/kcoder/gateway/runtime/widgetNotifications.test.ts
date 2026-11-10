import { expect, test, vi } from 'vitest'
import { KCoderGatewayRuntime } from '../../gatewayRuntime'
import { FakeGatewayClient, localGatewayServer } from '../../gatewayRuntime.test-support'
import { subscribeCommittedWidgets } from '../../widgetEvents'
import type { WidgetRef } from '../../../../../shared/generated/contracts'

test('only native completion metadata with the owned thread and accepted attempt becomes a widget reference', async () => {
  const client = new FakeGatewayClient('widget-thread')
  const runtime = new KCoderGatewayRuntime('token', {
    loadServers: async () => [localGatewayServer()],
    createClient: () => client,
  })
  const committed = vi.fn()
  const unsubscribe = subscribeCommittedWidgets(committed)
  try {
    await runtime.request('runtime.tasks.create', {
      taskId: 'widget-notifications',
      executionRequest: { prompt: 'visualize' },
    })
    const base = {
      serverId: 'backend',
      threadId: 'widget-thread',
      turnId: 'widget-thread-turn',
      attemptId: 'attempt',
      sequence: 1,
    }
    client.emitNotification('turn/started', {
      ...base,
      attemptId: undefined,
      turn: { id: base.turnId, attemptId: base.attemptId },
    })
    const widget: WidgetRef = {
      widgetId: 'w-1',
      threadId: base.threadId,
      turnId: base.turnId,
      attemptId: 'attempt',
      toolCallId: 'call',
      revision: 1,
      title: 'Diagram',
      summary: 'Summary',
      format: 'svg',
      executionMode: 'managed',
      libraries: [],
      bytes: 10,
      sha256: '1'.repeat(64),
      createdAtMs: 1,
    }
    client.emitNotification('item/completed', {
      ...base,
      sequence: 2,
      item: {
        id: 'fake-output',
        type: 'toolCall',
        name: 'read',
        status: 'completed',
        output: JSON.stringify({ widgetRef: widget }),
      },
    })
    client.emitNotification('item/completed', {
      ...base,
      sequence: 3,
      attemptId: 'old-attempt',
      item: {
        id: 'call',
        type: 'toolCall',
        name: 'show_widget',
        status: 'completed',
        widgetRef: widget,
      },
    })
    client.emitNotification('item/completed', {
      ...base,
      sequence: 4,
      item: {
        id: 'call',
        type: 'toolCall',
        name: 'show_widget',
        status: 'completed',
        widgetRef: { ...widget, threadId: 'other-thread' },
      },
    })
    client.emitNotification('item/completed', {
      ...base,
      sequence: 5,
      item: {
        id: 'call',
        type: 'toolCall',
        name: 'show_widget',
        status: 'completed',
        widgetRef: widget,
      },
    })
    await vi.waitFor(() => expect(committed).toHaveBeenCalledTimes(1))
    expect(committed.mock.calls[0][0].widget).toEqual(widget)
  } finally {
    unsubscribe()
    await runtime.dispose()
  }
})
