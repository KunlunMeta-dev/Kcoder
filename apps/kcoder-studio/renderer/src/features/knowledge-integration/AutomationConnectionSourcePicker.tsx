import type { AutomationConnectionEventSource } from '../../../../shared/generated/contracts'
import { useTranslation } from '@/hooks/useTranslation'
import { Button } from '@/components/ui/button'
import type { KnowledgeIntegrationClient } from './client'
import { OperationError, PageActions } from './shared'
import { useDomainPage } from './useDomainPage'

export function AutomationConnectionSourcePicker({
  client,
  value,
  disabled,
  onSelection,
}: {
  client: KnowledgeIntegrationClient
  value?: AutomationConnectionEventSource
  disabled?: boolean
  onSelection: (source: AutomationConnectionEventSource | undefined) => void
}) {
  const { t } = useTranslation('knowledgeIntegration')
  const page = useDomainPage(client.ownerKey, (after, signal) =>
    client.listConnectionEventSources(after, signal)
  )
  return (
    <div className="studio-card-spacing space-y-3 rounded-xl border border-border" aria-busy={page.pending}>
      <p className="text-sm text-text-secondary">{t('connectionEventHint')}</p>
      <OperationError error={page.error} />
      {!page.pending && !page.error && !page.items.length && (
        <p className="text-sm text-text-muted" data-testid="automation-connection-source-empty">
          {t('noConnectionEventSources')}
        </p>
      )}
      {page.items.map(source => (
        <div key={source.sourceRef} className="studio-card-spacing rounded-lg border border-border text-sm">
          <p className="font-medium">
            {t(`connectionPlatform${source.platform}`)} · {source.connectionId}
          </p>
          {source.state === 'unavailable' && (
            <p className="mt-1 text-text-muted">{t('connectionEventUnavailable')}</p>
          )}
          <Button
            type="button"
            variant="outline"
            className="mt-2"
            disabled={disabled || page.pending || source.state !== 'available'}
            onClick={() => onSelection(source)}
            aria-pressed={value?.sourceRef === source.sourceRef}
            data-testid="automation-connection-source-select"
          >
            {t(
              value?.sourceRef === source.sourceRef
                ? 'connectionSourceSelected'
                : 'selectConnectionSource'
            )}
          </Button>
        </div>
      ))}
      <PageActions
        {...page}
        refresh={() => {
          onSelection(undefined)
          page.refresh()
        }}
      />
      {value && (
        <p role="status" className="text-sm text-text-secondary">
          {t('connectionSourceReady', { connection: value.connectionId })}
        </p>
      )}
    </div>
  )
}
