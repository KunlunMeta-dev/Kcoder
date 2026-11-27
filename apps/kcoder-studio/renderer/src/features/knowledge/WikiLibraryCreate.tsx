import { useRef, useState } from 'react'
import { BookOpen } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ModalDialog } from '@/components/ui/modal-dialog'
import { InputWithIcon } from '@/components/settings/settings-ui'
import { useTranslation } from '@/hooks/useTranslation'
import { knowledgeApi } from '@/kcoder/knowledgeApi'
import { createRandomUuid } from '@/lib/random-id'
import { WikiError } from './WikiError'

export function WikiLibraryCreate({
  serverId,
  isCurrent,
  onClose,
  onCreated,
}: {
  serverId: string
  isCurrent: () => boolean
  onClose: () => void
  onCreated: () => void
}) {
  const { t } = useTranslation('knowledge')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const pending = useRef(false)
  const request = useRef<{ name: string; key: string; libraryId?: string } | null>(null)
  const create = async () => {
    const title = name.trim()
    if (!title || pending.current || !isCurrent()) return
    pending.current = true
    setBusy(true)
    setError('')
    if (request.current?.name !== title) request.current = { name: title, key: createRandomUuid() }
    const attempt = request.current
    try {
      if (!attempt.libraryId) {
        const library = await knowledgeApi.create(serverId, attempt.key, title)
        attempt.libraryId = library.id
      }
      if (!isCurrent()) return
      await knowledgeApi.selectLibrary(serverId, attempt.libraryId)
      if (isCurrent()) onCreated()
    } catch (cause) {
      if (isCurrent()) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      pending.current = false
      if (isCurrent()) setBusy(false)
    }
  }
  return (
    <ModalDialog title={t('create')} testId="wiki-create-dialog" pending={busy} onClose={onClose}>
      <form
        className="mt-4 space-y-3"
        onSubmit={event => {
          event.preventDefault()
          void create()
        }}
      >
        <label htmlFor="wiki-create-name" className="block text-xs text-text-muted">
          {t('wikiName')}
        </label>
        <InputWithIcon
          icon={<BookOpen className="size-4" />}
          id="wiki-create-name"
          data-testid="wiki-create-input"
          autoFocus
          maxLength={120}
          value={name}
          placeholder={t('createNamePlaceholder')}
          disabled={busy}
          onChange={event => setName(event.target.value)}
        />
        {error && <WikiError error={error} />}
        <div className="flex justify-end gap-2">
          <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button
            type="submit"
            size="sm"
            variant="outline"
            data-testid="wiki-create-confirm"
            disabled={busy || !name.trim()}
          >
            {t('create')}
          </Button>
        </div>
      </form>
    </ModalDialog>
  )
}
