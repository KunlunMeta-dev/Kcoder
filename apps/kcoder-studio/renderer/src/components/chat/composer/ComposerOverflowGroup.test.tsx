import { createRef } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { ComposerOverflowGroup } from './ComposerOverflowGroup'

describe('ComposerOverflowGroup layout', () => {
  test('keeps the overflow popover inside a narrow composer pane', () => {
    const triggerRef = createRef<HTMLButtonElement>()
    render(
      <div data-floating-menu-boundary="true" data-testid="composer-boundary">
        <button ref={triggerRef} type="button" data-testid="overflow-trigger" />
        <ComposerOverflowGroup
          folded
          id="composer-overflow-test"
          label="More"
          triggerRef={triggerRef}
          onOpenChange={vi.fn()}
        >
          <button type="button">Action</button>
        </ComposerOverflowGroup>
      </div>
    )

    const boundary = screen.getByTestId('composer-boundary')
    boundary.getBoundingClientRect = () =>
      ({ left: 500, right: 640, top: 600, bottom: 700, width: 140, height: 100 }) as DOMRect
    triggerRef.current!.getBoundingClientRect = () =>
      ({ left: 510, right: 542, top: 650, bottom: 682, width: 32, height: 32 }) as DOMRect

    const menu = boundary.querySelector<HTMLElement>('[data-composer-overflow-group]')!
    const event = new Event('beforetoggle', { bubbles: true })
    Object.defineProperty(event, 'newState', { value: 'open' })
    fireEvent(menu, event)

    expect(menu.style.width).toBe('124px')
    expect(Number.parseFloat(menu.style.left)).toBeGreaterThanOrEqual(508)
    expect(Number.parseFloat(menu.style.left) + Number.parseFloat(menu.style.width)).toBeLessThanOrEqual(632)
  })
})
