import { render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { MacOSTitleBarDragRegion } from './MacOSTitleBarDragRegion'

afterEach(() => vi.restoreAllMocks())

test('preserves the titlebar dimensions and delegates dragging to Chromium', () => {
  render(<MacOSTitleBarDragRegion className="flex-1" />)
  expect(screen.getByTestId('macos-titlebar-drag-region')).toHaveClass('flex-1', '[-webkit-app-region:drag]')
})

test('leaves the Windows workbench toolbar out of the native drag region', () => {
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Win32')
  render(<MacOSTitleBarDragRegion className="absolute inset-0 h-full w-full" />)

  const region = screen.getByTestId('macos-titlebar-drag-region')
  expect(region).toHaveClass('absolute', 'inset-0', 'h-full', 'w-full', 'pointer-events-none')
  expect(region).not.toHaveClass('[-webkit-app-region:drag]')
  expect(region).not.toHaveAttribute('data-kcoder-drag-region')
})

test.each(['MacIntel', 'Linux x86_64'])('preserves dragging on %s', platform => {
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue(platform)
  render(<MacOSTitleBarDragRegion />)

  expect(screen.getByTestId('macos-titlebar-drag-region')).toHaveClass(
    'pointer-events-auto',
    '[-webkit-app-region:drag]'
  )
})
