import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import '@/i18n'
import * as toolsCatalogContext from '@/kcoder/toolsCatalogContext'
import { ScrollableMessageArea } from '../ScrollableMessageArea'

vi.mock('@/kcoder/toolPathPreview', () => {
  const items = [{ id: 'web-search-1', name: 'WebSearch', chars: 40 }]
  return {
    toolPathPreviews: {
      subscribe: () => () => {},
      snapshot: () => 1,
      acquire: () => () => {},
      read: () => [],
      readInputs: () => items,
      hasInputs: () => items.length > 0,
      readFiles: () => null,
      readToolLines: () => null,
      readProviderRetry: () => null,
    },
  }
})

const CONVERSATION_COLUMN = 'conversation-column'

describe('ScrollableMessageArea transient tool status', () => {
  test('projects generating parameters into the transcript column, not a standalone caption', async () => {
    vi.spyOn(toolsCatalogContext, 'readToolsCatalog').mockResolvedValue({
      entries: new Map(),
      total: 0,
      truncated: false,
    })
    render(
      <ScrollableMessageArea
        toolsCatalogTaskId="task"
        toolsCatalogServerId="target"
        messages={[
          {
            id: 'user-1',
            role: 'user',
            content: '检查一下代理可用性',
            status: 'done',
            createdAt: '2026-10-14T15:00:00.000Z',
          },
          {
            id: 'assistant-1',
            role: 'assistant',
            content: '',
            status: 'streaming',
            subtaskId: 'attempt-1',
            createdAt: '2026-10-14T15:00:01.000Z',
          },
        ]}
        messageListClassName={CONVERSATION_COLUMN}
      />
    )

    // Argument generation joins the turn's fold tree (renderer README: three-level
    // disclosure) instead of mounting a separate character-count/status row.
    expect(screen.queryByTestId('tool-input-progress-status')).not.toBeInTheDocument()
    const assistant = screen.getByTestId('message-assistant')
    expect(assistant.closest(`.${CONVERSATION_COLUMN}`)).not.toBeNull()
    expect(assistant.closest('.max-w-3xl')).toBeNull()
    await userEvent.click(within(assistant).getByTestId('processing-summary-toggle'))
    expect(assistant).toHaveTextContent(/正在生成 WebSearch 工具参数/)
  })
})
