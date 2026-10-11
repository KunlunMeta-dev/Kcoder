import { fireEvent, render, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { ExecutionModeInfo } from './ExecutionModeInfo'

vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

test('configuration opens outside toolbar layout and closes with Escape or outside click', () => {
  render(
    <div data-testid="toolbar">
      <ExecutionModeInfo text="configured runtime mode" />
    </div>
  )
  const button = screen.getByTestId('execution-mode-info-button')
  expect(screen.queryByTestId('execution-mode-info')).not.toBeInTheDocument()
  fireEvent.click(button)
  const popup = screen.getByTestId('execution-mode-info')
  expect(popup).toHaveTextContent('configured runtime mode')
  expect(popup).toHaveClass('fixed')
  expect(screen.getByTestId('toolbar').contains(popup)).toBe(false)
  expect(button).toHaveAttribute('aria-expanded', 'true')
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(screen.queryByTestId('execution-mode-info')).not.toBeInTheDocument()
  expect(button).toHaveFocus()
  fireEvent.click(button)
  fireEvent.pointerDown(document.body)
  expect(screen.queryByTestId('execution-mode-info')).not.toBeInTheDocument()
})
