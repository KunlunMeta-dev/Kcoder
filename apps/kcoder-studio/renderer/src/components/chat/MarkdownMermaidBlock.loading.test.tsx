import { act, render, screen, waitFor } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { AssistantMarkdown } from './AssistantMarkdown'
import { MarkdownMermaidBlock } from './MarkdownMermaidBlock'

const loading = vi.hoisted(() => {
  let release!: () => void
  const ready = new Promise<void>(resolve => { release = resolve })
  return { ready, release, started: vi.fn() }
})
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('./MarkdownMermaidRenderer', async () => {
  loading.started()
  await loading.ready
  return { MarkdownMermaidRenderer: ({ chart }: { chart: string }) => <div data-testid="loaded-diagram">{chart}</div> }
})

test('prose does not load diagrams; pending loads keep only the latest mounted chart', async () => {
  const view = render(<AssistantMarkdown content="Ordinary prose stays readable." />)
  expect(screen.getByText('Ordinary prose stays readable.')).toBeInTheDocument()
  expect(loading.started).not.toHaveBeenCalled()
  view.rerender(<AssistantMarkdown content={'Still readable.\n\n```mermaid\ngraph TD\n  A[Old] --> B\n```'} />)
  await waitFor(() => expect(loading.started).toHaveBeenCalledTimes(1))
  expect(screen.getByText('Still readable.')).toBeInTheDocument()
  expect(screen.getByTestId('markdown-mermaid-loading')).toHaveAttribute('aria-busy', 'true')
  expect(screen.queryByText(/A\[Old\]/)).not.toBeInTheDocument()
  view.rerender(<AssistantMarkdown content={'Still readable.\n\n```mermaid\ngraph TD\n  A[Latest] --> B\n```'} />)
  const removed = render(<MarkdownMermaidBlock chart="Removed chart" />)
  removed.unmount()
  await act(async () => { loading.release(); await loading.ready })
  expect(await screen.findByTestId('loaded-diagram')).toHaveTextContent('A[Latest]')
  expect(screen.queryByText('Removed chart')).not.toBeInTheDocument()
  expect(screen.queryByTestId('markdown-mermaid-loading')).not.toBeInTheDocument()
  expect(loading.started).toHaveBeenCalledTimes(1)
})
