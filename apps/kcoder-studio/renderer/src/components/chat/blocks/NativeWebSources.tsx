import { useState } from 'react'
import { ChevronDown, ChevronLeft, ChevronRight, Globe2 } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { openExternalUrl } from '@/lib/external-links'
import { formatWebSourceRetrievedAt, type WebSourcesV1 } from '../../../../../shared/webSources'

export function NativeWebSources({ receipt }: { receipt: WebSourcesV1 }) {
  const { t, i18n } = useTranslation('chat')
  const [page, setPage] = useState(0)
  const [expanded, setExpanded] = useState(receipt.sources.length > 0 && receipt.sources.length <= 3)
  const attempts = receipt.attempts ?? []
  const terminal = ['success', 'partial', 'empty', 'failed', 'cancelled'].includes(receipt.status)
  const switched = terminal && receipt.operation === 'search' && attempts.length > 1
  const pages = Math.ceil(receipt.sources.length / 10)
  const current = Math.min(page, Math.max(0, pages - 1))
  return (
    <div
      data-testid="native-web-sources"
      className="mt-2 flex min-w-0 flex-col gap-2 rounded-lg border border-border bg-surface p-3 text-sm"
    >
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded(value => !value)}
        className="flex min-h-11 min-w-0 items-center gap-1.5 text-left text-text-secondary sm:min-h-8"
      >
        <Globe2 className="h-4 w-4 shrink-0" strokeWidth={1.7} aria-hidden="true" />
        <span>
          {t(`web_sources.${receipt.operation}`)} · {t(`web_sources.${receipt.status}`)}
          {receipt.sources.length ? ` (${receipt.sources.length})` : ''}
        </span>
        {switched ? (
          <span data-testid="native-source-switch" className="text-xs text-text-muted">
            {t('web_sources.switched')}
          </span>
        ) : null}
        <span className="ml-auto flex min-w-0 items-center gap-1.5">
          {receipt.provider ? (
            <span className="text-right text-xs text-text-muted">{receipt.provider}</span>
          ) : null}
          <ChevronDown
            className={`h-3 w-3 shrink-0 transition-transform ${expanded ? '' : '-rotate-90'}`}
            strokeWidth={1.7}
            aria-hidden="true"
          />
        </span>
      </button>
      {expanded ? (
        <>
          {switched ? (
            <ol
              data-testid="native-source-attempts"
              aria-label={t('web_sources.attempts')}
              className="flex min-w-0 flex-col gap-1 text-xs text-text-muted"
            >
              {attempts.map((attempt, index) => (
                <li
                  key={`${index}-${attempt.provider}`}
                  data-testid="native-source-attempt"
                  data-provider={attempt.provider}
                  data-attempt-status={attempt.status}
                  className="break-words"
                >
                  {attempt.provider} · {t(`web_sources.${attempt.status}`)}
                </li>
              ))}
            </ol>
          ) : null}
          {receipt.sources.slice(current * 10, current * 10 + 10).map(source => (
            <div
              key={source.sourceId}
              data-source-id={source.sourceId}
              className="flex min-w-0 flex-col gap-1"
            >
              <a
                href={source.url}
                className="min-w-0 break-words text-text-primary underline decoration-border underline-offset-4 hover:text-primary"
                onClick={event => {
                  event.preventDefault()
                  void openExternalUrl(source.url)
                }}
              >
                {source.title || new URL(source.url).hostname}
              </a>
              <span className="break-words text-xs text-text-muted">
                {new URL(source.url).hostname} · {t(`web_sources.read_${source.readStatus}`)}
                {source.cacheHit ? ` · ${t('web_sources.cached')}` : ''}
              </span>
              {source.author ? (
                <span className="text-xs text-text-muted">{source.author}</span>
              ) : null}
              {source.publishedAt ? (
                <span className="text-xs text-text-muted">
                  {t('web_sources.published')} {source.publishedAt}
                </span>
              ) : null}
              <span className="text-xs text-text-muted" title={source.retrievedAt}>
                {t('web_sources.retrieved')} {formatWebSourceRetrievedAt(source.retrievedAt, i18n?.resolvedLanguage || i18n?.language || 'en')}
              </span>
            </div>
          ))}
          {receipt.failure ? (
            <span className="text-xs text-text-muted">{t('web_sources.unavailable')}</span>
          ) : null}
          {pages > 1 ? (
            <nav
              aria-label={t('web_sources.pages')}
              className="flex items-center justify-end gap-2 text-text-secondary"
            >
              <button
                type="button"
                aria-label={t('web_sources.previous')}
                disabled={current === 0}
                onClick={() => setPage(value => value - 1)}
                className="flex h-11 w-11 items-center sm:h-8 sm:w-8 justify-center rounded hover:bg-muted disabled:opacity-40"
              >
                <ChevronLeft className="h-4 w-4" strokeWidth={1.7} />
              </button>
              <span className="text-xs tabular-nums">
                {current + 1} / {pages}
              </span>
              <button
                type="button"
                aria-label={t('web_sources.next')}
                disabled={current + 1 === pages}
                onClick={() => setPage(value => value + 1)}
                className="flex h-11 w-11 items-center sm:h-8 sm:w-8 justify-center rounded hover:bg-muted disabled:opacity-40"
              >
                <ChevronRight className="h-4 w-4" strokeWidth={1.7} />
              </button>
            </nav>
          ) : null}
        </>
      ) : null}
    </div>
  )
}
