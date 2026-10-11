import { useEffect, useState } from 'react'
import { ChevronDown, Image } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { knowledgeApi, type WikiImageImport } from '@/kcoder/knowledgeApi'
import { startSnapshotPolling } from '@/lib/snapshotPolling'
import { WikiError } from './WikiError'

/** Recover target-owned extraction independently of uploaded staging files and browser lifetime. */
export function WikiImageImports({
  serverId,
  libraryId,
  isCurrent,
  canOrganize,
  refreshSignal,
  onChanged,
}: {
  serverId: string
  libraryId: string
  isCurrent: () => boolean
  canOrganize: boolean
  refreshSignal: number
  onChanged: () => void
}) {
  const { t, i18n } = useTranslation('knowledge')
  const [items, setItems] = useState<WikiImageImport[]>([])
  const [refresh, setRefresh] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [disconnected, setDisconnected] = useState(false)
  useEffect(
    () =>
      startSnapshotPolling({
        isCurrent,
        retryDelayMs: 2000,
        poll: async isLive => {
          const result = await knowledgeApi.imageImports(serverId, libraryId, isLive)
          if (!isLive()) return false
          setItems(result.items)
          setDisconnected(false)
          return result.items.some(item => item.status === 'running') ? 1000 : 15000
        },
        onError: () => setDisconnected(true),
      }),
    [serverId, libraryId, isCurrent, refreshSignal, refresh]
  )
  const control = async (item: WikiImageImport, cancel: boolean) => {
    if (!cancel) setBusy(true)
    setError('')
    try {
      if (cancel) await knowledgeApi.cancelImageImport(serverId, libraryId, item.id)
      else {
        const source = await knowledgeApi.resumeImageImport(serverId, libraryId, item)
        if (!isCurrent()) return
        await knowledgeApi.startJob(serverId, libraryId, source, i18n.language)
      }
      if (isCurrent()) onChanged()
    } catch (cause) {
      if (isCurrent()) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (isCurrent()) {
        if (!cancel) setBusy(false)
        setRefresh(value => value + 1)
      }
    }
  }
  if (!items.length) return null
  return (
    <div className="space-y-2" aria-live="polite">
      {items.map(item => (
        <details
          key={item.id}
          data-testid={`wiki-image-import-${item.id}`}
          data-state={item.status}
          className="group/import rounded-xl bg-surface/30 text-sm"
        >
          <summary className="flex min-h-16 cursor-pointer list-none items-center gap-4 rounded-xl px-4 py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus [&::-webkit-details-marker]:hidden">
            <span
              aria-hidden="true"
              className={`flex size-10 shrink-0 items-center justify-center rounded-xl ${item.status === 'failed' || item.status === 'cancelled' ? 'bg-destructive/5 text-destructive' : 'bg-accent-surface text-focus'}`}
            >
              <Image className="size-5" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium text-text-primary">{item.title}</span>
              <span className="mt-1 block text-sm text-text-muted">
                {t(`imageImport.phase.${item.phase}`)} · {t(`imageImport.status.${item.status}`)}
              </span>
            </span>
            <ChevronDown
              aria-hidden="true"
              className="size-4 shrink-0 text-text-muted transition-transform group-open/import:rotate-180"
            />
          </summary>
          <div className="space-y-2 px-4 pb-4 text-xs text-text-muted">
            <p data-testid="wiki-image-import-usage">
              {t('imageImport.usage', {
                calls: item.reservedCalls,
                input: item.inputTokens ?? '—',
                output: item.outputTokens ?? '—',
                unknown: item.unknownUsageCalls,
              })}
            </p>
            {item.model && <p>{item.model}</p>}
            {item.status === 'running' && (
              <p>{t('imageImport.received', { bytes: item.textBytes })}</p>
            )}
            {disconnected && <p>{t('statusRetrying')}</p>}
            {item.errorCode && (
              <p>{t(`imageImport.errors.${item.errorCode}`, { defaultValue: t('jobError') })}</p>
            )}
            <div className="flex flex-wrap gap-2">
              {['accepted', 'failed'].includes(item.status) && (
                <Button
                  data-testid="wiki-image-import-resume"
                  size="sm"
                  variant="outline"
                  className="max-md:min-h-11"
                  disabled={busy || !canOrganize || disconnected}
                  onClick={() => void control(item, false)}
                >
                  {t(
                    item.phase === 'interpretation' && item.reservedCalls >= item.callLimit
                      ? 'imageImport.retryVision'
                      : 'imageImport.resume',
                    { stage: t(`imageImport.phase.${item.phase}`) }
                  )}
                </Button>
              )}
              {['accepted', 'running', 'failed'].includes(item.status) && (
                <Button
                  data-testid="wiki-image-import-cancel"
                  size="sm"
                  variant="ghost"
                  className="max-md:min-h-11"
                  disabled={disconnected}
                  onClick={() => void control(item, true)}
                >
                  {t('cancelJob')}
                </Button>
              )}
            </div>
          </div>
        </details>
      ))}
      {error && <WikiError error={error} />}
    </div>
  )
}
