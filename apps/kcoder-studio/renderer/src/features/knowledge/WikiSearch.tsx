import { WikiError } from './WikiError'
import { groupWikiSearchResults, wikiSearchMatchesScope } from './wikiSearchResults'
import { useEffect, useRef, useState } from 'react'
import { Search, BookOpen, FileText } from 'lucide-react'
import { InputWithIcon } from '@/components/settings/settings-ui'
import { useTranslation } from '@/hooks/useTranslation'
import { knowledgeApi, type WikiPage, type WikiSource } from '@/kcoder/knowledgeApi'

export function WikiSearch({
  serverId,
  libraryId,
  isCurrent,
  onPage,
  onSource,
  onQueryChange,
  compact = false,
}: {
  serverId: string
  libraryId: string
  isCurrent: () => boolean
  onPage: (page: WikiPage) => void
  onSource: (source: WikiSource) => void
  onQueryChange?: () => void
  compact?: boolean
}) {
  const { t } = useTranslation('knowledge')
  const [query, setQuery] = useState('')
  const navigation = useRef(0)
  useEffect(() => {
    const lifetime = navigation
    return () => {
      ++lifetime.current
    }
  }, [serverId, libraryId, query])
  const [results, setResults] = useState<{
    serverId: string
    libraryId: string
    query: string
    items: Awaited<ReturnType<typeof knowledgeApi.search>>['items']
  } | null>(null)
  const [failure, setFailure] = useState<{
    serverId: string
    libraryId: string
    query: string
    message: string
  } | null>(null)
  useEffect(() => {
    if (!query.trim()) return
    let active = true
    const timer = setTimeout(() => {
      void knowledgeApi
        .search(serverId, libraryId, query)
        .then(value => {
          if (active && isCurrent()) {
            setResults({ serverId, libraryId, query, items: groupWikiSearchResults(value.items) })
            setFailure(null)
          }
        })
        .catch(cause => {
          if (active && isCurrent())
            setFailure({
              serverId,
              libraryId,
              query,
              message: String(cause instanceof Error ? cause.message : cause),
            })
        })
    }, 250)
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [serverId, libraryId, isCurrent, query])
  const hits = wikiSearchMatchesScope(results, serverId, libraryId, query) ? results!.items : null
  const error = wikiSearchMatchesScope(failure, serverId, libraryId, query) ? failure!.message : ''
  return (
    <div className={compact ? 'relative min-w-0 flex-1 sm:max-w-72' : 'mb-4 shrink-0'}>
      <InputWithIcon
        icon={<Search className="size-4" />}
        aria-label={t('searchWiki')}
        placeholder={t('searchWiki')}
        value={query}
        maxLength={4096}
        onChange={event => {
          ++navigation.current
          setQuery(event.target.value)
          setFailure(null)
          onQueryChange?.()
        }}
        data-testid="wiki-search"
      />
      {error && <WikiError error={error} />}
      {query.trim() && (
        <div
          className={`mt-2 max-h-64 overflow-y-auto rounded-xl border border-border/60 bg-popover p-2 ${compact ? 'absolute right-0 top-full z-20 w-full min-w-64 shadow-lg' : ''}`}
        >
          {hits?.length === 0 && (
            <p className="p-3 text-sm text-text-muted">{t('noSearchResults')}</p>
          )}
          {!hits && !error && <p className="p-3 text-sm text-text-muted">{t('loading')}</p>}
          {hits?.map(hit => (
            <button
              key={`${hit.documentId}:${hit.revisionId}`}
              data-testid={`wiki-search-result-${hit.documentId}-${hit.revisionId}`}
              aria-label={hit.title}
              className="flex w-full gap-3 rounded-lg p-3 text-left hover:bg-surface focus-visible:ring-2 focus-visible:ring-focus"
              onClick={() => {
                const attempt = ++navigation.current
                if (hit.documentId.startsWith('source:')) {
                  onSource({
                    sourceId: hit.documentId.split(':')[1],
                    revisionId: hit.revisionId,
                    title: hit.title,
                    bodyHash: '',
                  })
                } else
                  void knowledgeApi
                    .page(serverId, libraryId, hit.documentId, hit.revisionId)
                    .then(page => {
                      if (isCurrent() && attempt === navigation.current) onPage(page)
                    })
                    .catch(cause => {
                      if (isCurrent() && attempt === navigation.current)
                        setFailure({
                          serverId,
                          libraryId,
                          query,
                          message: String(cause instanceof Error ? cause.message : cause),
                        })
                    })
              }}
            >
              {hit.documentId.startsWith('source:') ? (
                <FileText className="mt-1 size-4 shrink-0 text-text-muted" />
              ) : (
                <BookOpen className="mt-1 size-4 shrink-0 text-text-muted" />
              )}
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">{hit.title}</span>
                <span className="mt-1 block truncate text-xs text-text-muted">
                  {t(hit.documentId.startsWith('source:') ? 'sources' : 'pages')}
                  {' · '}
                  {t('versionNumber', { number: hit.revisionId })}
                </span>
                <span className="mt-1 line-clamp-2 text-xs text-text-muted">{hit.excerpt}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
