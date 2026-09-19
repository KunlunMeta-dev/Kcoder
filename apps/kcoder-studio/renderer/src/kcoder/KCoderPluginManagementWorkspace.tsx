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

type Tab = 'plugins' | 'skills' | 'mcp' | 'hooks'
const tabs: Tab[] = ['plugins', 'skills', 'mcp', 'hooks']
function pluginId(plugin: InstalledPlugin): string {
  const labels = plugin.metadata.labels
  return String(
    (labels && typeof labels === 'object' ? (labels as Record<string, unknown>).id : undefined) ??
      plugin.metadata.name
  )
}

interface ManagementProps {
  targetDeviceId?: string
  targetWorkspacePath?: string
  sidebarCollapsed?: boolean
  topBarLeftActions?: ReactNode
}

export function KCoderPluginManagementWorkspace(props: ManagementProps) {
  const [tab, setTab] = useState<Tab>('plugins')
  return (
    <PluginManagerContents
      key={JSON.stringify([props.targetDeviceId, props.targetWorkspacePath])}
      {...props}
      tab={tab}
      setTab={setTab}
    />
  )
}

function PluginManagerContents({
  targetDeviceId,
  targetWorkspacePath,
  sidebarCollapsed = false,
  topBarLeftActions,
  tab,
  setTab,
}: ManagementProps & { tab: Tab; setTab: (tab: Tab) => void }) {
  const { t } = useTranslation('common')
  const api = useMemo(
    () =>
      createLocalCodexPluginApi({ deviceId: targetDeviceId, workspacePath: targetWorkspacePath }),
    [targetDeviceId, targetWorkspacePath]
  )
  const currentApi = useRef<typeof api | null>(null)
  const generation = useRef(0)
  const [state, setState] = useState<LocalCodexPluginsState | null>(null)
  const [skills, setSkills] = useState<LocalDeviceSkill[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [confirmation, setConfirmation] = useState<string | null>(null)
  const reload = useCallback(() => {
    const ticket = ++generation.current
    const current = () => generation.current === ticket && currentApi.current === api
    return Promise.all([api.readState(), api.listSkills()])
      .then(([next, nextSkills]) => {
        if (current()) {
          setState(next)
          setSkills(nextSkills)
        }
      })
      .catch(value => {
        if (current()) setError(value instanceof Error ? value.message : String(value))
      })
      .finally(() => {
        if (current()) setLoading(false)
      })
  }, [api])
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
    mcp: components.filter(item => item.kind === 'mcp').length,
    hooks: components.filter(item => item.kind === 'hooks').length,
  }
  const buttonClass =
    'min-h-11 md:min-h-8 rounded-lg px-3 text-sm text-text-secondary hover:bg-surface disabled:opacity-50'
  return (
    <main
      data-testid="kcoder-plugin-management"
      className="min-w-0 flex-1 overflow-y-auto bg-background text-text-primary"
    >
      <DesktopTopBar
        className={`sticky top-0 z-30 h-12 bg-background pl-20 pr-4 md:h-[52px] md:pr-7 ${sidebarCollapsed ? 'md:pl-6' : 'md:pl-7'}`}
        left={
          <>
            {topBarLeftActions}
            <button className={buttonClass} onClick={() => navigateTo('/plugins')}>
              {t('workbench.plugins_tab', '插件')}
            </button>
          </>
        }
        right={
          <button
            data-testid="kcoder-plugins-refresh"
            className={buttonClass}
            disabled={loading || busy}
            onClick={() => {
              setLoading(true)
              setError('')
              window.dispatchEvent(new Event('kcoder:mcp-refresh'))
              void reload()
            }}
          >
            {t('workbench.kcoder_plugins_refresh')}
          </button>
        }
      />
      <section className="mx-auto flex w-full max-w-[940px] flex-col gap-5 px-5 py-8">
        <h1 className="text-xl font-normal">{t('workbench.plugins_manage', '管理')}</h1>
        <p data-testid="plugins-install-target" className="break-all text-sm text-text-secondary">
          {t('workbench.plugins_install_target', {
            target: targetDeviceId ?? 'local',
            path: targetWorkspacePath ?? '',
          })}
        </p>
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
              className={`${buttonClass} ${tab === item ? 'bg-surface text-text-primary' : ''}`}
              onClick={() => setTab(item)}
            >
              {t(`workbench.kcoder_plugins_${item}`)}
              {item !== 'mcp' && ` (${counts[item]})`}
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
          {tab !== 'plugins' && (
            <p className="text-sm text-text-secondary">
              {t('workbench.kcoder_plugins_component_help')}
            </p>
          )}
          {tab === 'plugins' &&
            plugins.map(plugin => {
              const id = pluginId(plugin)
              return (
                <article
                  key={id}
                  data-testid={`kcoder-plugin-row-${id}`}
                  className="flex flex-wrap items-center justify-between gap-3 border-b border-border py-3"
                >
                  <div className="min-w-0 flex-1">
                    <p className="break-words text-base">{plugin.spec.displayName}</p>
                    <p className="text-sm text-text-secondary">{plugin.spec.description}</p>
                    <p className="text-xs text-text-muted">
                      {id} · {plugin.spec.version}
                    </p>
                  </div>
                  <div className="flex gap-1">
                    <button
                      data-testid={`kcoder-plugin-toggle-${id}`}
                      className={buttonClass}
                      disabled={busy || loading}
                      onClick={() =>
                        void mutate(() =>
                          api.updateInstalledPlugin(id, { enabled: !plugin.spec.enabled })
                        )
                      }
                    >
                      {t(
                        plugin.spec.enabled
                          ? 'workbench.kcoder_plugins_disable'
                          : 'workbench.kcoder_plugins_enable'
                      )}
                    </button>
                    {confirmation === id ? (
                      <>
                        <button
                          data-testid={`kcoder-plugin-confirm-uninstall-${id}`}
                          className={buttonClass}
                          disabled={busy || loading}
                          onClick={() => void mutate(() => api.uninstallInstalledPlugin(id))}
                        >
                          {t('workbench.kcoder_plugins_confirm_uninstall')}
                        </button>
                        <button
                          className={buttonClass}
                          disabled={busy}
                          onClick={() => setConfirmation(null)}
                        >
                          {t('workbench.kcoder_plugins_cancel')}
                        </button>
                      </>
                    ) : (
                      <button
                        data-testid={`kcoder-plugin-uninstall-${id}`}
                        className={buttonClass}
                        disabled={busy || loading}
                        onClick={() => setConfirmation(id)}
                      >
                        {t('workbench.kcoder_plugins_uninstall')}
                      </button>
                    )}
                  </div>
                </article>
              )
            })}
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
            skills.map(skill => (
              <article key={skill.path} className="border-b border-border py-3">
                <p className="text-base">{skill.name}</p>
                <p className="text-sm text-text-secondary">{skill.description}</p>
                <p className="break-all text-xs text-text-muted">{skill.path}</p>
                {skill.can_remove && (
                  <button
                    className={buttonClass}
                    disabled={busy}
                    data-testid="kcoder-skill-remove"
                    onClick={() => setConfirmation(`skill:${skill.name}`)}
                  >
                    {t('workbench.skill_remove')}
                  </button>
                )}
                {confirmation === `skill:${skill.name}` && (
                  <div role="alertdialog" aria-label={t('workbench.skill_remove')}>
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
            <KCoderMcpManagement deviceId={targetDeviceId} workspacePath={targetWorkspacePath} />
          )}
          {tab === 'hooks' &&
            components
              .filter(item => item.kind === tab)
              .map(item => (
                <article key={`${item.id}:${item.name}`} className="border-b border-border py-3">
                  <p className="break-all text-base">{item.name}</p>
                  <p className="text-sm text-text-secondary">{item.owner}</p>
                </article>
              ))}
        </div>
      </section>
    </main>
  )
}
