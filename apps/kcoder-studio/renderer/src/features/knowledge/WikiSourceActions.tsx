import { wikiFileAccept, wikiFileIssue } from './wikiFileCapabilities'
import { createRandomUuid } from '@/lib/random-id'
import { WikiError } from './WikiError'
import { useRef, useState } from 'react'
import { Play, RefreshCw, Trash2, ArchiveRestore } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { knowledgeApi, type WikiSource } from '@/kcoder/knowledgeApi'

export function WikiSourceActions({
  serverId,
  libraryId,
  source,
  isCurrent,
  onChanged,
  onClose,
}: {
  serverId: string
  libraryId: string
  source: WikiSource
  isCurrent: () => boolean
  onChanged: (source?: WikiSource) => void
  onClose: () => void
}) {
  const { t, i18n } = useTranslation('knowledge')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const picker = useRef<HTMLInputElement>(null)
  const requestKey = useRef(createRandomUuid())
  const run = async (action: () => Promise<void>) => {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await action()
    } catch (cause) {
      if (isCurrent()) setError(String(cause instanceof Error ? cause.message : cause))
    } finally {
      if (isCurrent()) setBusy(false)
    }
  }
  return (
    <div className="mt-3 space-y-2 border-t border-border/60 pt-3">
      <input
        ref={picker}
        type="file"
        accept={wikiFileAccept()}
        className="hidden"
        aria-label={t('replaceSource')}
        onChange={event => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (!file) return
          const issue = wikiFileIssue(file)
          if (issue) {
            setError(t(issue, { name: file.name }))
            return
          }
          void run(async () => {
            const updated = await knowledgeApi.updateSourceFile(
              serverId,
              libraryId,
              source,
              file,
              isCurrent
            )
            if (isCurrent()) {
              onChanged(updated)
              setNotice(t('sourceUpdated'))
            }
          })
        }}
      />
      <div className="flex flex-wrap gap-2">
        {!source.removed && (
          <>
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await knowledgeApi.startJob(
                    serverId,
                    libraryId,
                    source,
                    i18n.language,
                    requestKey.current
                  )
                  if (isCurrent()) {
                    requestKey.current = createRandomUuid()
                    onChanged()
                    setNotice(t('organizationStarted'))
                  }
                })
              }
            >
              <Play />
              {t('reorganize')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => picker.current?.click()}
            >
              <RefreshCw />
              {t('replaceSource')}
            </Button>
          </>
        )}
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          data-testid="wiki-source-remove"
          onClick={() =>
            void run(async () => {
              await knowledgeApi.removeSource(serverId, libraryId, source, !source.removed)
              if (isCurrent()) {
                onChanged()
                onClose()
              }
            })
          }
        >
          {source.removed ? <ArchiveRestore /> : <Trash2 />}
          {t(source.removed ? 'restoreSource' : 'removeSource')}
        </Button>
      </div>
      <p className="text-xs text-text-muted">
        {t(source.removed ? 'removedSourceHint' : 'sourceActionsHint')}
      </p>
      {notice && (
        <p role="status" className="text-xs text-text-secondary">
          {notice}
        </p>
      )}
      {error && <WikiError error={error} />}
    </div>
  )
}
