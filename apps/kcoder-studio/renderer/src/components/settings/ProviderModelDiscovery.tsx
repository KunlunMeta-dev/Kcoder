import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Box, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { IconSelect } from './settings-ui'
import { useTranslation } from '@/hooks/useTranslation'
import { captureAccountContextRevision } from '@/kcoder/accountContextEvents'
import { isPlaintextRemoteEndpoint } from '@/lib/endpoint-security'
import { RuntimeTargetConfirmDialog } from './RuntimeTargetConfirmDialog'
import { discoverProviderSettingsModels, type ProviderDraft } from '@/kcoder/providerSettings'

/** A model catalog is a disposable draft observation, never a saved or selected default. */
export function ProviderModelDiscovery({
  serverId,
  draft,
  enabled,
  hasStoredKey,
  ownerScope,
  onSelect,
}: {
  serverId: string
  draft: ProviderDraft
  enabled: boolean
  hasStoredKey: boolean
  ownerScope: string
  onSelect: (model: string) => void
}) {
  const { t } = useTranslation('common')
  const [refresh, setRefresh] = useState(0)
  const [plaintextApproval, setPlaintextApproval] = useState<string>()
  const [confirmation, setConfirmation] = useState(false)
  const fingerprint = JSON.stringify([
    serverId,
    ownerScope,
    draft.id,
    draft.endpoint,
    draft.apiFormat,
    draft.apiKey,
    draft.authentication,
    hasStoredKey,
  ])
  const current = useRef(fingerprint)
  useLayoutEffect(() => {
    current.current = fingerprint
  }, [fingerprint])
  const [state, setState] = useState<{
    fingerprint: string
    models?: string[]
    error?: string
    loading?: boolean
  }>()
  const usable = (() => {
    try {
      const url = new URL(draft.endpoint)
      return (
        ['http:', 'https:'].includes(url.protocol) &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash
      )
    } catch {
      return false
    }
  })()
  const canLoad =
    enabled &&
    usable &&
    Boolean(draft.apiKey.trim() || hasStoredKey || draft.authentication?.mode === 'none')
  const ready =
    canLoad && (!isPlaintextRemoteEndpoint(draft.endpoint) || plaintextApproval === fingerprint)
  useEffect(() => {
    if (!ready) return
    const controller = new AbortController()
    const accountValid = captureAccountContextRevision()
    const valid = () =>
      !controller.signal.aborted && current.current === fingerprint && accountValid(serverId)
    const timer = window.setTimeout(
      () => {
        setState({ fingerprint, loading: true })
        void (async () => {
          try {
            const result = await discoverProviderSettingsModels(serverId, draft, {
              signal: controller.signal,
            })
            if (valid()) setState({ fingerprint, models: result.models })
          } catch (error) {
            const category =
              error instanceof Error
                ? /\[provider_discovery_([a-z_]+)\]/.exec(error.message)?.[1]
                : undefined
            if (valid())
              setState({
                fingerprint,
                error: [
                  'authentication',
                  'permission',
                  'unsupported',
                  'timeout',
                  'network',
                  'rate_limit',
                  'changed',
                ].includes(category ?? '')
                  ? category
                  : 'response',
              })
          }
        })()
      },
      refresh ? 0 : 700
    )
    return () => {
      controller.abort()
      window.clearTimeout(timer)
    }
    // Only connection inputs invalidate discovery; selecting a model does not repeat the request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fingerprint, ready, refresh, serverId])
  const observed = state?.fingerprint === fingerprint ? state : undefined
  const models = observed?.models ?? []
  return (
    <section className="space-y-2 text-sm md:col-span-2" data-testid="provider-model-discovery">
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="outline"
          data-testid="provider-discover-models"
          disabled={!canLoad || observed?.loading}
          onClick={() => {
            if (!ready) setConfirmation(true)
            else setRefresh(value => value + 1)
          }}
        >
          <RefreshCw
            className={observed?.loading ? 'size-4 animate-spin' : 'size-4'}
            aria-hidden="true"
          />
          {t(`providerSettings.${observed?.loading ? 'discoveryLoading' : 'discoverModels'}`)}
        </Button>
        <span className="text-text-secondary">{t('providerSettings.discoveryHelp')}</span>
      </div>
      {observed?.error && (
        <p role="status" className="text-text-secondary" data-testid="provider-discovery-error">
          {t(`providerSettings.discovery_${observed.error}`)}
        </p>
      )}
      {observed?.models && models.length === 0 && (
        <p role="status">{t('providerSettings.discoveryEmpty')}</p>
      )}
      {models.length > 0 && (
        <label className="block space-y-2">
          <span>{t('providerSettings.discoveredModels', { count: models.length })}</span>
          <IconSelect
            icon={<Box />}
            data-testid="provider-discovered-model"
            aria-label={t('providerSettings.chooseDiscoveredModel')}
            value={models.includes(draft.model) ? draft.model : ''}
            onChange={event => {
              if (event.target.value) onSelect(event.target.value)
            }}
          >
            <option value="">{t('providerSettings.chooseDiscoveredModel')}</option>
            {models.map(model => (
              <option key={model} value={model}>
                {model}
              </option>
            ))}
          </IconSelect>
        </label>
      )}
      {confirmation && (
        <RuntimeTargetConfirmDialog
          testId="provider-discovery-plaintext-dialog"
          title={t('providerSettings.discoverModels')}
          description={t('providerSettings.discoveryPlaintext', {
            endpoint: draft.endpoint.trim(),
          })}
          cancelLabel={t('providerSettings.cancel')}
          closeLabel={t('providerSettings.cancel')}
          confirmLabel={t('providerSettings.discoverModels')}
          onCancel={() => setConfirmation(false)}
          onConfirm={() => {
            setPlaintextApproval(fingerprint)
            setConfirmation(false)
            setRefresh(value => value + 1)
          }}
        />
      )}
    </section>
  )
}
