import { useTranslation } from '@/hooks/useTranslation'

import type { PermissionApprovalPresentation } from './permissionApprovalPresentation'

export function PermissionApprovalContent({ value }: { value: PermissionApprovalPresentation }) {
  const { t } = useTranslation('common')
  return (
    <div
      className="mb-2 space-y-2 text-sm text-text-primary"
      data-testid="permission-approval-content"
    >
      <div className="font-medium">{t(`approvalUi.${value.kind}`)}</div>
      {value.subject ? (
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-surface p-2 text-xs">
          {value.subject}
        </pre>
      ) : (
        <p>{t('approvalUi.currentTask')}</p>
      )}
      {value.input && (
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-surface p-2 text-xs">
          {value.input}
        </pre>
      )}
      {value.reason && (
        <details className="text-text-secondary">
          <summary className="cursor-pointer rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
            {t('approvalUi.originalDetails')}
          </summary>
          <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words text-xs">
            {value.reason}
          </pre>
        </details>
      )}
    </div>
  )
}
