import { useState } from 'react'
import { FolderOpen } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ModalDialog } from '@/components/ui/modal-dialog'
import { InputWithIcon } from '@/components/settings/settings-ui'
import { useTranslation } from '@/hooks/useTranslation'

/** Choosing a directory prepares the normal conversation; it never starts nodes. */
export function WorkflowWorkspaceLocation({
  onClose,
  onChoose,
}: {
  onClose: () => void
  onChoose: (path: string) => void
}) {
  const { t } = useTranslation('common')
  const [path, setPath] = useState('')
  return (
    <ModalDialog
      title={t('workflowCanvas.workspace')}
      testId="workflow-location-dialog"
      closeLabel={t('workflowCanvas.back')}
      onClose={onClose}
    >
      <form
        className="mt-4 space-y-4"
        onSubmit={event => {
          event.preventDefault()
          if (path.trim()) onChoose(path.trim())
        }}
      >
        <p className="text-sm leading-relaxed text-text-secondary">
          {t('workflowCanvas.workspaceRequired')}
        </p>
        <InputWithIcon
          icon={<FolderOpen />}
          data-testid="workflow-location-input"
          aria-label={t('workflowCanvas.workspace')}
          value={path}
          onChange={event => setPath(event.target.value)}
          autoFocus
        />
        <div className="flex justify-end">
          <Button data-testid="workflow-location-confirm" type="submit" disabled={!path.trim()}>
            {t('workflowCanvas.continueInChat')}
          </Button>
        </div>
      </form>
    </ModalDialog>
  )
}
