import { afterEach, describe, expect, it, vi } from 'vitest'
import { readWidgetTheme } from './theme'

afterEach(() => {
  document.documentElement.removeAttribute('style')
  document.documentElement.removeAttribute('data-theme')
  document.documentElement.classList.remove('dark')
  vi.unstubAllGlobals()
})
describe('widget theme projection', () => {
  it('keeps widget animations enabled with the retired reduced-motion preference', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }))
    document.documentElement.dataset.theme = 'light'
    expect(readWidgetTheme('zh-CN').reducedMotion).toBe(false)
  })
  it('converts the product RGB-channel tokens into actual CSS colors', () => {
    document.documentElement.style.setProperty('--color-bg-base', '17 19 22')
    document.documentElement.style.setProperty('--color-text-primary', '241 245 249')
    document.documentElement.style.setProperty('--color-border', '55 61 70 / 0.5')
    document.documentElement.style.setProperty('--text-base', '16px')
    document.documentElement.dataset.theme = 'dark'
    const fontSize = getComputedStyle(document.documentElement)
      .getPropertyValue('--text-base')
      .trim()
    expect(readWidgetTheme('zh-CN')).toMatchObject({
      colorScheme: 'dark',
      background: 'rgb(17 19 22)',
      foreground: 'rgb(241 245 249)',
      border: 'rgb(55 61 70 / 0.5)',
      fontSize,
      locale: 'zh-CN',
    })
  })
  it('preserves already resolved colors and explicit light theme', () => {
    document.documentElement.style.setProperty('--color-primary', '#123456')
    document.documentElement.dataset.theme = 'light'
    expect(readWidgetTheme('en')).toMatchObject({
      colorScheme: 'light',
      primary: '#123456',
      locale: 'en',
    })
  })
})
