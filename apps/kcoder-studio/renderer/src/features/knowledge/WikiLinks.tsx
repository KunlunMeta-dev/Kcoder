import { useEffect, useState } from 'react'
import { ArrowUpRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { knowledgeApi, type WikiPage } from '@/kcoder/knowledgeApi'
import { WikiError } from './WikiError'

export function WikiLinks({
  serverId,
  libraryId,
  pageId,
  isCurrent,
  onPage,
}: {
  serverId: string
  libraryId: string
  pageId: string
  isCurrent: () => boolean
  onPage: (page: WikiPage) => void
}) {
  const { t } = useTranslation('knowledge')
  const [links, setLinks] = useState<{
    pageId: string
    value: Awaited<ReturnType<typeof knowledgeApi.links>>
  } | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let active = true
    void knowledgeApi
      .links(serverId, libraryId, pageId)
      .then(value => {
        if (active && isCurrent()) {
          setLinks({ pageId, value })
          setError('')
        }
      })
      .catch(cause => {
        if (active && isCurrent()) setError(String(cause instanceof Error ? cause.message : cause))
      })
    return () => {
      active = false
    }
  }, [serverId, libraryId, pageId, isCurrent])
  const current = links?.pageId === pageId ? links.value : null
  return (
    <>
      {error && <WikiError error={error} />}
      {current &&
        (['outgoing', 'incoming'] as const).map(
          direction =>
            current[direction].length > 0 && (
              <section key={direction} className="mt-6">
                <h3 className="mb-2 text-xs font-medium text-text-muted">
                  {t(direction === 'outgoing' ? 'relatedPages' : 'backlinks')}
                </h3>
                <div className="flex flex-wrap gap-2">
                  {current[direction].map(link => (
                    <Button
                      key={link.pageId}
                      data-testid={`wiki-link-${direction}-${link.pageId}`}
                      aria-label={link.title}
                      size="sm"
                      variant="ghost"
                      className="max-w-full"
                      disabled={busy}
                      onClick={() => {
                        setBusy(true)
                        void knowledgeApi
                          .page(serverId, libraryId, link.pageId)
                          .then(page => {
                            if (isCurrent()) onPage(page)
                          })
                          .catch(cause => {
                            if (isCurrent())
                              setError(String(cause instanceof Error ? cause.message : cause))
                          })
                          .finally(() => {
                            if (isCurrent()) setBusy(false)
                          })
                      }}
                    >
                      <ArrowUpRight className="size-3" />
                      <span className="truncate">{link.title}</span>
                    </Button>
                  ))}
                </div>
                {current[`${direction}Truncated`] && (
                  <p className="mt-2 text-xs text-text-muted">{t('linksLimited')}</p>
                )}
              </section>
            )
        )}
    </>
  )
}
