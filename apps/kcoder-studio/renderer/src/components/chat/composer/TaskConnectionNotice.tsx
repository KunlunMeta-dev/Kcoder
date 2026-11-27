import { useSyncExternalStore } from 'react'
import { AlertTriangle, LoaderCircle } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { taskConnectionStatus } from '@/kcoder/taskConnectionStatus'
import { cn } from '@/lib/utils'
import type { RuntimeTaskAddress } from '@/types/api'

export function TaskConnectionNotice({ address }: { address: RuntimeTaskAddress }) {
  const { t } = useTranslation('chat')
  const status = useSyncExternalStore(
    taskConnectionStatus.subscribe,
    () => taskConnectionStatus.read(address.deviceId, address.taskId)
  )
  if (!status) return null
  const failed = status === 'failed'
  const Icon = failed ? AlertTriangle : LoaderCircle
  return (
    <div
      className={cn(
        'mb-2 flex items-center gap-2 px-2 py-1 text-sm',
        failed ? 'text-destructive' : 'text-text-secondary'
      )}
      data-testid="task-connection-notice"
      role={failed ? 'alert' : 'status'}
    >
      <Icon className={cn('size-4 shrink-0', !failed && 'motion-safe:animate-spin')} aria-hidden="true" />
      {t(`connection_status.${status}`)}
    </div>
  )
}
