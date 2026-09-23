import { afterEach, describe, expect, it, vi } from 'vitest'
import { getKeyboardPlatform, keybindingPartDisplay } from './keyboard-platform'

afterEach(() => vi.restoreAllMocks())

describe('keyboard platform', () => {
  it.each([
    ['MacIntel', 'mac'],
    ['Win32', 'windows'],
    ['Linux x86_64', 'linux'],
  ] as const)('detects the client platform %s', (value, expected) => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue(value)
    expect(getKeyboardPlatform()).toBe(expected)
  })

  it('falls back to the browser user agent when platform is unavailable', () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('')
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Windows NT 10.0)')
    expect(getKeyboardPlatform()).toBe('windows')
  })

  it('displays explicit Meta bindings without turning them into Control', () => {
    expect(keybindingPartDisplay('Command', 'mac')).toEqual({ text: '⌘', label: 'Command' })
    expect(keybindingPartDisplay('Command', 'windows')).toEqual({ text: 'Win', label: 'Win' })
    expect(keybindingPartDisplay('Command', 'linux')).toEqual({ text: 'Super', label: 'Super' })
    expect(keybindingPartDisplay('Control', 'windows')).toEqual({ text: 'Ctrl', label: 'Control' })
    expect(keybindingPartDisplay('Alt', 'linux')).toEqual({ text: 'Alt', label: 'Alt' })
    expect(keybindingPartDisplay('Shift', 'linux')).toEqual({ text: 'Shift', label: 'Shift' })
  })

  it('resolves portable modifiers using the client platform', () => {
    expect(keybindingPartDisplay('CommandOrControl', 'mac')).toEqual({
      text: '⌘',
      label: 'Command',
    })
    expect(keybindingPartDisplay('CommandOrControl', 'windows')).toEqual({
      text: 'Ctrl',
      label: 'Control',
    })
    expect(keybindingPartDisplay('CommandOrControl', 'linux')).toEqual({
      text: 'Ctrl',
      label: 'Control',
    })
  })
})
