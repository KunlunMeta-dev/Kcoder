import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { WorkbenchMessage } from '@/types/workbench'
import { MessageList } from './MessageList'
import { clearPersistentProcessingExpansions } from './blocks/processingExpansionState'
import '@/i18n'

const preferences = vi.hoisted(() => ({ ready: false, collapsed: false }))
vi.mock('@/features/appearance/useConversationPreferences', async importOriginal => {
  const actual =
    await importOriginal<typeof import('@/features/appearance/useConversationPreferences')>()
  return {
    ...actual,
    useConversationPreferences: () => ({
      ...actual.useConversationPreferences(),
      hydration: preferences.ready ? 'ready' : 'loading',
      toolsCollapsedByDefault: preferences.collapsed,
      thinkingCollapsedByDefault: true,
    }),
  }
})

afterEach(() => {
  clearPersistentProcessingExpansions()
  preferences.ready = false
  preferences.collapsed = false
})

it('freezes the first hydrated process preference and preserves an explicit user choice', () => {
  const response: WorkbenchMessage = {
    id: 'preference-response',
    role: 'assistant',
    status: 'done',
    content: 'Result',
    createdAt: '2026-10-26T00:00:00Z',
  }
  const view = render(<MessageList messages={[response]} conversationKey="preference-thread" />)
  const withTool: WorkbenchMessage = {
    ...response,
    blocks: [
      {
        id: 'preference-write',
        subtaskId: 'preference-thread',
        type: 'tool',
        toolName: 'write',
        toolInput: { file_path: 'result.txt' },
        toolOutput: 'written',
        status: 'done',
        createdAt: 1,
        completedAt: 2,
      },
    ],
  }
  view.rerender(<MessageList messages={[withTool]} conversationKey="preference-thread" />)
  expect(screen.getByTestId('final-processing-toggle')).toHaveAttribute('aria-expanded', 'false')
  preferences.ready = true
  view.rerender(<MessageList messages={[withTool]} conversationKey="preference-thread" />)
  expect(screen.getByTestId('final-processing-toggle')).toHaveAttribute('aria-expanded', 'true')
  preferences.collapsed = true
  view.rerender(<MessageList messages={[withTool]} conversationKey="preference-thread" />)
  expect(screen.getByTestId('final-processing-toggle')).toHaveAttribute('aria-expanded', 'true')
  fireEvent.click(screen.getByTestId('final-processing-toggle'))
  preferences.collapsed = false
  view.rerender(<MessageList messages={[withTool]} conversationKey="preference-thread" />)
  expect(screen.getByTestId('final-processing-toggle')).toHaveAttribute('aria-expanded', 'false')
})
