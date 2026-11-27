import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { MarkdownCodeBlock } from './MarkdownCodeBlock'

const loading = vi.hoisted(() => ({ started: vi.fn() }))
vi.mock('./markdownSyntaxHighlighter', () => {
  loading.started()
  throw new Error('Controlled syntax module failure')
})

test('failed highlighting retains selectable, copyable and wrappable source across later content', async () => {
  const view = render(<MarkdownCodeBlock lang="md">original source</MarkdownCodeBlock>)
  const writeText = vi.fn(async () => undefined)
  vi.stubGlobal('navigator', { clipboard: { writeText } })
  try {
    await waitFor(() => expect(loading.started).toHaveBeenCalledTimes(1))
    await act(async () => { await Promise.resolve() })
    expect(view.container.querySelector('code')).toHaveClass('select-text')
    expect(view.container.querySelector('code span')).toBeNull()
    fireEvent.click(screen.getByTestId('markdown-code-wrap-button'))
    expect(view.container.querySelector('code')).toHaveStyle({ whiteSpace: 'pre-wrap' })
    view.rerender(<MarkdownCodeBlock lang="md">updated source</MarkdownCodeBlock>)
    await act(async () => { fireEvent.click(screen.getByTestId('markdown-code-copy-button')) })
    expect(writeText).toHaveBeenLastCalledWith('updated source')
    expect(view.container.querySelector('code')).toHaveTextContent('updated source')
    expect(loading.started).toHaveBeenCalledTimes(1)
  } finally {
    vi.unstubAllGlobals()
  }
})
