import fixtures from '../../../shared/generated/examples.web-sources.json'
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
  it('retains only bounded line estimates, preserves them on tool start and rejects late input', () => {
    const projection = new SubagentConversationProjection(address)
    let messages = apply([], projection, 'item/event', {
      event: {
        type: 'tool_input_progress',
        id: 'write',
        name: 'write',
        chars: 16,
        lines: { generatedLines: 2, replacedLines: 1 },
      },
    })
    expect(messages[0].blocks?.[0]).toMatchObject({
      generatedLineProgress: { generatedLines: 2, replacedLines: 1 },
    })
    for (const generatedLines of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity]) {
      messages = apply(messages, projection, 'item/event', {
        event: {
          type: 'tool_input_progress',
          id: 'write',
          name: 'write',
          chars: 32,
          lines: { generatedLines },
        },
      })
      expect(messages[0].blocks?.[0]).toMatchObject({
        generatedLineProgress: { generatedLines: 2, replacedLines: 1 },
      })
    }
    messages = apply(messages, projection, 'item/started', {
      item: {
        id: 'write',
        type: 'toolCall',
        name: 'write',
        input: { file_path: 'file.txt', content: 'one\ntwo\n' },
      },
    })
    expect(messages[0].blocks?.[0]).toMatchObject({
      status: 'pending',
      generatedLineProgress: { generatedLines: 2, replacedLines: 1 },
    })
    messages = apply(messages, projection, 'item/event', {
      event: {
        type: 'tool_input_progress',
        id: 'write',
        name: 'write',
        chars: 128,
        lines: { generatedLines: 99 },
      },
    })
    expect(messages[0].blocks?.[0]).toMatchObject({
      status: 'pending',
      generatedLineProgress: { generatedLines: 2 },
    })
    messages = apply(messages, projection, 'item/completed', {
      item: { id: 'write', type: 'toolCall', status: 'completed', output: 'Written' },
    })
    expect(messages[0].blocks?.[0]).not.toHaveProperty('generatedLineProgress')
    messages = apply(messages, projection, 'item/event', {
      event: {
        type: 'tool_input_progress',
        id: 'write',
        name: 'write',
        chars: 256,
        lines: { generatedLines: 100 },
      },
    })
    expect(messages[0].blocks?.[0]).toMatchObject({ status: 'done' })
    expect(messages[0].blocks?.[0]).not.toHaveProperty('generatedLineProgress')
  })

  it('clears argument estimates during provider retry and never restores inactive snapshot progress', () => {
    const projection = new SubagentConversationProjection(address)
    let messages = apply([], projection, 'item/event', {
      event: {
        type: 'tool_input_progress',
        id: 'write',
        name: 'write',
        chars: 16,
        lines: { generatedLines: 2 },
      },
    })
    messages = apply(messages, projection, 'item/started', {
      item: { id: 'write', type: 'toolCall', name: 'write', input: {} },
    })
    messages = apply(messages, projection, 'item/event', {
      event: { type: 'system_notice', kind: 'provider_retry' },
    })
    expect(messages[0].blocks?.[0]).toMatchObject({ status: 'pending' })
    expect(messages[0].blocks?.[0]).not.toHaveProperty('generatedLineProgress')
    const snapshot = projection.snapshot({
      ...scope,
      active: false,
      activeAssistantItemId: 'answer',
      pendingEvents: [
        {
          type: 'tool_input_progress',
          id: 'stale',
          name: 'write',
          chars: 32,
          lines: { generatedLines: 3 },
        },
      ],
      messages: [
        {
          id: 'answer',
          role: 'assistant',
          status: 'done',
          content: '',
          blocks: [
            {
              id: 'stale',
              type: 'tool',
              tool_name: 'write',
              status: 'generating_arguments',
              generatedLineProgress: { generatedLines: 99 },
            },
          ],
        },
      ],
    })
    expect(snapshot.messages[0].blocks?.[0]).toMatchObject({ status: 'unknown' })
    expect(snapshot.messages[0].blocks?.[0]).not.toHaveProperty('generatedLineProgress')
  })

  it('keeps a reused tool ID in a later assistant item separate from settled history', () => {
    const projection = new SubagentConversationProjection(address)
    let messages = projection.snapshot({
      ...scope,
      activeAssistantItemId: 'new-answer',
      messages: [
        {
          id: 'old-answer',
          role: 'assistant',
          status: 'done',
          content: '',
          blocks: [{ id: 'reused', type: 'tool', tool_name: 'write', status: 'done' }],
        },
        { id: 'new-answer', role: 'assistant', status: 'streaming', content: '', blocks: [] },
      ],
    }).messages
    messages = apply(messages, projection, 'item/event', {
      event: {
        type: 'tool_input_progress',
        id: 'reused',
        name: 'write',
        chars: 32,
        lines: { generatedLines: 2 },
      },
    })
    expect(messages[0].blocks?.[0]).not.toHaveProperty('generatedLineProgress')
    expect(messages[1].blocks?.[0]).toMatchObject({
      status: 'generating_arguments',
      generatedLineProgress: { generatedLines: 2 },
    })
    messages = apply(messages, projection, 'turn/completed', { turn: { status: 'interrupted' } })
    expect(messages[0].blocks?.[0]).toMatchObject({ status: 'done' })
    expect(messages[1].blocks?.[0]).toMatchObject({
      status: 'unknown',
      rawStatus: 'result_unrecorded',
    })
    expect(messages[1].blocks?.[0]).not.toHaveProperty('generatedLineProgress')
  })
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

it('keeps native child source identity in the normal tool projection', () => {
  const projection = new SubagentConversationProjection(address)
  let messages = apply([], projection, 'item/started', { item: { id: 'search-1', type: 'toolCall', name: 'WebSearch', input: { query: 'docs' } } })
  const sample = fixtures.WebSourcesToolResultV1.find(value => value.name === 'native-summary')!.value.webSources
  const webSources = { ...sample, identity: { threadId: 'child-thread', turnId: 'child-turn', attemptId: 'child-attempt' } }
  messages = apply(messages, projection, 'item/completed', { item: { id: 'search-1', type: 'toolCall', name: 'WebSearch', status: 'completed', output: 'Search result', webSources } })
  expect(messages[0].blocks?.[0]).toMatchObject({ type: 'tool', status: 'done', webSources })
})
