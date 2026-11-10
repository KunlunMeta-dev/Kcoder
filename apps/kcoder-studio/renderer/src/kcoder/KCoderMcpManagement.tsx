import { McpInstallForm } from './McpInstallForm'
import { McpClientAuthorizationForm } from './McpClientAuthorizationForm'
import { useCallback, useEffect, useRef, useState } from 'react'
import { requestLocalExecutor } from '@/host/localExecutor'
import { useTranslation } from '@/hooks/useTranslation'
import { openExternalUrl } from '@/lib/external-links'
import { Network } from 'lucide-react'
import { Switch } from '@/components/ui/switch'

interface McpServer {
  name: string
  transport: string
  enabled?: boolean
  pluginId?: string
  /** Reported by the runtime; resolved through AUTHORIZATION_LABEL_KEYS. */
  authorization: string
  lastConnectionAttempt?: string
}
interface Props {
  deviceId?: string
  workspacePath?: string
  query?: string
  onInventoryCount?: (count: number) => void
}
const identity = (server: McpServer) => JSON.stringify([server.pluginId, server.name])

/**
 * Authorization states this build can label.
 *
 * The value arrives as an untyped string from another process, and the previous
 * code interpolated it straight into an i18n key with no fallback: a state this
 * build does not know about rendered the literal `workbench.mcp_status_<state>`
 * to the user, which DESIGN.md 11 and the U-C acceptance rule forbid. Resolving
 * through a table means an unknown state degrades to readable copy instead.
 */
const AUTHORIZATION_LABEL_KEYS = {
  notAuthorized: 'workbench.mcp_status_notAuthorized',
  expired: 'workbench.mcp_status_expired',
  reauthorizationRequired: 'workbench.mcp_status_reauthorizationRequired',
  authorized: 'workbench.mcp_status_authorized',
  notApplicable: 'workbench.mcp_status_notApplicable',
  configuredHeader: 'workbench.mcp_status_configuredHeader',
  unavailable: 'workbench.mcp_status_unavailable',
} as const

/** States where offering a fresh browser authorization is the useful action. */
const AUTHORIZATION_STATES_REQUIRING_LOGIN = [
  'notAuthorized',
  'expired',
  'reauthorizationRequired',
] as const

function authorizationLabelKey(value: string): string {
  return (
    AUTHORIZATION_LABEL_KEYS[value as keyof typeof AUTHORIZATION_LABEL_KEYS] ??
    'workbench.mcp_status_unknown'
  )
}

function authorizationNeedsLogin(value: string): boolean {
  return (AUTHORIZATION_STATES_REQUIRING_LOGIN as readonly string[]).includes(value)
}

export function KCoderMcpManagement(props: Props) {
  return <McpManagementContent key={JSON.stringify([props.deviceId, props.workspacePath])} {...props} />
}

