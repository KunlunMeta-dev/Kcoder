import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { ModalDialog } from '@/components/ui/modal-dialog'
import { useTranslation } from '@/hooks/useTranslation'
import type { WikiLibrary } from '@/kcoder/knowledgeApi'

export type WikiLibraryLifecycleAction = 'archive' | 'trash' | 'purge'

export function WikiLibraryLifecycleDialog({
  action,
  library,
  pending,
  onClose,
  onConfirm,
}: {
  action: WikiLibraryLifecycleAction
  library: WikiLibrary
  pending: boolean
  onClose: () => void
  onConfirm: () => void
}) {
  const { t } = useTranslation('knowledge')
  const [typedName, setTypedName] = useState('')
  const title = t(`${action}ConfirmTitle`)
  const description =
    action === 'purge' && library.purgePending
      ? t('purgeConfirmPendingDescription', { name: library.name })
      : t(`${action}ConfirmDescription`, { name: library.name })
  const canConfirm = action !== 'purge' || typedName.trim() === library.name

  return (
    <ModalDialog
      title={title}
      testId={`wiki-${action}-confirm`}
      pending={pending}
      closeLabel={t('cancel')}
      onClose={onClose}
    >
      <div className="mt-4 space-y-4 text-sm leading-relaxed text-text-secondary">
        <p>{description}</p>
        {action === 'purge' && (
          <label className="block space-y-2">
            <span>{t('purgeConfirmTypeName')}</span>
            <input
              type="text"
              autoComplete="off"
              value={typedName}
              onChange={event => setTypedName(event.target.value)}
              placeholder={library.name}
              data-testid="wiki-purge-confirm-name"
              className="min-h-11 w-full rounded-lg border border-border bg-background px-3 text-base text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            />
          </label>
        )}
      </div>
      <div className="mt-6 flex flex-wrap justify-end gap-2">
        <Button variant="outline" disabled={pending} onClick={onClose}>
          {t('cancel')}
        </Button>
        <Button
          variant={action === 'purge' || action === 'trash' ? 'destructive' : 'primary'}
          disabled={pending || !canConfirm}
          data-testid={`wiki-${action}-confirm-action`}
          onClick={onConfirm}
        >
          {t(`${action}ConfirmAction`)}
        </Button>
      </div>
    </ModalDialog>
  )
}
