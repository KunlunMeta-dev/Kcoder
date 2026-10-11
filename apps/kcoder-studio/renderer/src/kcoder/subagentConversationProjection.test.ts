import { describe, expect, it } from 'vitest'
import { reduceWorkbenchMessages } from '@wegent/chat-core'
import { SubagentConversationProjection } from './subagentConversationProjection'
import type { WorkbenchMessage } from '@/types/workbench'

const address = { deviceId: 'local', taskId: 'parent', threadId: 'parent-thread' }
const scope = {
  threadId: 'parent-thread',
  agentId: 'child',
  subscriptionId: 'sub',
  runId: 'run',
  sequence: 1,
  active: true,
}
function apply(
  messages: WorkbenchMessage[],
  projection: SubagentConversationProjection,
  method: string,
  params: Record<string, unknown>
) {
  const event = projection.event({ ...scope, method, params, occurredAtMs: 1770000000000 })
  if (event.type !== 'event') throw new Error('expected incremental event')
  return event.actions.reduce((state, action) => reduceWorkbenchMessages(state, action), messages)
}
describe('ordinary conversation projection for a child stream', () => {
  it('preserves the public failure cause when the run terminal frame has no error detail', () => {
    const projection = new SubagentConversationProjection(address)
    let messages = apply([], projection, 'item/event', {
      event: { type: 'error', error: 'Provider overloaded; retry later' },
    })
    messages = apply(messages, projection, 'turn/completed', { turn: { status: 'failed' } })
    expect(messages[0]).toMatchObject({
      status: 'failed',
      error: 'Provider overloaded; retry later',
    })
  })
  it('keeps arguments and tools active when the model message ends before tool execution', () => {
    const projection = new SubagentConversationProjection(address)
    let messages = projection.snapshot({
      ...scope,
      activeAssistantItemId: 'answer',
      messages: [
        {
          id: 'answer',
          role: 'assistant',
          status: 'streaming',
          content: 'Inspecting files',
          timestampMs: 1770000000000,
          turnId: 'run',
        },
      ],
    }).messages
    messages = apply(messages, projection, 'item/event', {
      event: { type: 'tool_input_progress', id: 'tool', name: 'glob', chars: 12 },
    })
    messages = apply(messages, projection, 'item/completed', {
      item: { id: 'answer', type: 'agentMessage' },
    })
    expect(messages[0].blocks?.find(block => block.id === 'tool')?.status).toBe(
      'generating_arguments'
    )
    messages = apply(messages, projection, 'item/started', {
      item: { id: 'tool', type: 'toolCall', name: 'glob', input: { pattern: '**/*.rs' } },
    })
    expect(messages[0].blocks?.find(block => block.id === 'tool')).toMatchObject({
      status: 'pending',
      toolInput: { pattern: '**/*.rs' },
    })
    messages = apply(messages, projection, 'item/completed', {
      item: { id: 'tool', type: 'toolCall', status: 'completed', output: 'src/main.rs' },
    })
    expect(messages[0].blocks?.find(block => block.id === 'tool')).toMatchObject({
      status: 'done',
      toolOutput: 'src/main.rs',
    })
  })
  it('retains snapshot text blocks when opening during tools and when the next answer completes', () => {
    const projection = new SubagentConversationProjection(address)
    let messages = projection.snapshot({
      ...scope,
      activeAssistantItemId: null,
      messages: [
        {
          id: 'answer',
          role: 'assistant',
          status: 'done',
          content: '',
          timestampMs: 1770000000000,
          turnId: 'run',
          blocks: [
            { id: 'answer-text-0', type: 'text', content: 'first second third', status: 'done' },
            {
              id: 'tool',
              type: 'tool',
              tool_name: 'read',
              status: 'running',
              timestamp: 1770000000000,
            },
          ],
        },
      ],
    }).messages
    expect(messages[0].blocks?.find(block => block.type === 'text')).toMatchObject({
      content: 'first second third',
    })
    messages = apply(messages, projection, 'item/completed', {
      item: { id: 'tool', type: 'toolCall', status: 'completed', output: 'read result' },
    })
    messages = apply(messages, projection, 'item/started', {
      item: { id: 'next-answer', type: 'agentMessage' },
    })
    messages = apply(messages, projection, 'item/delta', {
      itemId: 'next-answer',
      delta: { text: 'final answer' },
    })
    messages = apply(messages, projection, 'item/completed', {
      item: { id: 'next-answer', type: 'agentMessage' },
    })
    messages = apply(messages, projection, 'turn/completed', { turn: { status: 'completed' } })
    expect(messages[0].blocks?.find(block => block.type === 'text')).toMatchObject({
      content: 'first second third',
    })
    expect(messages.at(-1)?.content).toBe('final answer')
  })
  it('continues an already streaming message, attaches its tools and retains final text', () => {
    const projection = new SubagentConversationProjection(address)
    let messages = projection.snapshot({
      ...scope,
      activeAssistantItemId: 'answer',
      messages: [
        {
          id: 'answer',
          role: 'assistant',
          status: 'streaming',
          content: 'hel',
          timestampMs: 1770000000000,
        },
      ],
    }).messages
    messages = apply(messages, projection, 'item/delta', {
      itemId: 'answer',
      delta: { text: 'lo' },
    })
    expect(messages).toHaveLength(1)
    expect(messages[0].content).toBe('hello')
    messages = apply(messages, projection, 'item/started', {
      item: { id: 'tool', type: 'toolCall', name: 'read', input: { file_path: 'a.ts' } },
    })
    expect(messages[0].blocks?.find(block => block.type === 'tool')).toMatchObject({
      status: 'pending',
      toolName: 'read',
      toolInput: { file_path: 'a.ts' },
    })
    messages = apply(messages, projection, 'item/completed', {
      item: {
        id: 'tool',
        type: 'toolCall',
        name: 'read',
        status: 'completed',
        output: 'file content',
      },
    })
    expect(messages[0].blocks?.find(block => block.type === 'tool')).toMatchObject({
      status: 'done',
      toolOutput: 'file content',
    })
    messages = apply(messages, projection, 'turn/completed', { turn: { status: 'completed' } })
    expect(
      [
        messages[0].content,
        ...(messages[0].blocks ?? [])
          .filter(block => block.type === 'text')
          .map(block => (block.type === 'text' ? block.content : '')),
      ].join('')
    ).toBe('hello')
  })
  it('updates a tool from an initial snapshot and shows errors instead of a fake running row', () => {
    const projection = new SubagentConversationProjection(address)
    let messages = projection.snapshot({
      ...scope,
      messages: [
        {
          id: 'answer',
          role: 'assistant',
          status: 'done',
          content: '',
          timestampMs: 1770000000000,
          blocks: [
            {
              id: 'tool',
              type: 'tool',
              status: 'running',
              tool_name: 'glob',
              timestamp: 1770000000000,
            },
          ],
        },
      ],
    }).messages
    messages = apply(messages, projection, 'item/completed', {
      item: { id: 'tool', type: 'toolCall', status: 'failed', output: 'not found' },
    })
    expect(messages[0].blocks?.find(block => block.type === 'tool')).toMatchObject({
      status: 'error',
      toolOutput: 'not found',
    })
  })
  it('keeps the receipt identity of an applied instruction and never exposes private thinking', () => {
    const projection = new SubagentConversationProjection(address)
    let messages = apply([], projection, 'item/started', {
      item: { id: 'receipt-1', type: 'userMessage', text: 'change direction' },
    })
    expect(messages[0]).toMatchObject({
      id: 'receipt-1',
      role: 'user',
      content: 'change direction',
    })
    messages = apply(messages, projection, 'item/event', {
      event: { type: 'assistant_thinking_delta', text: 'private' },
    })
    expect(messages).toHaveLength(1)
    expect(JSON.stringify(messages)).not.toContain('private')
    const restored = projection.snapshot({
      ...scope,
      messages: [
        {
          id: 'receipt-1',
          role: 'user',
          content: 'change direction',
          timestampMs: 1770000000000,
          clientMessageId: 'owned-client',
        },
      ],
    }).messages
    expect(restored[0].id).toBe('owned-client')
    expect(restored[0].source).toMatchObject({ clientMessageId: 'owned-client' })
  })
  it('retires reset arguments and never leaves unresolved tools active after termination', () => {
    const projection = new SubagentConversationProjection(address)
    let messages = projection.snapshot({
      ...scope,
      activeAssistantItemId: 'answer',
      messages: [
        {
          id: 'answer',
          role: 'assistant',
          status: 'streaming',
          content: 'working',
          timestampMs: 1770000000000,
        },
      ],
    }).messages
    messages = apply(messages, projection, 'item/event', {
      event: { type: 'tool_input_progress', id: 'pending', name: 'read', chars: 12 },
    })
    expect(messages[0].blocks?.some(block => block.status === 'generating_arguments')).toBe(true)
    messages = apply(messages, projection, 'item/event', { event: { type: 'tool_input_reset' } })
    expect(messages[0].blocks?.some(block => block.status === 'generating_arguments')).toBe(false)
    messages = apply(messages, projection, 'item/started', {
      item: { type: 'toolCall', id: 'unfinished', name: 'read', input: {} },
    })
    messages = apply(messages, projection, 'turn/completed', { turn: { status: 'completed' } })
    expect(messages[0].blocks?.find(block => block.id === 'unfinished')).toMatchObject({
      status: 'unknown',
      rawStatus: 'result_unrecorded',
    })
  })
})
