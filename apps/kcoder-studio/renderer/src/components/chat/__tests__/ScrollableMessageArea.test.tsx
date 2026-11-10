import { render, screen } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import '@/i18n'
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
      readFiles: () => null,
      readToolLines: () => null,
      readProviderRetry: () => null,
    },
  }
})

const CONVERSATION_COLUMN = 'conversation-column'

describe('ScrollableMessageArea transient tool status', () => {
  test('mounts the generating-parameters row in the transcript column, not a centered caption', () => {
    render(
      <ScrollableMessageArea
        messages={[
          {
            id: 'user-1',
            role: 'user',
            content: '检查一下代理可用性',
            status: 'done',
            createdAt: '2026-10-14T15:00:00.000Z',
          },
        ]}
        messageListClassName={CONVERSATION_COLUMN}
      />
    )

    const row = screen.getByTestId('tool-input-progress-status')
    expect(row).toHaveClass(CONVERSATION_COLUMN)
    expect(row).not.toHaveClass('max-w-3xl')
  })
})
