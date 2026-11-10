import { useEffect, useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import type { KnowledgePublication } from '../../../../shared/generated/contracts'
import type { KnowledgeOperationError, KnowledgeIntegrationClient } from './client'
import { OperationError, PageActions } from './shared'
import { formatAutomationTimestamp } from './time'
import { useDomainPage } from './useDomainPage'

type Publication = Pick<KnowledgePublication, 'owner' | 'version' | 'draft' | 'pages'>

function SourceObservations({
  client,
  publication,
  onError,
}: {
  client: KnowledgeIntegrationClient
  publication: Publication
  onError: (error?: KnowledgeOperationError) => void
}) {
  const { t, i18n } = useTranslation('knowledgeIntegration')
  const identity = JSON.stringify([
    client.ownerKey,
    publication.owner,
    publication.draft.publicationId,
    publication.version,
  ])
  const page = useDomainPage(identity, (after, signal) =>
    client.readPublicationSources(publication, after, signal)
  )
  useEffect(() => {
    if (!page.pending) onError(page.error)
  }, [page.pending, page.error, onError])
  return (
    <div className="mt-3 space-y-3" aria-busy={page.pending}>
      <p className="text-sm text-text-muted">{t('publicationSourceStatusHint')}</p>
      <OperationError error={page.error} />
      {page.pending && (
        <p className="text-sm text-text-muted" role="status">
          {t('loading')}
        </p>
      )}
      {!page.pending && !page.error && page.items.length === 0 && (
        <p className="text-sm text-text-muted">{t('noPublicationSourceObservations')}</p>
      )}
      {!page.pending &&
        page.items.map(item => {
          const saved = publication.pages.find(
            page =>
              page.source.libraryId === item.source.libraryId &&
              page.source.pageId === item.source.pageId &&
              page.source.pageRevision === item.source.pageRevision
          )
          return (
            <div
              key={JSON.stringify(item.source)}
              className="studio-card-spacing space-y-1 rounded-xl border border-border text-sm"
              data-testid="publication-source-observation"
            >
              <p className="break-words font-medium">{saved?.title ?? t('source')}</p>
              <p className="break-all text-xs text-text-muted">
                {t('sourceRevision', { revision: item.source.pageRevision })}
              </p>
              <p className={item.available ? 'text-text-secondary' : 'text-text-primary'}>
                {t(item.available ? 'publicationSourceAvailable' : 'publicationSourceMissing')}
              </p>
              {item.removed && <p className="text-text-muted">{t('publicationSourceRemoved')}</p>}
              {item.archived && <p className="text-text-muted">{t('publicationSourceArchived')}</p>}
              <p className="text-xs text-text-muted">
                {t('publicationSourceObservedAt', {
                  time:
                    formatAutomationTimestamp(
                      item.observedAtMs,
                      i18n?.resolvedLanguage || i18n?.language || 'en'
                    ) ?? t('unknown'),
                })}
              </p>
            </div>
          )
        })}
      <PageActions {...page} />
    </div>
  )
}

export function PublicationSources({
  client,
  publication,
  onError,
}: {
  client: KnowledgeIntegrationClient
  publication: Publication
  onError: (error?: KnowledgeOperationError) => void
}) {
  const { t } = useTranslation('knowledgeIntegration')
  const [open, setOpen] = useState(false)
  return (
    <details
      className="text-sm text-text-secondary"
      onToggle={event => {
        if (event.target === event.currentTarget) setOpen(event.currentTarget.open)
      }}
    >
      <summary
        className="min-h-11 cursor-pointer rounded-md py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/60 md:min-h-6 md:py-0"
        data-testid="publication-source-status-toggle"
      >
        {t('publicationSourceStatus')}
      </summary>
      {open && <SourceObservations client={client} publication={publication} onError={onError} />}
    </details>
  )
}
