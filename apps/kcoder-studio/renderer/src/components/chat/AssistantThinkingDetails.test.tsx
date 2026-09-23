import { fireEvent, render, screen } from '@testing-library/react'
import { expect, test } from 'vitest'
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
