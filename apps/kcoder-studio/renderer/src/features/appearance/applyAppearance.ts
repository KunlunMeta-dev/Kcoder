import { blendTriplet, hexToRgbTriplet } from './color'
import { darkPalette, lightPalette } from './presets'
import type { AppearanceConfig, ResolvedAppearanceMode, ThemePalette } from './types'
import { resolveUiTypographyVariables } from './typography'

const PALETTE_VARIABLES: Record<keyof ThemePalette, string> = {
  bgBase: '--color-bg-base',
  bgSurface: '--color-bg-surface',
  bgMuted: '--color-muted',
  bgHover: '--color-bg-hover',
  sidebar: '--color-sidebar',
  sidebarActive: '--color-sidebar-active',
  sidebarHover: '--color-sidebar-hover',
  sidebarTextPrimary: '--color-sidebar-text-primary',
  sidebarTextSecondary: '--color-sidebar-text-secondary',
  sidebarTextMuted: '--color-sidebar-text-muted',
  mobileDrawer: '--color-mobile-drawer',
  border: '--color-border',
  textPrimary: '--color-text-primary',
  textSecondary: '--color-text-secondary',
  textMuted: '--color-text-muted',
  primary: '--color-primary',
  primaryContrast: '--color-primary-contrast',
  popover: '--color-popover',
  codeBg: '--color-code-bg',
}

export function resolveAppearanceMode(mode: AppearanceConfig['mode']): ResolvedAppearanceMode {
  if (mode === 'light' || mode === 'dark') return mode

  if (typeof window !== 'undefined' && window.matchMedia) {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  }

  return 'light'
}

export function applyAppearance(
  appearance: AppearanceConfig,
  resolvedMode = resolveAppearanceMode(appearance.mode)
) {
  if (typeof document === 'undefined') return

  const root = document.documentElement
  const defaultPalette = resolvedMode === 'dark' ? darkPalette : lightPalette
  const palette = {
    ...(resolvedMode === 'dark' ? appearance.dark : appearance.light),
    primary: hexToRgbTriplet(appearance.accentColor),
  }

  if (!palette.mobileDrawer || palette.mobileDrawer.includes('/')) {
    palette.mobileDrawer = defaultPalette.mobileDrawer
  }

  const contrast = (appearance.contrast - 50) / 50
  if (contrast !== 0) {
    const target = contrast > 0 ? palette.textPrimary : palette.bgBase
    for (const key of ['bgSurface', 'bgMuted', 'sidebarActive', 'codeBg'] as const) {
      palette[key] = blendTriplet(
        palette[key],
        target,
        Math.abs(contrast) * (contrast > 0 ? 0.08 : 0.6)
      )
    }
    palette.border = blendTriplet(palette.border, target, Math.abs(contrast) * 0.5)
    if (contrast > 0) {
      for (const key of [
        'textSecondary',
        'textMuted',
        'sidebarTextSecondary',
        'sidebarTextMuted',
      ] as const) {
        palette[key] = blendTriplet(palette[key], palette.textPrimary, contrast * 0.4)
      }
    }
  }
  // Inline palette values otherwise override the CSS opacity toggle.
  if (!appearance.sidebarTranslucent) palette.sidebar = palette.sidebar.split('/')[0].trim()

  root.dataset.theme = resolvedMode
  root.dataset.appearanceMode = appearance.mode
  root.dataset.sidebarTranslucent = String(appearance.sidebarTranslucent)
  root.classList.toggle('dark', resolvedMode === 'dark')
  root.style.colorScheme = resolvedMode

  Object.entries(PALETTE_VARIABLES).forEach(([key, variable]) => {
    root.style.setProperty(variable, palette[key as keyof ThemePalette])
  })

  root.style.setProperty('--font-ui', appearance.uiFont)
  root.style.setProperty('--font-code', appearance.codeFont)
  root.style.setProperty('--font-size-ui', `${appearance.uiFontSize}px`)
  root.style.setProperty('--font-size-code', `${appearance.codeFontSize}px`)
  root.style.setProperty('--text-chat', `${appearance.uiFontSize}px`)
  root.style.setProperty('--text-code', `${appearance.codeFontSize}px`)
  root.style.setProperty('--text-code-sm', `${Math.max(8, appearance.codeFontSize - 1)}px`)
  root.style.setProperty('--diffs-font-size', `${appearance.codeFontSize}px`)
  Object.entries(resolveUiTypographyVariables(appearance.uiFontSize)).forEach(
    ([variable, value]) => {
      root.style.setProperty(variable, value)
    }
  )
  root.style.setProperty('--appearance-contrast', String(appearance.contrast))
  const terminalColor =
    appearance.terminal?.colors[resolvedMode === 'dark' ? 'foreground_dark' : 'foreground_light']
  if (terminalColor)
    root.style.setProperty('--kcoder-terminal-foreground', hexToRgbTriplet(terminalColor))
  else root.style.removeProperty('--kcoder-terminal-foreground')
}
