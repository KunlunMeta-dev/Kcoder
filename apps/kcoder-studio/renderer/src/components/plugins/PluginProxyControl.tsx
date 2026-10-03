import { useEffect, useRef, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { Switch } from '@/components/ui/switch'
import { useTranslation } from '@/hooks/useTranslation'
import type { LocalCodexPluginApi, PluginProxySettings } from '@/api/local/codexPlugins'

export function PluginProxyControl({
  api,
  probeUrl,
}: {
  api: LocalCodexPluginApi
  probeUrl?: string
}) {
  const { t } = useTranslation('common')
  const [state, setState] = useState<PluginProxySettings | null>(null)
  const [pending, setPending] = useState<boolean | null>(null)
  const [error, setError] = useState<string | null>(null)
  const mounted = useRef(true)
  const inFlight = useRef(false)
  useEffect(() => {
    mounted.current = true
    let disposed = false
    const refresh = () => {
      void api
        .getProxySettings?.()
        .then(value => {
          if (!disposed) {
            setState(value)
            setError(null)
          }
        })
        .catch(() => {
          if (!disposed) setError(t('pluginNetwork.autoProxyUnavailable'))
        })
    }
    refresh()
    window.addEventListener('kcoder:tools-catalog-invalidated', refresh)
    return () => {
      disposed = true
      mounted.current = false
      window.removeEventListener('kcoder:tools-catalog-invalidated', refresh)
    }
  }, [api, t])
  const apply = async (enabled: boolean) => {
    if (inFlight.current || !api.configureAutoProxy) return
    inFlight.current = true
    setPending(enabled)
    setError(null)
    try {
      const result = await api.configureAutoProxy(enabled, probeUrl)
      if (mounted.current) setState(result)
    } catch (cause) {
      if (mounted.current)
        setError(cause instanceof Error ? cause.message : t('pluginNetwork.autoProxyUnavailable'))
    } finally {
      inFlight.current = false
      if (mounted.current) setPending(null)
    }
  }
  const status =
    pending !== null
      ? t('pluginNetwork.autoProxyScanning')
      : state?.status === 'detected'
        ? t('pluginNetwork.autoProxyDetected', { url: state.detectedUrl })
        : state?.status === 'not_found'
          ? t('pluginNetwork.autoProxyNone')
          : state?.status === 'timed_out'
            ? t('pluginNetwork.autoProxyTimeout')
            : state?.status === 'limited'
              ? t('pluginNetwork.autoProxyLimited')
              : state?.autoDetect
                ? t('pluginNetwork.autoProxyIdle')
                : ''
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
      {error && (
        <p role="alert" className="break-words text-xs text-red-600">
          {error}
        </p>
      )}
    </div>
  )
}