function McpManagementContent({
  deviceId,
  workspacePath,
  query = '',
  onInventoryCount,
}: Props) {
  const { t } = useTranslation('common')
  const [servers, setServers] = useState<McpServer[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [removeConfirmation, setRemoveConfirmation] = useState<string | null>(null)
  const [pending, setPending] = useState<Record<string, string>>({})
  const [authorizationLinks, setAuthorizationLinks] = useState<Record<string, string>>({})
  const flows = useRef<Record<string, string>>({})
  const mounted = useRef(false)
  const scope = useRef(0)
  const request = useCallback(
    <T,>(method: string, params: Record<string, unknown> = {}) =>
      requestLocalExecutor<T>('runtime.plugins.request', {
        deviceId,
        workspacePath,
        method,
        params,
      }),
    [deviceId, workspacePath]
  )
  const reload = useCallback(async () => {
    const generation = scope.current
    const result = await request<{ servers: McpServer[] }>('mcp/list')
    if (mounted.current && generation === scope.current) {
      setServers(result.servers)
      setLoaded(true)
      onInventoryCount?.(result.servers.length)
    }
  }, [request, onInventoryCount])
  useEffect(() => {
    scope.current += 1
    mounted.current = true
    void reload().catch(value => {
      if (mounted.current) setError(String(value))
    })
    const changed = (event: Event) => {
      const detail = (event as CustomEvent).detail
      if (!detail || !Object.values(flows.current).includes(detail.flowId)) return
      flows.current = Object.fromEntries(
        Object.entries(flows.current).filter(([, id]) => id !== detail.flowId)
      )
      setPending({ ...flows.current })
      if (detail.status === 'authorized') setError('')
      else if (detail.status === 'failed')
        setError(
          t(
            detail.message === 'credential_storage_failed'
              ? 'workbench.mcp_authorization_storage_failed'
              : detail.message === 'token_exchange_failed'
                ? 'workbench.mcp_authorization_exchange_failed'
                : 'workbench.mcp_authorization_failed'
          )
        )
      else if (detail.status === 'expired') setError(t('workbench.mcp_authorization_expired'))
      void reload().catch(value => {
        if (mounted.current) setError(String(value))
      })
      window.dispatchEvent(new Event('kcoder:tools-catalog-invalidated'))
    }
    const refresh = () => {
      setError('')
      void reload().catch(value => {
        if (mounted.current) setError(String(value))
      })
    }
    window.addEventListener('kcoder:mcp-refresh', refresh)
    window.addEventListener('kcoder:mcp-authorization-changed', changed)
    return () => {
      scope.current += 1
      mounted.current = false
      window.removeEventListener('kcoder:mcp-authorization-changed', changed)
      window.removeEventListener('kcoder:mcp-refresh', refresh)
      for (const flowId of Object.values(flows.current)) {
        void request('mcp/cancel', { flowId }).catch(() => {})
      }
      flows.current = {}
    }
  }, [reload, request, t])
  const toggle = async (server: McpServer, enabled: boolean) => {
    const generation = scope.current
    setBusy(true)
    setError('')
    try {
      await request('mcp/setEnabled', { name: server.name, pluginId: server.pluginId, enabled })
      if (!mounted.current || generation !== scope.current) return
      await reload()
      window.dispatchEvent(new Event('kcoder:tools-catalog-invalidated'))
    } catch (value) {
      if (mounted.current && generation === scope.current) setError(value instanceof Error ? value.message : String(value))
    } finally {
      if (mounted.current && generation === scope.current) setBusy(false)
    }
  }
  const enableSearch = async () => {
    const generation = scope.current
    setBusy(true)
    setError('')
    try {
      await request('mcp/install', { config: { name: 'searxng', transport: 'searxng' } })
      await request('mcp/setEnabled', { name: 'searxng', enabled: true })
      if (!mounted.current || generation !== scope.current) return
      await reload()
      window.dispatchEvent(new Event('kcoder:tools-catalog-invalidated'))
    } catch (value) {
      if (mounted.current && generation === scope.current) {
        setError(value instanceof Error ? value.message : String(value))
        await reload().catch(() => {})
      }
    } finally {
      if (mounted.current && generation === scope.current) setBusy(false)
    }
  }
  const act = async (
    server: McpServer,
    action: 'login' | 'logout' | 'cancel' | 'remove',
    options: Record<string, unknown> = {}
  ) => {
    setBusy(true)
    setError('')
    try {
      const key = identity(server)
      if (action === 'login') {
        const result = await request<{ flowId: string; authorizationUrl: string }>(
          'gateway/mcp/login',
          {
            ...options,
            server: { name: server.name, pluginId: server.pluginId },
          }
        )
        if (!mounted.current) {
          await request('mcp/cancel', { flowId: result.flowId })
          return
        }
        flows.current[key] = result.flowId
        setAuthorizationLinks(current => ({ ...current, [key]: result.authorizationUrl }))
        setPending({ ...flows.current })
        try {
          if (!(await openExternalUrl(result.authorizationUrl, { target: 'system' }))) {
            throw new Error('Browser did not open')
          }
        } catch {
          if (mounted.current) setError(t('workbench.mcp_open_failed'))
        }
      } else if (action === 'cancel') {
        await request('mcp/cancel', { flowId: flows.current[key] })
        delete flows.current[key]
        if (mounted.current) setPending({ ...flows.current })
      } else if (action === 'remove') {
        await request('mcp/remove', { name: server.name })
        if (mounted.current) setRemoveConfirmation(null)
        window.dispatchEvent(new Event('kcoder:tools-catalog-invalidated'))
      } else {
        await request('mcp/logout', { name: server.name, pluginId: server.pluginId })
        window.dispatchEvent(new Event('kcoder:tools-catalog-invalidated'))
      }
      await reload()
    } catch (value) {
      if (mounted.current) setError(value instanceof Error ? value.message : String(value))
    } finally {
      if (mounted.current) setBusy(false)
    }
  }
  const button =
    'inline-flex min-h-11 items-center justify-center rounded-xl border border-border bg-background px-4 text-sm text-text-secondary hover:bg-surface disabled:opacity-50 md:min-h-10'
  const filteredServers = servers.filter(server =>
    `${server.name} ${server.pluginId ?? ''} ${server.transport}`
      .toLocaleLowerCase()
      .includes(query.trim().toLocaleLowerCase())
  )
  return (
    <section data-testid="kcoder-mcp-management" className="flex flex-col gap-3">
      {loaded && !servers.some(server => server.name === 'searxng' && !server.pluginId) &&
        `searxng ${t('workbench.mcp_searxng_title')}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()) && (
        <article className="studio-card-spacing flex items-center gap-4 rounded-xl border border-border/60 bg-background">
          <Network className="size-6 shrink-0 text-focus" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold">{t('workbench.mcp_searxng_title')}</h2>
            <p className="mt-1 text-xs text-text-muted">{t('workbench.mcp_searxng_description')}</p>
          </div>
          <Switch checked={false} disabled={busy} onCheckedChange={value => { if (value) void enableSearch() }} aria-label={t('workbench.mcp_toggle', { name: 'searxng' })} data-testid="kcoder-searxng-enable" />
        </article>
      )}
      <McpInstallForm
        disabled={busy}
        install={async config => {
          setBusy(true)
          setError('')
          try {
            await request('mcp/install', { config })
            await reload().catch(value => {
              if (mounted.current) setError(value instanceof Error ? value.message : String(value))
            })
            window.dispatchEvent(new Event('kcoder:tools-catalog-invalidated'))
          } finally {
            if (mounted.current) setBusy(false)
          }
        }}
      />
      <p className="text-xs text-text-muted">{t('workbench.mcp_activation_help')}</p>
      {error && (
        <p role="alert" className="break-words text-sm text-text-secondary">
          {error}
        </p>
      )}
      {!servers.length && (
        <p className="text-sm text-text-muted">{t('workbench.kcoder_plugins_empty')}</p>
      )}
      {servers.length > 0 && filteredServers.length === 0 && (
        <p role="status" className="py-8 text-center text-sm text-text-secondary">
          {t('workbench.plugins_no_marketplace_results')}
        </p>
      )}
      {filteredServers.map(server => {
        const key = identity(server)
        const waiting = pending[key]
        const enabled = server.enabled !== false
        const canLogin = enabled && authorizationNeedsLogin(server.authorization)
        return (
          <article
            key={key}
            className="studio-card-spacing flex flex-wrap items-center gap-5 rounded-xl border border-border/60 bg-background"
          >
            <span className="flex size-[60px] shrink-0 items-center justify-center rounded-xl bg-surface text-focus">
              <Network className="size-7" aria-hidden="true" />
            </span>
            <div className="min-w-0 flex-1">
              <h2 className="break-all text-sm font-semibold">{server.name}</h2>
              <p className="break-all text-xs text-text-muted">
                {server.pluginId ?? t('workbench.mcp_standalone')} · {server.transport}
              </p>
              {server.transport === 'searxng' && <p className="mt-1 text-xs text-text-muted">{t('workbench.mcp_searxng_description')}</p>}
              <p role="status" className="text-sm text-text-secondary">
                {t(
                  waiting
                    ? 'workbench.mcp_status_pending'
                    : !enabled ? 'workbench.mcp_disabled'
                    : authorizationLabelKey(server.authorization)
                )}
              </p>
              <p
                data-testid="kcoder-mcp-connection-status"
                className="mt-1 text-xs text-text-muted"
              >
                {t(
                  !enabled ? 'workbench.mcp_disabled_connection' : server.lastConnectionAttempt === 'ready'
                    ? 'workbench.mcp_connection_ready'
                    : server.lastConnectionAttempt === 'unavailable'
                      ? 'workbench.mcp_connection_unavailable'
                      : server.lastConnectionAttempt === 'timedOut'
                        ? 'workbench.mcp_connection_timedOut'
                        : 'workbench.mcp_connection_unchecked'
                )}
              </p>
            </div>
            <Switch
              checked={enabled}
              disabled={busy || Boolean(waiting)}
              onCheckedChange={value => void toggle(server, value)}
              aria-label={t('workbench.mcp_toggle', { name: server.name })}
              data-testid="kcoder-mcp-toggle"
              className="shrink-0"
            />
            {waiting && (
              <a
                className={button}
                href={authorizationLinks[key]}
                target="_blank"
                rel="noopener noreferrer"
                data-testid="kcoder-mcp-open-authorization"
              >
                {t('workbench.mcp_open_authorization')}
              </a>
            )}
            {waiting ? (
              <button
                data-testid="kcoder-mcp-auth-action"
                className={button}
                disabled={busy}
                onClick={() => void act(server, 'cancel')}
              >
                {t('workbench.mcp_cancel')}
              </button>
            ) : canLogin ? (
              <button
                data-testid="kcoder-mcp-auth-action"
                className={button}
                disabled={busy}
                onClick={() => void act(server, 'login')}
              >
                {t('workbench.mcp_authorize')}
              </button>
            ) : server.authorization === 'authorized' ? (
              <button
                data-testid="kcoder-mcp-auth-action"
                className={button}
                disabled={busy}
                onClick={() => void act(server, 'logout')}
              >
                {t('workbench.mcp_logout')}
              </button>
            ) : null}
            {!server.pluginId && (
              <button
                className={button}
                disabled={busy || Boolean(waiting)}
                data-testid="kcoder-mcp-remove"
                onClick={() => setRemoveConfirmation(key)}
              >
                {t('workbench.mcp_remove')}
              </button>
            )}
            {removeConfirmation === key && (
              <div
                role="alertdialog"
                aria-label={t('workbench.mcp_remove')}
                className="studio-card-spacing w-full rounded-lg border border-border"
              >
                <p>{t('workbench.mcp_remove_prompt', { name: server.name })}</p>
                <button
                  className={button}
                  disabled={busy}
                  onClick={() => void act(server, 'remove')}
                >
                  {t('workbench.mcp_remove_confirm')}
                </button>
                <button
                  className={button}
                  disabled={busy}
                  onClick={() => setRemoveConfirmation(null)}
                >
                  {t('workbench.mcp_remove_cancel')}
                </button>
              </div>
            )}
            {canLogin && !waiting && (
              <McpClientAuthorizationForm
                disabled={busy}
                authorize={options => act(server, 'login', options)}
              />
            )}
          </article>
        )
      })}
    </section>
  )
}
