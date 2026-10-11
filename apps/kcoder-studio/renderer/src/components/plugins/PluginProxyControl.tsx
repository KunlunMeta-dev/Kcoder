import { useEffect, useRef, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { useTranslation } from '@/hooks/useTranslation'
import type { LocalCodexPluginApi } from '@/api/local/codexPlugins'
import {
  proxyDisplayUrl,
  proxyTargetHosts,
  type PluginProxyDiagnostics,
} from '@/features/plugins/pluginProxyDiagnostics'

export function PluginProxyControl({
  api,
  probeUrl,
  targetLabel,
}: {
  api: LocalCodexPluginApi
  probeUrl?: string
  targetLabel?: string
}) {
  const { t } = useTranslation('common')
  const [snapshot, setSnapshot] = useState<{
    api: LocalCodexPluginApi
    state: PluginProxyDiagnostics | null
    pending: boolean | null
    error: boolean
    loading: boolean
  }>({ api, state: null, pending: null, error: false, loading: true })
  const state = snapshot.api === api ? snapshot.state : null
  const pending = snapshot.api === api ? snapshot.pending : null
  const error =
    snapshot.api === api && snapshot.error ? t('pluginNetwork.autoProxyUnavailable') : null
  const loading = snapshot.api === api ? snapshot.loading : true
  const generation = useRef(0)
  const readRevision = useRef(0)
  const refreshControl = useRef<{ request: () => void; resume: () => void } | null>(null)
  const inFlight = useRef(false)
  useEffect(() => {
    const current = ++generation.current
    inFlight.current = false
    let disposed = false
    let reading = false
    let queued = true
    const drain = () => {
      if (disposed || reading || inFlight.current || !queued) return
      queued = false
      reading = true
      const revision = ++readRevision.current
      const valid = () =>
        !disposed &&
        current === generation.current &&
        revision === readRevision.current &&
        !inFlight.current
      // Coalesce catalog invalidations and never start a read over a write.
      void Promise.resolve().then(async () => {
        try {
          if (!valid()) return
          setSnapshot(previous => ({
            api,
            state: previous.api === api ? previous.state : null,
            pending: null,
            error: false,
            loading: true,
          }))
          if (!api.getProxySettings) throw new Error('Proxy settings unavailable')
          const value = await api.getProxySettings()
          if (valid())
            setSnapshot({ api, state: value, pending: null, error: false, loading: false })
        } catch {
          if (valid())
            setSnapshot(previous => ({
              ...previous,
              error: true,
              loading: false,
            }))
        } finally {
          reading = false
          drain()
        }
      })
    }
    const refresh = () => {
      queued = true
      drain()
    }
    const control = { request: refresh, resume: drain }
    refreshControl.current = control
    drain()
    window.addEventListener('kcoder:tools-catalog-invalidated', refresh)
    return () => {
      disposed = true
      generation.current = current + 1
      if (refreshControl.current === control) refreshControl.current = null
      window.removeEventListener('kcoder:tools-catalog-invalidated', refresh)
    }
  }, [api])
  const apply = async (enabled: boolean) => {
    if (inFlight.current || !api.configureAutoProxy) return
    const current = generation.current
    inFlight.current = true
    ++readRevision.current
    setSnapshot({ api, state, pending: enabled, error: false, loading: false })
    try {
      const result = await api.configureAutoProxy(enabled, probeUrl)
      if (current === generation.current)
        setSnapshot({ api, state: result, pending: enabled, error: false, loading: false })
    } catch {
      if (current === generation.current)
        setSnapshot({
          api,
          state,
          pending: enabled,
          error: true,
          loading: false,
        })
    } finally {
      if (current === generation.current) {
        inFlight.current = false
        setSnapshot(value => ({ ...value, pending: null }))
        refreshControl.current?.resume()
      }
    }
  }
  const status =
    pending !== null
      ? t('pluginNetwork.autoProxyScanning')
      : state?.status === 'detected'
        ? t('pluginNetwork.autoProxyDetected', { url: proxyDisplayUrl(state.detectedUrl) })
        : state?.status === 'not_found'
          ? t('pluginNetwork.autoProxyNone')
          : state?.status === 'timed_out'
            ? t('pluginNetwork.autoProxyTimeout')
            : state?.status === 'limited'
              ? t('pluginNetwork.autoProxyLimited')
              : state?.autoDetect
                ? t('pluginNetwork.autoProxyIdle')
                : ''
  const hosts = proxyTargetHosts(state?.targetHosts)
  return (
    <div data-testid="plugins-auto-proxy" className="space-y-1">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <label
          className="flex min-h-11 cursor-pointer items-center gap-2 text-sm text-text-secondary"
          title={t('pluginNetwork.autoProxyHint')}
        >
          <Switch
            data-testid="plugins-auto-proxy-switch"
            aria-label={t('pluginNetwork.autoProxy')}
            checked={pending ?? state?.autoDetect ?? false}
            disabled={!state || pending !== null}
            onCheckedChange={value => {
              void apply(value)
            }}
          />
          <span>{t('pluginNetwork.autoProxy')}</span>
        </label>
        {(state?.autoDetect || pending === true) && (
          <button
            type="button"
            data-testid="plugins-auto-proxy-rescan"
            className="inline-flex min-h-8 items-center gap-1.5 rounded-lg px-2 text-xs text-text-secondary hover:bg-surface disabled:opacity-50 max-md:min-h-11"
            disabled={pending !== null}
            onClick={() => {
              void apply(true)
            }}
          >
            <RefreshCw className={`h-3.5 w-3.5 ${pending !== null ? 'animate-spin' : ''}`} />
            {t('pluginNetwork.autoProxyRescan')}
          </button>
        )}
        <span role="status" className="min-w-0 break-all text-xs text-text-muted">
          {status}
        </span>
      </div>
      {targetLabel && (
        <p className="text-xs text-text-muted" data-testid="plugins-proxy-target">
          {t('pluginNetwork.autoProxyTarget', { target: targetLabel })}
        </p>
      )}
      {state?.autoDetect && (
        <p className="text-xs text-text-muted">{t('pluginNetwork.autoProxyTargetHint')}</p>
      )}
      {state && (state.checkedPorts > 0 || (state.quickChecks ?? 0) > 0) && (
        <details className="text-xs text-text-muted" data-testid="plugins-proxy-details">
          <summary className="min-h-8 cursor-pointer max-md:min-h-11">
            {t('pluginNetwork.autoProxySummary', {
              ports: state.checkedPorts,
              candidates: state.checkedCandidates ?? 0,
              quickChecks: state.quickChecks ?? 0,
            })}
          </summary>
          {state.source && <p>{t(`pluginNetwork.autoProxySource_${state.source}`)}</p>}
          {hosts.length > 0 && (
            <p>{t('pluginNetwork.autoProxyHosts', { hosts: hosts.join(', ') })}</p>
          )}
        </details>
      )}
      {error && (
        <div className="flex flex-wrap items-center gap-2" role="alert">
          <p className="min-w-0 break-words text-xs text-destructive">{error}</p>
          {api.getProxySettings && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              data-testid="plugins-auto-proxy-retry"
              className="max-md:min-h-11"
              disabled={loading || pending !== null}
              onClick={() => refreshControl.current?.request()}
            >
              {t('common.retry')}
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
