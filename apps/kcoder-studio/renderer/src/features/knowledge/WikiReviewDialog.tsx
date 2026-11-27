import { WikiError } from './WikiError'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { ModalDialog } from '@/components/ui/modal-dialog'
import { X } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { knowledgeApi, type WikiJob } from '@/kcoder/knowledgeApi'

export function WikiReviewDialog({
  serverId,
  libraryId,
  jobId,
  isCurrent,
  onClose,
  onResolved,
}: {
  serverId: string
  libraryId: string
  jobId: string
  isCurrent: () => boolean
  onClose: () => void
  onResolved: (job: WikiJob) => void
}) {
  const { t } = useTranslation('knowledge')
  const [review, setReview] = useState<Awaited<ReturnType<typeof knowledgeApi.review>> | null>(null)
  const [pageId, setPageId] = useState('')
  const [offset, setOffset] = useState(0)
  const [excerpt, setExcerpt] = useState<
    | (Awaited<ReturnType<typeof knowledgeApi.reviewPage>> & { pageId: string; offset: number })
    | null
  >(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let alive = true
    void knowledgeApi
      .review(serverId, libraryId, jobId)
      .then(value => {
        if (alive && isCurrent()) {
          setReview(value)
          setPageId(value.pages[0]?.pageId ?? '')
        }
      })
      .catch(cause => {
        if (alive && isCurrent()) setError(String(cause instanceof Error ? cause.message : cause))
      })
    return () => {
      alive = false
    }
  }, [serverId, libraryId, jobId, isCurrent])
  useEffect(() => {
    if (!review || !pageId) return
    let alive = true
    void knowledgeApi
      .reviewPage(serverId, libraryId, jobId, review.token, pageId, offset)
      .then(value => {
        if (alive && isCurrent()) setExcerpt({ ...value, pageId, offset })
      })
      .catch(cause => {
        if (alive && isCurrent()) setError(String(cause instanceof Error ? cause.message : cause))
      })
    return () => {
      alive = false
    }
  }, [serverId, libraryId, jobId, review, pageId, offset, isCurrent])
  const visibleExcerpt = excerpt?.pageId === pageId && excerpt.offset === offset ? excerpt : null
  const decide = async (decision: 'accept' | 'reject') => {
    if (!review) return
    setBusy(true)
    setError('')
    try {
      const job = await knowledgeApi.decideReview(
        serverId,
        libraryId,
        jobId,
        review.token,
        decision
      )
      if (isCurrent()) {
        onResolved(job)
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
      title={t('reviewTitle')}
      testId="wiki-review-dialog"
      pending={busy}
      wide
      onClose={onClose}
    >
      <div className="my-3 flex shrink-0 items-start gap-2">
        <p className="flex-1 text-sm text-text-secondary">{t('reviewHint')}</p>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          aria-label={t('closeReview')}
          onClick={onClose}
        >
          <X />
        </Button>
      </div>
      {error && <WikiError error={error} />}
      {!review ? (
        <p className="text-sm text-text-muted">{t('loading')}</p>
      ) : (
        <>
          {review.notes.length > 0 && (
            <ul className="max-h-32 list-disc overflow-y-auto pl-5 text-sm text-text-secondary">
              {review.notes.map((note, index) => (
                <li key={index}>{note}</li>
              ))}
            </ul>
          )}
          <div className="flex shrink-0 flex-wrap gap-2">
            {review.pages.map(page => (
              <Button
                key={page.pageId}
                size="sm"
                variant={pageId === page.pageId ? 'secondary' : 'ghost'}
                disabled={busy}
                onClick={() => {
                  setPageId(page.pageId)
                  setOffset(0)
                  setExcerpt(null)
                }}
              >
                {page.title}
              </Button>
            ))}
          </div>
          {!visibleExcerpt ? (
            <p className="text-sm text-text-muted">{t('loading')}</p>
          ) : (
            <div className="grid min-h-0 flex-1 gap-4 overflow-y-auto md:grid-cols-2">
              <section>
                <h3 className="mb-2 text-xs font-medium text-text-muted">{t('currentVersion')}</h3>
                <pre className="whitespace-pre-wrap break-words rounded-lg border border-border/60 bg-surface/40 p-3 text-sm leading-relaxed">
                  {visibleExcerpt.current ?? t('newPage')}
                </pre>
              </section>
              <section>
                <h3 className="mb-2 text-xs font-medium text-text-muted">{t('proposedVersion')}</h3>
                <pre
                  data-testid="wiki-review-proposed"
                  className="whitespace-pre-wrap break-words rounded-lg border border-border/60 p-3 text-sm leading-relaxed"
                >
                  {visibleExcerpt.proposed}
                </pre>
              </section>
            </div>
          )}
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-2">
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="ghost"
                disabled={busy || offset === 0}
                onClick={() => {
                  setOffset(value => Math.max(0, value - 16384))
                  setExcerpt(null)
                }}
              >
                {t('previousPart')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy || !visibleExcerpt?.nextOffset}
                onClick={() => {
                  setOffset(visibleExcerpt!.nextOffset!)
                  setExcerpt(null)
                }}
              >
                {t('nextPart')}
              </Button>
            </div>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="ghost"
                data-testid="wiki-review-reject"
                disabled={busy}
                onClick={() => void decide('reject')}
              >
                {t('rejectChanges')}
              </Button>
              <Button
                size="sm"
                variant="outline"
                data-testid="wiki-review-accept"
                disabled={busy || !visibleExcerpt}
                onClick={() => void decide('accept')}
              >
                {t('applyChanges')}
              </Button>
            </div>
          </div>
        </>
      )}
    </ModalDialog>
  )
}
