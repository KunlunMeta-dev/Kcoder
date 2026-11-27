import { act, render, screen, waitFor } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { AssistantMarkdown } from './AssistantMarkdown'

const loading = vi.hoisted(() => {
  let release!: () => void
  const ready = new Promise<void>(resolve => { release = resolve })
  return { ready, release, started: vi.fn() }
})
vi.mock('./markdownMathPlugin', async () => {
  loading.started()
  await loading.ready
  return vi.importActual('./markdownMathPlugin')
})

test('prose stays immediate and mounted while the latest formula waits for its plugin', async () => {
  const view = render(<AssistantMarkdown content="Ordinary text stays readable." />)
  const paragraph = screen.getByText('Ordinary text stays readable.')
  expect(loading.started).not.toHaveBeenCalled()
  view.rerender(<AssistantMarkdown content={'Ordinary text stays readable.\n\n$x^2$'} />)
  await waitFor(() => expect(loading.started).toHaveBeenCalledTimes(1))
  expect(screen.getByText('Ordinary text stays readable.')).toBe(paragraph)
  expect(view.container.querySelector('.katex')).toBeNull()
  view.rerender(<AssistantMarkdown content={'Ordinary text stays readable.\n\n$x^3$'} />)
  const removed = render(<AssistantMarkdown content="$y^2$" />)
  removed.unmount()
  await act(async () => { loading.release(); await loading.ready })
  await waitFor(() => expect(view.container.querySelectorAll('.katex')).toHaveLength(1))
  expect(view.container.querySelector('annotation')).toHaveTextContent('x^3')
  expect(screen.getByText('Ordinary text stays readable.')).toBe(paragraph)
  expect(loading.started).toHaveBeenCalledTimes(1)
})
