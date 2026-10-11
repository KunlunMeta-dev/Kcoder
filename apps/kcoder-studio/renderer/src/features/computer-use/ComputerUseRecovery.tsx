import { useRef, useState } from 'react'
import { LoaderCircle, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'

export type ComputerUseRecoveryFacts = import('@/kcoder/computerUseState').ComputerUseDiagnostic

const failureCodes = new Set([
  'operation_timeout',
  'connection_lost',
  'worker_exited',
  'worker_failed',
  'invalid_worker_response',
  'lease_revoked',
  'desktop_locked',
  'desktop_unavailable',
  'input_observer_unavailable',
  'recovery_process_exited',
  'result_too_large',
  'cleanup_failed',
  'recoverable_operation_error',
  'desktop_observation_required',
])
const tools = new Set([
  'Snapshot',
  'Screenshot',
  'DisplayInventory',
  'App',
  'Click',
  'Type',
  'Scroll',
  'Move',
  'Shortcut',
  'WaitFor',
])

export function ComputerUseRecovery({
  turnId,
  facts,
  recoveryAvailable,
  onRecover,
}: {
  turnId: string
  facts: ComputerUseRecoveryFacts
  recoveryAvailable: boolean
  onRecover?: (previousTurnId: string) => Promise<void>
}) {
  const { t } = useTranslation('common')
  const [pending, setPending] = useState(false)
  const [unknown, setUnknown] = useState(false)
  const [attempted, setAttempted] = useState(false)
  const inFlight = useRef(false)
  const recover = async () => {
    if (inFlight.current) return
    inFlight.current = true
    setPending(true)
    setAttempted(true)
    try {
      await onRecover?.(turnId)
    } catch {
      // A missing RPC receipt may have already created the replacement turn.
      // Only a fresh host observation may offer another recovery attempt.
      setUnknown(true)
    } finally {
      setPending(false)
    }
  }
  const canRecover =
    recoveryAvailable && facts.authorization === 'valid' && facts.channel !== 'available'
  const failureCode =
    facts.failureCode && failureCodes.has(facts.failureCode) ? facts.failureCode : null
  const operationId = facts.operationId?.match(/^[A-Za-z0-9_.:-]{1,128}$/)?.[0]
  return (
    <div className="min-w-0 flex-1" data-testid="computer-use-recovery">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-text-secondary">
        <span data-testid="computer-use-authorization">
          {t(`computerUse.recovery.authorization.${facts.authorization}`)}
        </span>
        <span data-testid="computer-use-channel">
          {t(`computerUse.recovery.channel.${facts.channel}`)}
        </span>
        <span data-testid="computer-use-cleanup">
          {t(`computerUse.recovery.cleanup.${facts.cleanup}`)}
        </span>
      </div>
      {failureCode && (
        <p className="mt-1 text-sm" data-testid="computer-use-failure">
          {t(`computerUse.recovery.failure.${failureCode}`)}
        </p>
      )}
      {(operationId || (facts.tool && tools.has(facts.tool))) && (
        <details className="mt-1 text-sm">
          <summary className="cursor-pointer">{t('computerUse.recovery.diagnostics')}</summary>
          <dl className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-text-secondary">
            {operationId && (
              <div>
                <dt className="inline">{t('computerUse.recovery.operation')} </dt>
                <dd className="inline font-mono">{operationId}</dd>
              </div>
            )}
            {facts.tool && tools.has(facts.tool) && (
              <div>
                <dt className="inline">{t('computerUse.recovery.tool')} </dt>
                <dd className="inline font-mono">{facts.tool}</dd>
              </div>
            )}
            {Number.isSafeInteger(facts.hostPid) && Number.isSafeInteger(facts.workerPid) && (
              <div>
                <dt className="inline">{t('computerUse.recovery.processes')} </dt>
                <dd className="inline font-mono">
                  {facts.hostPid} / {facts.workerPid}
                </dd>
              </div>
            )}
            {Number.isSafeInteger(facts.elapsedMs) && facts.elapsedMs! >= 0 && (
              <div>
                <dt className="inline">{t('computerUse.recovery.elapsed')} </dt>
                <dd className="inline">
                  {t('computerUse.recovery.milliseconds', { value: facts.elapsedMs })}
                </dd>
              </div>
            )}
          </dl>
        </details>
      )}
      {canRecover && onRecover && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="mt-1 max-md:min-h-11 max-md:min-w-11"
          data-testid="computer-use-recover"
          disabled={pending || unknown || attempted}
          onClick={() => void recover()}
        >
          {pending ? <LoaderCircle className="animate-spin" /> : <RotateCcw />}
          {t(pending ? 'computerUse.recovery.recovering' : 'computerUse.recovery.recover')}
        </Button>
      )}
      {(pending || unknown) && (
        <p role={unknown ? 'alert' : 'status'} className="mt-1 text-sm">
          {t(unknown ? 'computerUse.recovery.receiptUnknown' : 'computerUse.recovery.observeFirst')}
        </p>
      )}
    </div>
  )
}
