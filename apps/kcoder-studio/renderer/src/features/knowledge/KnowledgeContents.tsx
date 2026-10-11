import { WikiError } from './WikiError'
import { WikiSearch } from './WikiSearch'
import { WikiSourceReader } from './WikiSourceReader'
import { WikiImport } from './WikiImport'
import { WikiSourceJobStatus } from './WikiSourceJobStatus'
import { useWikiCatalog, WIKI_CATALOG_PAGE_SIZE } from './useWikiCatalog'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  ArrowDownAZ,
  BookOpen,
  ChevronLeft,
  ChevronRight,
  Copy,
  FileText,
  LoaderCircle,
  Search,
} from 'lucide-react'
import { ActionMenu } from '@/components/common/ActionMenu'
import { InputWithIcon } from '@/components/settings/settings-ui'
import { SettingsSelect } from '@/components/settings/SettingsSelect'
import { Button } from '@/components/ui/button'
import { WikiReader } from './WikiReader'
import { useTranslation } from '@/hooks/useTranslation'
import {
  knowledgeApi,
  type WikiPage,
  type WikiPageSummary,
  type WikiSource,
  type WikiJob,
} from '@/kcoder/knowledgeApi'
import { cn } from '@/lib/utils'

export function KnowledgeContents({
  serverId,
  libraryId,
  isCurrent,
  canRetrieve,
  canOrganize,
  actions,
}: {
  serverId: string
  libraryId: string
  isCurrent: () => boolean
  canRetrieve: boolean
  canOrganize: boolean
  actions?: ReactNode
}) {
  const { t } = useTranslation('knowledge')
  const [showRemoved, setShowRemoved] = useState(false)
  const [original, setOriginal] = useState<WikiSource | null>(null)
  const [sourceJobs, setSourceJobs] = useState<WikiJob[]>([])
  const [jobsDisconnected, setJobsDisconnected] = useState(false)
  const onJobsChanged = useCallback((jobs: WikiJob[], disconnected: boolean) => {
    setSourceJobs(jobs)
    setJobsDisconnected(disconnected)
  }, [])
  const [page, setPage] = useState<WikiPage | null>(null)
  const [tab, setTab] = useState<'pages' | 'sources'>('pages')
  const [sort, setSort] = useState('catalog')
  const [localQuery, setLocalQuery] = useState('')
  const sorted = <T extends { title: string }>(items: T[]) =>
    sort === 'catalog'
      ? items
      : [...items].sort((a, b) => (sort === 'name' ? 1 : -1) * a.title.localeCompare(b.title))
  const [error, setError] = useState('')
  const [reading, setReading] = useState<string | null>(null)
  const readRevision = useRef(0)
  const [refresh, setRefresh] = useState(0)
  const onChanged = useCallback(() => setRefresh(value => value + 1), [])
  const filtered = <T extends { title: string }>(items: T[]) =>
    sorted(
      !canRetrieve && localQuery.trim()
        ? items.filter(item =>
            item.title.toLocaleLowerCase().includes(localQuery.trim().toLocaleLowerCase())
          )
        : items
    )
  const loadPages = useCallback(
    (afterId?: string) => knowledgeApi.pages(serverId, libraryId, afterId, WIKI_CATALOG_PAGE_SIZE),
    [serverId, libraryId]
  )
  const loadSources = useCallback(
    (afterId?: string) =>
      showRemoved
        ? knowledgeApi.removedSources(serverId, libraryId, afterId, WIKI_CATALOG_PAGE_SIZE)
        : knowledgeApi.sources(serverId, libraryId, afterId, WIKI_CATALOG_PAGE_SIZE),
    [serverId, libraryId, showRemoved]
  )
  const scope = JSON.stringify([serverId, libraryId])
  const pageCatalog = useWikiCatalog({
    scope,
    load: loadPages,
    isCurrent,
    refreshSignal: refresh,
    project: filtered<WikiPageSummary>,
  })
  const sourceCatalog = useWikiCatalog({
    scope: JSON.stringify([serverId, libraryId, showRemoved]),
    load: loadSources,
    isCurrent,
    refreshSignal: refresh,
    project: filtered<WikiSource>,
  })
  const pages = pageCatalog.items
  const sources = sourceCatalog.items
  const catalog = tab === 'pages' ? pageCatalog : sourceCatalog
  const loading = catalog.loading
  const visiblePages = pageCatalog.visibleItems
  const visibleSources = sourceCatalog.visibleItems
  const resetPages = () => {
    pageCatalog.reset()
    sourceCatalog.reset()
  }
  useEffect(() => {
    let alive = true
    const lifetime = readRevision
    ++lifetime.current
    queueMicrotask(() => {
      if (!alive || !isCurrent()) return
      setReading(null)
      setError('')
    })
    return () => {
      alive = false
      ++lifetime.current
    }
  }, [serverId, libraryId, isCurrent, refresh, showRemoved])
  const empty = tab === 'pages' ? !visiblePages.length : !visibleSources.length
  const openPage = async (item: WikiPageSummary) => {
    const attempt = ++readRevision.current
    setReading(item.pageId)
    setError('')
    try {
      const value = await knowledgeApi.page(serverId, libraryId, item.pageId)
      if (isCurrent() && attempt === readRevision.current) setPage(value)
    } catch (cause) {
      if (isCurrent() && attempt === readRevision.current)
        setError(String(cause instanceof Error ? cause.message : cause))
    } finally {
      if (isCurrent() && attempt === readRevision.current) setReading(null)
    }
  }
  const copyTitle = async (title: string) => {
    try {
      await navigator.clipboard.writeText(title)
    } catch (cause) {
      if (isCurrent()) setError(String(cause instanceof Error ? cause.message : cause))
    }
  }
  return (
    <section className="flex flex-1 flex-col" aria-busy={loading || reading !== null}>
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
          actions={actions}
          serverId={serverId}
          libraryId={libraryId}
          isCurrent={isCurrent}
          onChanged={onChanged}
          sources={sources}
          refreshSignal={refresh}
          canOrganize={canOrganize}
          onInspectSource={setOriginal}
          onJobsChanged={onJobsChanged}
        />
      )}
      {(error || catalog.error) && <WikiError error={error || catalog.error} />}
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
          <div className="mb-4 flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border/60">
            <div role="tablist" aria-label={t('contentTabs')} className="flex shrink-0 gap-6">
              {(['pages', 'sources'] as const).map(value => (
                <button
                  key={value}
                  role="tab"
                  id={`wiki-tab-${value}`}
                  aria-controls="wiki-content-panel"
                  aria-selected={tab === value}
                  tabIndex={tab === value ? 0 : -1}
                  data-testid={`knowledge-tab-${value}`}
                  onClick={() => setTab(value)}
                  onKeyDown={event => {
                    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
                    event.preventDefault()
                    const next =
                      event.key === 'Home'
                        ? 'pages'
                        : event.key === 'End'
                          ? 'sources'
                          : value === 'pages'
                            ? 'sources'
                            : 'pages'
                    setTab(next)
                    document.getElementById(`wiki-tab-${next}`)?.focus()
                  }}
                  className={cn(
                    'inline-flex min-h-11 items-center gap-2 border-b-2 px-0.5 pb-3 pt-1 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/50',
                    tab === value
                      ? 'border-focus font-medium text-text-primary'
                      : 'border-transparent text-text-muted hover:text-text-primary'
                  )}
                >
                  {t(value)}
                  <span className="text-xs tabular-nums text-text-muted">
                    {value === 'pages' ? pages.length : sources.length}
                    {(value === 'pages' ? pageCatalog.cursor : sourceCatalog.cursor) ? '+' : ''}
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
            <div className="flex min-w-0 flex-1 items-center justify-end gap-3 pb-3 sm:flex-none">
              {canRetrieve && (
                <WikiSearch
                  compact
                  serverId={serverId}
                  libraryId={libraryId}
                  isCurrent={isCurrent}
                  onPage={setPage}
                  onSource={setOriginal}
                  onQueryChange={resetPages}
                />
              )}
              {!canRetrieve && (
                <div className="min-w-0 flex-1 sm:w-64">
                  <InputWithIcon
                    icon={<Search className="size-4" />}
                    data-testid="wiki-title-search"
                    aria-label={t('searchTitles')}
                    placeholder={t('searchTitles')}
                    value={localQuery}
                    maxLength={4096}
                    onChange={event => {
                      setLocalQuery(event.target.value)
                      resetPages()
                    }}
                  />
                </div>
              )}
              <SettingsSelect
                density="compact"
                icon={<ArrowDownAZ />}
                value={sort}
                aria-label={t('sort')}
                data-testid="wiki-content-sort"
                onChange={event => {
                  setSort(event.target.value)
                  resetPages()
                }}
              >
                <option value="catalog">{t('catalogOrder')}</option>
                <option value="name">{t('nameAscending')}</option>
                <option value="name-desc">{t('nameDescending')}</option>
              </SettingsSelect>
            </div>
          </div>
          <div
            id="wiki-content-panel"
            role="tabpanel"
            aria-labelledby={`wiki-tab-${tab}`}
            className="flex flex-1 flex-col"
          >
            {(sort !== 'catalog' || (!canRetrieve && localQuery.trim())) && catalog.cursor && (
              <p className="mb-3 text-sm text-text-muted" data-testid="wiki-content-loaded-hint">
                {t('loadedCatalogHint')}
              </p>
            )}
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
                  {loading
                    ? t('loading')
                    : !canRetrieve && localQuery.trim()
                      ? t('noSearchResults')
                      : t(tab === 'pages' ? 'noPages' : 'noSources')}
                </h3>
                {!loading && !localQuery.trim() && (
                  <p className="mt-2 max-w-xs text-sm leading-relaxed text-text-muted">
                    {t(tab === 'pages' ? 'pagesHint' : 'sourcesHint')}
                  </p>
                )}
              </div>
            ) : (
              <div className="space-y-2 py-1">
                {tab === 'pages'
                  ? visiblePages.map(item => (
                      <div
                        key={item.pageId}
                        className="flex items-center rounded-xl border border-border/60 bg-background pr-3 transition-colors hover:border-text-muted/30 hover:bg-surface/40"
                      >
                        <button
                          key={item.pageId}
                          data-testid={`wiki-page-row-${item.pageId}`}
                          aria-label={item.title}
                          disabled={reading !== null}
                          className="group flex min-h-16 min-w-0 flex-1 items-center gap-4 rounded-xl px-3 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/50 disabled:opacity-50"
                          onClick={() => void openPage(item)}
                        >
                          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-surface text-text-secondary">
                            <BookOpen className="size-4" />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-base font-medium">
                              {item.title}
                            </span>
                            <span className="mt-1 block text-xs text-text-muted">
                              {t(item.humanEdited ? 'humanEdited' : 'organizedPage')}
                            </span>
                          </span>
                          <span className="hidden shrink-0 text-xs text-text-muted lg:block">
                            {t('versionNumber', { number: item.revisionId.slice(0, 12) })}
                          </span>
                          {reading === item.pageId ? (
                            <LoaderCircle className="size-4 animate-spin" />
                          ) : (
                            <ChevronRight className="size-4 shrink-0 text-text-muted" />
                          )}
                        </button>
                        <ActionMenu
                          testId={`wiki-page-actions-${item.pageId}`}
                          ariaLabel={t('contentActions', { title: item.title })}
                          placement="bottom-end"
                          disabled={reading !== null}
                          items={[
                            {
                              label: t('openPage'),
                              icon: BookOpen,
                              testId: `wiki-page-open-${item.pageId}`,
                              onSelect: () => openPage(item),
                            },
                            {
                              label: t('copyTitle'),
                              icon: Copy,
                              testId: `wiki-page-copy-${item.pageId}`,
                              onSelect: () => copyTitle(item.title),
                            },
                          ]}
                        />
                      </div>
                    ))
                  : visibleSources.map(source => (
                      <div
                        key={source.sourceId}
                        className="flex items-center rounded-xl border border-border/60 bg-background pr-3 transition-colors hover:border-text-muted/30 hover:bg-surface/40"
                      >
                        <button
                          key={source.sourceId}
                          data-testid={`wiki-source-row-${source.sourceId}`}
                          onClick={() => setOriginal(source)}
                          className="flex min-h-16 min-w-0 flex-1 items-center gap-4 rounded-xl px-3 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                        >
                          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-surface text-text-secondary">
                            <FileText className="size-4" />
                          </span>
                          <span className="min-w-0 flex-1 text-base font-medium">
                            <span className="block truncate">{source.title}</span>
                            <WikiSourceJobStatus
                              source={source}
                              jobs={sourceJobs}
                              disconnected={jobsDisconnected}
                            />
                          </span>
                          <span className="hidden shrink-0 text-xs text-text-muted lg:block">
                            {t('versionNumber', { number: source.revisionId.slice(0, 12) })}
                          </span>
                          <ChevronRight className="size-4 shrink-0 text-text-muted" />
                        </button>
                        <ActionMenu
                          testId={`wiki-source-actions-${source.sourceId}`}
                          ariaLabel={t('contentActions', { title: source.title })}
                          placement="bottom-end"
                          items={[
                            {
                              label: t('openSource'),
                              icon: FileText,
                              testId: `wiki-source-open-${source.sourceId}`,
                              onSelect: () => setOriginal(source),
                            },
                            {
                              label: t('copyTitle'),
                              icon: Copy,
                              testId: `wiki-source-copy-${source.sourceId}`,
                              onSelect: () => copyTitle(source.title),
                            },
                          ]}
                        />
                      </div>
                    ))}
              </div>
            )}
            <nav
              aria-label={t('catalogPagination')}
              className="mt-4 flex flex-wrap items-center justify-end gap-3"
              data-testid="wiki-content-pagination"
            >
              <Button
                data-testid="wiki-content-previous"
                className="max-md:min-h-11"
                variant="ghost"
                size="sm"
                disabled={loading || catalog.pageIndex === 0}
                onClick={catalog.previous}
              >
                <ChevronLeft className="size-4" />
                {t('previousPage')}
              </Button>
              <span
                className="text-sm tabular-nums text-text-secondary"
                role="status"
                data-testid="wiki-content-page"
              >
                {t('catalogPage', { number: catalog.pageIndex + 1 })}
              </span>
              <Button
                data-testid="wiki-content-next"
                className="max-md:min-h-11"
                variant="ghost"
                size="sm"
                disabled={loading || !catalog.hasNext}
                onClick={() => void catalog.next()}
              >
                {t('nextPage')}
                {loading ? (
                  <LoaderCircle className="size-4 animate-spin" />
                ) : (
                  <ChevronRight className="size-4" />
                )}
              </Button>
            </nav>
          </div>
        </>
      )}
    </section>
  )
}
