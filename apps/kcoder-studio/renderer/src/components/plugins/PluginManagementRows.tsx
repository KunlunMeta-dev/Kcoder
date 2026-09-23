import { Globe, Sparkles, Trash2 } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { Switch } from '@/components/ui/switch'
import { PluginIcon, type PluginIconLoader } from './PluginIcon'
import type {
  InstalledMCP,
  InstalledMCPSource,
  InstalledPlugin,
  InstalledPluginSource,
  InstalledSkill,
  InstalledSkillSource,
  MCPInstallState,
  PluginInstallState,
} from '@/types/api'

/** The two backend install-state unions share these six members exactly. */
type InstalledState = PluginInstallState | MCPInstallState

/**
 * X1: the install state has to be readable from the list rather than inferred.
 * The backend contract carries six states (types/api.ts `PluginInstallState`)
 * but the row previously rendered only name, version and components, so
 * "update available" and "install failed" looked identical to a healthy
 * install. Each entry carries a text label, since DESIGN.md 4.2 requires a
 * non-colour cue alongside any status colour.
 */
const INSTALL_STATE_PRESENTATION: Partial<
  Record<InstalledState, { label: string; fallback: string; className: string }>
> = {
  update_available: {
    label: 'workbench.plugins_state_update_available',
    fallback: '有可用更新',
    className: 'bg-warning/10 text-warning',
  },
  unavailable: {
    label: 'workbench.plugins_state_unavailable',
    fallback: '不可用',
    className: 'bg-muted text-text-muted',
  },
  failed: {
    label: 'workbench.plugins_state_failed',
    fallback: '安装失败',
    className: 'bg-destructive/10 text-destructive',
  },
  uninstalled: {
    label: 'workbench.plugins_state_uninstalled',
    fallback: '已卸载',
    className: 'bg-muted text-text-muted',
  },
}

function pluginSourceLabel(source: InstalledPluginSource | null | undefined): {
  label: string
  fallback: string
  values?: Record<string, string>
} | null {
  // Tolerated rather than assumed: a payload missing `source` should drop the
  // origin chip, not take the whole installed list down with it.
  if (!source) return null
  if (source.type === 'marketplace') {
    const name = source.marketplace?.trim() || source.providerKey
    return {
      label: 'workbench.plugins_source_marketplace',
      fallback: '来自 {{name}}',
      values: { name },
    }
  }
  if (source.type === 'upload') {
    return { label: 'workbench.plugins_source_upload', fallback: '本地上传包' }
  }
  return { label: 'workbench.plugins_source_local', fallback: '本地目录' }
}

function mcpSourceLabel(source: InstalledMCPSource | null | undefined): {
  label: string
  fallback: string
  values?: Record<string, string>
} | null {
  if (!source) return null
  if (source.type === 'provider' && source.providerKey?.trim()) {
    return {
      label: 'workbench.plugins_source_mcp_provider',
      fallback: '来自 {{name}}',
      values: { name: source.providerKey.trim() },
    }
  }
  return { label: 'workbench.plugins_source_custom', fallback: '自定义 MCP' }
}

function skillSourceLabel(source: InstalledSkillSource | null | undefined): {
  label: string
  fallback: string
  values?: Record<string, string>
} | null {
  if (!source) return null
  if (source.type === 'personal') {
    return { label: 'workbench.plugins_personal', fallback: '个人' }
  }
  if (source.type === 'git') {
    return { label: 'workbench.plugins_source_git', fallback: 'Git 仓库' }
  }
  if (source.type === 'market' && source.providerKey?.trim()) {
    return {
      label: 'workbench.plugins_source_market',
      fallback: '来自 {{name}}',
      values: { name: source.providerKey.trim() },
    }
  }
  return { label: 'workbench.plugins_system', fallback: '系统' }
}

export interface InstalledSkillItem {
  id: number
  name: string
  description: string
  enabled: boolean
  /** Lossy: collapses `git`/`market` into `system`. Prefer `raw.spec.source`. */
  sourceType: 'system' | 'personal'
  /** Kept so the row can report the true origin and install state. */
  raw: InstalledSkill
}

export interface InstalledMcpItem {
  id: number
  name: string
  description: string
  enabled: boolean
  serverType: string
  /** Kept so the row can report install state and origin, mirroring plugins. */
  raw: InstalledMCP
}

export interface InstalledPluginItem {
  id: string | number
  name: string
  description: string
  enabled: boolean
  version?: string | null
  componentCounts: Record<string, number>
  raw: InstalledPlugin
}

