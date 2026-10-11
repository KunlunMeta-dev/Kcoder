import { afterEach, expect, test } from 'vitest'
import { mergeAppearance, readStoredAppearance, writeStoredAppearance } from './storage'
import { applyAppearance } from './applyAppearance'
import { getTerminalTheme } from '@/lib/xterm-theme'

afterEach(() => {
  localStorage.clear()
  document.documentElement.removeAttribute('style')
})

test('terminal color defaults remain compatible with existing profiles and validate overrides', () => {
  expect(mergeAppearance({}).terminal?.colors).toEqual({
    foreground_light: null,
    foreground_dark: null,
  })
  expect(
    mergeAppearance({ terminal: { colors: { foreground_light: 'invalid' } } }).terminal?.colors
      .foreground_light
  ).toBeNull()
})

test('terminal colors persist locally, follow the selected theme and reset to theme colors', () => {
  const appearance = mergeAppearance({
    terminal: { colors: { foreground_light: '#123456', foreground_dark: '#abcdef' } },
  })
  writeStoredAppearance(appearance)
  const stored = readStoredAppearance()
  applyAppearance(stored, 'light')
  expect(getTerminalTheme().foreground).toBe('rgb(18, 52, 86)')
  applyAppearance(stored, 'dark')
  expect(getTerminalTheme().foreground).toBe('rgb(171, 205, 239)')
  applyAppearance(mergeAppearance({}), 'light')
  expect(getTerminalTheme().foreground).not.toBe('rgb(18, 52, 86)')
})
