import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { MarkdownCodeBlock } from './MarkdownCodeBlock'

const loading = vi.hoisted(() => {
  let release!: () => void
  const ready = new Promise<void>(resolve => { release = resolve })
  return { ready, release, started: vi.fn() }
})
vi.mock('./markdownSyntaxHighlighter', async () => {
  loading.started()
  await loading.ready
  return vi.importActual('./markdownSyntaxHighlighter')
})

test('source and controls remain available while highlighting waits, then use the latest content and theme', async () => {
  expect(loading.started).not.toHaveBeenCalled()
  const view = render(<MarkdownCodeBlock lang="md">original source</MarkdownCodeBlock>)
  const copy = screen.getByTestId('markdown-code-copy-button')
  const writeText = vi.fn(async () => undefined)
  vi.stubGlobal('navigator', { clipboard: { writeText } })
  try {
    await waitFor(() => expect(loading.started).toHaveBeenCalledTimes(1))
    expect(view.container.querySelector('code')).toHaveTextContent('original source')
    expect(view.container.querySelector('code span')).toBeNull()
    fireEvent.click(screen.getByTestId('markdown-code-wrap-button'))
    expect(screen.getByTestId('markdown-code-scroll-container')).toHaveAttribute('data-wrap', 'true')
    await act(async () => { fireEvent.click(copy) })
    expect(writeText).toHaveBeenLastCalledWith('original source')
    view.rerender(<MarkdownCodeBlock lang="ts">const latest = 42</MarkdownCodeBlock>)
    await act(async () => { document.documentElement.dataset.theme = 'dark' })
    const removed = render(<MarkdownCodeBlock lang="python">removed = True</MarkdownCodeBlock>)
    removed.unmount()
    await act(async () => { loading.release(); await import('./markdownSyntaxHighlighter') })
    await waitFor(() => expect(view.container.querySelector('code span')).not.toBeNull())
    expect(view.container.querySelector('code')).toHaveTextContent('const latest = 42')
    expect(screen.getByTestId('markdown-code-block')).toHaveAttribute('data-color-scheme', 'dark')
    expect(screen.getByTestId('markdown-code-copy-button')).toBe(copy)
    const attempts = loading.started.mock.calls.length
    view.rerender(<MarkdownCodeBlock lang="ts">const next = 43</MarkdownCodeBlock>)
    expect(view.container.querySelector('code')).toHaveTextContent('const next = 43')
    expect(loading.started).toHaveBeenCalledTimes(attempts)
    expect(screen.queryByText('removed = True')).not.toBeInTheDocument()
  } finally {
    view.unmount()
    document.documentElement.removeAttribute('data-theme')
    vi.unstubAllGlobals()
  }
})
