import { PluginIcon, type PluginIconLoader } from './PluginIcon'
import './plugin-marketplace.css'
import { ExternalLink, MessageCircle, MoreHorizontal } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { DesktopTopBar } from '@/components/layout/DesktopTopBar'
import type { InstalledPlugin } from '@/types/api'
import type { InstalledPluginItem } from './PluginManagementRows'
import { resolvePluginAssetUrl } from './plugin-assets'

interface PluginDetailViewProps {
  iconLoader?: PluginIconLoader
  plugin: InstalledPluginItem
  onBack: () => void
  onToggle: () => void
  onComponentToggle: (componentKey: string, enabled: boolean) => void
  onUninstall: () => void
  primaryActionLabel?: string
  showUninstall?: boolean
  primaryActionDisabled?: boolean
  actionError?: string | null
  onDismissError?: () => void
}

interface DetailComponentItem {
  key: string
  componentKey: string
  type: string
  name: string
  description: string
  toggleable: boolean
}

function formatManifestValue(value: unknown): string {
  if (!value) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    if (typeof record.name === 'string') {
      const email = typeof record.email === 'string' && record.email ? ` <${record.email}>` : ''
      return `${record.name}${email}`
    }
    if (typeof record.url === 'string') return record.url
  }
  return ''
}

function formatBytes(value?: number | null): string {
  if (!value || value <= 0) return ''
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}

function buildComponentItems(plugin: InstalledPlugin): DetailComponentItem[] {
  const components = plugin.spec.components
  return [
    ...components.skills.map(item => ({
      key: `skill-${item.name}`,
      componentKey: `skill:${item.name}`,
      type: 'skill',
      name: item.name,
      description: item.description || item.path,
      toggleable: true,
    })),
    ...components.commands.map(item => ({
      key: `command-${item.name}`,
      componentKey: `command:${item.name}`,
      type: 'command',
      name: item.name,
      description: item.path,
      toggleable: false,
    })),
    ...(components.apps ?? []).map(item => ({
      key: `app-${item.name}`,
      componentKey: `app:${item.name}`,
      type: 'app',
      name: item.name,
      description: item.path,
      toggleable: false,
    })),
    ...components.agents.map(item => ({
      key: `agent-${item.name}`,
      componentKey: `agent:${item.name}`,
      type: 'agent',
      name: item.name,
      description: item.path,
      toggleable: false,
    })),
    ...components.hooks.map(item => ({
      key: `hook-${item.name}`,
      componentKey: `hook:${item.name}`,
      type: 'hook',
      name: item.name,
      description: item.path,
      toggleable: false,
    })),
    ...components.mcps.map(item => ({
      key: `mcp-${item.name}`,
      componentKey: `mcp:${item.name}`,
      type: 'mcp',
      name: item.name,
      description:
        typeof item.server.description === 'string'
          ? item.server.description
          : typeof item.server.command === 'string'
            ? item.server.command
            : item.name,
      toggleable: false,
    })),
    ...components.lsps.map(item => ({
      key: `lsp-${item.name}`,
      componentKey: `lsp:${item.name}`,
      type: 'lsp',
      name: item.name,
      description: item.path,
      toggleable: false,
    })),
    ...components.monitors.map(item => ({
      key: `monitor-${item.name}`,
      componentKey: `monitor:${item.name}`,
      type: 'monitor',
      name: item.name,
      description: item.path,
      toggleable: false,
    })),
    ...components.bins.map(item => ({
      key: `bin-${item.name}`,
      componentKey: `bin:${item.name}`,
      type: 'bin',
      name: item.name,
      description: item.path,
      toggleable: false,
    })),
  ]
}

function installedPluginLogo(plugin: InstalledPluginItem): string {
  return resolvePluginAssetUrl(
    plugin.raw.spec.interface?.logo || plugin.raw.spec.interface?.composerIcon
  )
}

function pluginDisplayDescription(plugin: InstalledPluginItem): string {
  return (
    plugin.raw.spec.interface?.longDescription ||
    plugin.raw.spec.interface?.shortDescription ||
    plugin.description
  )
}

function pluginPromptExamples(plugin: InstalledPluginItem): string[] {
  const prompts = normalizePromptExamples(plugin.raw.spec.interface?.defaultPrompt)
  if (prompts.length > 0) return prompts.slice(0, 3)

  return []
}

