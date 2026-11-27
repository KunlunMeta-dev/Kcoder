import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { ModalDialog } from '@/components/ui/modal-dialog'
import { useTranslation } from '@/hooks/useTranslation'
import type { WorkflowStorageCapacity } from './WorkflowVerification'
export function WorkflowVerificationStorage({
  capacity,
  disabled = false,
  isCurrent,
  onChangeStorage,
}: {
  capacity: WorkflowStorageCapacity
  disabled?: boolean
  isCurrent: () => boolean
  onChangeStorage: (operation: 'migrate' | 'rollback') => Promise<void>
}) {
  const { t } = useTranslation('common')
  const [operation, setOperation] = useState<'migrate' | 'rollback' | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const confirm = async () => {
    if (!operation || disabled || pending || !isCurrent()) return
    setPending(true)
    setError('')
    try {
      await onChangeStorage(operation)
      if (isCurrent()) setOperation(null)
    } catch (failure) {
      if (isCurrent()) setError(String(failure))
    } finally {
      if (isCurrent()) setPending(false)
    }
  }
  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="max-md:min-h-11"
        disabled={disabled || pending}
        data-testid="workflow-storage-action"
        onClick={() => {
          setError('')
          setOperation(capacity.backend === 'legacy_json' ? 'migrate' : 'rollback')
        }}
      >
        {t(
          capacity.backend === 'legacy_json'
            ? 'workflowVerification.migrate'
            : 'workflowVerification.rollback'
        )}
      </Button>
      {operation && (
        <ModalDialog
          title={t(
            operation === 'migrate'
              ? 'workflowVerification.migrate'
              : 'workflowVerification.rollback'
          )}
          testId="workflow-storage-dialog"
          pending={pending}
          onClose={() => setOperation(null)}
          closeLabel={t('workflowVerification.cancel')}
        >
          <p className="my-4 text-sm">
            {t(
              operation === 'migrate'
                ? 'workflowVerification.migrationConfirmation'
                : 'workflowVerification.rollbackConfirmation'
            )}
          </p>
          {error && (
            <p role="alert" className="my-3">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              disabled={pending}
              onClick={() => setOperation(null)}
            >
              {t('workflowVerification.cancel')}
            </Button>
            <Button
              type="button"
              disabled={disabled || pending || !isCurrent()}
              data-testid="workflow-storage-confirm"
              onClick={() => void confirm()}
            >
              {t('workflowVerification.confirmStorage')}
            </Button>
          </div>
        </ModalDialog>
      )}
    </>
  )
}
