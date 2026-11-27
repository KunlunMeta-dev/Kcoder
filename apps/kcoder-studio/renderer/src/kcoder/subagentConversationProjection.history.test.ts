import { expect, test } from 'vitest'
import { reduceWorkbenchMessages } from '@wegent/chat-core'
import { createRuntimeTaskStreamHandlers } from '@/features/workbench/runtimePaneMessages'
import { SubagentConversationProjection } from './subagentConversationProjection'

test('child thinking and tool rounds keep settled history as stable as ordinary chat', () => {
  const address = { deviceId: 'local', taskId: 'original', threadId: 'parent' }
  const time = 1_770_000_000_000
  const history = Array.from({ length: 64 }, (_, i) => ({
    id: `old-${i}`, role: 'assistant', status: 'done', content: '既有回复'.repeat(256),
    timestampMs: time + i,
    blocks: [
      { id: `thought-${i}`, type: 'thinking', status: 'done', content: '既有思考'.repeat(256), timestamp: time + i },
      { id: `tool-${i}`, type: 'tool', tool_name: 'read', status: 'done', tool_output: '已读内容'.repeat(256), timestamp: time + i },
    ],
  }))
  const scope = { threadId: address.threadId, agentId: 'child', subscriptionId: 'scope', runId: 'run', active: true }
  const child = new SubagentConversationProjection(address)
  let childMessages = child.snapshot({ ...scope, messages: history, sequence: 0 }).messages
  let mainMessages = childMessages
  const main = createRuntimeTaskStreamHandlers(address, {
    onMessageAction: action => { mainMessages = reduceWorkbenchMessages(mainMessages, action) },
  })
  let seq = 0, mainReplaced = 0, childReplaced = 0
  const apply = (event: string, params: Record<string, unknown>, mainAction: () => void) => {
    const beforeMain = mainMessages, beforeChild = childMessages
    mainAction()
    const next = child.event({ ...scope, sequence: ++seq, occurredAtMs: time + seq + 1000, method: event, params })
    if (next.type !== 'event' || !next.projectedMessages) throw Error('expected a projected live event')
    childMessages = next.projectedMessages
    for (let i = 0; i < history.length; i++) {
      mainReplaced += Number(beforeMain[i] !== mainMessages[i])
      childReplaced += Number(beforeChild[i] !== childMessages[i])
    }
  }
  for (let round = 0; round < 12; round++) {
    const id = `active-${round}`, thought = `t-${round}`, callId = `read-${round}`
    const base = { ...address, subtaskId: id }
    apply('item/started', { item: { id, type: 'agentMessage' } }, () => main.onChatStart?.(base))
    apply('item/event', { itemId: id, event: { type: 'assistant_thinking_started' } }, () => {})
    for (let i = 0; i < 16; i++) {
      apply('item/event', { itemId: id, event: { type: 'assistant_thinking_delta', id: thought, text: '思考' } },
        () => main.onChatChunk?.({ ...base, content: '', result: { reasoningChunk: '思考' } }))
    }
    apply('item/event', { itemId: id, event: { type: 'assistant_thinking_completed', id: thought } }, () => {})
    apply('item/delta', { itemId: id, delta: { text: '已检查。' } }, () => main.onChatChunk?.({ ...base, content: '已检查。' }))
    apply('item/completed', { item: { id, type: 'agentMessage' } }, () => main.onChatDone?.({ ...base, result: {} }))
    apply('item/started', { item: { id: callId, type: 'toolCall', name: 'read' } },
      () => main.onBlockCreated?.({ ...base, block: { id: callId, type: 'tool', tool_name: 'read', status: 'pending', timestamp: time + seq + 1000 } }))
    apply('item/completed', { item: { id: callId, type: 'toolCall', status: 'completed', output: '成功' } },
      () => main.onBlockUpdated?.({ ...base, blockId: callId, status: 'done', toolOutput: '成功' }))
  }
  expect(mainReplaced).toBe(0)
  expect(childReplaced).toBe(0)
  expect(childMessages.at(-1)?.blocks?.at(-1)).toMatchObject({ type: 'tool', status: 'done', toolOutput: '成功' })
})
