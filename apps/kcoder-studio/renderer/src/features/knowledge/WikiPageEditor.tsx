import { createRandomUuid } from '@/lib/random-id'
import { WikiError } from './WikiError'
import { useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { InputWithIcon } from '@/components/settings/settings-ui'
import { FileText } from 'lucide-react'
import { ModalDialog } from '@/components/ui/modal-dialog'
import { AssistantMarkdown } from '@/components/chat/AssistantMarkdown'
import { useTranslation } from '@/hooks/useTranslation'
import { knowledgeApi, type WikiPage } from '@/kcoder/knowledgeApi'
import { useWikiPageCommit } from './useWikiPageCommit'

export function WikiPageEditor({
  page,
  libraryId,
  serverId,
  isCurrent,
  onClose,
  onSaved,
}: {
  page: WikiPage
  libraryId: string
  serverId: string
  isCurrent: () => boolean
  onClose: () => void
  onSaved: (page: WikiPage) => void
}) {
  const { t } = useTranslation('knowledge')
  const [title, setTitle] = useState(page.draft.title)
  const [markdown, setMarkdown] = useState(page.draft.markdown)
  const [preview, setPreview] = useState(false)
  const { busy, receipt, error, commit, reload } = useWikiPageCommit({
    serverId,
    libraryId,
    isCurrent,
    onCommitted: onSaved,
    onClose,
  })
  const requestKey = useRef(createRandomUuid())
  const save = () =>
    commit(() =>
      knowledgeApi.editPage(serverId, libraryId, page, requestKey.current, title.trim(), markdown)
    )
  return (
    <ModalDialog
      title={t('editPage')}
      testId="wiki-page-editor"
      pending={busy}
      wide
      onClose={onClose}
    >
      <p className="my-3 text-sm text-text-secondary">{t('editHint')}</p>
      {error && <WikiError error={error} summary={receipt ? t('savedReadFailed') : undefined} />}
      <label className="mb-2 text-xs text-text-muted" htmlFor="wiki-edit-title">
        {t('pageTitle')}
      </label>
      <InputWithIcon
        icon={<FileText className="size-4" />}
        id="wiki-edit-title"
        data-testid="wiki-edit-title"
        value={title}
        maxLength={240}
        disabled={busy || !!receipt}
        onChange={event => {
          setTitle(event.target.value)
          requestKey.current = createRandomUuid()
        }}
      />
      <div className="my-3 flex items-center justify-between">
        <label className="text-xs text-text-muted" htmlFor="wiki-edit-body">
          {t('pageContent')}
        </label>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy || !!receipt}
          onClick={() => setPreview(value => !value)}
        >
          {preview ? t('editPage') : t('preview')}
        </Button>
      </div>
      {preview ? (
        <div className="min-h-48 max-h-[45vh] overflow-y-auto rounded-lg border border-border/60 p-4">
          <AssistantMarkdown content={markdown} />
        </div>
      ) : (
        <textarea
          id="wiki-edit-body"
          data-testid="wiki-edit-body"
          className="text-code min-h-64 max-h-[45vh] w-full resize-y rounded-lg border border-border bg-background p-4 text-text-primary outline-none focus:ring-2 focus:ring-focus/30"
          value={markdown}
          disabled={busy || !!receipt}
          onChange={event => {
            setMarkdown(event.target.value)
            requestKey.current = createRandomUuid()
          }}
        />
      )}
      <div className="mt-4 flex shrink-0 justify-end gap-2">
        <Button size="sm" variant="ghost" disabled={busy} onClick={onClose}>
          {t('cancel')}
        </Button>
        <Button
          size="sm"
          variant="outline"
          data-testid="wiki-edit-save"
          disabled={busy || !!receipt || !title.trim() || !markdown.trim()}
          onClick={() => void save()}
        >
          {t('save')}
        </Button>
        {receipt && error && (
          <Button
            size="sm"
            variant="outline"
            data-testid="wiki-edit-reload"
            disabled={busy}
            onClick={() => void reload()}
          >
            {t('reloadSavedPage')}
          </Button>
        )}
      </div>
    </ModalDialog>
  )
}
