import { notifyToolsCatalogChanged } from './toolsCatalogEvents'
import { WorkspacePageHeader } from '@/components/layout/WorkspacePageHeader'
import { PluginInstallTarget } from '@/components/plugins/PluginInstallTarget'
import { PluginTrustManager } from '@/components/plugins/PluginTrustManager'
import { usePluginTargetScope } from './usePluginTargetScope'
import { SkillImportForm } from './SkillImportForm'
import { requestLocalExecutor } from '@/host/localExecutor'
import { KCoderMcpManagement } from './KCoderMcpManagement'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { createLocalCodexPluginApi } from '@/api/local/codexPlugins'
import type { LocalCodexPluginsState } from '@/api/local/codexPlugins'
import type { InstalledPlugin, LocalDeviceSkill } from '@/types/api'
import { Button } from '@/components/ui/button'
import { IconSelect } from '@/components/settings/settings-ui'
import { useRuntimeSettingsTargets } from '@/features/runtime-target/useRuntimeSettingsTargets'
import type { RuntimeSettingsTargetsState } from '@/features/runtime-target/useRuntimeSettingsTargets'
import type { GatewayServer } from './gatewayRpc'
import { runtimeNameForCurrentHost } from './legacyRuntimeAbi'
import { useTranslation } from '@/hooks/useTranslation'
import { navigateTo } from '@/lib/navigation'
import { workspacePathKey } from '@/lib/workspace-path-identity'
import {
  Box,
  Webhook,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
  Loader2,
  RotateCcw,
  Server,
} from 'lucide-react'
import { Switch } from '@/components/ui/switch'
import { PageContent } from '@/components/ui/page-content'
import { KCoderInstalledPluginCard } from '@/components/plugins/KCoderInstalledPluginCard'
import { installedPluginTags } from '@/components/plugins/installed-plugin-metadata'
import { useExtensionsInventory } from './useExtensionsInventory'
import {
  ExtensionsAllView,
  ExtensionsConflictsView,
  ExtensionsUpgradeHint,
  SkillOverrideBadges,
} from './KCoderExtensionsView'
import { HookIssueList } from './extensionsPresentation'
import { ReserveText, StableStatus } from '@/components/ui/stable-content'

type Tab = 'plugins' | 'skills' | 'mcp' | 'hooks' | 'all' | 'conflicts'
const baseTabs: Tab[] = ['plugins', 'skills', 'mcp', 'hooks']
const extensionTabs: Tab[] = ['all', 'conflicts']
/** `/plugins/manage?view=<tab>` opens a management tab directly, e.g. from `/mcp`. */
function initialTab(): Tab {
  const view = new URLSearchParams(window.location.search).get('view')
  return [...baseTabs, ...extensionTabs].find(tab => tab === view) ?? 'plugins'
}
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
  if (runtimeNameForCurrentHost() === 'kcoder') {
    return <GatewayPluginManagementWorkspace {...props} />
  }
  return <NativePluginManagementWorkspace {...props} />
}

