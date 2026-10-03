import type { ITheme, Terminal } from '@xterm/xterm'

type RequiredTerminalTheme = Required<
  Pick<ITheme, 'background' | 'foreground' | 'cursor' | 'selectionBackground'>
>

const LIGHT_TERMINAL_THEME: RequiredTerminalTheme = {
  background: '#ffffff',
  foreground: '#1a1a1a',
  cursor: '#14b8a6',
  selectionBackground: 'rgba(20, 184, 166, 0.2)',
}

const DARK_TERMINAL_THEME: RequiredTerminalTheme = {
  background: '#111316',
  foreground: '#f1f5f9',
  cursor: '#2dd4bf',
  selectionBackground: 'rgba(45, 212, 191, 0.28)',
}

const LIGHT_ANSI: ITheme = {
  black: '#1a1a1a',
  red: '#a31515',
  green: '#087443',
  yellow: '#795e00',
  blue: '#0451a5',
  magenta: '#7a3e9d',
  cyan: '#006b75',
  white: '#555555',
  brightBlack: '#666666',
  brightRed: '#b91c1c',
  brightGreen: '#167744',
  brightYellow: '#846000',
  brightBlue: '#1d4ed8',
  brightMagenta: '#9333aa',
  brightCyan: '#087e8b',
  brightWhite: '#333333',
}

const DARK_ANSI: ITheme = {
  black: '#000000',
  red: '#cd3131',
  green: '#0dbc79',
  yellow: '#e5e510',
  blue: '#2472c8',
  magenta: '#bc3fbc',
  cyan: '#11a8cd',
  white: '#e5e5e5',
  brightBlack: '#666666',
  brightRed: '#f14c4c',
  brightGreen: '#23d18b',
  brightYellow: '#f5f543',
  brightBlue: '#3b8eea',
  brightMagenta: '#d670d6',
  brightCyan: '#29b8db',
  brightWhite: '#ffffff',
}

function isDarkAppearance(): boolean {
  if (typeof document === 'undefined') return false

  const root = document.documentElement
  if (root.dataset.theme === 'dark' || root.classList.contains('dark')) {
    return true
  }
  if (root.dataset.theme === 'light') {
    return false
  }

  return Boolean(window.matchMedia?.('(prefers-color-scheme: dark)').matches)
}

function cssVariableColor(name: string, fallback: string, alpha?: number): string {
  if (typeof document === 'undefined') return fallback

  const rawValue = window.getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  if (!rawValue) return fallback

  const channels = rawValue
    .split('/')[0]
    .trim()
    .split(/\s+/)
    .map(channel => Number(channel))

  if (channels.length !== 3 || channels.some(channel => Number.isNaN(channel))) {
    return fallback
  }

  const [red, green, blue] = channels
  if (alpha != null) return `rgba(${red}, ${green}, ${blue}, ${alpha})`
  return `rgb(${red}, ${green}, ${blue})`
}

export function getTerminalTheme(transparentBackground = false): ITheme {
  const fallbackTheme = isDarkAppearance() ? DARK_TERMINAL_THEME : LIGHT_TERMINAL_THEME

  return {
    ...(isDarkAppearance() ? DARK_ANSI : LIGHT_ANSI),
    background: transparentBackground
      ? 'rgba(0, 0, 0, 0)'
      : cssVariableColor('--color-bg-base', fallbackTheme.background),
    foreground: cssVariableColor(
      '--kcoder-terminal-foreground',
      cssVariableColor('--color-text-primary', fallbackTheme.foreground)
    ),
    cursor: cssVariableColor('--color-primary', fallbackTheme.cursor),
    selectionBackground: cssVariableColor(
      '--color-primary',
      fallbackTheme.selectionBackground ?? DARK_TERMINAL_THEME.selectionBackground,
      isDarkAppearance() ? 0.28 : 0.2
    ),
  }
}

export function applyTerminalTheme(
  terminal: Terminal,
  container: HTMLElement,
  theme = getTerminalTheme(),
  transparentBackground = false
): ITheme {
  const appliedTheme = {
    ...theme,
    ...(transparentBackground ? { background: 'rgba(0, 0, 0, 0)' } : {}),
  }
  terminal.options.theme = appliedTheme
  // Shell SGR/true-color output can override the default foreground. Keep that
  // output readable too, rather than changing only uncolored terminal text.
  terminal.options.minimumContrastRatio = 4.5

  if (appliedTheme.background) {
    container.style.backgroundColor = appliedTheme.background
    container
      .querySelectorAll<HTMLElement>(
        '.xterm, .xterm-viewport, .xterm-screen, .xterm-scrollable-element'
      )
      .forEach(element => {
        element.style.backgroundColor = appliedTheme.background ?? ''
      })
  }

  return appliedTheme
}

export function createTerminalThemeScheduler(
  terminal: Terminal,
  container: HTMLElement,
  transparentBackground = false
): () => void {
  let frameId: number | null = null

  return () => {
    if (frameId != null) return

    frameId = window.requestAnimationFrame(() => {
      frameId = null
      applyTerminalTheme(terminal, container, getTerminalTheme(), transparentBackground)
    })
  }
}

export function observeTerminalTheme(onChange: (theme: ITheme) => void): () => void {
  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') {
    return () => undefined
  }

  const observer = new MutationObserver(() => {
    onChange(getTerminalTheme())
  })

  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class', 'data-theme', 'style'],
  })

  return () => observer.disconnect()
}
