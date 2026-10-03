import { WikiError } from './WikiError'
import { WikiSearch } from './WikiSearch'
import { WikiSourceReader } from './WikiSourceReader'
import { WikiImport } from './WikiImport'
import { useCallback, useEffect, useRef, useState } from 'react'
import { BookOpen, ChevronRight, FileText, LoaderCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { WikiReader } from './WikiReader'
import { useTranslation } from '@/hooks/useTranslation'
import {
  knowledgeApi,
  type WikiPage,
  type WikiPageSummary,
  type WikiSource,
} from '@/kcoder/knowledgeApi'
import { cn } from '@/lib/utils'

export function KnowledgeContents({
  serverId,
  libraryId,
  isCurrent,
  canRetrieve,
  canOrganize,
}: {
  serverId: string
  libraryId: string
  isCurrent: () => boolean
  canRetrieve: boolean
  canOrganize: boolean
}) {
  const { t } = useTranslation('knowledge')
  const [showRemoved, setShowRemoved] = useState(false)
  const [original, setOriginal] = useState<WikiSource | null>(null)
  const [pages, setPages] = useState<WikiPageSummary[]>([])
  const [sources, setSources] = useState<WikiSource[]>([])
  const [page, setPage] = useState<WikiPage | null>(null)
  const [tab, setTab] = useState<'pages' | 'sources'>('pages')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [reading, setReading] = useState<string | null>(null)
  const [pageCursor, setPageCursor] = useState<string | null>(null)
  const [sourceCursor, setSourceCursor] = useState<string | null>(null)
  const readRevision = useRef(0)
  const [refresh, setRefresh] = useState(0)
  const onChanged = useCallback(() => setRefresh(value => value + 1), [])
  useEffect(() => {
    let alive = true
    const lifetime = readRevision
    void Promise.all([
      knowledgeApi.pages(serverId, libraryId),
      showRemoved
        ? knowledgeApi.removedSources(serverId, libraryId)
        : knowledgeApi.sources(serverId, libraryId),
    ])
      .then(([knowledge, originals]) => {
        if (alive && isCurrent()) {
          setPages(knowledge.items)
          setSources(originals.items)
          setPageCursor(knowledge.nextAfterId ?? null)
          setSourceCursor(originals.nextAfterId ?? null)
        }
      })
      .catch(cause => {
        if (alive && isCurrent()) setError(String(cause instanceof Error ? cause.message : cause))
      })
      .finally(() => {
        if (alive && isCurrent()) setLoading(false)
      })
    return () => {
      alive = false
      ++lifetime.current
    }
  }, [serverId, libraryId, isCurrent, refresh, showRemoved])
  const more = async () => {
    setLoading(true)
    setError('')
    try {
      if (tab === 'pages' && pageCursor) {
        const result = await knowledgeApi.pages(serverId, libraryId, pageCursor)
        if (isCurrent()) {
          setPages(items => [...items, ...result.items])
          setPageCursor(result.nextAfterId ?? null)
        }
      } else if (tab === 'sources' && sourceCursor) {
        const result = await (showRemoved
          ? knowledgeApi.removedSources(serverId, libraryId, sourceCursor)
          : knowledgeApi.sources(serverId, libraryId, sourceCursor))
        if (isCurrent()) {
          setSources(items => [...items, ...result.items])
          setSourceCursor(result.nextAfterId ?? null)
        }
      }
    } catch (cause) {
      if (isCurrent()) setError(String(cause instanceof Error ? cause.message : cause))
    } finally {
      if (isCurrent()) setLoading(false)
    }
  }
  const empty = tab === 'pages' ? !pages.length : !sources.length
  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-busy={loading || reading !== null}>
      {!page && canRetrieve && (
        <WikiSearch
          serverId={serverId}
          libraryId={libraryId}
          isCurrent={isCurrent}
          onPage={setPage}
          onSource={setOriginal}
        />
      )}
      {original && (
        <WikiSourceReader
          serverId={serverId}
          libraryId={libraryId}
          source={original}
          isCurrent={isCurrent}
          onClose={() => setOriginal(null)}
          canOrganize={canOrganize}
          onChanged={source => {
            onChanged()
            if (source) setOriginal(source)
          }}
        />
      )}
      {!page && (
        <WikiImport
          serverId={serverId}
          libraryId={libraryId}
          isCurrent={isCurrent}
          onChanged={onChanged}
          sources={sources}
          refreshSignal={refresh}
          canOrganize={canOrganize}
        />
      )}
      {error && <WikiError error={error} />}
      {page ? (
        <WikiReader
          page={page}
          serverId={serverId}
          libraryId={libraryId}
          sources={sources}
          isCurrent={isCurrent}
          onBack={() => setPage(null)}
          canOrganize={canOrganize}
          onUpdated={value => {
            setPage(value)
            onChanged()
          }}
        />
      ) : (
        <>
          <div
            role="tablist"
            aria-label={t('contentTabs')}
            className="flex shrink-0 gap-6 border-b border-border/60"
          >
            {(['pages', 'sources'] as const).map(value => (
              <button
                key={value}
                role="tab"
                id={`wiki-tab-${value}`}
                aria-controls="wiki-content-panel"
                aria-selected={tab === value}
                data-testid={`knowledge-tab-${value}`}
                onClick={() => setTab(value)}
                className={cn(
                  'inline-flex min-h-11 items-center gap-2 border-b-2 px-0.5 pb-3 pt-1 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/50',
                  tab === value
                    ? 'border-text-primary font-medium text-text-primary'
                    : 'border-transparent text-text-muted hover:text-text-primary'
                )}
              >
                {t(value)}
                <span className="text-xs tabular-nums text-text-muted">
                  {value === 'pages' ? pages.length : sources.length}
                  {(value === 'pages' ? pageCursor : sourceCursor) ? '+' : ''}
                </span>
              </button>
            ))}
            {tab === 'sources' && (
              <Button
                size="sm"
                variant="ghost"
                className="ml-auto"
                data-testid="wiki-trash-toggle"
                onClick={() => setShowRemoved(value => !value)}
              >
                {t(showRemoved ? 'activeSources' : 'removedSources')}
              </Button>
            )}
          </div>
          <div
            id="wiki-content-panel"
            role="tabpanel"
            aria-labelledby={`wiki-tab-${tab}`}
            className="flex min-h-0 flex-1 flex-col overflow-y-auto"
          >
            {empty ? (
              <div className="flex flex-1 flex-col items-center justify-center px-4 py-12 text-center">
                {loading ? (
                  <LoaderCircle className="mb-5 size-6 animate-spin text-text-muted" />
                ) : (
                  <div className="mb-5 flex size-14 items-center justify-center rounded-2xl bg-text-primary/[0.03]">
                    {tab === 'pages' ? (
                      <BookOpen className="size-6 text-text-muted" strokeWidth={1.3} />
                    ) : (
                      <FileText className="size-6 text-text-muted" strokeWidth={1.3} />
                    )}
                  </div>
                )}
                <h3 className="text-sm font-medium text-text-primary">
                  {loading ? t('loading') : t(tab === 'pages' ? 'noPages' : 'noSources')}
                </h3>
                {!loading && (
                  <p className="mt-2 max-w-xs text-sm leading-relaxed text-text-muted">
                    {t(tab === 'pages' ? 'pagesHint' : 'sourcesHint')}
                  </p>
                )}
              </div>
            ) : (
              <div className="py-3">
                {tab === 'pages'
                  ? pages.map(item => (
                      <button
                        key={item.pageId}
                        data-testid={`wiki-page-row-${item.pageId}`}
                        aria-label={item.title}
                        disabled={reading !== null}
                        className="group flex min-h-14 w-full items-center gap-3 rounded-xl px-3 py-3 text-left transition-colors hover:bg-text-primary/[0.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/50 disabled:opacity-50"
                        onClick={() => {
                          const attempt = ++readRevision.current
                          setReading(item.pageId)
                          setError('')
                          void knowledgeApi
                            .page(serverId, libraryId, item.pageId)
                            .then(value => {
                              if (isCurrent() && attempt === readRevision.current) setPage(value)
                            })
                            .catch(cause => {
                              if (isCurrent() && attempt === readRevision.current)
                                setError(String(cause instanceof Error ? cause.message : cause))
                            })
                            .finally(() => {
                              if (isCurrent() && attempt === readRevision.current) setReading(null)
                            })
                        }}
                      >
                        <BookOpen className="size-4 shrink-0 text-text-muted" />
                        <span className="min-w-0 flex-1 truncate text-sm">{item.title}</span>
                        {reading === item.pageId ? (
                          <LoaderCircle className="size-4 animate-spin" />
                        ) : (
                          <ChevronRight className="size-4 shrink-0 text-text-muted" />
                        )}
                      </button>
                    ))
                  : sources.map(source => (
                      <button
                        key={source.sourceId}
                        data-testid={`wiki-source-row-${source.sourceId}`}
                        onClick={() => setOriginal(source)}
                        className="flex min-h-14 w-full items-center gap-3 rounded-xl px-3 py-3 text-left hover:bg-surface focus-visible:ring-2 focus-visible:ring-focus"
                      >
                        <FileText className="size-4 shrink-0 text-text-muted" />
                        <span className="min-w-0 truncate text-sm">{source.title}</span>
                      </button>
                    ))}
                {(tab === 'pages' ? pageCursor : sourceCursor) && (
                  <Button
                    className="mt-3 max-md:min-h-11"
                    variant="ghost"
                    size="sm"
                    disabled={loading}
                    onClick={() => void more()}
                  >
                    {t('more')}
                  </Button>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </section>
  )
}
