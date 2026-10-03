import { createRandomUuid } from '@/lib/random-id'
import { WikiError } from './WikiError'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { ModalDialog } from '@/components/ui/modal-dialog'
import { AssistantMarkdown } from '@/components/chat/AssistantMarkdown'
import { useTranslation } from '@/hooks/useTranslation'
import { knowledgeApi, type WikiPage } from '@/kcoder/knowledgeApi'

export function WikiPageHistory({
  page,
  libraryId,
  serverId,
  isCurrent,
  onClose,
  onRestored,
  canOrganize,
}: {
  page: WikiPage
  libraryId: string
  serverId: string
  isCurrent: () => boolean
  onClose: () => void
  onRestored: (page: WikiPage) => void
  canOrganize: boolean
}) {
  const { t } = useTranslation('knowledge')
  const [history, setHistory] = useState<Awaited<ReturnType<typeof knowledgeApi.history>> | null>(
    null
  )
  const [selected, setSelected] = useState<WikiPage | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const revision = useRef(0)
  const restoreKey = useRef(createRandomUuid())
  useEffect(() => {
    let active = true
    const lifetime = revision
    void knowledgeApi
      .history(serverId, libraryId, page.draft.pageId)
      .then(value => {
        if (active && isCurrent()) setHistory(value)
      })
      .catch(cause => {
        if (active && isCurrent()) setError(String(cause instanceof Error ? cause.message : cause))
      })
    return () => {
      active = false
      ++lifetime.current
    }
  }, [serverId, libraryId, page.draft.pageId, isCurrent])
  const restore = async () => {
    if (!selected) return
    setBusy(true)
    setError('')
    try {
      const result = await knowledgeApi.restorePage(
        serverId,
        libraryId,
        page,
        selected.revisionId,
        restoreKey.current
      )
      const restored = await knowledgeApi.page(
        serverId,
        libraryId,
        result.pageId,
        result.revisionId
      )
      if (isCurrent()) {
        onRestored(restored)
        onClose()
      }
    } catch (cause) {
      if (isCurrent()) setError(String(cause instanceof Error ? cause.message : cause))
    } finally {
      if (isCurrent()) setBusy(false)
    }
  }
  return (
    <ModalDialog
      title={t('history')}
      testId="wiki-page-history"
      pending={busy}
      wide
      onClose={onClose}
    >
      <p className="my-3 text-sm text-text-secondary">{t('restoreHint')}</p>
      {error && <WikiError error={error} />}
      <div className="grid min-h-0 gap-4 md:grid-cols-[12rem_1fr]">
        <div className="max-h-[45vh] space-y-1 overflow-y-auto">
          {history?.items.map(version => (
            <Button
              key={version.revisionId}
              size="sm"
              variant={selected?.revisionId === version.revisionId ? 'secondary' : 'ghost'}
              className="w-full justify-start"
              data-testid={`wiki-history-version-${version.sequence}`}
              disabled={busy}
              onClick={() => {
                const attempt = ++revision.current
                setSelected(null)
                restoreKey.current = createRandomUuid()
                setError('')
                void knowledgeApi
                  .page(serverId, libraryId, page.draft.pageId, version.revisionId)
                  .then(value => {
                    if (isCurrent() && attempt === revision.current) setSelected(value)
                  })
                  .catch(cause => {
                    if (isCurrent() && attempt === revision.current)
                      setError(String(cause instanceof Error ? cause.message : cause))
                  })
              }}
            >
              {t('versionNumber', { number: version.sequence })} ·{' '}
              {version.author === 'human' ? t('humanEdit') : t('modelEdit')}
            </Button>
          ))}
          {history?.nextBeforeSequence && (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                void knowledgeApi
                  .history(serverId, libraryId, page.draft.pageId, history.nextBeforeSequence!)
                  .then(value => {
                    if (isCurrent())
                      setHistory(current => ({
                        items: [...(current?.items ?? []), ...value.items],
                        nextBeforeSequence: value.nextBeforeSequence,
                      }))
                  })
                  .catch(cause => {
                    if (isCurrent())
                      setError(String(cause instanceof Error ? cause.message : cause))
                  })
              }}
            >
              {t('more')}
            </Button>
          )}
        </div>
        <div className="max-h-[45vh] min-h-48 overflow-y-auto rounded-lg border border-border/60 p-4">
          {selected ? (
            <AssistantMarkdown content={selected.draft.markdown} />
          ) : (
            <p className="text-sm text-text-muted">{t('selectVersion')}</p>
          )}
        </div>
      </div>
      <div className="mt-4 flex shrink-0 justify-end gap-2">
        <Button size="sm" variant="ghost" disabled={busy} onClick={onClose}>
          {t('cancel')}
        </Button>
        <Button
          size="sm"
          variant="outline"
          data-testid="wiki-history-restore"
          disabled={busy || !canOrganize || !selected || selected.revisionId === page.revisionId}
          onClick={() => void restore()}
        >
          {t('restoreVersion')}
        </Button>
      </div>
    </ModalDialog>
  )
}
