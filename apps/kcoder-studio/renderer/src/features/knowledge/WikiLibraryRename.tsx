import { WikiError } from './WikiError'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { InputWithIcon } from '@/components/settings/settings-ui'
import { FileText } from 'lucide-react'
import { ModalDialog } from '@/components/ui/modal-dialog'
import { useTranslation } from '@/hooks/useTranslation'
import { knowledgeApi, type WikiLibrary } from '@/kcoder/knowledgeApi'

export function WikiLibraryRename({
  library,
  serverId,
  isCurrent,
  onClose,
  onSaved,
}: {
  library: WikiLibrary
  serverId: string
  isCurrent: () => boolean
  onClose: () => void
  onSaved: (library: WikiLibrary) => void
}) {
  const { t } = useTranslation('knowledge')
  const [name, setName] = useState(library.name)
  const [purpose, setPurpose] = useState(library.purpose)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const save = async () => {
    setBusy(true)
    setError('')
    try {
      const value = await knowledgeApi.updateLibrary(serverId, library, name.trim(), purpose)
      if (isCurrent()) {
        onSaved(value)
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
      title={t('renameWiki')}
      testId="wiki-rename-dialog"
      pending={busy}
      onClose={onClose}
    >
      <form
        className="mt-4 space-y-3"
        onSubmit={event => {
          event.preventDefault()
          if (!busy && name.trim()) void save()
        }}
      >
        <label htmlFor="wiki-name" className="block text-xs text-text-muted">
          {t('wikiName')}
        </label>
        <InputWithIcon
          icon={<FileText className="size-4" />}
          id="wiki-name"
          data-testid="wiki-rename-input"
          maxLength={120}
          value={name}
          disabled={busy}
          onChange={event => setName(event.target.value)}
        />
        <details
          className="rounded-lg border border-border/50 p-3"
          open={purpose ? true : undefined}
        >
          <summary className="cursor-pointer text-xs text-text-secondary">{t('purpose')}</summary>
          <textarea
            aria-label={t('purpose')}
            className="mt-3 min-h-24 w-full resize-y rounded-lg border border-border bg-background p-3 text-sm outline-none focus:ring-2 focus:ring-focus/30"
            value={purpose}
            maxLength={32000}
            disabled={busy}
            onChange={event => setPurpose(event.target.value)}
          />
          <p className="mt-2 text-xs text-text-muted">{t('purposeHint')}</p>
        </details>
        {error && <WikiError error={error} />}
        <div className="flex justify-end gap-2">
          <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button
            type="submit"
            size="sm"
            variant="outline"
            data-testid="wiki-rename-save"
            disabled={busy || !name.trim()}
          >
            {t('save')}
          </Button>
        </div>
      </form>
    </ModalDialog>
  )
}