export function InstalledSkillRow({
  skill,
  onToggle,
  onUninstall,
}: {
  skill: InstalledSkillItem
  onToggle: () => void
  onUninstall: () => void
}) {
  const { t } = useTranslation('common')
  const installState = skill.raw?.spec?.installState
  const installStateChip = installState ? INSTALL_STATE_PRESENTATION[installState] : undefined
  const origin = skillSourceLabel(skill.raw?.spec?.source)

  return (
    <article className="grid grid-cols-[64px_minmax(0,1fr)_112px] items-center gap-4">
      <div className="flex h-14 w-14 items-center justify-center rounded-xl border border-border bg-surface text-text-secondary shadow-sm">
        <Sparkles className="h-7 w-7" />
      </div>
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="truncate text-lg font-semibold leading-6">{skill.name}</h2>
          {installStateChip && (
            <span
              data-testid={`installed-skill-state-${skill.id}`}
              data-install-state={installState}
              className={[
                'rounded-md px-2 py-0.5 text-xs font-semibold',
                installStateChip.className,
              ].join(' ')}
            >
              {t(installStateChip.label, installStateChip.fallback)}
            </span>
          )}
        </div>
        <p className="mt-1 truncate text-base leading-6 text-text-secondary">{skill.description}</p>
        {origin && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            <span
              data-testid={`installed-skill-origin-${skill.id}`}
              data-source-type={skill.raw?.spec?.source?.type}
              className="rounded-md bg-surface px-2 py-0.5 text-xs font-semibold text-text-muted"
            >
              {t(origin.label, { ...origin.values, defaultValue: origin.fallback })}
            </span>
          </div>
        )}
      </div>
      <div className="flex items-center justify-end gap-3">
        <button
          type="button"
          aria-label={t('workbench.plugins_uninstall', '卸载')}
          data-testid={`installed-skill-uninstall-${skill.id}`}
          className="flex h-9 w-9 items-center justify-center rounded-lg text-text-muted transition-colors hover:bg-surface hover:text-red-500"
          onClick={onUninstall}
        >
          <Trash2 className="h-4 w-4" />
        </button>
        <Switch
          checked={skill.enabled}
          onCheckedChange={onToggle}
          aria-label={skill.name}
          data-testid={`installed-skill-toggle-${skill.id}`}
        />
      </div>
    </article>
  )
}

export function InstalledMcpRow({
  mcp,
  onToggle,
  onUninstall,
}: {
  mcp: InstalledMcpItem
  onToggle: () => void
  onUninstall: () => void
}) {
  const { t } = useTranslation('common')
  // Reads defensively for the same reason as the plugin row: a payload that
  // cannot describe its state should lose the chips, not the whole list.
  const installState = mcp.raw?.spec?.installState
  const installStateChip = installState ? INSTALL_STATE_PRESENTATION[installState] : undefined
  const origin = mcpSourceLabel(mcp.raw?.spec?.source)

  return (
    <article className="grid grid-cols-[64px_minmax(0,1fr)_112px] items-center gap-4">
      <div className="flex h-14 w-14 items-center justify-center rounded-xl border border-border bg-emerald-50 text-emerald-600 shadow-sm">
        <Globe className="h-7 w-7" />
      </div>
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="truncate text-lg font-semibold leading-6">{mcp.name}</h2>
          <span className="rounded-md bg-surface px-2 py-0.5 text-xs font-semibold text-text-muted">
            {mcp.serverType}
          </span>
          {installStateChip && (
            <span
              data-testid={`installed-mcp-state-${mcp.id}`}
              data-install-state={installState}
              className={[
                'rounded-md px-2 py-0.5 text-xs font-semibold',
                installStateChip.className,
              ].join(' ')}
            >
              {t(installStateChip.label, installStateChip.fallback)}
            </span>
          )}
        </div>
        <p className="mt-1 truncate text-base leading-6 text-text-secondary">{mcp.description}</p>
        {origin && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            <span
              data-testid={`installed-mcp-origin-${mcp.id}`}
              data-source-type={mcp.raw?.spec?.source?.type}
              className="rounded-md bg-surface px-2 py-0.5 text-xs font-semibold text-text-muted"
            >
              {t(origin.label, { ...origin.values, defaultValue: origin.fallback })}
            </span>
          </div>
        )}
      </div>
      <div className="flex items-center justify-end gap-3">
        <button
          type="button"
          aria-label={t('workbench.plugins_uninstall', '卸载')}
          data-testid={`installed-mcp-uninstall-${mcp.id}`}
          className="flex h-9 w-9 items-center justify-center rounded-lg text-text-muted transition-colors hover:bg-surface hover:text-red-500"
          onClick={onUninstall}
        >
          <Trash2 className="h-4 w-4" />
        </button>
        <Switch
          checked={mcp.enabled}
          onCheckedChange={onToggle}
          aria-label={mcp.name}
          data-testid={`installed-mcp-toggle-${mcp.id}`}
        />
      </div>
    </article>
  )
}

