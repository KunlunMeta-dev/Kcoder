import { useEffect, useState } from 'react'
import { RefreshCw, ShieldCheck, X } from 'lucide-react'
import type { LocalCodexPluginApi, PluginTrustState } from '@/api/local/codexPlugins'
import { useTranslation } from '@/hooks/useTranslation'
import { Button } from '@/components/ui/button'

/** Target-bound API instance and component key prevent a late response changing another target. */
export function PluginTrustManager({
  api,
  target,
  onClose,
}: {
  api: LocalCodexPluginApi
  target: string
  onClose: () => void
}) {
  const { t } = useTranslation('common')
  const [state, setState] = useState<PluginTrustState | null>(null)
  const [revision, setRevision] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const [pending, setPending] = useState<{
    path: string
    action: 'trust' | 'revoke' | 'never'
  } | null>(null)
  useEffect(() => {
    let disposed = false
    setBusy(true)
    setError(false)
    void api
      .listTrust?.()
      .then(value => {
        if (!disposed) setState(value)
      })
      .catch(() => {
        if (!disposed) setError(true)
      })
      .finally(() => {
        if (!disposed) setBusy(false)
      })
    return () => {
      disposed = true
    }
  }, [api, revision])
  const apply = async () => {
    if (!pending || !api.setTrust || busy) return
    setBusy(true)
    setError(false)
    try {
      setState(await api.setTrust(pending.path, pending.action))
      setPending(null)
    } catch {
      setError(true)
    } finally {
      setBusy(false)
    }
  }
  return (
    <section
      data-testid="plugin-trust-manager"
      aria-labelledby="plugin-trust-title"
      className="space-y-4 rounded-xl border border-border bg-background p-4"
    >
      <div className="flex items-center justify-between gap-3">
        <h2 id="plugin-trust-title" className="flex items-center gap-2 text-sm font-semibold">
          <ShieldCheck className="h-4 w-4" />
          {t('pluginTrust.title')}
        </h2>
        <div className="flex gap-2">
          <Button
            variant="ghost"
            size="icon"
            disabled={busy}
            aria-label={t('pluginTrust.refresh')}
            onClick={() => setRevision(value => value + 1)}
          >
            <RefreshCw className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="icon" aria-label={t('pluginTrust.close')} onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>
      <p className="text-sm text-text-secondary [overflow-wrap:anywhere]">
        {t('pluginTrust.target', { target })}
      </p>
      {state?.bypassActive && (
        <p role="alert" className="text-sm text-text-secondary">
          {t('pluginTrust.bypass')}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-red-600">
          {t('pluginTrust.failed')}
        </p>
      )}
      {busy && (
        <p role="status" className="text-sm text-text-secondary">
          {t('pluginTrust.loading')}
        </p>
      )}
      {!busy && state?.entries.length === 0 && (
        <p className="text-sm text-text-secondary">{t('pluginTrust.empty')}</p>
      )}
      <ul className="divide-y divide-border">
        {state?.entries.map(entry => (
          <li
            key={`${entry.source}:${entry.path}:${entry.decision}`}
            data-testid="plugin-trust-entry"
            className="flex flex-wrap items-center justify-between gap-3 py-3"
          >
            <div className="min-w-0 flex-1">
              <p className="break-all font-mono text-sm">{entry.path}</p>
              <p className="mt-1 text-xs text-text-secondary">
                {t(`pluginTrust.source_${entry.source}`)} ·{' '}
                {t(`pluginTrust.state_${entry.effective}`)}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {(['trust', 'revoke', 'never'] as const)
                .filter(action => action !== entry.decision)
                .map(action => (
                  <Button
                    key={action}
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    data-testid={`plugin-trust-${action}`}
                    onClick={() => setPending({ path: entry.path, action })}
                  >
                    {t(`pluginTrust.action_${action}`)}
                  </Button>
                ))}
            </div>
          </li>
        ))}
      </ul>
      {pending && (
        <div
          role="group"
          aria-label={t('pluginTrust.confirmTitle')}
          className="space-y-3 rounded-lg bg-muted p-3"
          data-testid="plugin-trust-confirm"
        >
          <p className="text-sm font-medium">{t('pluginTrust.confirmTitle')}</p>
          <p className="break-all text-sm">
            {t(`pluginTrust.action_${pending.action}`)} · {pending.path}
          </p>
          <p className="text-sm text-text-secondary">{t('pluginTrust.confirmHelp')}</p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" disabled={busy} onClick={() => setPending(null)}>
              {t('pluginTrust.cancel')}
            </Button>
            <Button disabled={busy} data-testid="plugin-trust-apply" onClick={() => void apply()}>
              {t('pluginTrust.apply')}
            </Button>
          </div>
        </div>
      )}
    </section>
  )
}
