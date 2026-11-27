import { fireEvent, render, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { Button } from '../button'

test('a pending button keeps its label mounted under the spinner, ignores clicks and keeps focus', () => {
  const onClick = vi.fn()
  const { rerender } = render(<Button onClick={onClick}>Save changes</Button>)
  const button = screen.getByRole('button', { name: 'Save changes' })
  button.focus()
  rerender(
    <Button onClick={onClick} pending>
      Save changes
    </Button>
  )
  // Same element, same accessible name: the label only becomes transparent.
  expect(screen.getByRole('button', { name: 'Save changes' })).toBe(button)
  expect(button.querySelector('[data-button-label]')).toHaveTextContent('Save changes')
  expect(button.querySelector('[data-button-spinner]')).toHaveAttribute('aria-hidden', 'true')
  expect(button).toHaveAttribute('aria-busy', 'true')
  expect(button).toHaveAttribute('aria-disabled', 'true')
  expect(button).not.toBeDisabled()
  expect(button).toHaveFocus()
  fireEvent.click(button)
  expect(onClick).not.toHaveBeenCalled()

  rerender(<Button onClick={onClick}>Save changes</Button>)
  expect(button).not.toHaveAttribute('aria-busy')
  fireEvent.click(button)
  expect(onClick).toHaveBeenCalledTimes(1)
})
