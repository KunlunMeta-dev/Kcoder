import { taskAgentBinding } from './taskAgentBinding'
import { useTranslation } from '@/hooks/useTranslation'
import { useWorkbench } from '@/features/workbench/useWorkbench'
import { Button } from '@/components/ui/button'
import type { RuntimeTaskAddress } from '@/types/api'

export function TaskAgentSummary({
  address,
  showExpertName = true,
}: {
  address: RuntimeTaskAddress
  showExpertName?: boolean
}) {
  const { t } = useTranslation('experts')
  const { startExpertTask } = useWorkbench()
  const binding = taskAgentBinding(address)
  if (!binding || (!showExpertName && binding.source !== 'channel')) return null
  return (
    <div className="mb-2 space-y-1 text-sm text-text-secondary" data-testid="task-agent-summary">
      {showExpertName && (
        <p>{t('task.selected', { name: binding.title, version: binding.definition.version })}</p>
      )}
      {binding.source === 'channel' && (
        <>
          <p>{t('task.channelReadOnly')}</p>
          {startExpertTask && address.workspacePath && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                startExpertTask({
                  deviceId: address.deviceId,
                  workspacePath: address.workspacePath!,
                  title: binding.title,
                  reference: binding.definition,
                })
              }
            >
              {t('task.localNew')}
            </Button>
          )}
        </>
      )}
    </div>
  )
}
