import { WikiLinks } from './WikiLinks'
import { WikiError } from './WikiError'
import { WikiPageEditor } from './WikiPageEditor'
import { WikiPageHistory } from './WikiPageHistory'
import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, FileText, LoaderCircle, X, Pencil, History } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { AssistantMarkdown } from '@/components/chat/AssistantMarkdown'
import { useTranslation } from '@/hooks/useTranslation'
import { knowledgeApi, type WikiPage, type WikiSource } from '@/kcoder/knowledgeApi'

export function WikiReader({
  page,
  serverId,
  libraryId,
  sources,
  isCurrent,
  onBack,
  onUpdated,
  canOrganize,
}: {
  page: WikiPage
  serverId: string
  libraryId: string
  sources: WikiSource[]
  isCurrent: () => boolean
  onBack: () => void
  onUpdated: (page: WikiPage) => void
  canOrganize: boolean
}) {
  const { t } = useTranslation('knowledge')
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof knowledgeApi.citation>> | null>(
    null
  )
  const [pending, setPending] = useState<number | null>(null)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const revision = useRef(0)
  useEffect(() => {
    const lifetime = revision
    return () => {
      ++lifetime.current
    }
  }, [])
  const heading = page.draft.markdown.match(/^#\s+([^\r\n]+)\r?\n/)
  const markdown =
    heading?.[1].trim() === page.draft.title.trim()
      ? page.draft.markdown.slice(heading[0].length).trimStart()
      : page.draft.markdown
  return (
    <article
      data-testid="wiki-reader"
      className="mx-auto min-h-0 w-full max-w-3xl flex-1 overflow-y-auto pb-12"
    >
      <div className="mb-6 flex flex-wrap items-center justify-between gap-2">
        <Button
          size="sm"
          variant="ghost"
          className="max-md:min-h-11"
          data-testid="wiki-reader-back"
          onClick={onBack}
        >
          <ArrowLeft />
          {t('pages')}
        </Button>
        <div className="flex justify-end gap-2">
          <Button
            size="sm"
            variant="ghost"
            disabled={!canOrganize}
            data-testid="wiki-reader-edit"
            onClick={() => setEditing(true)}
          >
            <Pencil />
            {t('editPage')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            data-testid="wiki-reader-history"
            onClick={() => setHistoryOpen(true)}
          >
            <History />
            {t('history')}
          </Button>
        </div>
      </div>
      {page.humanEdited && <p className="mb-3 text-xs text-text-muted">{t('humanEdited')}</p>}
      <h2 className="heading-lg mb-6 break-words tracking-tight">{page.draft.title}</h2>
      <AssistantMarkdown content={markdown} />
      <WikiLinks
        key={page.draft.pageId}
        serverId={serverId}
        libraryId={libraryId}
        pageId={page.draft.pageId}
        isCurrent={isCurrent}
        onPage={onUpdated}
      />
      {page.draft.citations.length > 0 && (
        <section className="mt-8 border-t border-border/60 pt-5" aria-label={t('citations')}>
          <h3 className="mb-3 text-xs font-medium text-text-muted">{t('citations')}</h3>
          <div className="flex flex-wrap gap-2">
            {page.draft.citations.map((citation, index) => (
              <Button
                key={`${citation.sourceId}:${citation.revisionId}:${citation.chunkId}:${index}`}
                size="sm"
                variant="outline"
                className="max-w-full max-md:min-h-11"
                data-testid={`wiki-citation-${index}`}
                disabled={pending !== null}
                onClick={() => {
                  const attempt = ++revision.current
                  setPending(index)
                  setError('')
                  void knowledgeApi
                    .citation(serverId, libraryId, citation)
                    .then(value => {
                      if (isCurrent() && attempt === revision.current) setPreview(value)
                    })
                    .catch(cause => {
                      if (isCurrent() && attempt === revision.current)
                        setError(String(cause instanceof Error ? cause.message : cause))
                    })
                    .finally(() => {
                      if (isCurrent() && attempt === revision.current) setPending(null)
                    })
                }}
              >
                {pending === index ? <LoaderCircle className="animate-spin" /> : <FileText />}
                <span className="truncate">
                  {sources.find(source => source.sourceId === citation.sourceId)?.title ??
                    t('sourceNumber', { number: index + 1 })}
                </span>
              </Button>
            ))}
          </div>
          {error && <WikiError error={error} />}
          {preview && (
            <aside
              data-testid="wiki-source-preview"
              className="mt-4 rounded-xl border border-border/60 bg-surface/40 p-4"
              aria-live="polite"
            >
              <div className="mb-3 flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-sm font-medium">
                  {preview.source.title}
                </span>
                <span className="text-xs text-text-muted">
                  {preview.chunk.page
                    ? t('sourcePage', { page: preview.chunk.page })
                    : t('sourceLines', {
                        start: preview.chunk.firstLine,
                        end: preview.chunk.lastLine,
                      })}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={t('closeSource')}
                  onClick={() => setPreview(null)}
                >
                  <X />
                </Button>
              </div>
              {preview.source.removed && (
                <p className="mb-3 text-xs text-text-muted">{t('removedSourceHint')}</p>
              )}
              <pre className="whitespace-pre-wrap break-words text-sm leading-relaxed">
                {preview.chunk.text}
              </pre>
            </aside>
          )}
        </section>
      )}
      {editing && (
        <WikiPageEditor
          page={page}
          serverId={serverId}
          libraryId={libraryId}
          isCurrent={isCurrent}
          onClose={() => setEditing(false)}
          onSaved={onUpdated}
        />
      )}
      {historyOpen && (
        <WikiPageHistory
          page={page}
          serverId={serverId}
          libraryId={libraryId}
          isCurrent={isCurrent}
          onClose={() => setHistoryOpen(false)}
          onRestored={onUpdated}
          canOrganize={canOrganize}
        />
      )}
    </article>
  )
}
