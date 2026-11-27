import { expect, test } from 'vitest'
import { reduceWorkbenchMessages } from '@wegent/chat-core'
import type { WorkbenchMessage } from '@/types/workbench'
import type { RuntimePaneMessageAction } from '@/features/workbench/runtimePaneMessages'
import { filterBufferedTranscriptActions, mergeBufferedTranscriptProcessing } from './paneMessageReducer'

const history: WorkbenchMessage[] = [{ id: 'canonical-body', role: 'assistant',
  turnId: 'turn-1', subtaskId: 'history:1', content: 'Original partial response',
  status: 'error', error: 'Incomplete provider stream', createdAt: '2026-11-04T00:00:00Z' }]

function buffered(attemptId = 'turn-1'): RuntimePaneMessageAction[] {
  return [
    { type: 'assistant_started', subtaskId: attemptId, turnId: 'turn-1', attemptId },
    { type: 'assistant_chunk', subtaskId: attemptId, reasoningChunk: 'Original thought' },
    { type: 'assistant_chunk', subtaskId: attemptId, content: 'Original partial response' },
    { type: 'assistant_error', subtaskId: attemptId, error: 'Incomplete provider stream' },
  ]
}

test('retains buffered reasoning when a failed original turn settles during history loading', () => {
  const snapshot = mergeBufferedTranscriptProcessing(history, buffered())
  const actions = filterBufferedTranscriptActions(snapshot, buffered())
  const restored = actions.reduce((messages, action) => reduceWorkbenchMessages(messages, action), snapshot)
  expect(restored).toHaveLength(1)
  expect(restored[0]).toMatchObject({ id: 'canonical-body', status: 'error', content: 'Original partial response',
    error: 'Incomplete provider stream', blocks: [{ type: 'thinking', content: 'Original thought', status: 'done' }] })
  expect(actions).toEqual([])
})

test('does not replace committed reasoning or import a different execution attempt', () => {
  expect(mergeBufferedTranscriptProcessing(history, buffered('different-attempt'))).toEqual(history)
  const withThinking = [{ ...history[0], blocks: [{ id: 'canonical-thought', type: 'thinking' as const,
    content: 'Persisted thought', status: 'done' }] }]
  expect(mergeBufferedTranscriptProcessing(withThinking, buffered())).toEqual(withThinking)
})

test('targets buffered tool creation at the canonical assistant without creating another reply', () => {
  const tool: RuntimePaneMessageAction = { type: 'block_created', subtaskId: 'turn-1',
    block: { id: 'original-tool', type: 'tool_call', tool_name: 'read', status: 'done', tool_output: 'Original result' } }
  const events: RuntimePaneMessageAction[] = [buffered()[0], tool,
    { type: 'assistant_done', subtaskId: 'turn-1', content: 'Original partial response' }]
  const snapshot = mergeBufferedTranscriptProcessing(history, events)
  const restored = filterBufferedTranscriptActions(snapshot, events)
    .reduce((messages, action) => reduceWorkbenchMessages(messages, action), snapshot)
  expect(restored).toHaveLength(1)
  expect(restored[0].blocks?.[0]).toMatchObject({ id: 'original-tool', tool_output: 'Original result' })
  expect(filterBufferedTranscriptActions(restored, [tool])).toEqual([])
})

test('an unresolved tool observation stays unknown without reopening the settled task', () => {
  const events: RuntimePaneMessageAction[] = [buffered()[0],
    { type: 'block_created', subtaskId: 'turn-1', block: { id: 'unfinished', type: 'tool_call',
      tool_name: 'read', status: 'pending' } },
    { type: 'block_updated', subtaskId: 'turn-1', blockId: 'unfinished', updates: { status: 'pending' } },
  ]
  const snapshot = mergeBufferedTranscriptProcessing(history, events)
  const restored = filterBufferedTranscriptActions(snapshot, events)
    .reduce((messages, action) => reduceWorkbenchMessages(messages, action), snapshot)
  expect(restored).toHaveLength(1)
  expect(restored[0]).toMatchObject({ status: 'error', error: 'Incomplete provider stream',
    blocks: [{ id: 'unfinished', status: 'unknown' }] })
})
