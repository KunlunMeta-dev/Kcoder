import { useContext } from 'react'
import { WorkbenchContext } from '@/features/workbench/useWorkbench'
import { useTranslation } from '@/hooks/useTranslation'
import { NativeRemoteOperationPanel } from './NativeRemoteOperationPanel'

/** The normal conversation selection owns the target; the directory never picks one for a write. */
export function NativeRemoteOperationWorkspace() {
  const workbench = useContext(WorkbenchContext)
  const { t } = useTranslation('remoteCapabilities')
  const address = workbench?.state.currentRuntimeTask
  if (!address?.deviceId || !address.workspacePath)
    return (
      <p className="border-t border-border pt-5 text-sm text-text-secondary">
        {t('operation.selectConversation')}
      </p>
    )
  return (
    <div className="min-w-0 space-y-2" data-testid="remote-operation-workspace">
      <p className="break-all text-sm text-text-muted">
        {t('operation.selectedTarget')}: {address.deviceId} · {address.workspacePath}
      </p>
      <NativeRemoteOperationPanel
        target={{ serverId: address.deviceId, workspacePath: address.workspacePath }}
      />
    </div>
  )
}
