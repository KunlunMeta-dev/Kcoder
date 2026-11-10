import '@/i18n'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { hydrateConversationPreferences, saveConversationPreferences } from '@/features/appearance/useConversationPreferences'
import { AssistantThinkingDetails } from './AssistantThinkingDetails'

test('shows a rotating indicator while collapsed or expanded and removes it when finished', () => {
  const { rerender } = render(<AssistantThinkingDetails content="Actual reasoning" running />)
  const toggle = screen.getByTestId('assistant-thinking-toggle')
  expect(toggle).toHaveAttribute('aria-expanded', 'false')
  expect(toggle).toHaveAttribute('aria-busy', 'true')
  expect(screen.getByTestId('assistant-thinking-spinner')).toHaveClass('animate-spin')
  expect(screen.getByTestId('assistant-thinking-spinner')).not.toHaveClass(
    'motion-reduce:animate-none'
  )
  expect(screen.getByTestId('assistant-thinking-spinner')).toHaveAttribute('aria-hidden', 'true')
  fireEvent.click(toggle)
  expect(screen.getByTestId('assistant-thinking-spinner')).toBeInTheDocument()
  expect(screen.getByTestId('assistant-thinking-content')).toHaveTextContent('Actual reasoning')
  rerender(<AssistantThinkingDetails content="Actual reasoning completed" running={false} />)
  expect(toggle).toHaveAttribute('aria-busy', 'false')
  expect(toggle).toHaveAttribute('aria-expanded', 'true')
  expect(screen.queryByTestId('assistant-thinking-spinner')).not.toBeInTheDocument()
})

test('only actual reasoning is shown and starts collapsed', () => {
  const { rerender } = render(<AssistantThinkingDetails content="" running />)
  expect(screen.queryByTestId('assistant-thinking-details')).not.toBeInTheDocument()
  rerender(<AssistantThinkingDetails content="Returned reasoning text" running />)
  expect(screen.getByTestId('assistant-thinking-toggle')).toHaveAttribute('aria-expanded', 'false')
  expect(screen.queryByText('Returned reasoning text')).not.toBeInTheDocument()
  fireEvent.click(screen.getByTestId('assistant-thinking-toggle'))
  expect(screen.getByTestId('assistant-thinking-content')).toHaveTextContent(
    'Returned reasoning text'
  )
  rerender(
    <AssistantThinkingDetails content="Returned reasoning text plus a delta" running={false} />
  )
  expect(screen.getByTestId('assistant-thinking-content')).toHaveTextContent('plus a delta')
  expect(screen.getByTestId('assistant-thinking-toggle')).not.toHaveTextContent('Thinking')
})

test('windowed reasoning opens while running and collapses when its segment finishes', () => {
  const { rerender } = render(
    <AssistantThinkingDetails content="Reasoning in progress" running windowed />
  )
  expect(screen.getByTestId('assistant-thinking-toggle')).toHaveAttribute('aria-expanded', 'true')
  expect(screen.getByTestId('assistant-thinking-content')).toHaveTextContent(
    'Reasoning in progress'
  )
  rerender(<AssistantThinkingDetails content="Reasoning complete" running={false} windowed />)
  expect(screen.queryByTestId('assistant-thinking-content')).not.toBeInTheDocument()
  fireEvent.click(screen.getByTestId('assistant-thinking-toggle'))
  expect(screen.getByTestId('assistant-thinking-content')).toHaveTextContent('Reasoning complete')
})

test('ordinary reasoning uses the conversation default and retains manual folding through updates', async () => {
  await act(async () => {
    await hydrateConversationPreferences()
    await saveConversationPreferences({ thinkingCollapsedByDefault: false })
  })
  try {
    const { rerender } = render(<AssistantThinkingDetails content="Reasoning" running />)
    expect(screen.getByTestId('assistant-thinking-toggle')).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(screen.getByTestId('assistant-thinking-toggle'))
    rerender(<AssistantThinkingDetails content="Reasoning plus a delta" running />)
    expect(screen.getByTestId('assistant-thinking-toggle')).toHaveAttribute('aria-expanded', 'false')
    rerender(<AssistantThinkingDetails content="Reasoning complete" running={false} />)
    expect(screen.getByTestId('assistant-thinking-toggle')).toHaveAttribute('aria-expanded', 'false')
  } finally {
    await act(async () => {
      await saveConversationPreferences({ thinkingCollapsedByDefault: true })
    })
  }
})

test('windowed reasoning retains manual folding while its running segment receives deltas', () => {
  const { rerender } = render(<AssistantThinkingDetails content="Reasoning" running windowed />)
  fireEvent.click(screen.getByTestId('assistant-thinking-toggle'))
  rerender(<AssistantThinkingDetails content="Reasoning plus a delta" running windowed />)
  expect(screen.getByTestId('assistant-thinking-toggle')).toHaveAttribute('aria-expanded', 'false')
  rerender(<AssistantThinkingDetails content="Reasoning complete" running={false} windowed />)
  expect(screen.getByTestId('assistant-thinking-toggle')).toHaveAttribute('aria-expanded', 'false')
  fireEvent.click(screen.getByTestId('assistant-thinking-toggle'))
  expect(screen.getByTestId('assistant-thinking-content')).toHaveTextContent('Reasoning complete')
})


test('shows the reasoning icon and updates duration across deltas and folding', () => {
  vi.useFakeTimers()
  const start = 1_800_000_000_000
  vi.setSystemTime(start)
  try {
    const { rerender, unmount } = render(
      <AssistantThinkingDetails content="Reasoning" running startedAt={start} windowed />
    )
    expect(screen.getByTestId('assistant-thinking-icon')).toHaveAttribute('aria-hidden', 'true')
    act(() => { vi.advanceTimersByTime(3000) })
    fireEvent.click(screen.getByTestId('assistant-thinking-toggle'))
    rerender(<AssistantThinkingDetails content="Reasoning plus delta" running startedAt={start} windowed />)
    act(() => { vi.advanceTimersByTime(8000) })
    expect(screen.getByTestId('thinking-duration').textContent).toMatch(/11/)
    expect(screen.queryByTestId('assistant-thinking-content')).not.toBeInTheDocument()
    rerender(<AssistantThinkingDetails content="Reasoning complete" running={false} startedAt={start} completedAt={start + 11_000} windowed />)
    act(() => { vi.advanceTimersByTime(50_000) })
    expect(screen.getByTestId('thinking-duration').textContent).toMatch(/11/)
    unmount()
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    vi.useRealTimers()
  }
})
