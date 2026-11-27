import { beforeEach, expect, test, vi } from 'vitest'
import type { GatewayRuntimeCore } from './core'
import { forwardAcceptedNotification, forwardNotification } from './notifications'
import { NotificationReplayGuard } from '../../notificationReplayGuard'
import { emitRuntimeEvent } from '../../gatewayServiceBridge'
import { createResponseApiStreamState, emitResponseApiEvent } from '../../../stream/responseApiStream'
import { createRuntimeTaskStreamHandlers } from '../../../features/workbench/runtimePaneMessages'
import { reduceWorkbenchMessages } from '@wegent/chat-core'

vi.mock('../../gatewayServiceBridge', () => ({ emitRuntimeEvent: vi.fn(async () => undefined) }))
beforeEach(() => vi.clearAllMocks())

const metadata = { version: 1, messageId: 'peer-message', sourceThreadId: 'source', targetThreadId: 'target',
  createdAtMs: 1700000000000, bodySha256: 'a'.repeat(64),
  sourceAddress: { targetId: 'native-source', workspaceId: 'workspace-source', threadId: 'source' },
  targetAddress: { targetId: 'native-target', workspaceId: 'workspace-target', threadId: 'target' } }

function fixture() {
  const connection = { targetId: 'local', connectionId: 'live' }
  const client = { diagnosticConnection: connection, supportsExperimental: () => false }
  const task = { taskId: 'owned-task', serverId: 'local', threadId: 'target', workspacePath: '/owned', running: false }
  const runtime = {
    disposed: false, tasks: new Map([[task.taskId, task]]), taskByThread: new Map([['local\0target', task.taskId]]),
    threadKey: (target: string, thread: string) => `${target}\0${thread}`, clientByTask: new Map([[task.taskId, client]]),
    notificationReplayGuard: new NotificationReplayGuard(), forwardAcceptedNotification,
    turnAttemptIds: new Map(), turnText: new Map(), pendingQuestionByKey: new Map(), backgroundJobById: new Map(),
    remoteSessions: { handleNotification: () => false },
    toolPathPreviews: { beforeResumeBoundary: () => false, handle: () => {} },
  }
  const item = { id: 'history-uuid', type: 'peerAgentMessage', role: 'peer_agent', origin: 'peer_agent',
    agentMessage: metadata, text: '<application_context>keep this text</application_context>', timestamp: metadata.createdAtMs }
  return { runtime, client, task, connection, params: { threadId: 'target', serverId: 'native-runtime', sequence: 42, item } }
}

test.each(['item/started', 'item/completed'])('%s projects the actual host peer envelope without creating a user or assistant response', async method => {
  const { runtime, client, connection, params, task } = fixture()
  await forwardNotification.call(runtime as unknown as GatewayRuntimeCore, method, params, 'local', client as never, connection)
  expect(emitRuntimeEvent).toHaveBeenCalledExactlyOnceWith(expect.any(String), expect.objectContaining({
    event: 'runtime.user_message', payload: expect.objectContaining({ taskId: task.taskId,
      data: { message: expect.objectContaining({ id: 'history-uuid', role: 'peer_agent', origin: 'peer_agent',
        content: params.item.text, agentMessage: metadata }) } }),
  }))
  expect(task).toMatchObject({ running: false })
  await forwardNotification.call(runtime as unknown as GatewayRuntimeCore, method, params, 'local', client as never, connection)
  expect(emitRuntimeEvent).toHaveBeenCalledTimes(1)
})

test.each(['wrong-thread', 'wrong-target', 'retired-client', 'retired-connection'])('%s cannot inject a peer row or claim its replay identity', async conflict => {
  const { runtime, client, connection, params } = fixture()
  const staleParams = conflict === 'wrong-thread' ? { ...params, threadId: 'other' } : params
  const source = conflict === 'retired-client' ? { ...client } : client
  const target = conflict === 'wrong-target' ? 'other-target' : 'local'
  const sourceConnection = conflict === 'retired-connection' ? { ...connection, connectionId: 'retired' } : connection
  await forwardNotification.call(runtime as unknown as GatewayRuntimeCore, 'item/completed', staleParams, target, source as never, sourceConnection)
  expect(emitRuntimeEvent).not.toHaveBeenCalled()
  await forwardNotification.call(runtime as unknown as GatewayRuntimeCore, 'item/completed', params, 'local', client as never, connection)
  expect(emitRuntimeEvent).toHaveBeenCalledTimes(1)
})