function NativePluginManagementWorkspace(props: ManagementProps) {
  const [tab, setTab] = useState<Tab>(initialTab)
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

function GatewayPluginManagementWorkspace(props: ManagementProps) {
  const [tab, setTab] = useState<Tab>(initialTab)
  const targets = useRuntimeSettingsTargets()
  const target = targets.selectedTarget
  // A workspace from the active task belongs to that target only. When the
  // settings target differs, use its configured workspace instead.
  const targetWorkspacePath = target
    ? target.id === props.targetDeviceId
      ? (props.targetWorkspacePath ?? target.workspacePath)
      : target.workspacePath
    : undefined
  const scope = usePluginTargetScope(target?.id, targetWorkspacePath, target)

  if (!target) {
    return (
      <GatewayPluginTargetSelectionPage
        targets={targets}
        sidebarCollapsed={props.sidebarCollapsed}
        topBarLeftActions={props.topBarLeftActions}
      />
    )
  }
  return (
    <PluginManagerContents
      key={scope.key}
      isScopeCurrent={scope.isCurrent}
      targetDeviceId={target.id}
      targetWorkspacePath={targetWorkspacePath}
      sidebarCollapsed={props.sidebarCollapsed}
      topBarLeftActions={props.topBarLeftActions}
      targetSelection={targets}
      tab={tab}
      setTab={setTab}
    />
  )
}

function pluginTargetLabel(target: GatewayServer): string {
  return target.label ? `${target.label} (${target.id})` : target.id
}

function PluginTargetPicker({ targets }: { targets: RuntimeSettingsTargetsState }) {
  const { t } = useTranslation('common')
  return (
    <section className="studio-card-spacing rounded-xl border border-border bg-background">
      <label
        htmlFor="kcoder-plugin-target-select"
        className="block text-sm font-semibold text-text-primary"
      >
        {t('workbench.execution_defaults_target')}
      </label>
      <p className="mt-1 text-xs leading-5 text-text-secondary">
        {t('workbench.execution_defaults_target_scope')}
      </p>
      <IconSelect
        id="kcoder-plugin-target-select"
        data-testid="kcoder-plugin-target-select"
        aria-label={t('workbench.execution_defaults_target')}
        icon={<Server className="h-4 w-4" />}
        value={targets.selectedServerId}
        disabled={targets.loading || targets.targets.length <= 1}
        onChange={event => targets.selectTarget(event.target.value)}
      >
        {targets.targets.length !== 1 && (
          <option value="">{t('workbench.execution_defaults_select_target')}</option>
        )}
        {targets.targets.map(target => (
          <option key={target.id} value={target.id}>
            {pluginTargetLabel(target)}
          </option>
        ))}
      </IconSelect>
      {targets.currentRuntimeTarget && (
        <p data-testid="kcoder-plugin-current-target" className="mt-2 text-xs text-text-secondary">
          {t('workbench.execution_defaults_current_target')}:{' '}
          {pluginTargetLabel(targets.currentRuntimeTarget)}
        </p>
      )}
      {/* Reserved so finishing the target read does not move the page below. */}
      <StableStatus
        className="mt-2 text-xs text-text-secondary"
        itemClassName="flex items-center gap-2"
        reserve={[
          <>
            <span className="h-3.5 w-3.5 shrink-0" />
            <ReserveText text={t('workbench.execution_defaults_targets_loading')} />
          </>,
        ]}
      >
        {targets.loading && (
          <>
            <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
            {t('workbench.execution_defaults_targets_loading')}
          </>
        )}
      </StableStatus>
    </section>
  )
}

function GatewayPluginTargetSelectionPage({
  targets,
  topBarLeftActions,
}: {
  targets: RuntimeSettingsTargetsState
  sidebarCollapsed?: boolean
  topBarLeftActions?: ReactNode
}) {
  const { t } = useTranslation('common')
  return (
    <main
      data-testid="kcoder-plugin-target-selection"
      className="min-w-0 flex-1 overflow-y-auto bg-background text-text-primary [scrollbar-gutter:stable]"
    >
      <WorkspacePageHeader
        title={t('workbench.plugins_tab')}
        beforeBack={topBarLeftActions}
        actions={
          targets.error ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={targets.loading}
              onClick={() => void targets.refresh()}
            >
              <RotateCcw className="h-4 w-4" aria-hidden="true" />
              {t('workbench.execution_defaults_retry')}
            </Button>
          ) : undefined
        }
      />
      <section className="mx-auto flex w-full max-w-[940px] flex-col gap-5 px-5 py-8">
        <h1 className="text-xl font-normal">{t('workbench.plugins_manage', '管理')}</h1>
        <PluginTargetPicker targets={targets} />
        {!targets.loading && targets.error && (
          <p role="alert" className="text-sm text-text-secondary">
            {t('workbench.execution_defaults_targets_load_failed')}
          </p>
        )}
        {!targets.loading && !targets.error && targets.targets.length === 0 && (
          <div className="flex flex-wrap items-center gap-3 text-sm text-text-secondary">
            <span>{t('workbench.execution_defaults_no_targets')}</span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => navigateTo('/settings/kcoder-servers')}
            >
              {t('workbench.execution_defaults_manage_targets')}
            </Button>
          </div>
        )}
        {!targets.loading && !targets.error && targets.targets.length > 1 && (
          <p className="text-sm text-text-secondary">
            {t('workbench.execution_defaults_choose_target')}
          </p>
        )}
      </section>
    </main>
  )
}

