import { render, screen, fireEvent } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import '@/i18n'
import { ChatInput } from './ChatInput'

test.each(['compact', 'desktop'] as const)('%s original-history view disables editing while retaining its unsent draft', variant => {
  const props = { value: 'Retain this unsent draft', onChange: vi.fn(), onSubmit: vi.fn(), variant }
  const view = render(<ChatInput {...props} disabled={false} />)
  expect(screen.getByTestId('chat-message-input')).toHaveAttribute('contenteditable', 'true')
  view.rerender(<ChatInput {...props} disabled disabledReason="Original session belongs to another terminal" />)
  expect(screen.getByTestId('composer-disabled-reason')).toHaveTextContent('another terminal')
  expect(screen.getByTestId('chat-message-input')).toHaveAttribute('contenteditable', 'false')
  expect(screen.getByTestId('chat-message-input')).toHaveAttribute('aria-readonly', 'true')
  expect(screen.getByTestId('chat-message-input')).toHaveAttribute('aria-disabled', 'true')
  expect(screen.getByTestId('chat-message-input')).toHaveTextContent(props.value)
  fireEvent.keyDown(screen.getByTestId('chat-message-input'), { key: 'Enter', code: 'Enter' })
  expect(props.onSubmit).not.toHaveBeenCalled()
  view.rerender(<ChatInput {...props} disabled={false} />)
  expect(screen.getByTestId('chat-message-input')).toHaveAttribute('contenteditable', 'true')
  expect(screen.getByTestId('chat-message-input')).toHaveAttribute('aria-readonly', 'false')
})
