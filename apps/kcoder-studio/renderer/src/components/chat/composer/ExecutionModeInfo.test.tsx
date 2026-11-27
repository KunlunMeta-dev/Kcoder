import { fireEvent, render, screen, waitFor } from '@testing-library/react'
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

test('keeps the configuration popup within a narrow composer pane', async () => {
  render(
    <div data-testid="project-chat-composer" data-floating-menu-boundary="true">
      <ExecutionModeInfo text="configured runtime mode" />
    </div>
  )
  const boundary = screen.getByTestId('project-chat-composer')
  boundary.getBoundingClientRect = () =>
    ({ left: 500, right: 640, top: 600, bottom: 700, width: 140, height: 100 }) as DOMRect
  const button = screen.getByTestId('execution-mode-info-button')
  button.getBoundingClientRect = () =>
    ({ left: 510, right: 542, top: 650, bottom: 682, width: 32, height: 32 }) as DOMRect

  fireEvent.click(button)
  const popup = screen.getByTestId('execution-mode-info')
  await waitFor(() => expect(popup.style.width).toBe('124px'))

  expect(Number.parseFloat(popup.style.left)).toBeGreaterThanOrEqual(508)
  expect(Number.parseFloat(popup.style.left) + Number.parseFloat(popup.style.width)).toBeLessThanOrEqual(632)
})
