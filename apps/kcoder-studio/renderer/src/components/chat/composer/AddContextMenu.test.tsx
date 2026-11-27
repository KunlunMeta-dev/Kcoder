import '@/i18n'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { AddContextMenu } from './AddContextMenu'

describe('AddContextMenu layout', () => {
  test('keeps the menu within a narrow composer boundary', async () => {
    render(
      <div data-testid="project-chat-composer" data-floating-menu-boundary="true">
        <AddContextMenu disabled={false} onFileSelect={vi.fn()} />
      </div>
    )

    const boundary = screen.getByTestId('project-chat-composer')
    boundary.getBoundingClientRect = () =>
      ({ left: 500, right: 640, top: 600, bottom: 700, width: 140, height: 100 }) as DOMRect
    const button = screen.getByTestId('add-context-button')
    button.parentElement!.getBoundingClientRect = () =>
      ({ left: 510, right: 542, top: 650, bottom: 682, width: 32, height: 32 }) as DOMRect

    fireEvent.click(button)
    const menu = await screen.findByTestId('add-context-menu')
    await waitFor(() => expect(menu.style.width).toBe('124px'))

    const left = 510 + Number.parseFloat(menu.style.left)
    expect(left).toBeGreaterThanOrEqual(508)
    expect(left + Number.parseFloat(menu.style.width)).toBeLessThanOrEqual(632)
  })
})
