import { WikiError } from './WikiError'
import { useEffect, useState } from 'react'
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
}: {
  serverId: string
  libraryId: string
  isCurrent: () => boolean
  onPage: (page: WikiPage) => void
  onSource: (source: WikiSource) => void
}) {
  const { t } = useTranslation('knowledge')
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<{
    query: string
    items: Awaited<ReturnType<typeof knowledgeApi.search>>['items']
  } | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!query.trim()) return
    let active = true
    const timer = setTimeout(() => {
      void knowledgeApi
        .search(serverId, libraryId, query)
        .then(value => {
          if (active && isCurrent()) {
            setResults({ query, items: value.items })
            setError('')
          }
        })
        .catch(cause => {
          if (active && isCurrent())
            setError(String(cause instanceof Error ? cause.message : cause))
        })
    }, 250)
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [serverId, libraryId, isCurrent, query])
  const hits = results?.query === query ? results.items : null
  return (
    <div className="mb-4 shrink-0">
      <InputWithIcon
        icon={<Search className="size-4" />}
        aria-label={t('searchWiki')}
        placeholder={t('searchWiki')}
        value={query}
        maxLength={4096}
        onChange={event => {
          setQuery(event.target.value)
          setError('')
        }}
        data-testid="wiki-search"
      />
      {error && <WikiError error={error} />}
      {query.trim() && (
        <div className="mt-2 max-h-64 overflow-y-auto rounded-xl border border-border/60 p-2">
          {hits?.length === 0 && (
            <p className="p-3 text-sm text-text-muted">{t('noSearchResults')}</p>
          )}
          {!hits && <p className="p-3 text-sm text-text-muted">{t('loading')}</p>}
          {hits?.map(hit => (
            <button
              key={`${hit.documentId}:${hit.revisionId}`}
              className="flex w-full gap-3 rounded-lg p-3 text-left hover:bg-surface focus-visible:ring-2 focus-visible:ring-focus"
              onClick={() => {
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
                      if (isCurrent()) onPage(page)
                    })
                    .catch(cause => {
                      if (isCurrent())
                        setError(String(cause instanceof Error ? cause.message : cause))
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
                <span className="mt-1 line-clamp-2 text-xs text-text-muted">{hit.excerpt}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
