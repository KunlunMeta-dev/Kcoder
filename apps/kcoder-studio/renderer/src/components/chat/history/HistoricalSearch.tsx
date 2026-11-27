import { useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { useMigrationSearch } from '@/kcoder/useMigrationSearch'
import type { useMigrationTranscript } from '@/kcoder/useMigrationTranscript'
import { Button } from '@/components/ui/button'
import { HistoricalBody } from './HistoricalTranscriptContent'
import type { MigrationHistorySearchHit } from '../../../../../shared/generated/contracts'

export function HistoricalSearch(props: {
  deviceId: string
  workspacePath?: string
  jobId: string
  viewId?: string
  isCurrent: () => boolean
  model: ReturnType<typeof useMigrationTranscript>
}) {
  const { t } = useTranslation('migration')
  const search = useMigrationSearch(
    props.deviceId,
    props.workspacePath,
    props.jobId,
    props.viewId,
    props.isCurrent
  )
  const [query, setQuery] = useState(''),
    [caseSensitive, setCaseSensitive] = useState(false)
  const [selected, setSelected] = useState<{ key: string; hit: MigrationHistorySearchHit } | null>(
    null
  )
  const value = search.value,
    running = search.phase === 'running'
  const key = JSON.stringify([props.model.scope, value?.id, value?.starts.length])
  const hit = selected?.key === key ? selected.hit : null
  return (
    <section className="my-3 space-y-3" data-testid="historical-search">
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={event => {
          event.preventDefault()
          void search.search(query, caseSensitive)
        }}
      >
        <input
          value={query}
          maxLength={1024}
          className="min-h-11 min-w-0 flex-1 rounded-md border border-border bg-surface px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-focus"
          placeholder={t('search.placeholder')}
          aria-label={t('search.placeholder')}
          onChange={event => setQuery(event.target.value)}
        />
        <Button size="sm" type="submit" disabled={!query.trim()}>
          {t('search.find')}
        </Button>
        {running && (
          <Button size="sm" variant="ghost" type="button" onClick={search.cancel}>
            {t('search.pause')}
          </Button>
        )}
        <label className="flex min-h-11 items-center gap-2 text-xs text-text-secondary">
          <input
            type="checkbox"
            checked={caseSensitive}
            onChange={event => setCaseSensitive(event.target.checked)}
          />
          {t('search.case_sensitive')}
        </label>
      </form>
      {search.phase !== 'idle' && (
        <p role="status" className="text-xs text-text-secondary">
          {t(
            running
              ? 'search.scanning'
              : search.phase === 'paused'
                ? 'search.paused'
                : 'search.progress',
            {
              scanned: value?.scanned ?? 0,
              total: value?.total ?? 0,
              bytes: (value?.bytes ?? 0).toLocaleString(),
            }
          )}
        </p>
      )}
      {search.error && (
        <p role="alert" className="text-sm text-destructive">
          {t(`errors.${search.error}`, { defaultValue: t('search.failed') })}
        </p>
      )}
      {search.phase === 'paused' && (
        <Button size="sm" variant="outline" onClick={search.resume}>
          {t('search.resume')}
        </Button>
      )}
      {value && (
        <>
          {value.unsupported > 0 && (
            <p className="text-xs text-text-secondary">
              {t('search.unsupported', { count: value.unsupported })}
            </p>
          )}
          {value.excluded > 0 && (
            <p className="text-xs text-text-muted">
              {t('search.excluded', { count: value.excluded })}
            </p>
          )}
          <ul className="max-h-64 space-y-2 overflow-y-auto overscroll-contain">
            {value.items.map(item => (
              <li key={`${item.position}:${item.block.index}`}>
                <button
                  type="button"
                  className="min-h-11 w-full rounded-md px-3 py-2 text-left text-sm hover:bg-muted focus-visible:ring-2 focus-visible:ring-focus"
                  onClick={() => setSelected({ key, hit: item })}
                >
                  <span className="mb-1 block text-xs text-text-muted">
                    {t('search.location', { record: item.record + 1, block: item.block.index + 1 })}
                  </span>
                  <span className="break-words whitespace-pre-wrap">
                    {item.before}
                    <mark className="bg-muted font-medium text-text-primary underline">
                      {item.matched}
                    </mark>
                    {item.after}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {search.phase === 'ready' && value.done && value.items.length === 0 && (
            <p className="text-sm text-text-secondary">{t('search.empty')}</p>
          )}
          {hit && (
            <div
              className="studio-card-spacing rounded-lg border border-border"
              data-testid="historical-search-body"
            >
              <p className="text-xs text-text-muted">
                {t('search.location', { record: hit.record + 1, block: hit.block.index + 1 })} ·{' '}
                {t(`transcript.block_kinds.${hit.block.kind}`)}
              </p>
              <HistoricalBody
                key={`${key}:${hit.position}:${hit.block.index}`}
                block={hit.block}
                record={hit.position}
                model={props.model}
                initialCursor={hit.bodyCursor}
              />
            </div>
          )}
          <div className="flex justify-end gap-2">
            <Button
              size="sm"
              variant="ghost"
              disabled={running || value.starts.length < 2}
              onClick={search.previous}
            >
              {t('previous')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={running || value.done || search.phase !== 'ready'}
              onClick={search.next}
            >
              {t('next')}
            </Button>
          </div>
        </>
      )}
    </section>
  )
}
