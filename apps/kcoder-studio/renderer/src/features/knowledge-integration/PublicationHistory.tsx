import { useTranslation } from '@/hooks/useTranslation'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import type { KnowledgeIntegrationClient } from './client'
import { useDomainPage } from './useDomainPage'
import { useDomainAction } from './useDomainAction'
import { OperationError, PageActions } from './shared'
import { formatAutomationTimestamp } from './time'

export function PublicationHistory({
  client,
  refreshPublications,
}: {
  client: KnowledgeIntegrationClient
  refreshPublications: () => void
}) {
  const { t, i18n } = useTranslation('knowledgeIntegration')
  const page = useDomainPage(client.ownerKey, (after, signal) =>
    client.listPublicationHistory(after, signal)
  )
  const [observedAt, setObservedAt] = useState(Date.now)
  const refreshHistory = () => {
    setObservedAt(Date.now())
    page.refresh()
  }
  const action = useDomainAction(() => {
    refreshHistory()
    refreshPublications()
  }, client)
  return (
    <div className="mt-3 space-y-3" data-testid="publication-owner-history">
      <p className="text-sm text-text-muted">{t('publicationHistoryHint')}</p>
      <OperationError error={page.error ?? action.error} onInspect={() => void action.inspect()} />
      {page.items.map(item => {
        const now = observedAt
        const state = item.revoked
          ? 'publicationRevoked'
          : item.validFromMs != null && now < item.validFromMs
            ? 'publicationNotEffective'
            : item.validUntilMs != null && now >= item.validUntilMs
              ? 'publicationExpired'
              : 'publicationEffective'
        return (
          <div
            key={`${item.publicationId}-${item.version}`}
            className="studio-card-spacing flex flex-wrap items-center gap-3 rounded-xl border border-border"
          >
            <div className="mr-auto min-w-0 text-sm">
              <p className="font-medium">
                {item.title} · {t('version', { version: item.version })}
              </p>
              <p className="text-text-muted">
                {t(state)} ·{' '}
                {formatAutomationTimestamp(
                  item.publishedAtMs,
                  i18n?.resolvedLanguage || i18n?.language || 'en'
                ) ?? t('unknown')}
              </p>
            </div>
            {!item.revoked && (
              <Button
                variant="outline"
                disabled={action.blocked}
                data-testid="publication-history-revoke"
                onClick={() =>
                  void action.run(() =>
                    client.revokePublication({
                      owner: item.owner,
                      version: item.version,
                      draft: { publicationId: item.publicationId },
                    })
                  )
                }
              >
                {t('revoke')}
              </Button>
            )}
          </div>
        )
      })}
      <PageActions {...page} refresh={refreshHistory} />
    </div>
  )
}
