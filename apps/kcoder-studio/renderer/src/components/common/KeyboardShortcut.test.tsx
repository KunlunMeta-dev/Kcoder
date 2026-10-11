import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { KeyboardShortcut } from './KeyboardShortcut'

afterEach(() => vi.restoreAllMocks())

describe('KeyboardShortcut', () => {
  test.each([
    ['MacIntel', '⌃⌥⇧⌘J'],
    ['Win32', 'CtrlAltShiftWinJ'],
    ['Linux x86_64', 'CtrlAltShiftSuperJ'],
  ])('renders the actual modifiers on %s', (platform, expected) => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue(platform)
    render(
      <div data-testid="shortcut">
        <KeyboardShortcut value="Control+Alt+Shift+Command+J" />
      </div>
    )
    expect(screen.getByTestId('shortcut')).toHaveTextContent(expected)
  })
})
