import { useState } from 'react'
import { Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ModalDialog } from '@/components/ui/modal-dialog'
import { useTranslation } from '@/hooks/useTranslation'
import { workflowApi, type WorkflowDefinition } from './workflowApi'

export function WorkflowDeleteButton({
  serverId,
  definition,
  disabled,
  isCurrent,
  onDeleted,
}: {
  serverId: string
  definition: WorkflowDefinition
  disabled: boolean
  isCurrent: () => boolean
  onDeleted: () => void
}) {
  const { t } = useTranslation('common')
  const [revision, setRevision] = useState<number | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const remove = async () => {
    if (revision == null) return
    setPending(true)
    setError(null)
    try {
      await workflowApi.delete(serverId, definition.id, revision)
      if (isCurrent()) onDeleted()
    } catch (failure) {
      if (isCurrent()) setError(String(failure))
    } finally {
      if (isCurrent()) setPending(false)
    }
  }
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        disabled={disabled || pending}
        data-testid="workflow-delete"
        onClick={() => {
          setError(null)
          setRevision(definition.revision)
        }}
      >
        <Trash2 />
        {t('workflowCanvas.deleteWorkflow')}
      </Button>
      {revision != null && (
        <ModalDialog
          title={t('workflowCanvas.deleteWorkflow')}
          testId="workflow-delete-dialog"
          pending={pending}
          onClose={() => setRevision(null)}
        >
          <p className="my-4 text-sm break-words">
            {t('workflowCanvas.deleteConfirmation', { title: definition.title })}
          </p>
          {error && (
            <p role="alert" className="my-3 text-sm break-all text-destructive">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              disabled={pending}
              data-testid="workflow-delete-cancel"
              onClick={() => setRevision(null)}
            >
              {t('workflowCanvas.cancelDelete')}
            </Button>
            <Button
              disabled={pending}
              data-testid="workflow-delete-confirm"
              onClick={() => void remove()}
            >
              {t('workflowCanvas.deleteWorkflow')}
            </Button>
          </div>
        </ModalDialog>
      )}
    </>
  )
}
