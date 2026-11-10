import { SettingsSelect } from '@/components/settings/SettingsSelect'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { createMigrationApi } from '@/kcoder/gatewayMigration'
import type {
  MigrationApiKeySource,
  MigrationJobReadResult,
} from '../../../../shared/generated/contracts'

export function MigrationCredentialPanel({
  deviceId,
  workspacePath,
  job,
  itemId,
  isCurrent,
  onUpdated,
  onBusy,
  onClose,
}: {
  deviceId: string
  workspacePath?: string
  job: MigrationJobReadResult
  itemId: string
  isCurrent: () => boolean
  onUpdated: (value: MigrationJobReadResult) => void
  onBusy: (value: boolean) => void
  onClose: () => void
}) {
  const { t } = useTranslation('migration')
  const api = useMemo(() => createMigrationApi(deviceId, workspacePath), [deviceId, workspacePath])
  const [current, setCurrent] = useState(job),
    [source, setSource] = useState<MigrationApiKeySource>(
      job.source === 'codex' ? 'environment' : 'configuration'
    ),
    [consent, setConsent] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  const mounted = useRef(true),
    running = useRef(false)
  const plan = current.credentialPlans?.filter(plan => plan.itemId === itemId).at(-1)
  const [lastAction, setLastAction] = useState<'apply' | 'undo' | null>(null)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  useEffect(() => {
    onBusy(busy)
    return () => onBusy(false)
  }, [busy, onBusy])
  const valid = () => mounted.current && isCurrent()
  const accept = (value: MigrationJobReadResult) => {
    if (!valid()) return
    setCurrent(previous => (previous.job.sequence > value.job.sequence ? previous : value))
    onUpdated(value)
  }
  const perform = async (action: () => Promise<MigrationJobReadResult>) => {
    if (running.current || !valid()) return
    running.current = true
    setBusy(true)
    setError('')
    try {
      const next = await action()
      accept(next)
    } catch (cause) {
      if (valid()) {
        setError(
          (cause instanceof Error ? cause.message : '').match(/\bmigration_[a-z_]+\b/)?.[0] ??
            'error'
        )
        try {
          accept(await api.read(current.job.jobId))
        } catch {
          /* A read never authorizes a credential replay. */
        }
      }
    } finally {
      running.current = false
      if (valid()) setBusy(false)
    }
  }
  const operate = (undo: boolean) => {
    if (!plan) return
    setLastAction(undo ? 'undo' : 'apply')
    void perform(() =>
      undo
        ? api.undoCredential({
            jobId: current.job.jobId,
            planId: plan.planId,
            expectedSequence: current.job.sequence,
          })
        : api.applyCredential({
            jobId: current.job.jobId,
            planId: plan.planId,
            expectedSequence: current.job.sequence,
          })
    )
  }
  return (
    <section className="mt-3 space-y-3 rounded-lg bg-surface p-3" aria-busy={busy}>
      <div className="flex items-center justify-between gap-3">
        <h4 className="text-sm font-medium">{t('credential.title')}</h4>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onClose}>
          {t('close')}
        </Button>
      </div>
      <p className="text-xs leading-5 text-text-secondary">{t('credential.boundary')}</p>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {t(`errors.${error}`, { defaultValue: t('error') })}
        </p>
      )}
      {!plan && (
        <>
          <label className="block text-sm">
            <span className="mb-1 block text-text-secondary">{t('credential.source')}</span>
            <SettingsSelect
              aria-label={t('credential.source')}
              disabled={busy}
              value={source}
              onChange={event => setSource(event.target.value as MigrationApiKeySource)}
              className="h-10 w-full rounded-lg border border-border bg-background px-3 max-md:min-h-11"
            >
              {job.source === 'claude-code' && (
                <option value="configuration">{t('credential.configuration')}</option>
              )}
              <option value="environment">{t('credential.environment')}</option>
            </SettingsSelect>
          </label>
          <label className="flex min-h-11 items-start gap-2 text-sm">
            <input
              type="checkbox"
              disabled={busy}
              checked={consent}
              onChange={event => setConsent(event.target.checked)}
              className="mt-1"
            />
            {t('credential.consent')}
          </label>
          <Button
            disabled={busy || !consent}
            onClick={() =>
              void perform(() =>
                api.planCredential({
                  jobId: current.job.jobId,
                  itemId,
                  expectedSequence: current.job.sequence,
                  source,
                  consentApiKey: consent,
                })
              )
            }
          >
            {t('credential.preview')}
          </Button>
        </>
      )}
      {plan && (
        <>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
            <dt className="text-text-secondary">{t('credential.destination')}</dt>
            <dd className="min-w-0 break-words">{plan.targetName}</dd>
            <dt className="text-text-secondary">{t('endpoint')}</dt>
            <dd className="min-w-0 break-all">{plan.endpoint}</dd>
            <dt className="text-text-secondary">{t('credential.storage')}</dt>
            <dd>{t(`credential.${plan.storage}`)}</dd>
            <dt className="text-text-secondary">{t('credential.source_field')}</dt>
            <dd className="min-w-0 break-words">{plan.sourceField}</dd>
          </dl>
          <p className="text-xs leading-5 text-text-secondary">
            {t(plan.storage === 'file' ? 'credential.file_notice' : 'credential.keyring_notice')}
          </p>
          <p role="status" className="text-sm">
            {t(`credential.phases.${plan.phase}`)}
          </p>
          {plan.errorCode && (
            <p role="alert" className="text-sm text-destructive">
              {t(`errors.${plan.errorCode}`, { defaultValue: t('error') })}
            </p>
          )}
          {plan.grouped && <p className="text-sm text-text-secondary">{t('credential.grouped')}</p>}
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void perform(() => api.read(current.job.jobId))}
            >
              {t('refresh')}
            </Button>
            {!plan.grouped && plan.phase !== 'published' && plan.phase !== 'undone' && (
              <Button
                size="sm"
                disabled={busy}
                onClick={() =>
                  operate(
                    lastAction === 'undo' || plan.phase === 'undoing' || plan.undoRequested === true
                  )
                }
              >
                {t(plan.phase === 'ready' ? 'credential.apply' : 'retry')}
              </Button>
            )}
            {!plan.grouped &&
              ['published', 'unknown', 'undoing', 'conflict'].includes(plan.phase) && (
                <Button size="sm" variant="outline" disabled={busy} onClick={() => operate(true)}>
                  {t('credential.undo')}
                </Button>
              )}
          </div>
        </>
      )}
      {busy && (
        <p role="status" className="text-xs text-text-secondary">
          {t('busy')}
        </p>
      )}
    </section>
  )
}
