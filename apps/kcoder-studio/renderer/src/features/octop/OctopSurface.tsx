// Adapted from Octop PageShell and ThemedApp; MIT, third_party/octop/LICENSE.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ConfigProvider, theme, type ThemeConfig } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import enUS from 'antd/locale/en_US'
import { useTranslation } from '@/hooks/useTranslation'
import { workbenchTheme } from './workbenchTheme'
import './surface.css'
import './workbench-surface.css'

/** Octop presentation is isolated from the rest of the KCoder workbench. */
export function OctopSurface({
  children,
  variant = 'reference',
}: {
  children: ReactNode
  variant?: 'reference' | 'workbench'
}) {
  const { i18n } = useTranslation('experts')
  const root = useRef<HTMLDivElement>(null)
  const [dark, setDark] = useState(false)
  const [nativeTheme, setNativeTheme] = useState<ThemeConfig>()
  useEffect(() => {
    const update = () => {
      const element = document.documentElement
      const nextDark = element.classList.contains('dark') || element.dataset.theme === 'dark'
      setDark(nextDark)
      if (variant === 'workbench')
        setNativeTheme(workbenchTheme(getComputedStyle(element), nextDark))
    }
    update()
    const observer = new MutationObserver(update)
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter:
        variant === 'workbench' ? ['class', 'data-theme', 'style'] : ['class', 'data-theme'],
    })
    return () => observer.disconnect()
  }, [variant])
  return (
    <div
      className={`octop-surface${variant === 'workbench' ? ' kcoder-experts' : ''}`}
      data-presentation={variant}
      lang={i18n.language.startsWith('zh') ? 'zh-CN' : 'en'}
      ref={root}
    >
      <ConfigProvider
        prefixCls="octop"
        locale={i18n.language.startsWith('zh') ? zhCN : enUS}
        getPopupContainer={node =>
          node?.closest<HTMLElement>('.octop-surface') ?? root.current ?? document.body
        }
        theme={{
          algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm,
          ...(variant === 'workbench'
            ? nativeTheme
            : {
                token: {
                  borderRadius: 10,
                  colorPrimary: dark ? '#F08B9A' : '#E85D75',
                  colorLink: dark ? '#F08B9A' : '#E85D75',

                  ...(dark
                    ? {
                        colorBgBase: '#0f1117',
                        colorTextBase: '#e7e7ed',
                        colorBgContainer: '#0f1117',
                        colorBgElevated: '#1a1c28',
                        colorBgLayout: '#0b0d14',
                        colorBorder: 'rgba(255,255,255,0.08)',
                        colorBorderSecondary: 'rgba(255,255,255,0.05)',
                      }
                    : {}),
                },
              }),
        }}
      >
        {children}
      </ConfigProvider>
    </div>
  )
}

export function OctopPageShell({
  title,
  subtitle,
  actions,
  children,
  testId,
  scopeLabel,
}: {
  title: string
  subtitle: string
  actions?: ReactNode
  children: ReactNode
  testId: string
  scopeLabel?: string
}) {
  return (
    <div className={`octop-shell ${scopeLabel ? 'octop-shell-scoped' : ''}`} data-testid={testId}>
      <header className="octop-title-row">
        <div>
          <h1 className="octop-title">{title}</h1>
          <p className="octop-subtitle">{subtitle}</p>
        </div>
        {!scopeLabel && <div className="octop-owner-select">{actions}</div>}
      </header>
      {scopeLabel && (
        <div className="octop-scope-bar">
          <span>{scopeLabel}</span>
          <div className="octop-owner-select">{actions}</div>
        </div>
      )}
      <div className="octop-content">{children}</div>
    </div>
  )
}