function normalizePromptExamples(value: unknown): string[] {
  if (!value) return []
  if (typeof value === 'string') {
    const prompt = value.trim()
    return prompt ? [prompt] : []
  }
  if (Array.isArray(value)) {
    return value
      .map(item => {
        if (typeof item === 'string') return item.trim()
        if (item && typeof item === 'object') {
          const record = item as Record<string, unknown>
          const prompt = record.prompt || record.text || record.title
          return typeof prompt === 'string' ? prompt.trim() : ''
        }
        return ''
      })
      .filter(Boolean)
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    const prompt = record.prompt || record.text || record.title
    return typeof prompt === 'string' && prompt.trim() ? [prompt.trim()] : []
  }
  return []
}

function pluginCapabilitySummary(plugin: InstalledPluginItem): string {
  const capabilities = plugin.raw.spec.interface?.capabilities
  if (capabilities && capabilities.length > 0) {
    return capabilities.join(', ')
  }
  const counts = plugin.componentCounts
  return Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([key]) => key)
    .join(', ')
}

function componentTypeLabel(type: string, t: ReturnType<typeof useTranslation>['t']): string {
  switch (type) {
    case 'skill':
      return t('workbench.plugin_component_type_skill', '技能')
    case 'app':
      return t('workbench.plugin_component_type_app', '应用')
    case 'mcp':
      return t('workbench.plugin_component_type_mcp', 'MCP')
    case 'hook':
      return t('workbench.plugin_component_type_hook', 'Hook')
    case 'command':
      return t('workbench.plugin_component_type_command', '命令')
    case 'agent':
      return t('workbench.plugin_component_type_agent', '智能体')
    default:
      return type
  }
}

function detailRows(
  plugin: InstalledPlugin,
  t: ReturnType<typeof useTranslation>['t']
): Array<{
  label: string
  value: string
  href?: string
}> {
  const manifest = plugin.spec.manifest ?? {}
  const homepage = plugin.spec.interface?.websiteUrl || formatManifestValue(manifest.homepage)
  const repository = formatManifestValue(manifest.repository)
  return [
    {
      label: t('pluginPresentation.developer'),
      value:
        plugin.spec.interface?.developerName ||
        formatManifestValue(manifest.author) ||
        plugin.spec.author ||
        '',
    },
    {
      label: t('pluginPresentation.category'),
      value: plugin.spec.interface?.category || plugin.spec.source.type,
    },
    {
      label: t('pluginPresentation.website'),
      value: homepage,
      href: homepage.startsWith('http') ? homepage : undefined,
    },
    {
      label: t('pluginPresentation.repository'),
      value: repository,
      href: repository.startsWith('http') ? repository : undefined,
    },
    {
      label: t('pluginPresentation.version'),
      value: plugin.spec.version || formatManifestValue(manifest.version),
    },
    {
      label: t('pluginPresentation.size'),
      value: formatBytes(plugin.spec.packageRef?.sizeBytes),
    },
  ].filter(row => row.value)
}

