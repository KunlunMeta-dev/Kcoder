import { useSyncExternalStore } from 'react'
import { Monitor, LoaderCircle } from 'lucide-react'
import { computerUseStates } from '@/kcoder/computerUseState'
import { useTranslation } from '@/hooks/useTranslation'
import { Button } from '@/components/ui/button'

export function ComputerUseStatus({
  serverId,
  taskId,
  onStop,
}: {
  serverId: string
  taskId: string
  onStop?: () => void
}) {
  const { t } = useTranslation('common')
  const snapshot = useSyncExternalStore(
    computerUseStates.subscribe,
    () => computerUseStates.get(serverId, taskId),
    () => null
  )
  if (!snapshot || snapshot.state === 'stopped') return null
  const pending = snapshot.state === 'stopping'
  const active = snapshot.state === 'active'
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="computer-use-status"
      data-state={snapshot.state}
      className="mb-2 flex min-w-0 items-center gap-2 rounded-lg bg-surface px-3 py-2 text-sm text-text-secondary"
    >
      {pending ? (
        <LoaderCircle aria-hidden className="size-4 shrink-0 animate-spin" />
      ) : (
        <Monitor aria-hidden className="size-4 shrink-0" />
      )}
      <span className="min-w-0 flex-1 break-words">{t(`computerUse.state.${snapshot.state}`)}</span>
      {active && onStop && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="max-md:min-h-11 max-md:min-w-11"
          onClick={onStop}
        >
          {t('computerUse.stop')}
        </Button>
      )}
    </div>
  )
}
