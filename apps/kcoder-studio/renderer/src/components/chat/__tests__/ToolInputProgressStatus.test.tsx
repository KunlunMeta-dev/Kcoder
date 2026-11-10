import { render, screen } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import '@/i18n'
import { ToolInputProgressStatus } from '../ToolInputProgressStatus'

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

const CONVERSATION_COLUMN = 'w-[min(59.8rem,calc(100%_-_2rem))]'

describe('ToolInputProgressStatus alignment', () => {
  test('sits on the left edge of the conversation column it is mounted in', () => {
    render(
      <ToolInputProgressStatus target="target" task="task" className={CONVERSATION_COLUMN} />
    )

    const row = screen.getByTestId('tool-input-progress-status')
    expect(row).toHaveClass(CONVERSATION_COLUMN)
    // A second inner reading cap would center the row inside a wider pane.
    expect(row).not.toHaveClass('max-w-3xl')
    expect(row).toHaveTextContent(/正在生成 WebSearch 工具参数/)
  })

  test('keeps the centered reading column when the caller passes none', () => {
    render(<ToolInputProgressStatus target="target" task="task" />)

    expect(screen.getByTestId('tool-input-progress-status')).toHaveClass(
      'mx-auto',
      'max-w-3xl',
      'px-6'
    )
  })

  test('embedded rows stay flush inside their tool block and still accept caller classes', () => {
    render(
      <ToolInputProgressStatus
        target="target"
        task="task"
        embedded
        className="transcript-inset"
      />
    )

    const row = screen.getByTestId('tool-input-progress-status')
    expect(row).toHaveClass('min-w-0', 'py-2', 'transcript-inset')
    expect(row).not.toHaveClass('max-w-3xl')
  })
})
