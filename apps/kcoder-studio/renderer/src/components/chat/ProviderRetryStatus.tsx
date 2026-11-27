import { useState } from 'react'
import { ChevronDown, LoaderCircle } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { Button } from '@/components/ui/button'
import { useVisibleNow } from '@/hooks/useVisibleNow'
import type { ProviderRetryActivity } from '@/kcoder/toolPathPreview'

export function ProviderRetryStatus({ activity }: { activity: ProviderRetryActivity }) {
  const { t } = useTranslation('chat')
  const deadline = activity.receivedAtMs + activity.retryAfterMs
  const nowMs = useVisibleNow(true, 1000, deadline)
  const [expanded, setExpanded] = useState(false)

  const displayNow = Math.max(nowMs, activity.receivedAtMs)
  const waiting = activity.retryAfterMs > 0 && displayNow < deadline
  const message = waiting
    ? t('provider_retry.waiting', {
        attempt: activity.attempt,
        maxRetries: activity.maxRetries,
        seconds: Math.max(1, Math.ceil((deadline - displayNow) / 1000)),
      })
    : t('provider_retry.retrying', { attempt: activity.attempt, maxRetries: activity.maxRetries })
  const facts = activity.diagnostics
  const rows = [
    ['provider', facts?.provider],
    ['model', facts?.model],
    ['reason', facts?.reason],
    ['timeout_kind', facts?.timeoutKind],
    ['previous_attempt_ms', facts?.previousAttemptElapsedMs],
    ['previous_transport_ms', facts?.previousTransportElapsedMs],
    ['turn_at_failure_ms', facts?.turnElapsedMsAtFailure],
    ['previous_first_token_ms', facts?.previousFirstTokenMs],
    ['previous_last_token_ms', facts?.previousLastTokenMs],
  ].filter((row): row is [string, string | number] => row[1] !== undefined)
  return (
    <div
      className="min-w-0 text-sm text-text-secondary"
      data-testid="provider-retry-status"
      data-state={waiting ? 'waiting' : 'retrying'}
      role="status"
      aria-live={waiting ? 'off' : 'polite'}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <LoaderCircle className="h-4 w-4 shrink-0 animate-spin" aria-hidden="true" />
        <span>{message}</span>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setExpanded(value => !value)}
          aria-expanded={expanded}
          data-testid="provider-retry-details-toggle"
          className="h-7 shrink-0 px-2 text-xs"
        >
          {t('provider_retry.details')}
          <ChevronDown className={expanded ? 'rotate-180' : ''} aria-hidden="true" />
        </Button>
      </div>
      {expanded && (
        <div
          className="mt-2 space-y-2 rounded-lg border border-border bg-surface p-3"
          data-testid="provider-retry-details"
        >
          <p>
            {t(waiting ? 'provider_retry.phase_waiting' : 'provider_retry.phase_backoff_elapsed')}
          </p>
          <p className="text-xs text-text-muted">{t('provider_retry.previous_attempt_notice')}</p>
          {rows.length ? (
            <dl className="grid min-w-0 gap-1 text-xs">
              {rows.map(([key, value]) => (
                <div key={key} className="min-w-0">
                  <dt className="text-text-muted">{t(`provider_retry.fields.${key}`)}</dt>
                  <dd className="break-words font-mono">{value}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="text-xs">{t('provider_retry.details_unavailable')}</p>
          )}
        </div>
      )}
    </div>
  )
}
