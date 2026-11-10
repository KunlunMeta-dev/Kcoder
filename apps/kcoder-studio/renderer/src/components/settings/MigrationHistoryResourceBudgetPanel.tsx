import { MigrationResourceAttachmentPanel } from './MigrationResourceAttachmentPanel'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { fetchGatewayServers } from '@/kcoder/gatewayRpc'
import { captureAccountContextRevision } from '@/kcoder/accountContextEvents'
import { getRuntimeConfig } from '@/config/runtime'
import { migrationSourceRecoveryScope } from '@/kcoder/migrationSourceTransferScope'
import { usePluginTargetScope } from '@/kcoder/usePluginTargetScope'
import { createMigrationApi } from '@/kcoder/gatewayMigration'
import { createHistoryResourceController, HistoryBudgetLifetime } from '../../../../shared/migrationHistoryResourceController'
import { createResourceBudgetStorage } from '../../../../shared/migrationResourceBudgetStorage.mjs'
import { resourceBudgetDraft } from '../../../../shared/migrationResourceBudget'

type Props = { deviceId: string; workspacePath?: string; jobId: string; cancelled: boolean; isCurrent(): boolean }
export function MigrationHistoryResourceBudgetPanel(props: Props) {
  const { key: lifetimeKey, isCurrent: lifetimeCurrent } = usePluginTargetScope(props.deviceId, props.workspacePath)
  const external = useRef(props.isCurrent)
  useLayoutEffect(() => { external.current = props.isCurrent }, [props.isCurrent])
  const [selected, setSelected] = useState<{ scope: string; current(): boolean } | null>(null)
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
  return selected?.current() ? <><MigrationResourceAttachmentPanel {...props} kind="history" scope={selected.scope} isCurrent={selected.current} disabled={props.cancelled}/><OwnedHistoryBudgetPanel key={`${selected.scope}:${props.jobId}`} {...props} scope={selected.scope} isCurrent={selected.current}/></> : null
}
export function OwnedHistoryBudgetPanel(props: Props & { scope: string }) {
  const { t } = useTranslation('migrationResources')
  const lifetime = useMemo(() => new HistoryBudgetLifetime([props.deviceId, props.workspacePath, props.scope, props.jobId]), [props.deviceId, props.workspacePath, props.scope, props.jobId])
  useLayoutEffect(() => { lifetime.update(props.isCurrent, !props.cancelled); return () => lifetime.invalidate() }, [lifetime, props.isCurrent, props.cancelled])
  const controller = useMemo(() => {
    const api = createMigrationApi(props.deviceId, props.workspacePath)
    const current = lifetime.isCurrent
    return createHistoryResourceController({ api: { read: api.historyResourcesRead, increase: api.historyResourcesIncrease },
      storage: createResourceBudgetStorage({ storage: { getItem: key => window.localStorage.getItem(key) }, indexedDB: globalThis.indexedDB, isCurrent: current }),
      scope: props.scope, jobId: props.jobId, isCurrent: current, canIncrease: lifetime.canIncrease,
      createRequestId: () => crypto.randomUUID(),
    })
  }, [props.deviceId, props.workspacePath, props.scope, props.jobId, lifetime])
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
  useEffect(() => { controller.activate(); void controller.read(); return () => controller.dispose() }, [controller])
  const [bytes, setBytes] = useState(''), [files, setFiles] = useState(''), [word, setWord] = useState('')
  const [confirm, setConfirm] = useState<'increase' | 'resubmit' | 'archive' | null>(null)
  const view = state.view, observed = controller.observed(), draft = resourceBudgetDraft(view, bytes, files)
  const owned = observed?.ownerJobId === props.jobId && !props.cancelled
  const permitted = confirm === 'archive' ? !!state.expiredObservation && !!state.pending : confirm === 'resubmit' ? !!state.pending && state.checked && !state.receipt && !state.expiredObservation : owned && !!draft && view?.phase === 'active'
  const choose = (value: 'increase' | 'resubmit' | 'archive') => { setWord(''); setConfirm(value) }
  if (state.error === 'updateRequired' || !view && !state.error) return null
  return <details className="studio-card-spacing rounded-lg border border-border text-sm" open={state.pending || state.error ? true : undefined} data-testid="migration-history-resource-budget">
    <summary className="cursor-pointer font-medium">{t('title')}</summary>
    <div className="mt-3 space-y-3" aria-busy={state.busy}>
      <p className="text-xs text-text-secondary">{t('historyBoundary')}</p>
      {state.error && <p role="alert" className="text-destructive">{t(`errors.${state.error}`, { defaultValue: t('errors.readFailed') })}</p>}
      {view && <p>{t(`phase.${view.phase}`)}</p>}
      {observed?.ownerJobId && observed.ownerJobId !== props.jobId && <p className="break-all text-text-secondary">{t('parentOwner', { id: observed.ownerJobId })}</p>}
      {observed?.initialLimits && <p className="text-text-secondary">{t('initialFrozen', { bytes: observed.initialLimits.maxTotalBytes, files: observed.initialLimits.maxPayloadFiles })}</p>}
      {view?.phase === 'active' && <><p>{t('current', { revision: view.policyRevision })} · {t('limits', { bytes: view.limits.maxTotalBytes, files: view.limits.maxPayloadFiles })}</p><p>{t('usage', { bytes: view.usage.committedBytes, files: view.usage.committedFiles, reserved: view.usage.reservedBytes, reservedFiles: view.usage.reservedFiles })}</p></>}
      <Button size="sm" variant="outline" data-testid="migration-history-resource-read" disabled={state.busy} onClick={() => void controller.read()}>{t(state.pending ? 'checkOriginal' : 'refresh')}</Button>
      {state.pending && <><p className="break-all">{t('originalRequest')} · {state.pending.requestId}</p><p>{t('recovery')}</p>{!state.receipt && !state.expiredObservation && <Button size="sm" data-testid="migration-history-resource-resubmit" disabled={state.busy || !state.checked || state.recoveryBlocked || !owned} onClick={() => choose('resubmit')}>{t('resubmit')}</Button>}{state.expiredObservation && <Button size="sm" disabled={state.busy} onClick={() => choose('archive')}>{t('archiveExpired')}</Button>}</>}
      {state.receipt && <div role="status" data-testid="migration-history-resource-receipt"><p>{t('receipt', { previous: state.receipt.previousRevision, revision: state.receipt.revision })}</p><p>{t('resumeSeparately')}</p><Button variant="ghost" size="sm" onClick={() => void controller.acknowledge()} disabled={state.busy}>{t('acknowledge')}</Button></div>}
      {view?.phase === 'active' && !state.pending && owned && <>
        <label className="block">{t('bytes')}<input className="mt-1 min-h-11 w-full rounded-md border border-border bg-background px-3" data-testid="migration-history-resource-bytes" inputMode="numeric" maxLength={16} disabled={state.busy} value={bytes} onChange={event => setBytes(event.target.value)} placeholder={String(view.limits.maxTotalBytes)}/></label>
        <label className="block">{t('files')}<input className="mt-1 min-h-11 w-full rounded-md border border-border bg-background px-3" data-testid="migration-history-resource-files" inputMode="numeric" maxLength={8} disabled={state.busy} value={files} onChange={event => setFiles(event.target.value)} placeholder={String(view.limits.maxPayloadFiles)}/></label>
        <Button size="sm" data-testid="migration-history-resource-increase" disabled={!draft || state.busy || state.recoveryBlocked} onClick={() => choose('increase')}>{t('increase')}</Button>
      </>}
      {confirm && <div className="space-y-2"><label className="block">{t(confirm === 'archive' ? 'confirmArchive' : 'confirm')}<input className="mt-1 min-h-11 w-full rounded-md border border-border bg-background px-3" data-testid="migration-history-resource-word" value={word} maxLength={8} onChange={event => setWord(event.target.value)}/></label><Button size="sm" data-testid="migration-history-resource-confirm" disabled={state.busy || !permitted || !owned && confirm !== 'archive' || word !== (confirm === 'archive' ? 'ARCHIVE' : 'INCREASE')} onClick={() => { if (confirm === 'archive') void controller.archiveExpired(true); else if (confirm === 'resubmit') void controller.resubmit(true); else if (draft && view?.phase === 'active') void controller.increase(draft, view.policyRevision, true); setConfirm(null) }}>{t('confirmAction')}</Button><Button variant="ghost" size="sm" onClick={() => setConfirm(null)}>{t('dismiss')}</Button></div>}
    </div>
  </details>
}
