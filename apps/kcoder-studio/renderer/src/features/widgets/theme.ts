import type { WidgetTheme } from './types'

export function readWidgetTheme(locale: string): WidgetTheme {
  const style = getComputedStyle(document.documentElement)
  const token = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback
  const color = (name: string, fallback: string) => {
    const value = token(name, fallback)
    return /^[-\d.]+\s+[-\d.]+\s+[-\d.]+(?:\s*\/\s*[-\d.%]+)?$/.test(value) ? `rgb(${value})` : value
  }
  const root = document.documentElement
  const dark = root.dataset.theme === 'dark' || root.classList.contains('dark') ||
    (root.dataset.theme !== 'light' && typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches)
  return {
    colorScheme: dark ? 'dark' : 'light',
    foreground: color('--color-text-primary', 'CanvasText'),
    background: color('--color-bg-base', 'Canvas'),
    muted: color('--color-text-secondary', 'GrayText'),
    border: color('--color-border', 'GrayText'),
    primary: color('--color-primary', 'Highlight'),
    success: color('--color-success', 'CanvasText'),
    destructive: color('--color-destructive', 'CanvasText'),
    fontFamily: token('--font-ui', 'system-ui, sans-serif'),
    fontSize: token('--text-base', 'inherit'),
    locale,
    reducedMotion: false,
  }
}