function PluginManagerContents({
  isScopeCurrent,
  targetDeviceId,
  targetWorkspacePath,
  topBarLeftActions,
  targetSelection,
  tab,
  setTab,
}: ManagementProps & {
  tab: Tab
  setTab: (tab: Tab) => void
  isScopeCurrent: () => boolean
  targetSelection?: RuntimeSettingsTargetsState
}) {
  const { t } = useTranslation('common')
  const { t: tx } = useTranslation('extensions')
  const extensions = useExtensionsInventory({
    enabled: runtimeNameForCurrentHost() === 'kcoder',
    deviceId: targetDeviceId,
    workspacePath: targetWorkspacePath,
    isScopeCurrent,
  })
  const extensionsSupported = extensions.status !== 'idle' && extensions.status !== 'unsupported'
  const tabs = extensionsSupported ? [...baseTabs, ...extensionTabs] : baseTabs
  const activeTab: Tab = tabs.includes(tab) ? tab : 'plugins'
  const mcpPanelVisible = activeTab === 'mcp'
  const mcpCountOwner = useRef({ panelVisible: mcpPanelVisible })
  // Opening/closing the panel retires the old badge read without restarting the target.
  useLayoutEffect(() => { mcpCountOwner.current = { panelVisible: mcpPanelVisible } }, [mcpPanelVisible])
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
  const [mcpCount, setMcpCount] = useState<number | null>(null)
  const [pendingSkill, setPendingSkill] = useState<string | null>(null)
  const [showTrustManager, setShowTrustManager] = useState(false)
  const reload = useCallback(() => {
    const ticket = ++generation.current
    const current = () => generation.current === ticket && currentApi.current === api
    const countOwner = mcpCountOwner.current
    if (!countOwner.panelVisible) {
      void requestLocalExecutor<{ servers: unknown[] }>('runtime.plugins.request', {
        deviceId: targetDeviceId,
        workspacePath: targetWorkspacePath,
        method: 'mcp/list',
        params: {},
      })
        .then(result => {
          if (current() && mcpCountOwner.current === countOwner) setMcpCount(result.servers.length)
        })
        .catch(() => {
          if (current() && mcpCountOwner.current === countOwner) setMcpCount(null)
        })
    }
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
  // Mutations and explicit refreshes also reload the unified inventory; it
  // never probes binaries on these paths.
  const refreshExtensions = extensions.refresh
  const reloadAll = useCallback(() => {
    void refreshExtensions()
    return reload()
  }, [refreshExtensions, reload])
  const mutate = async (action: () => Promise<unknown>) => {
    const scope = api
    setBusy(true)
    setError('')
    try {
      await action()
      if (currentApi.current === scope) {
        setConfirmation(null)
        await reloadAll()
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
      if (!(await reloadAll()) && currentApi.current === current)
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
  const inventory = extensions.result
  const counts: Record<Tab, number | null> = {
    plugins: plugins.length,
    skills: skills.length,
    mcp: mcpCount,
    hooks: components.filter(item => item.kind === 'hooks').length,
    all: inventory ? inventory.items.length : null,
    conflicts: inventory ? inventory.conflicts.length + (inventory.hookIssues ?? []).length : null,
  }
  const componentTab = baseTabs.includes(activeTab)
  const hasLoadedInventory =
    plugins.length > 0 || skills.length > 0 || components.length > 0 || (mcpCount ?? 0) > 0 || !!inventory
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
  const hookIssues = (inventory?.hookIssues ?? []).filter(issue =>
    matches(issue.path, issue.event, issue.message, issue.location)
  )
  const buttonClass =
    'inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-border bg-background px-4 text-sm text-text-secondary hover:bg-surface disabled:opacity-50 md:min-h-10'
  const refresh = () => {
    setLoading(true)
    setError('')
    window.dispatchEvent(new Event('kcoder:mcp-refresh'))
    void reloadAll()
  }
  return (
    <div
      data-testid="kcoder-plugin-management"
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background text-text-primary"
    >
      <WorkspacePageHeader title={t('workbench.plugins_tab')} beforeBack={topBarLeftActions} />
      <div className="flex min-h-0 flex-1 flex-col">
        <main
          data-testid="kcoder-plugin-scroll"
          className="min-w-0 flex-1 studio-page-gutter overflow-y-auto"
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
            {targetSelection && <PluginTargetPicker targets={targetSelection} />}
            {api.listTrust && (
              <div className="space-y-3">
                <button
                  type="button"
                  data-testid="plugins-trust-manage-button"
                  className={buttonClass}
                  aria-expanded={showTrustManager}
                  onClick={() => setShowTrustManager(value => !value)}
                >
                  {t('pluginTrust.title')}
                </button>
                {showTrustManager && (
                  <PluginTrustManager
                    key={`${targetDeviceId}:${targetWorkspacePath}`}
                    api={api}
                    target={targetDeviceId ?? 'local'}
                    onClose={() => {
                      setShowTrustManager(false)
                      requestAnimationFrame(() =>
                        document
                          .querySelector<HTMLButtonElement>(
                            '[data-testid="plugins-trust-manage-button"]'
                          )
                          ?.focus()
                      )
                    }}
                  />
                )}
              </div>
            )}
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
                const index = tabs.indexOf(activeTab)
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
                  tabIndex={activeTab === item ? 0 : -1}
                  aria-selected={activeTab === item}
                  data-testid={`kcoder-plugin-tab-${item}`}
                  className={`min-h-11 min-w-28 rounded-lg border px-5 text-base transition-colors md:min-h-10 ${activeTab === item ? 'border-focus/20 bg-accent-surface text-focus' : 'border-transparent bg-surface/60 text-text-primary hover:bg-surface'}`}
                  onClick={() => setTab(item)}
                >
                  {item === 'all' || item === 'conflicts'
                    ? tx(`tabs.${item}`)
                    : t(`workbench.kcoder_plugins_${item}`)}
                  {counts[item] !== null ? (
                    <span className="tabular-nums">{` (${counts[item]})`}</span>
                  ) : (
                    // Reserve the count that arrives with the inventory so the tab row does not widen.
                    <ReserveText text=" (0)" className="invisible whitespace-pre tabular-nums" />
                  )}
                </button>
              ))}
            </div>
            {extensions.status === 'unsupported' && <ExtensionsUpgradeHint />}
            <div
              role="tabpanel"
              id="kcoder-plugin-panel"
              aria-labelledby={`kcoder-plugin-tab-${activeTab}`}
              aria-busy={loading}
              className="flex flex-col gap-3"
            >
              {error && (
                <p role="alert" className="break-words text-sm text-text-secondary">
                  {error}
                </p>
              )}
              {/* A refresh keeps the loaded inventory in place; only an empty read says loading. */}
              {loading && !hasLoadedInventory && (
                <p role="status" className="text-sm text-text-muted">
                  {t('workbench.kcoder_plugins_loading')}
                </p>
              )}
              {!loading &&
                !error &&
                componentTab &&
                activeTab !== 'mcp' &&
                counts[activeTab] === 0 &&
                (activeTab !== 'hooks' || hookIssues.length === 0) && (
                  <p className="text-sm text-text-muted">{t('workbench.kcoder_plugins_empty')}</p>
                )}
              {!loading &&
                search &&
                componentTab &&
                activeTab !== 'mcp' &&
                (activeTab === 'plugins'
                  ? filteredPlugins.length
                  : activeTab === 'skills'
                    ? filteredSkills.length
                    : filteredHooks.length) === 0 && (
                  <p role="status" className="py-8 text-center text-sm text-text-secondary">
                    {t('workbench.plugins_no_marketplace_results')}
                  </p>
                )}
              {componentTab && activeTab !== 'plugins' && (
                <p className="text-sm text-text-secondary">
                  {t('workbench.kcoder_plugins_component_help')}
                </p>
              )}
              {activeTab === 'all' && (
                <ExtensionsAllView
                  state={extensions}
                  query={query}
                  onShowConflicts={() => setTab('conflicts')}
                  evolutionScope={{
                    deviceId: targetDeviceId,
                    workspacePath: targetWorkspacePath,
                    isScopeCurrent,
                  }}
                />
              )}
              {activeTab === 'conflicts' && (
                <ExtensionsConflictsView state={extensions} query={query} />
              )}
              {activeTab === 'plugins' &&
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
              {activeTab === 'skills' && (
                <p
                  className="text-sm text-text-secondary"
                  data-testid="kcoder-skill-activation-timing"
                >
                  {t('workbench.skill_activation_timing')}
                </p>
              )}
              {activeTab === 'skills' && (
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
                      await reloadAll()
                      notifyToolsCatalogChanged(targetDeviceId)
                    } finally {
                      if (currentApi.current === api) setBusy(false)
                    }
                  }}
                />
              )}
              {activeTab === 'skills' &&
                filteredSkills.map(skill => (
                  <article
                    key={skill.name}
                    className="studio-card-spacing flex flex-wrap items-center gap-5 rounded-xl border border-border/60 bg-background"
                    data-testid="kcoder-skill-row"
                    data-skill-name={skill.name}
                  >
                    <span className="flex size-[60px] shrink-0 items-center justify-center rounded-xl bg-surface text-focus">
                      <Sparkles className="size-7" aria-hidden="true" />
                    </span>
                    <div className="min-w-0 flex-1" data-testid="kcoder-skill-content">
                      <h2 className="break-words text-lg font-semibold">{skill.name}</h2>
                      <p className="text-sm text-text-secondary">{skill.description}</p>
                      <p className="break-all text-xs text-text-muted">{skill.path}</p>
                      {skillOwner(skill, plugins) && (
                        <p className="text-xs text-text-muted">
                          {t('workbench.skill_owner', { name: skillOwner(skill, plugins) })}
                        </p>
                      )}
                      <SkillOverrideBadges result={inventory} name={skill.name} />
                    </div>
                    <div
                      className="flex basis-full flex-col items-start gap-2 sm:w-36 sm:basis-auto sm:shrink-0 sm:items-end"
                      data-testid="kcoder-skill-actions"
                    >
                      <label className="inline-flex items-center gap-3 whitespace-nowrap text-base">
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
                      <span
                        role="status"
                        aria-hidden={pendingSkill !== skill.name}
                        className={`w-full text-xs text-text-muted sm:text-right ${pendingSkill === skill.name ? 'visible' : 'invisible'}`}
                        data-testid="kcoder-skill-saving-status"
                      >
                        {t('workbench.skill_activation_saving')}
                      </span>
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
                        className="studio-card-spacing w-full rounded-lg border border-border"
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
              {activeTab === 'mcp' && (
                <KCoderMcpManagement
                  deviceId={targetDeviceId}
                  workspacePath={targetWorkspacePath}
                  query={query}
                  onInventoryCount={setMcpCount}
                  presetTarget={
                    targetSelection?.selectedTarget?.id === targetDeviceId
                      ? targetSelection?.selectedTarget
                      : null
                  }
                />
              )}
              {activeTab === 'hooks' && <HookIssueList issues={hookIssues} />}
              {activeTab === 'hooks' &&
                filteredHooks.map(item => (
                  <article
                    key={`${item.id}:${item.name}`}
                    className="studio-card-spacing flex items-center gap-7 rounded-xl border border-border/60 bg-background"
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
