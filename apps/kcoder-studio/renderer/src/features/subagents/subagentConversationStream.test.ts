import { describe, expect, test } from 'vitest'
import type {
  RuntimeSubagentConversationEvent,
  RuntimeSubagentConversationSnapshot,
} from '@/types/subagents'
import { applySubagentConversationEvent } from './subagentConversationStream'

// QA: the UI projection/replay boundary is model independent. Sequences, lifecycle,
// authoritative resets, and isolation are tested without transport or filesystem polling.
const initial: RuntimeSubagentConversationSnapshot = {
  threadId: 'parent',
  agentId: 'worker',
  subscriptionId: 'sub',
  runId: 'run',
  sequence: 1,
  active: true,
  messages: [],
}
function event(
  sequence: number,
  actions: Extract<RuntimeSubagentConversationEvent, { type: 'event' }>['actions']
): RuntimeSubagentConversationEvent {
  return { type: 'event', ...initial, sequence, method: 'item/delta', params: {}, actions }
}
describe('subagent ordinary conversation stream projection', () => {
  test('text and tools increment immediately in the same assistant message and settle', () => {
    let snapshot = applySubagentConversationEvent(
      initial,
      event(2, [
        { type: 'assistant_started', subtaskId: 'assistant-1' },
        { type: 'assistant_chunk', subtaskId: 'assistant-1', content: 'Reading ' },
      ])
    ).snapshot
    expect(snapshot.messages[0]).toMatchObject({ content: 'Reading ', status: 'streaming' })
    snapshot = applySubagentConversationEvent(
      snapshot,
      event(3, [
        {
          type: 'assistant_chunk',
          subtaskId: 'assistant-1',
          content: 'files',
          blocks: [
            {
              id: 'read-1',
              subtaskId: 'assistant-1',
              type: 'tool',
              toolName: 'read',
              status: 'running',
              toolInput: { file_path: 'src/main.rs' },
              createdAt: 1234,
            },
          ],
        },
      ])
    ).snapshot
    expect(snapshot.messages).toHaveLength(1)
    expect(snapshot.messages[0].content).toBe('Reading files')
    expect(snapshot.messages[0].blocks).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'read-1', status: 'running' })])
    )
    snapshot = applySubagentConversationEvent(snapshot, {
      ...event(4, [
        {
          type: 'assistant_done',
          subtaskId: 'assistant-1',
          blocks: [
            {
              id: 'read-1',
              subtaskId: 'assistant-1',
              type: 'tool',
              toolName: 'read',
              status: 'done',
              toolOutput: 'file content',
              createdAt: 1234,
              completedAt: 1334,
            },
          ],
        },
      ]),
      terminalStatus: 'completed',
    }).snapshot
    expect(snapshot.active).toBe(false)
    expect(snapshot.messages[0].status).toBe('done')
    expect(snapshot.messages[0].blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'read-1', status: 'done', toolOutput: 'file content' }),
      ])
    )
  })

  test('duplicate frames never duplicate text; gaps request a fresh snapshot', () => {
    const frame = event(2, [{ type: 'assistant_chunk', subtaskId: 'assistant', content: 'one' }])
    const first = applySubagentConversationEvent(initial, frame).snapshot
    expect(applySubagentConversationEvent(first, frame)).toEqual({
      snapshot: first,
      resubscribe: false,
    })
    expect(applySubagentConversationEvent(first, event(4, []))).toEqual({
      snapshot: first,
      resubscribe: true,
    })
  })

  test('restored text-block snapshots retain the first narrative during later tool updates', () => {
    const restored: RuntimeSubagentConversationSnapshot = {
      ...initial,
      messages: [
        {
          id: 'assistant-live',
          subtaskId: 'assistant-live',
          role: 'assistant',
          content: '',
          status: 'streaming',
          createdAt: '',
          blocks: [
            {
              id: 'text-first',
              subtaskId: 'assistant-live',
              type: 'text',
              content: 'S03_LIVE_VISIBLE',
              status: 'done',
              createdAt: 1000,
            },
          ],
        },
      ],
    }
    const next = applySubagentConversationEvent(
      restored,
      event(2, [
        {
          type: 'block_created',
          subtaskId: 'assistant-live',
          block: {
            id: 'read-live',
            subtaskId: 'assistant-live',
            type: 'tool',
            toolName: 'read',
            toolInput: { file_path: 'src/main.rs' },
            status: 'running',
            createdAt: 1100,
          },
        },
      ])
    ).snapshot
    expect(next.messages).toHaveLength(1)
    expect(next.messages[0].content).toBe('')
    expect(next.messages[0].blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'text', content: 'S03_LIVE_VISIBLE' }),
        expect.objectContaining({ id: 'read-live', status: 'running' }),
      ])
    )
  })

  test('a reset replaces pending projection and another worker cannot alter it', () => {
    const reset: RuntimeSubagentConversationEvent = {
      type: 'reset',
      ...initial,
      runId: 'new-run',
      sequence: 20,
      active: false,
      messages: [
        {
          id: 'answer',
          role: 'assistant',
          content: 'authoritative final',
          status: 'done',
          createdAt: '',
        },
      ],
    }
    const replaced = applySubagentConversationEvent(initial, reset).snapshot
    expect(replaced.messages[0].content).toBe('authoritative final')
    expect(replaced.active).toBe(false)
    expect(
      applySubagentConversationEvent(replaced, { ...event(21, []), agentId: 'other' })
    ).toEqual({ snapshot: replaced, resubscribe: false })
    expect(
      applySubagentConversationEvent(replaced, { ...event(21, []), subscriptionId: 'closed' })
    ).toEqual({ snapshot: replaced, resubscribe: false })
  })
})
