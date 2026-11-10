import { useSyncExternalStore } from 'react'
import { Monitor, LoaderCircle } from 'lucide-react'
import { computerUseStates } from '@/kcoder/computerUseState'
import { useTranslation } from '@/hooks/useTranslation'
import { Button } from '@/components/ui/button'
import { ComposerStatusItem } from '@/components/chat/composer/ComposerStatusRegion'
import { ComputerUseRecovery, type ComputerUseRecoveryFacts } from './ComputerUseRecovery'

export function ComputerUseStatus({
  serverId,
  taskId,
  onStop,
  diagnostics,
  recoveryAvailable = false,
  onRecover,
  presentation,
}: {
  serverId: string
  taskId: string
  onStop?: () => void
  diagnostics?: ComputerUseRecoveryFacts
  recoveryAvailable?: boolean
  onRecover?: (previousTurnId: string) => Promise<void>
  presentation?: 'detail' | 'embedded'
}) {
  const { t } = useTranslation('common')
  const snapshot = useSyncExternalStore(
    computerUseStates.subscribe,
    () => computerUseStates.get(serverId, taskId),
    () => null
  )
  const facts = diagnostics ?? snapshot?.diagnostic
  const canRecover = snapshot?.recoveryAvailable === true || recoveryAvailable
  if (!snapshot || (snapshot.state === 'stopped' && !facts)) return null
  const pending = snapshot.state === 'stopping'
  const active = snapshot.state === 'active'
  const attention =
    snapshot.state === 'unknown' ||
    snapshot.state === 'stop_failed' ||
    Boolean(facts?.failureCode) ||
    facts?.authorization === 'revoked' ||
    facts?.authorization === 'unknown' ||
    facts?.channel === 'unavailable' ||
    facts?.channel === 'unknown' ||
    facts?.cleanup === 'failed' ||
    facts?.cleanup === 'unknown'
  const stateSummary = t(`computerUse.state.${snapshot.state}`)
  const recoverySummary = facts
    ? [
        facts.failureCode
          ? t(`computerUse.recovery.failure.${facts.failureCode}`, {
              defaultValue: t('computerUse.recovery.cleanup.unknown'),
            })
          : null,
        facts.authorization !== 'valid'
          ? t(`computerUse.recovery.authorization.${facts.authorization}`)
          : null,
        facts.channel !== 'available' ? t(`computerUse.recovery.channel.${facts.channel}`) : null,
        facts.cleanup !== 'confirmed' && facts.cleanup !== 'pending'
          ? t(`computerUse.recovery.cleanup.${facts.cleanup}`)
          : null,
      ].filter(Boolean)
    : []
  const summary = [stateSummary, ...recoverySummary].join(' · ')
  const detail = (
    <div
      role="status"
      aria-live="polite"
      data-testid="computer-use-status"
      data-state={snapshot.state}
      className={
        presentation === 'embedded'
          ? 'flex min-w-0 items-start gap-2 text-sm text-text-secondary'
          : 'mb-2 flex min-w-0 items-center gap-2 rounded-lg bg-surface px-3 py-2 text-sm text-text-secondary'
      }
    >
      {pending ? (
        <LoaderCircle aria-hidden className="mt-0.5 size-4 shrink-0 animate-spin" />
      ) : (
        <Monitor aria-hidden className="mt-0.5 size-4 shrink-0" />
      )}
      {facts ? (
        <ComputerUseRecovery
          key={JSON.stringify([
            serverId,
            taskId,
            snapshot.turnId,
            snapshot.attemptId,
            facts.operationId,
          ])}
          turnId={snapshot.turnId}
          facts={facts}
          recoveryAvailable={canRecover}
          onRecover={onRecover}
        />
      ) : (
        <span className="min-w-0 flex-1 break-words">{stateSummary}</span>
      )}
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

  if (presentation === 'detail') return detail
  if (presentation === 'embedded') {
    return (
      <ComposerStatusItem
        id="computer-use"
        title={t('computerUse.title')}
        statusText={stateSummary}
        summary={summary}
        icon={Monitor}
        attention={attention}
        order={50}
      >
        {detail}
      </ComposerStatusItem>
    )
  }
  return detail
}
