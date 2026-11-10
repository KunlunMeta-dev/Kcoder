import { expect, it } from 'vitest'
import { workbenchTheme } from './workbenchTheme'

it('keeps primary contrast and focus independent while following the target UI font scale', () => {
  const style = document.createElement('div').style
  style.setProperty('--color-text-primary', '26 26 26')
  style.setProperty('--color-bg-base', '255 255 255')
  style.setProperty('--color-focus', '51 156 255')
  style.setProperty('--text-base', '16px')
  style.setProperty('--text-xs', '14px')
  style.setProperty('--font-ui', 'Test UI, sans-serif')
  const config = workbenchTheme(style, false)
  expect(config.token?.colorPrimary).toBe('rgb(26, 26, 26)')
  expect(config.token?.colorLink).toBe('rgb(51, 156, 255)')
  expect(config.token?.fontFamily).toBe('Test UI, sans-serif')
  expect(config.token?.fontSize).toBe(16)
  expect(config.token?.fontSizeSM).toBe(14)
  expect(config.components?.Button?.primaryColor).toBe('rgb(255, 255, 255)')
})

it('uses current dark tokens and resolves rem control sizes instead of fixed reference colours', () => {
  const style = document.createElement('div').style
  style.fontSize = '16px'
  style.setProperty('--color-text-primary', '235 235 235')
  style.setProperty('--color-bg-base', '24 24 24')
  style.setProperty('--color-border', '90 90 90 / 0.5')
  style.setProperty('--control-height-md', '2.25rem')
  style.setProperty('--radius-lg', '0.5rem')
  const config = workbenchTheme(style, true)
  expect(config.token?.colorPrimary).toBe('rgb(235, 235, 235)')
  expect(config.token?.colorBorder).toBe('rgba(90, 90, 90, 0.5)')
  expect(config.token?.borderRadius).toBe(8)
  expect(config.token?.controlHeight).toBe(36)
  expect(config.components?.Button?.primaryColor).toBe('rgb(24, 24, 24)')
})
