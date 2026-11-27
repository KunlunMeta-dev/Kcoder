import { useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import type { KnowledgeIntegrationClient } from './client'
import { useDomainPage } from './useDomainPage'
import { OperationError, PageActions } from './shared'
import { formatAutomationTimestamp } from './time'

function ClaimRecords({ client, runId }: { client: KnowledgeIntegrationClient; runId: string }) {
  const { t, i18n } = useTranslation('knowledgeIntegration')
  const page = useDomainPage(`${client.ownerKey}-${runId}`, (after, signal) =>
    client.listArtifactClaims(runId, after, signal)
  )
  return (
    <div className="mt-3 space-y-3" aria-busy={page.pending}>
      <OperationError error={page.error} />
      {!page.pending && !page.error && page.items.length === 0 && (
        <p className="text-sm text-text-muted">{t('noArtifactClaims')}</p>
      )}
      {page.items.map(claim => (
        <div
          key={claim.exportId}
          className="studio-card-spacing rounded-xl border border-border text-sm"
          data-testid="automation-artifact-claim"
        >
          <p>
            {t('artifactClaimCompleted', {
              revision: claim.manifestRef.revision,
              time:
                formatAutomationTimestamp(
                  claim.completedAtMs,
                  i18n?.resolvedLanguage || i18n?.language || 'en'
                ) ?? t('unknown'),
            })}
          </p>
          <details className="mt-2 text-xs text-text-muted">
            <summary className="cursor-pointer" data-testid="artifact-claim-details">
              {t('claimDetails')}
            </summary>
            <dl className="mt-2 space-y-1 break-all">
              <div>
                <dt>{t('claimExportId')}</dt>
                <dd>{claim.exportId}</dd>
              </div>
              <div>
                <dt>{t('claimBytes')}</dt>
                <dd>{claim.bytes}</dd>
              </div>
              <div>
                <dt>SHA-256</dt>
                <dd>{claim.sha256}</dd>
              </div>
            </dl>
          </details>
        </div>
      ))}
      <PageActions {...page} />
    </div>
  )
}
export function AutomationArtifactClaims({
  client,
  runId,
}: {
  client: KnowledgeIntegrationClient
  runId: string
}) {
  const { t } = useTranslation('knowledgeIntegration')
  const [open, setOpen] = useState(false)
  return (
    <details
      className="mt-3"
      onToggle={event => {
        if (event.target === event.currentTarget) setOpen(event.currentTarget.open)
      }}
    >
      <summary className="cursor-pointer text-sm" data-testid="artifact-claims-toggle">
        {t('artifactClaims')}
      </summary>
      {open && <ClaimRecords client={client} runId={runId} />}
    </details>
  )
}
