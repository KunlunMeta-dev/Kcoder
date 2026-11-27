import { MigrationResourceAttachmentPanel } from './MigrationResourceAttachmentPanel'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { fetchGatewayServers } from '@/kcoder/gatewayRpc'
import { captureAccountContextRevision } from '@/kcoder/accountContextEvents'
import { getRuntimeConfig } from '@/config/runtime'
import { migrationSourceRecoveryScope } from '@/kcoder/migrationSourceTransferScope'
import { usePluginTargetScope } from '@/kcoder/usePluginTargetScope'
import { useMigrationResourceBudget } from '@/kcoder/useMigrationResourceBudget'
import { resourceBudgetDraft, resourceBudgetMutable } from '../../../../shared/migrationResourceBudget'

type Props = { deviceId: string; workspacePath?: string; jobId: string; planId?: string | null; status: string; unresolvedActions?: number; isCurrent(): boolean }
/** Resolve this exact target before reading its metadata or opening a durable request selector. */
export function MigrationResourceBudgetPanel(props: Props) {
  const { key: lifetimeKey, isCurrent: lifetimeCurrent } = usePluginTargetScope(props.deviceId, props.workspacePath)
  const external = useRef(props.isCurrent)
  useLayoutEffect(() => { external.current = props.isCurrent }, [props.isCurrent])
  const [selected, setSelected] = useState<{ scope: string; current(): boolean } | null>(null)
  const [completedProof, setCompletedProof] = useState<string | null>(null)
  const proofKey = JSON.stringify([selected?.scope, props.deviceId, props.workspacePath, props.jobId, props.planId])
  const onObservation = useCallback((view: import('../../../../shared/generated/contracts').MigrationHistoryResourceAttachmentResult) => { setCompletedProof(view.jobId === props.jobId && view.ownerJobId === props.jobId && view.currentPlanId === props.planId && ['attached', 'tracked'].includes(view.phase) ? proofKey : null) }, [props.jobId, props.planId, proofKey])
  useEffect(() => {
    const account = captureAccountContextRevision(), mount = getRuntimeConfig().appBasePath
    let active = true
    const current = () => active && lifetimeCurrent() && external.current() && account(props.deviceId) && mount === getRuntimeConfig().appBasePath
    void fetchGatewayServers().then(targets => {
      const target = targets.find(value => value.id === props.deviceId)
      if (current()) setSelected(target ? { scope: migrationSourceRecoveryScope({ ...target, workspacePath: props.workspacePath ?? target.workspacePath }), current } : null)
    }).catch(() => { if (current()) setSelected(null) })
    return () => { active = false }
  }, [props.deviceId, props.workspacePath, lifetimeKey, lifetimeCurrent])
  if (!selected?.current()) return null
  return <><MigrationResourceAttachmentPanel {...props} kind="batch" onObservation={onObservation} scope={selected.scope} isCurrent={selected.current} disabled={['cancelled', 'rolled_back', 'rollback_failed'].includes(props.status)}/><OwnedBudgetPanel key={`${selected.scope}:${props.jobId}:${props.planId ?? ''}`} {...props} scope={selected.scope} isCurrent={selected.current} completedBudgetVerified={completedProof === proofKey}/></>
}
export function OwnedBudgetPanel(props: Props & { scope: string; completedBudgetVerified?: boolean }) {
  const { t } = useTranslation('migrationResources')
  const mutable = resourceBudgetMutable(props.status, props.unresolvedActions) || props.status === 'completed' && props.completedBudgetVerified === true
  const { controller, state } = useMigrationResourceBudget(props.deviceId, props.workspacePath, props.scope, props.jobId, props.planId, props.isCurrent, mutable)
  const [bytes, setBytes] = useState(''), [files, setFiles] = useState(''), [confirmation, setConfirmation] = useState<{ kind: 'increase' | 'resubmit' | 'archive'; bytes: string; files: string; revision: number; requestId: string | null } | null>(null), [word, setWord] = useState('')
  const view = state.view, receipt = state.receipt
  const draft = resourceBudgetDraft(view, bytes, files)
  const validConfirmation = confirmation?.kind === 'archive' ? !!state.expiredObservation && !!state.pending && state.pending.requestId === confirmation.requestId
    : confirmation?.kind === 'resubmit' ? !!state.pending && state.pending.requestId === confirmation.requestId && state.checked && !receipt && !state.expiredObservation
    : !!confirmation && view?.phase === 'active' && mutable && confirmation.revision === view.policyRevision && confirmation.bytes === bytes && confirmation.files === files && !!draft
  const change = (kind: 'increase' | 'resubmit' | 'archive') => { setWord(''); setConfirmation({ kind, bytes, files, revision: view?.phase === 'active' ? view.policyRevision : -1, requestId: state.pending?.requestId ?? null }) }
  if (state.error === 'updateRequired' || !view && !state.error || view?.phase === 'not_applicable') return null
  return <details open={state.error || state.pending ? true : undefined} className="studio-card-spacing rounded-lg border border-border text-sm" data-testid="migration-resource-budget">
    <summary className="cursor-pointer font-medium">{t('title')}</summary>
    <div className="mt-3 space-y-3" aria-busy={state.busy}>
      <p className="text-xs leading-5 text-text-secondary">{t('boundary')}</p>
      {state.recoveryBlocked && <p className="text-destructive">{t('errors.recoveryUnavailable')}</p>}
      {state.error && <p role="alert" className="text-destructive">{t(`errors.${state.error}`, { defaultValue: t('errors.readFailed') })}</p>}
      {view && <p>{t(`phase.${view.phase}`)}</p>}
      {view?.phase === 'planned' && <p>{t('limits', { bytes: view.limits.maxTotalBytes, files: view.limits.maxPayloadFiles })}</p>}
      {view?.phase === 'active' && <>
        <p data-testid="migration-resource-current">{t('current', { revision: view.policyRevision })} · {t('limits', { bytes: view.limits.maxTotalBytes, files: view.limits.maxPayloadFiles })}</p>
        <p className="text-text-secondary">{t('usage', { bytes: view.usage.committedBytes, reserved: view.usage.reservedBytes, files: view.usage.committedFiles, reservedFiles: view.usage.reservedFiles })}</p>
        <p className="text-xs text-text-secondary">{t('margins', { bytes: view.limits.minFreeBytes, files: view.limits.minFreeFileNodes })}</p>
      </>}
      <Button size="sm" variant="outline" data-testid="migration-resource-read" disabled={state.busy} onClick={() => void controller.read()}>{t(state.pending ? 'checkOriginal' : 'refresh')}</Button>
      {state.pending && <div className="space-y-2 rounded-md bg-surface p-3" data-testid="migration-resource-pending">
        <p className="break-all">{t('originalRequest')} · {state.pending.requestId}</p>
        <p>{t('limits', { bytes: state.pending.limits.maxTotalBytes, files: state.pending.limits.maxPayloadFiles })}</p>
        <p className="text-xs text-text-secondary">{t('recovery')}</p>
        {state.checked && !receipt && <p>{t('unknown')}</p>}
        {state.expiredObservation && <><p data-testid="migration-resource-expired">{t('expired', { previous: state.pending.expectedPolicyRevision, revision: state.expiredObservation.view.policyRevision })}</p><p className="text-xs text-text-secondary">{t('archiveBoundary')}</p><Button data-testid="migration-resource-archive-expired" size="sm" variant="outline" disabled={state.busy || state.recoveryBlocked} onClick={() => change('archive')}>{t('archiveExpired')}</Button></>}
        {!receipt && !state.expiredObservation && <Button size="sm" variant="outline" data-testid="migration-resource-resubmit" disabled={state.busy || !state.checked || state.recoveryBlocked || state.pending.planId !== props.planId} onClick={() => change('resubmit')}>{t('resubmit')}</Button>}
      </div>}
      {receipt && <div role="status" data-testid="migration-resource-receipt">
        <p>{t('receipt', { previous: receipt.previousRevision, revision: receipt.revision })}</p>
        <p className="break-all text-xs text-text-secondary">{receipt.requestId}</p><p>{t('limits', { bytes: receipt.limits.maxTotalBytes, files: receipt.limits.maxPayloadFiles })}</p>
        <p className="text-xs text-text-secondary">{t('resumeSeparately')}</p>
        {state.pending && <Button size="sm" variant="ghost" disabled={state.busy} onClick={() => { void controller.acknowledge(); setConfirmation(null) }}>{t('acknowledge')}</Button>}
      </div>}
      {view?.phase === 'active' && !state.pending && <>
        {!mutable && <p className="text-xs text-text-secondary">{t('terminal')}</p>}
        <label className="block">{t('bytes')}<input className="mt-1 min-h-11 w-full rounded-md border border-border bg-background px-3" data-testid="migration-resource-bytes" inputMode="numeric" maxLength={16} value={bytes} placeholder={String(view.limits.maxTotalBytes)} disabled={!mutable || state.busy} onChange={event => setBytes(event.target.value)}/></label>
        <label className="block">{t('files')}<input className="mt-1 min-h-11 w-full rounded-md border border-border bg-background px-3" data-testid="migration-resource-files" inputMode="numeric" maxLength={8} value={files} placeholder={String(view.limits.maxPayloadFiles)} disabled={!mutable || state.busy} onChange={event => setFiles(event.target.value)}/></label>
        <Button size="sm" data-testid="migration-resource-increase" disabled={!draft || !mutable || !props.planId || state.busy || state.recoveryBlocked} onClick={() => change('increase')}>{t('increase')}</Button>
      </>}
      {confirmation && <div className="space-y-2">
        <label className="block">{t(confirmation.kind === 'archive' ? 'confirmArchive' : 'confirm')}<input className="mt-1 min-h-11 w-full rounded-md border border-border bg-background px-3" data-testid="migration-resource-confirm-input" value={word} maxLength={8} onChange={event => setWord(event.target.value)}/></label>
        <Button data-testid="migration-resource-confirm" disabled={state.busy || word !== (confirmation.kind === 'archive' ? 'ARCHIVE' : 'INCREASE') || !validConfirmation} onClick={() => { const action = confirmation.kind === 'archive' ? controller.archiveExpired(true) : confirmation.kind === 'resubmit' ? controller.resubmit(true) : draft && view?.phase === 'active' ? controller.increase(draft, view.policyRevision, true) : null; if (action) void action; setConfirmation(null); setWord('') }}>{t(confirmation.kind === 'archive' ? 'archiveExpired' : 'confirmAction')}</Button>
        <Button variant="ghost" disabled={state.busy} onClick={() => setConfirmation(null)}>{t('dismiss')}</Button>
      </div>}
      {!state.pending && state.historyRows?.filter(row => row.kind === 'expired').map(row => row.kind === 'expired' && <details key={row.requestId} data-testid="migration-resource-expired-history"><summary>{t('expiredHistory')} · {row.requestId}</summary><p>{t('expired', { previous: row.intent.expectedPolicyRevision, revision: row.observation.view.policyRevision })}</p><p>{t('limits', { bytes: row.intent.limits.maxTotalBytes, files: row.intent.limits.maxPayloadFiles })}</p><p className="text-xs text-text-secondary">{t('archiveBoundary')}</p></details>)}
      {!state.pending && state.history.length > 0 && <details><summary>{t('history')}</summary>{state.history.map(id => <Button key={id} variant="ghost" size="sm" disabled={state.busy} onClick={() => void controller.read(id)}>{id}</Button>)}</details>}
    </div>
  </details>
}