export function PluginDetailView({
  iconLoader,
  plugin,
  onBack,
  onToggle,
  onComponentToggle,
  onUninstall,
  primaryActionLabel,
  showUninstall = true,
  primaryActionDisabled = false,
  actionError,
  onDismissError,
}: PluginDetailViewProps) {
  const { t } = useTranslation('common')
  const [isActionMenuOpen, setIsActionMenuOpen] = useState(false)
  const raw = plugin.raw
  const componentItems = buildComponentItems(raw)
  const componentStates = raw.spec.componentStates || {}
  const rows = [
    { label: t('pluginPresentation.capabilities'), value: pluginCapabilitySummary(plugin) },
    ...detailRows(raw, t),
  ].filter(row => row.value)
  const logo = installedPluginLogo(plugin)
  const prompts = pluginPromptExamples(plugin)
  const description = pluginDisplayDescription(plugin)

  const compatibility = plugin.raw.spec.manifest?.compatibility as
    { deferredCapabilities?: unknown } | undefined
  const deferred = Array.isArray(compatibility?.deferredCapabilities)
    ? compatibility.deferredCapabilities.filter(
        (value): value is string => typeof value === 'string'
      )
    : []
  return (
    <main
      data-testid="plugin-detail-page"
      className="plugin-marketplace-page min-w-0 flex-1 overflow-y-auto bg-background text-text-primary"
    >
      <DesktopTopBar
        testId="plugin-detail-topbar"
        className="sticky top-0 z-40 h-12 bg-background/95 pl-5 pr-5 backdrop-blur-xl md:h-[52px] md:pl-7 md:pr-7"
        dragRegionClassName="hidden md:block"
        left={
          <nav
            className="flex items-center gap-2 text-sm font-medium leading-[18px] text-text-muted"
            aria-label={t('pluginPresentation.navigation')}
          >
            <button
              type="button"
              data-testid="plugin-detail-back-button"
              className="h-8 rounded-lg px-2 transition-colors hover:bg-surface hover:text-text-primary"
              onClick={onBack}
            >
              {t('workbench.plugins_tab', '插件')}
            </button>
            <span className="text-text-muted">›</span>
            <span className="truncate text-text-primary">{plugin.name}</span>
          </nav>
        }
      />
      <div className="mx-auto flex w-full max-w-[1040px] flex-col gap-7 px-5 pb-14 pt-5 sm:px-8 sm:py-4">
        <header className="flex flex-col gap-5 rounded-2xl border border-border bg-surface/40 p-5 sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0">
            <div className="mb-5 flex h-14 w-14 items-center justify-center overflow-hidden rounded-xl border border-border bg-background text-text-secondary shadow-sm">
              <PluginIcon
                id={plugin.id}
                source={logo}
                darkSource={plugin.raw.spec.interface?.logoDark}
                loader={iconLoader}
              />
            </div>
            <h1 className="text-xl font-semibold leading-9 tracking-tight text-text-primary">
              {plugin.name}
            </h1>
            <p className="mt-1 max-w-[560px] text-sm leading-5 text-text-secondary">
              {plugin.description}
            </p>
          </div>

          <div className="flex items-center gap-2 pb-1">
            {showUninstall && (
              <div className="relative">
                <button
                  type="button"
                  aria-label={t('workbench.plugins_actions', '插件操作')}
                  aria-expanded={isActionMenuOpen}
                  data-testid={`plugin-detail-actions-${plugin.id}`}
                  className="flex h-8 w-8 items-center justify-center rounded-lg text-text-muted transition-colors hover:bg-surface hover:text-text-primary"
                  onClick={() => setIsActionMenuOpen(open => !open)}
                >
                  <MoreHorizontal className="h-4 w-4" />
                </button>
                {isActionMenuOpen && (
                  <div
                    data-testid={`plugin-detail-actions-menu-${plugin.id}`}
                    className="absolute right-0 top-9 z-30 w-28 rounded-xl border border-border bg-background p-1 shadow-xl"
                  >
                    <button
                      type="button"
                      data-testid={`plugin-detail-uninstall-${plugin.id}`}
                      className="flex h-8 w-full items-center rounded-lg px-3 text-left text-sm leading-[18px] text-red-600 transition-colors hover:bg-red-50"
                      onClick={() => {
                        setIsActionMenuOpen(false)
                        onUninstall()
                      }}
                    >
                      {t('workbench.plugins_uninstall', '卸载')}
                    </button>
                  </div>
                )}
              </div>
            )}
            <button
              type="button"
              data-testid={`plugin-detail-toggle-${plugin.id}`}
              disabled={primaryActionDisabled}
              className="flex h-8 items-center gap-1.5 rounded-lg bg-text-primary px-3 text-sm font-medium leading-[18px] text-background transition-colors hover:bg-text-primary/90 disabled:cursor-wait disabled:opacity-70"
              onClick={onToggle}
            >
              <MessageCircle className="h-4 w-4" />
              {primaryActionLabel ?? t('workbench.plugins_try_in_chat', '在对话中试用')}
            </button>
          </div>
        </header>

        {deferred.length > 0 && (
          <p
            role="status"
            data-testid="plugin-compatibility-warning"
            className="rounded-xl border border-border bg-surface/50 p-3 text-sm text-text-secondary"
          >
            {t('pluginNetwork.partial', { capabilities: deferred.join(', ') })}
          </p>
        )}
        {actionError && (
          <div
            role="alert"
            data-testid="plugin-detail-action-error"
            className="mb-4 flex items-start gap-3 rounded-lg border border-red-200 p-3 text-sm text-red-600"
          >
            <p className="min-w-0 flex-1 break-words">{actionError}</p>
            {onDismissError && (
              <button
                type="button"
                data-testid="plugin-detail-dismiss-error"
                onClick={onDismissError}
                className="shrink-0 rounded px-2 py-1 focus-visible:ring-2"
              >
                {t('workbench.dismiss_error', '关闭提示')}
              </button>
            )}
          </div>
        )}

        {prompts.length > 0 && (
          <section className="space-y-3" aria-label={t('pluginPresentation.examples')}>
            <h2 className="text-sm font-semibold text-text-primary">
              {t('pluginPresentation.examples')}
            </h2>
            <div className="grid gap-3 sm:grid-cols-2">
              {prompts.map(prompt => (
                <blockquote
                  key={prompt}
                  className="rounded-xl border border-border bg-surface/40 p-4 text-sm leading-6 text-text-secondary"
                >
                  {prompt}
                </blockquote>
              ))}
            </div>
          </section>
        )}

        <p className="max-w-[720px] text-sm leading-6 text-text-secondary">{description}</p>

        <section className="space-y-5 rounded-2xl border border-border p-5">
          <h2 className="text-base font-medium leading-6 text-text-muted">
            {t('workbench.plugin_detail_contents', '包含内容')} {componentItems.length}
          </h2>
          <div className="space-y-4">
            {componentItems.map(item => (
              <div
                key={item.key}
                className="grid grid-cols-[40px_minmax(0,1fr)_auto] items-center gap-3"
              >
                <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-surface text-text-secondary">
                  <PluginIcon
                    id={plugin.id}
                    source={logo}
                    darkSource={plugin.raw.spec.interface?.logoDark}
                    loader={iconLoader}
                  />
                </div>
                <div className="min-w-0">
                  <div className="flex min-w-0 items-center gap-2">
                    <h3 className="truncate text-base font-medium leading-5">{item.name}</h3>
                    <span className="shrink-0 rounded-md bg-surface px-1.5 py-0.5 text-xs font-medium leading-4 text-text-muted">
                      {componentTypeLabel(item.type, t)}
                    </span>
                  </div>
                  <p className="truncate text-sm leading-[18px] text-text-muted">
                    {item.description}
                  </p>
                </div>
                {item.toggleable ? (
                  <button
                    type="button"
                    role="switch"
                    aria-checked={componentStates[item.componentKey] ?? true}
                    aria-label={item.name}
                    data-testid={`plugin-component-toggle-${item.componentKey}`}
                    className={[
                      'relative h-7 w-12 rounded-full transition-colors',
                      (componentStates[item.componentKey] ?? true)
                        ? 'bg-text-primary'
                        : 'bg-border',
                    ].join(' ')}
                    onClick={() =>
                      onComponentToggle(
                        item.componentKey,
                        !(componentStates[item.componentKey] ?? true)
                      )
                    }
                  >
                    <span
                      className={[
                        'absolute left-1 top-1 h-5 w-5 rounded-full bg-background shadow-sm transition-transform',
                        (componentStates[item.componentKey] ?? true)
                          ? 'translate-x-5'
                          : 'translate-x-0',
                      ].join(' ')}
                    />
                  </button>
                ) : (
                  <span className="text-sm leading-5 text-text-muted">
                    {t('workbench.plugins_component_included', '已包含')}
                  </span>
                )}
              </div>
            ))}
          </div>
        </section>

        <section className="space-y-5 rounded-2xl border border-border p-5">
          <h2 className="text-base font-medium leading-6 text-text-primary">
            {t('workbench.plugin_detail_info', '信息')}
          </h2>
          <dl className="space-y-5">
            {rows.map(row => (
              <div
                key={row.label}
                className="grid gap-2 text-sm leading-5 sm:grid-cols-[160px_minmax(0,1fr)]"
              >
                <dt className="font-medium text-text-muted">{row.label}</dt>
                <dd className="min-w-0 break-words text-text-primary">
                  {row.href ? (
                    <a
                      href={row.href}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-blue-600 hover:underline"
                    >
                      {row.value}
                      <ExternalLink className="h-3.5 w-3.5" />
                    </a>
                  ) : (
                    row.value
                  )}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      </div>
    </main>
  )
}
