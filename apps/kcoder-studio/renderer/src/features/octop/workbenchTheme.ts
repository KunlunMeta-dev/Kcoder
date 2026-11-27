import type { ThemeConfig } from 'antd'

/** Adapt remaining Ant controls to the same live tokens as the workbench. */
export function workbenchTheme(style: CSSStyleDeclaration, dark: boolean): ThemeConfig {
  const token = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback
  const color = (name: string, fallback: string) => {
    const value = token(name, fallback)
    const [channels, alpha] = value.split('/')
    const values = channels.trim().split(/\s+/).map(Number)
    if (values.length !== 3 || values.some(value => !Number.isFinite(value))) return value
    return alpha === undefined
      ? `rgb(${values.join(', ')})`
      : `rgba(${values.join(', ')}, ${alpha.trim()})`
  }
  const pixels = (name: string, fallback: number) => {
    const value = token(name, '')
    const number = parseFloat(value)
    if (!Number.isFinite(number) || number <= 0) return fallback
    return value.endsWith('rem') ? number * (parseFloat(style.fontSize) || 16) : number
  }
  const foreground = color('--color-text-primary', dark ? '#e8e8e8' : '#1a1a1a')
  const secondary = color('--color-text-secondary', dark ? '#a3a3a3' : '#666666')
  const background = color('--color-bg-base', dark ? '#171717' : '#ffffff')
  const surface = color('--color-bg-surface', dark ? '#222222' : '#f7f7f8')
  const border = color('--color-border', dark ? '#333333' : '#e0e0e0')
  const focus = color('--color-focus', '#339cff')
  const fontSize = pixels('--text-base', 14)
  return {
    token: {
      colorPrimary: foreground,
      colorPrimaryHover: secondary,
      colorPrimaryActive: foreground,
      colorPrimaryBg: surface,
      colorPrimaryBgHover: surface,
      colorPrimaryBorder: border,
      colorPrimaryText: foreground,
      colorLink: focus,
      colorLinkHover: focus,
      colorLinkActive: focus,
      colorText: foreground,
      colorTextBase: foreground,
      colorTextSecondary: secondary,
      colorTextTertiary: color('--color-text-muted', '#999999'),
      colorTextDisabled: color('--color-text-muted', '#999999'),
      colorBgBase: background,
      colorBgContainer: background,
      colorBgElevated: color('--color-popover', background),
      colorBgLayout: background,
      colorBorder: border,
      colorBorderSecondary: border,
      colorFillSecondary: surface,
      colorFillTertiary: surface,
      colorSuccess: color('--color-success', '#00a240'),
      colorWarning: color('--color-warning', '#d97706'),
      colorError: color('--color-destructive', '#dc2626'),
      colorInfo: focus,
      controlOutline: focus,
      fontFamily: token('--font-ui', 'system-ui, sans-serif'),
      fontFamilyCode: token('--font-code', 'monospace'),
      fontSize,
      fontSizeSM: pixels('--text-xs', 12),
      fontSizeLG: pixels('--text-lg', 16),
      fontWeightStrong: 500,
      borderRadius: pixels('--radius-lg', 8),
      borderRadiusLG: pixels('--radius-dialog', 20),
      controlHeight: pixels('--control-height-md', 36),
      controlHeightSM: pixels('--control-height-sm', 28),
    },
    components: {
      Button: {
        primaryColor: background,
        defaultColor: foreground,
        defaultBg: background,
        defaultBorderColor: border,
        defaultHoverColor: foreground,
        defaultHoverBorderColor: border,
        defaultHoverBg: surface,
        defaultActiveBg: surface,
        fontWeight: 500,
        primaryShadow: 'var(--shadow-control-inverse)',
        defaultShadow: 'var(--shadow-control)',
      },
      Input: { activeBorderColor: focus, hoverBorderColor: border },
      Select: {
        activeBorderColor: focus,
        optionSelectedBg: surface,
        optionSelectedColor: foreground,
      },
      Tabs: {
        inkBarColor: foreground,
        itemColor: secondary,
        itemSelectedColor: foreground,
        itemHoverColor: foreground,
        itemActiveColor: foreground,
        titleFontSize: fontSize,
        horizontalItemGutter: 24,
      },
      Drawer: { colorBgElevated: color('--color-popover', background) },
    },
  }
}