test('an owned idle Peer notification reaches the real stream decoder and pane reducer as plain lower-trust content', async () => {
  const { runtime, client, connection, params, task } = fixture()
  await forwardNotification.call(runtime as unknown as GatewayRuntimeCore, 'item/completed', params, 'local', client as never, connection)
  const [, event] = vi.mocked(emitRuntimeEvent).mock.calls[0]!
  const onMessageAction = vi.fn()
  const handlers = createRuntimeTaskStreamHandlers({ deviceId: 'local', taskId: task.taskId, threadId: task.threadId }, { onMessageAction })
  emitResponseApiEvent(handlers, event.event, event.payload, createResponseApiStreamState())
  expect(onMessageAction).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    type: 'peer_added', message: expect.objectContaining({ id: 'history-uuid', role: 'system',
      peerAgent: metadata, content: params.item.text, taskId: task.taskId }),
  }))
  const messages = reduceWorkbenchMessages([], onMessageAction.mock.calls[0]![0])
  expect(messages).toHaveLength(1)
  expect(messages[0]).toMatchObject({ role: 'system', peerAgent: metadata, content: params.item.text })
  expect(messages[0]?.attachments).toBeUndefined()
  expect(task).toMatchObject({ running: false })
})

test('a peer boundary prevents a whole-turn completion from overwriting the following segment', async () => {
  const { runtime, client, connection, params, task } = fixture()
  const turnKey = `${task.taskId}:turn`
  runtime.turnAttemptIds.set(turnKey, 'attempt')
  runtime.turnText.set(turnKey, 'already streamed before the peer')
  await forwardNotification.call(runtime as unknown as GatewayRuntimeCore, 'item/completed',
    { ...params, turnId: 'turn' }, 'local', client as never, connection)
  expect(runtime.turnText.get(turnKey)).toBeNull()
  expect(emitRuntimeEvent).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
    event: 'runtime.user_message', payload: expect.objectContaining({ turnId: 'turn', subtaskId: 'attempt' }),
  }))
})

test('a peer row stays between the preceding and continuing assistant output throughout streaming', () => {
  const actions: Array<Parameters<typeof reduceWorkbenchMessages>[1]> = []
  const handlers = createRuntimeTaskStreamHandlers(
    { deviceId: 'local', taskId: 'owned-task', threadId: 'target' },
    { onMessageAction: action => actions.push(action) }
  )
  const stream = createResponseApiStreamState()
  const base = { deviceId: 'local', taskId: 'owned-task', turnId: 'turn', subtaskId: 'attempt', attemptId: 'attempt' }
  const emit = (name: string, data: unknown) => emitResponseApiEvent(handlers, name, { ...base, data }, stream)
  emit('response.created', {})
  emit('response.output_text.delta', { delta: 'before' })
  const peer = { id: 'history-uuid', role: 'peer_agent', origin: 'peer_agent', agentMessage: metadata, content: 'peer message' }
  emit('runtime.user_message', { message: peer })
  emit('response.output_text.delta', { delta: 'after' })
  // A replayed peer notification must not split the new segment or duplicate it.
  emit('runtime.user_message', { message: peer })
  emit('response.output_text.delta', { delta: ' more' })
  const live = actions.reduce(reduceWorkbenchMessages, [])
  expect(live.map(message => [message.role, message.content])).toEqual([
    ['assistant', 'before'], ['system', 'peer message'], ['assistant', 'after more'],
  ])
  expect(live[2]).toMatchObject({ status: 'streaming', taskId: 'owned-task', turnId: 'turn', attemptId: 'attempt' })
  emit('response.completed', { turnId: 'turn' })
  const done = actions.reduce(reduceWorkbenchMessages, [])
  expect(done.map(message => [message.role, message.content])).toEqual([
    ['assistant', 'before'], ['system', 'peer message'], ['assistant', 'after more'],
  ])
  expect(done[2].status).toBe('done')
})
