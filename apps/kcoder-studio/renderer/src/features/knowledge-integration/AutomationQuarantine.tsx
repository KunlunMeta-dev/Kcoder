import { useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import type { KnowledgeIntegrationClient } from './client'
import { OperationError, PageActions } from './shared'
import { useDomainPage } from './useDomainPage'
import { formatAutomationTimestamp } from './time'

function QuarantinedEvents({ client }: { client: KnowledgeIntegrationClient }) {
  const { t, i18n } = useTranslation('knowledgeIntegration')
  const page = useDomainPage(client.ownerKey, (after, signal) =>
    client.listQuarantinedEvents(after, signal)
  )
  return (
    <div className="mt-3 space-y-3" aria-busy={page.pending}>
      <p className="text-sm text-text-secondary">{t('quarantineHint')}</p>
      <OperationError error={page.error} />
      {!page.pending && !page.error && !page.items.length && (
        <p className="text-sm text-text-muted">{t('noQuarantinedEvents')}</p>
      )}
      {page.items.map(event => (
        <article
          key={event.id}
          className="studio-card-spacing rounded-xl border border-border text-sm"
          data-testid="automation-quarantined-event"
        >
          <p className="font-medium">
            {t(
              event.reasonCode === 'AUTOMATION_EVENT_STALE_QUARANTINED'
                ? 'quarantineStale'
                : event.reasonCode === 'AUTOMATION_EVENT_CLOCK_QUARANTINED'
                  ? 'quarantineClock'
                  : 'quarantineOther'
            )}
          </p>
          <p className="mt-1 text-text-secondary">
            {t('eventOccurredAt')}:{' '}
            {(event.occurredAtMs > 0 &&
              formatAutomationTimestamp(
                event.occurredAtMs,
                i18n?.resolvedLanguage || i18n?.language || 'en'
              )) ||
              t('eventTimeUnavailable')}
          </p>
          <details className="mt-2 text-text-muted">
            <summary className="cursor-pointer">{t('quarantineDetails')}</summary>
            <dl className="mt-2 space-y-1 break-all">
              <div>
                <dt>{t('quarantineSubscription')}</dt>
                <dd>
                  {event.subscriptionId} · v{event.subscriptionRevision}
                </dd>
              </div>
              <div>
                <dt>{t('quarantineSource')}</dt>
                <dd>{event.sourceRef}</dd>
              </div>
              <div>
                <dt>{t('quarantineEvent')}</dt>
                <dd>{event.eventId}</dd>
              </div>
              <div>
                <dt>{t('quarantineReasonCode')}</dt>
                <dd>{event.reasonCode}</dd>
              </div>
            </dl>
          </details>
        </article>
      ))}
      <PageActions {...page} />
    </div>
  )
}

export function AutomationQuarantine({ client }: { client: KnowledgeIntegrationClient }) {
  const { t } = useTranslation('knowledgeIntegration')
  const [open, setOpen] = useState(false)
  return (
    <details
      className="studio-card-spacing workbench-card"
      onToggle={event => {
        if (event.target === event.currentTarget) setOpen(event.currentTarget.open)
      }}
    >
      <summary className="cursor-pointer font-medium" data-testid="automation-quarantine-toggle">
        {t('quarantinedEvents')}
      </summary>
      {open && <QuarantinedEvents client={client} />}
    </details>
  )
}