export function InstalledPluginRow({
  plugin,
  onOpen,
  onToggle,
  onUninstall,
  iconLoader,
}: {
  plugin: InstalledPluginItem
  onOpen?: () => void
  onToggle: () => void
  onUninstall: () => void
  /** Resolves a plugin's packaged icon; the row falls back to a glyph. */
  iconLoader?: PluginIconLoader
}) {
  const { t } = useTranslation('common')
  const componentLabels = Object.entries(plugin.componentCounts)
    .filter(([, count]) => count > 0)
    .map(([key, count]) => `${key} ${count}`)
  const installState = plugin.raw.spec.installState
  const installStateChip = INSTALL_STATE_PRESENTATION[installState]
  const origin = pluginSourceLabel(plugin.raw.spec.source)

  return (
    <article
      role={onOpen ? 'button' : undefined}
      tabIndex={onOpen ? 0 : undefined}
      data-testid={`installed-plugin-row-${plugin.id}`}
      className="grid cursor-pointer grid-cols-[64px_minmax(0,1fr)_112px] items-center gap-4 rounded-xl transition-colors hover:bg-surface/70"
      onClick={onOpen}
      onKeyDown={event => {
        if (!onOpen) return
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onOpen()
        }
      }}
    >
      <div
        data-testid={`installed-plugin-icon-${plugin.id}`}
        // Same neutral tile as the marketplace row so the two plugin surfaces
        // agree; a plugin's own brand colour overrides it when declared.
        className="flex h-14 w-14 items-center justify-center overflow-hidden rounded-xl border border-border bg-surface text-text-secondary shadow-sm"
        style={{
          backgroundColor: plugin.raw?.spec?.interface?.brandColor || undefined,
          color: plugin.raw?.spec?.interface?.brandColor
            ? 'rgb(var(--color-bg-base))'
            : undefined,
        }}
      >
        <PluginIcon
          id={plugin.id}
          source={plugin.raw?.spec?.interface?.logo}
          darkSource={plugin.raw?.spec?.interface?.logoDark}
          loader={iconLoader}
        />
      </div>
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="truncate text-lg font-semibold leading-6">{plugin.name}</h2>
          {plugin.version && (
            <span className="rounded-md bg-surface px-2 py-0.5 text-xs font-semibold text-text-muted">
              {plugin.version}
            </span>
          )}
          {installStateChip && (
            <span
              data-testid={`installed-plugin-state-${plugin.id}`}
              data-install-state={installState}
              className={[
                'rounded-md px-2 py-0.5 text-xs font-semibold',
                installStateChip.className,
              ].join(' ')}
            >
              {t(installStateChip.label, installStateChip.fallback)}
            </span>
          )}
        </div>
        <p className="mt-1 truncate text-base leading-6 text-text-secondary">
          {plugin.description || componentLabels.join(' · ')}
        </p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {origin && (
            <span
              data-testid={`installed-plugin-origin-${plugin.id}`}
              data-source-type={plugin.raw.spec.source?.type}
              className="rounded-md bg-surface px-2 py-0.5 text-xs font-semibold text-text-muted"
            >
              {t(origin.label, { ...origin.values, defaultValue: origin.fallback })}
            </span>
          )}
          {componentLabels.map(label => (
            <span
              key={label}
              className="rounded-md bg-surface px-2 py-0.5 text-xs font-semibold text-text-muted"
            >
              {label}
            </span>
          ))}
        </div>
      </div>
      <div className="flex items-center justify-end gap-3">
        <button
          type="button"
          aria-label={t('workbench.plugins_uninstall', '卸载')}
          data-testid={`installed-plugin-uninstall-${plugin.id}`}
          className="flex h-9 w-9 items-center justify-center rounded-lg text-text-muted transition-colors hover:bg-surface hover:text-red-500"
          onClick={event => {
            event.stopPropagation()
            onUninstall()
          }}
        >
          <Trash2 className="h-4 w-4" />
        </button>
        <Switch
          checked={plugin.enabled}
          onCheckedChange={onToggle}
          aria-label={plugin.name}
          data-testid={`installed-plugin-toggle-${plugin.id}`}
          onClick={event => event.stopPropagation()}
        />
      </div>
    </article>
  )
}
