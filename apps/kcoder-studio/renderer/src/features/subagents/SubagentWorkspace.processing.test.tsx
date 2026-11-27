import '@/i18n'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { clearPersistentProcessingExpansions } from '@/components/chat/blocks/processingExpansionState'
import { SubagentConversationProjection } from '@/kcoder/subagentConversationProjection'
import { SubagentWorkspace } from './SubagentWorkspace'

vi.mock('@/components/chat/composer/ComposerTextarea', () => ({
  ComposerTextarea: () => <textarea data-testid="subagent-workspace-input" readOnly />,
}))

const owner = { deviceId: 'fold-target', taskId: 'parent-task', threadId: 'parent-thread' }
const runId = 'confirmed-child-run'
const stamp = 1795250000000
const callbacks = { onReadArtifact: vi.fn(), onSteer: vi.fn(), onStop: vi.fn(), onClose: vi.fn() }
const agent = { id: 'child', agentId: 'child', agentPath: 'parent:child', agentName: 'Explore', status: 'running' }

function snapshot(active: boolean) {
  const projection = new SubagentConversationProjection(owner)
  return projection.snapshot({
    threadId: owner.threadId, agentId: agent.agentId, runId, sequence: 1, active,
    messages: [
      { id: 'process-one', role: 'assistant', content: '', status: 'done', timestampMs: stamp,
        blocks: [
          { id: 'thought', type: 'thinking', content: 'Inspect the repository', status: 'done', timestamp: stamp },
          { id: 'read', type: 'tool', tool_name: 'read', status: 'done', tool_input: { file_path: 'README.md' },
            tool_output: 'Owned file contents', timestamp: stamp },
        ] },
      { id: 'process-two', role: 'assistant', content: '', status: 'done', timestampMs: stamp + 1000,
        blocks: [{ id: 'search', type: 'tool', tool_name: 'grep', status: 'done', tool_input: { pattern: 'test' },
          tool_output: 'Owned search results', timestamp: stamp + 1000 }] },
      { id: 'final', role: 'assistant', content: 'Child final response', status: 'done', timestampMs: stamp + 2000,
        blocks: [] },
    ],
  })
}

function child(current = snapshot(true), identity = current.runId) {
  return <SubagentWorkspace {...callbacks} agent={{ ...agent, status: current.active ? 'running' : 'done' }}
    connected canSteer={false} conversationMessages={current.messages} conversationActive={current.active}
    conversationKey="owned-child-conversation" conversationRunId={identity} />
}

beforeEach(() => { localStorage.clear(); vi.clearAllMocks() })
afterEach(() => { cleanup(); clearPersistentProcessingExpansions() })

test('a live child starts open with folded details and folds at completion', async () => {
  const view = render(child())
  const toggle = await screen.findByTestId('final-processing-toggle')
  expect(toggle).toHaveAttribute('aria-expanded', 'true')
  expect(screen.getAllByTestId('turn-process-summary')).toHaveLength(1)
  const batches = screen.getAllByTestId('process-activity-toggle')
  expect(batches).toHaveLength(2)
  for (const batch of batches) expect(batch).toHaveAttribute('aria-expanded', 'false')
  fireEvent.click(batches[0])
  expect(screen.getByTestId('assistant-thinking-toggle')).toHaveAttribute('aria-expanded', 'false')
  expect(screen.getByText('Child final response')).toBeVisible()
  for (const content of screen.getAllByTestId('turn-process-content')) expect(content).toBeVisible()
  view.rerender(child(snapshot(true)))
  expect(toggle).toHaveAttribute('aria-expanded', 'true')
  view.rerender(child(snapshot(false)))
  await waitFor(() => expect(toggle).toHaveAttribute('aria-expanded', 'false'))
  expect(screen.getByText('Child final response')).toBeVisible()
  fireEvent.click(toggle)
  expect(screen.getAllByTestId('turn-process-content')).toHaveLength(2)
  expect(callbacks.onSteer).not.toHaveBeenCalled()
  expect(callbacks.onStop).not.toHaveBeenCalled()
  expect(callbacks.onReadArtifact).not.toHaveBeenCalled()
})

test.each(['failed', 'stopped', 'unknown'] as const)('a terminal %s child remains collapsed and can be inspected', async outcome => {
  const current = snapshot(false)
  current.messages[2] = { ...current.messages[2],
    status: outcome === 'failed' ? 'failed' : outcome === 'unknown' ? 'unknown' : 'done',
    ...(outcome === 'stopped' ? { runtimeStatus: 'cancelled' } : {}),
  }
  render(child(current))
  const toggle = await screen.findByTestId('final-processing-toggle')
  expect(toggle).toHaveAttribute('aria-expanded', 'false')
  fireEvent.click(toggle)
  expect(toggle).toHaveAttribute('aria-expanded', 'true')
  expect(screen.getAllByTestId('turn-process-content').length).toBeGreaterThanOrEqual(2)
  expect(toggle.querySelector('.animate-spin')).toBeNull()
})

test('switching child runs resets disclosure even when message and conversation IDs are reused', async () => {
  const view = render(child())
  fireEvent.click(await screen.findByTestId('final-processing-toggle'))
  expect(screen.getByTestId('final-processing-toggle')).toHaveAttribute('aria-expanded', 'false')
  view.rerender(child(snapshot(true), 'replacement-child-run'))
  expect(screen.getByTestId('final-processing-toggle')).toHaveAttribute('aria-expanded', 'true')
  expect(screen.getAllByTestId('turn-process-content').length).toBeGreaterThan(0)
})

vi.mock('@/features/appearance/useConversationPreferences', async importOriginal => {
  const actual = await importOriginal<typeof import('@/features/appearance/useConversationPreferences')>()
  return { ...actual, useConversationPreferences: () => ({
    ...actual.useConversationPreferences(), conversationProcessDisplay: 'three-level-v1',
  }) }
})
