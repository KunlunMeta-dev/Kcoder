import { PluginInstallTarget } from '@/components/plugins/PluginInstallTarget'
import { usePluginTargetScope } from './usePluginTargetScope'
import { SkillImportForm } from './SkillImportForm'
import { requestLocalExecutor } from '@/tauri/localExecutor'
import { KCoderMcpManagement } from './KCoderMcpManagement'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { createLocalCodexPluginApi } from '@/api/local/codexPlugins'
import type { LocalCodexPluginsState } from '@/api/local/codexPlugins'
import type { InstalledPlugin, LocalDeviceSkill } from '@/types/api'
import { DesktopTopBar } from '@/components/layout/DesktopTopBar'
import { useTranslation } from '@/hooks/useTranslation'
import { navigateTo } from '@/lib/navigation'
import { workspacePathKey } from '@/lib/workspace-path-identity'
import { Boxes, Box, Webhook, RefreshCw, Search, Sparkles, Trash2 } from 'lucide-react'
import { Switch } from '@/components/ui/switch'
import { PageContent } from '@/components/ui/page-content'
import { PluginNavigationRail } from '@/components/plugins/PluginNavigationRail'
import { KCoderInstalledPluginCard } from '@/components/plugins/KCoderInstalledPluginCard'
import { installedPluginTags } from '@/components/plugins/installed-plugin-metadata'

type Tab = 'plugins' | 'skills' | 'mcp' | 'hooks'
const tabs: Tab[] = ['plugins', 'skills', 'mcp', 'hooks']
function pluginId(plugin: InstalledPlugin): string {
  const labels = plugin.metadata.labels
  return String(
    (labels && typeof labels === 'object' ? (labels as Record<string, unknown>).id : undefined) ??
      plugin.metadata.name
  )
}
function skillOwner(skill: LocalDeviceSkill, plugins: InstalledPlugin[]): string | undefined {
  const source = workspacePathKey(skill.path)
  return plugins.find(plugin =>
    (plugin.spec.components.skills ?? []).some(component => {
      const root = workspacePathKey(component.path)
      return root && (source === root || source.startsWith(`${root}/`))
    })
  )?.spec.displayName
}

interface ManagementProps {
  targetDeviceId?: string
  targetWorkspacePath?: string
  sidebarCollapsed?: boolean
  topBarLeftActions?: ReactNode
}

export function KCoderPluginManagementWorkspace(props: ManagementProps) {
  const [tab, setTab] = useState<Tab>('plugins')
  const scope = usePluginTargetScope(props.targetDeviceId, props.targetWorkspacePath)
  return (
    <PluginManagerContents
      key={scope.key}
      isScopeCurrent={scope.isCurrent}
      {...props}
      tab={tab}
      setTab={setTab}
    />
  )
}

function PluginManagerContents({
  isScopeCurrent,
  targetDeviceId,
  targetWorkspacePath,
  sidebarCollapsed = false,
  topBarLeftActions,
  tab,
  setTab,
}: ManagementProps & { tab: Tab; setTab: (tab: Tab) => void; isScopeCurrent: () => boolean }) {
  const { t } = useTranslation('common')
  const api = useMemo(
    () =>
      createLocalCodexPluginApi({
        deviceId: targetDeviceId,
        workspacePath: targetWorkspacePath,
        isScopeCurrent,
      }),
    [targetDeviceId, targetWorkspacePath, isScopeCurrent]
  )
  const currentApi = useRef<typeof api | null>(null)
  const generation = useRef(0)
  const [state, setState] = useState<LocalCodexPluginsState | null>(null)
  const [skills, setSkills] = useState<LocalDeviceSkill[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [confirmation, setConfirmation] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [navigation, setNavigation] = useState<'manage' | 'installed'>(() =>
    new URLSearchParams(window.location.search).get('view') === 'installed' ? 'installed' : 'manage'
  )
  const [mcpCount, setMcpCount] = useState<number | null>(null)
  const [pendingSkill, setPendingSkill] = useState<string | null>(null)
  const reload = useCallback(() => {
    const ticket = ++generation.current
    const current = () => generation.current === ticket && currentApi.current === api
    void requestLocalExecutor<{ servers: unknown[] }>('runtime.plugins.request', {
      deviceId: targetDeviceId,
      workspacePath: targetWorkspacePath,
      method: 'mcp/list',
      params: {},
    })
      .then(result => {
        if (current()) setMcpCount(result.servers.length)
      })
      .catch(() => {
        if (current()) setMcpCount(null)
      })
    return Promise.all([api.readState(), api.listSkills({ includeDisabled: true })])
      .then(([next, nextSkills]) => {
        if (current()) {
          setState(next)
          setSkills(nextSkills)
        }
        return true
      })
      .catch(value => {
        if (current()) setError(value instanceof Error ? value.message : String(value))
        return false
      })
      .finally(() => {
        if (current()) setLoading(false)
      })
  }, [api, targetDeviceId, targetWorkspacePath])
  useEffect(() => {
    currentApi.current = api
    void reload()
    return () => {
      currentApi.current = null
    }
  }, [api, reload])
  const mutate = async (action: () => Promise<unknown>) => {
    const scope = api
    setBusy(true)
    setError('')
    try {
      await action()
      if (currentApi.current === scope) {
        setConfirmation(null)
        await reload()
      }
    } catch (value) {
      if (currentApi.current === scope)
        setError(value instanceof Error ? value.message : String(value))
    } finally {
      if (currentApi.current === scope) setBusy(false)
    }
  }
  const plugins = state?.installedPlugins ?? []
  const toggleSkill = async (skill: LocalDeviceSkill) => {
    const current = api
    const enabled = skill.enabled === false
    setPendingSkill(skill.name)
    setBusy(true)
    setError('')
    try {
      // The API validates the authoritative receipt. A later inventory failure
      // must not undo this confirmed state or suggest that saving failed.
      await current.setSkillEnabled!(skill.name, enabled)
      if (currentApi.current !== current) return
      setSkills(previous =>
        previous.map(item => (item.name === skill.name ? { ...item, enabled } : item))
      )
      if (!(await reload()) && currentApi.current === current)
        setError(t('workbench.skill_activation_saved_refresh_failed'))
    } catch (value) {
      if (currentApi.current === current)
        setError(value instanceof Error ? value.message : String(value))
    } finally {
      if (currentApi.current === current) {
        setBusy(false)
        setPendingSkill(null)
      }
    }
  }
  const components = plugins.flatMap(plugin => {
    const id = pluginId(plugin)
    return [
      ...plugin.spec.components.mcps.map(item => ({
        kind: 'mcp' as const,
        name: item.name,
        owner: plugin.spec.displayName,
        id,
      })),
      ...plugin.spec.components.hooks.map(item => ({
        kind: 'hooks' as const,
        name: item.name,
        owner: plugin.spec.displayName,
        id,
      })),
    ]
  })
  const counts = {
    plugins: plugins.length,
    skills: skills.length,
    mcp: mcpCount,
    hooks: components.filter(item => item.kind === 'hooks').length,
  }
  const search = query.trim().toLocaleLowerCase()
  const matches = (...values: (string | undefined | null)[]) =>
    !search || values.join(' ').toLocaleLowerCase().includes(search)
  const catalogFor = (plugin: InstalledPlugin) =>
    state?.marketplaceItems.find(
      item => String(item.remotePluginId ?? item.id) === pluginId(plugin)
    )
  const filteredPlugins = plugins.filter(plugin =>
    matches(
      plugin.spec.displayName,
      plugin.spec.description,
      pluginId(plugin),
      plugin.spec.author,
      ...installedPluginTags(plugin, catalogFor(plugin))
    )
  )
  const filteredSkills = skills.filter(skill =>
    matches(skill.name, skill.description, skillOwner(skill, plugins))
  )
  const filteredHooks = components.filter(
    item => item.kind === 'hooks' && matches(item.name, item.owner)
  )
  const buttonClass =
    'inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-border bg-background px-4 text-sm text-text-secondary hover:bg-surface disabled:opacity-50 md:min-h-10'
  const refresh = () => {
    setLoading(true)
    setError('')
    window.dispatchEvent(new Event('kcoder:mcp-refresh'))
    void reload()
  }
  return (
    <div
      data-testid="kcoder-plugin-management"
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background text-text-primary"
    >
      <DesktopTopBar
        className={`h-10 shrink-0 border-b border-border bg-background px-6 ${sidebarCollapsed ? '' : 'max-md:pl-20'}`}
        left={
          <>
            {topBarLeftActions}
            <button
              className="inline-flex min-h-10 items-center gap-4 text-base"
              title={t('workbench.plugins_back_to_workbench')}
              onClick={() => navigateTo('/')}
            >
              <Boxes className="size-5 text-focus" aria-hidden="true" />
              {t('workbench.plugins_tab')}
            </button>
          </>
        }
      />
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <PluginNavigationRail
          active={navigation}
          onManage={() => {
            setNavigation('manage')
            setQuery('')
            navigateTo('/plugins/manage')
          }}
          onInstalled={() => {
            setNavigation('installed')
            setTab('plugins')
            setQuery('')
          }}
        />
        <main
          data-testid="kcoder-plugin-scroll"
          className="min-w-0 flex-1 overflow-y-auto px-8 max-md:px-4"
        >
          <PageContent
            as="section"
            data-testid="kcoder-plugin-content"
            className="flex flex-col gap-5 py-7"
          >
            <header className="flex items-start justify-between gap-4">
              <div>
                <h1 className="heading-base">{t('workbench.plugins_manage')}</h1>
                <p className="mt-1 text-sm text-text-secondary">
                  {t('workbench.plugins_management_description')}
                </p>
              </div>
              <button
                data-testid="kcoder-plugins-refresh"
                className="inline-flex min-h-11 shrink-0 items-center gap-3 px-1 text-base disabled:opacity-50"
                disabled={loading || busy}
                onClick={refresh}
              >
                <RefreshCw
                  className={`size-5 ${loading ? 'animate-spin' : ''}`}
                  aria-hidden="true"
                />
                {t('workbench.kcoder_plugins_refresh')}
              </button>
            </header>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <PluginInstallTarget
                deviceId={targetDeviceId ?? 'local'}
                path={targetWorkspacePath}
              />
              <label className="relative w-full md:w-[360px]">
                <Search
                  className="pointer-events-none absolute left-3 top-3 size-4 text-text-secondary"
                  aria-hidden="true"
                />
                <input
                  data-testid="kcoder-plugin-search"
                  type="search"
                  value={query}
                  onChange={event => setQuery(event.target.value)}
                  aria-label={t('workbench.plugins_management_search')}
                  placeholder={t('workbench.plugins_management_search')}
                  className="min-h-11 w-full rounded-lg border border-border bg-surface/40 pl-10 pr-3 text-sm md:min-h-10"
                />
              </label>
            </div>
            <div
              role="tablist"
              className="flex flex-wrap gap-2"
              onKeyDown={event => {
                const index = tabs.indexOf(tab)
                const next =
                  event.key === 'ArrowRight'
                    ? tabs[(index + 1) % tabs.length]
                    : event.key === 'ArrowLeft'
                      ? tabs[(index + tabs.length - 1) % tabs.length]
                      : event.key === 'Home'
                        ? tabs[0]
                        : event.key === 'End'
                          ? tabs[tabs.length - 1]
                          : null
                if (next) {
                  event.preventDefault()
                  setTab(next)
                  event.currentTarget
                    .querySelector<HTMLButtonElement>(`[data-testid="kcoder-plugin-tab-${next}"]`)
                    ?.focus()
                }
              }}
            >
              {tabs.map(item => (
                <button
                  key={item}
                  role="tab"
                  id={`kcoder-plugin-tab-${item}`}
                  aria-controls="kcoder-plugin-panel"
                  tabIndex={tab === item ? 0 : -1}
                  aria-selected={tab === item}
                  data-testid={`kcoder-plugin-tab-${item}`}
                  className={`min-h-11 min-w-28 rounded-lg border px-5 text-base transition-colors md:min-h-10 ${tab === item ? 'border-focus/20 bg-accent-surface text-focus' : 'border-transparent bg-surface/60 text-text-primary hover:bg-surface'}`}
                  onClick={() => setTab(item)}
                >
                  {t(`workbench.kcoder_plugins_${item}`)}
                  {counts[item] !== null && ` (${counts[item]})`}
                </button>
              ))}
            </div>
            <div
              role="tabpanel"
              id="kcoder-plugin-panel"
              aria-labelledby={`kcoder-plugin-tab-${tab}`}
              className="flex flex-col gap-3"
            >
              {error && (
                <p role="alert" className="break-words text-sm text-text-secondary">
                  {error}
                </p>
              )}
              {loading && (
                <p role="status" className="text-sm text-text-muted">
                  {t('workbench.kcoder_plugins_loading')}
                </p>
              )}
              {!loading && !error && tab !== 'mcp' && counts[tab] === 0 && (
                <p className="text-sm text-text-muted">{t('workbench.kcoder_plugins_empty')}</p>
              )}
              {!loading &&
                search &&
                tab !== 'mcp' &&
                (tab === 'plugins'
                  ? filteredPlugins.length
                  : tab === 'skills'
                    ? filteredSkills.length
                    : filteredHooks.length) === 0 && (
                  <p role="status" className="py-8 text-center text-sm text-text-secondary">
                    {t('workbench.plugins_no_marketplace_results')}
                  </p>
                )}
              {tab !== 'plugins' && (
                <p className="text-sm text-text-secondary">
                  {t('workbench.kcoder_plugins_component_help')}
                </p>
              )}
              {tab === 'plugins' &&
                filteredPlugins.map(plugin => {
                  const id = pluginId(plugin)
                  return (
                    <KCoderInstalledPluginCard
                      key={id}
                      id={id}
                      plugin={plugin}
                      catalog={catalogFor(plugin)}
                      iconLoader={api.readPluginIcon}
                      disabled={busy || loading}
                      confirming={confirmation === id}
                      onToggle={() =>
                        void mutate(() =>
                          api.updateInstalledPlugin(id, { enabled: !plugin.spec.enabled })
                        )
                      }
                      onUninstall={() => setConfirmation(id)}
                      onConfirm={() => void mutate(() => api.uninstallInstalledPlugin(id))}
                      onCancel={() => setConfirmation(null)}
                    />
                  )
                })}
              {tab === 'skills' && (
                <p
                  className="text-sm text-text-secondary"
                  data-testid="kcoder-skill-activation-timing"
                >
                  {t('workbench.skill_activation_timing')}
                </p>
              )}
              {tab === 'skills' && (
                <SkillImportForm
                  disabled={busy}
                  install={async path => {
                    setBusy(true)
                    try {
                      await requestLocalExecutor('runtime.plugins.request', {
                        deviceId: targetDeviceId,
                        workspacePath: targetWorkspacePath,
                        method: 'skills/import',
                        params: { path },
                      })
                      await reload()
                      window.dispatchEvent(new Event('kcoder:tools-catalog-invalidated'))
                    } finally {
                      if (currentApi.current === api) setBusy(false)
                    }
                  }}
                />
              )}
              {tab === 'skills' &&
                filteredSkills.map(skill => (
                  <article
                    key={skill.name}
                    className="flex flex-wrap items-center gap-5 rounded-xl border border-border/60 bg-background px-4 py-4"
                    data-testid="kcoder-skill-row"
                    data-skill-name={skill.name}
                  >
                    <span className="flex size-[60px] shrink-0 items-center justify-center rounded-xl bg-surface text-focus">
                      <Sparkles className="size-7" aria-hidden="true" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <h2 className="break-words text-lg font-semibold">{skill.name}</h2>
                      <p className="text-sm text-text-secondary">{skill.description}</p>
                      <p className="break-all text-xs text-text-muted">{skill.path}</p>
                      {skillOwner(skill, plugins) && (
                        <p className="text-xs text-text-muted">
                          {t('workbench.skill_owner', { name: skillOwner(skill, plugins) })}
                        </p>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-4">
                      <label className="inline-flex items-center gap-3 text-base">
                        <Switch
                          checked={skill.enabled !== false}
                          aria-label={t('workbench.skill_activation_label', { name: skill.name })}
                          aria-busy={pendingSkill === skill.name}
                          data-testid="kcoder-skill-toggle"
                          disabled={
                            busy ||
                            loading ||
                            skill.can_set_enabled !== true ||
                            !api.setSkillEnabled
                          }
                          onCheckedChange={() => void toggleSkill(skill)}
                        />
                        {t(
                          skill.enabled === false
                            ? 'workbench.skill_disabled'
                            : 'workbench.skill_enabled'
                        )}
                      </label>
                      {pendingSkill === skill.name && (
                        <span role="status" className="text-xs text-text-muted">
                          {t('workbench.skill_activation_saving')}
                        </span>
                      )}
                      {skill.can_set_enabled !== true && (
                        <span className="text-xs text-text-muted">
                          {t('workbench.skill_activation_upgrade')}
                        </span>
                      )}
                    </div>
                    {skill.can_remove && (
                      <button
                        className={buttonClass}
                        disabled={busy}
                        data-testid="kcoder-skill-remove"
                        onClick={() => setConfirmation(`skill:${skill.name}`)}
                      >
                        <Trash2 className="size-4" aria-hidden="true" />
                        {t('workbench.skill_remove')}
                      </button>
                    )}
                    {confirmation === `skill:${skill.name}` && (
                      <div
                        role="alertdialog"
                        className="w-full rounded-lg border border-border p-3"
                        aria-label={t('workbench.skill_remove')}
                      >
                        <p>{t('workbench.skill_remove_prompt', { name: skill.name })}</p>
                        <button
                          className={buttonClass}
                          disabled={busy}
                          onClick={() =>
                            void mutate(() =>
                              requestLocalExecutor('runtime.plugins.request', {
                                deviceId: targetDeviceId,
                                workspacePath: targetWorkspacePath,
                                method: 'skills/remove',
                                params: { name: skill.name },
                              })
                            )
                          }
                        >
                          {t('workbench.mcp_remove_confirm')}
                        </button>
                        <button
                          className={buttonClass}
                          disabled={busy}
                          onClick={() => setConfirmation(null)}
                        >
                          {t('workbench.mcp_remove_cancel')}
                        </button>
                      </div>
                    )}
                  </article>
                ))}
              {tab === 'mcp' && (
                <KCoderMcpManagement
                  deviceId={targetDeviceId}
                  workspacePath={targetWorkspacePath}
                  query={query}
                  onInventoryCount={setMcpCount}
                />
              )}
              {tab === 'hooks' &&
                filteredHooks.map(item => (
                  <article
                    key={`${item.id}:${item.name}`}
                    className="flex items-center gap-7 rounded-xl border border-border/60 bg-background px-4 py-4"
                  >
                    <span className="flex size-[60px] shrink-0 items-center justify-center rounded-xl bg-surface text-focus">
                      <Webhook className="size-7" aria-hidden="true" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <h2 className="break-all text-lg font-semibold">{item.name}</h2>
                      <p className="mt-1 text-sm text-text-secondary">{item.owner}</p>
                    </div>
                    <button
                      className={buttonClass}
                      onClick={() => {
                        setTab('plugins')
                        setQuery(item.owner)
                      }}
                    >
                      <Box className="size-4" aria-hidden="true" />
                      {t('workbench.plugins_manage_owner')}
                    </button>
                  </article>
                ))}
            </div>
          </PageContent>
        </main>
      </div>
    </div>
  )
}
