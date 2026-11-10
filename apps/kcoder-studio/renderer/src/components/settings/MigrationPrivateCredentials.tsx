import { useEffect, useLayoutEffect, useState, useSyncExternalStore } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { migrationSourceRecoveryScope } from '@/kcoder/migrationSourceTransferScope'
import { StudioPrivateCredentialController } from '@/kcoder/migrationPrivateCredentialController'
import type { GatewayServer } from '@/kcoder/gatewayRpc'
import type { MigrationJobReadResult, MigrationSourceCredentialCandidate, MigrationSourceCredentialSelection,
  MigrationSourceCredentialSide, MigrationSourceCredentialWatermark } from '../../../../shared/generated/contracts'

type Props = { target: GatewayServer; targets: GatewayServer[]; job: MigrationJobReadResult; isCurrent(): boolean;
  onPrepared(job: MigrationJobReadResult): void; onBusy(value: boolean): void }
type Confirmation = { kind: 'run' | 'prepare' | 'restore' | 'cancel' | 'resume'; signature: string;
  side?: MigrationSourceCredentialSide; control?: MigrationSourceCredentialWatermark }
export function MigrationPrivateCredentials(props: Props) {
  return <OwnedPrivateCredentials key={`${migrationSourceRecoveryScope(props.target)}:${props.job.job.jobId}:${props.job.batch?.planId}:${props.job.job.sequence}`} {...props}/>
}
class PrivateCredentialsViewOwner {
  private callbacks: Pick<Props, 'isCurrent' | 'onPrepared'>;
  readonly controller: StudioPrivateCredentialController;
  constructor(props: Pick<Props, 'target' | 'job' | 'isCurrent' | 'onPrepared'>) {
    this.callbacks = props;
    this.controller = new StudioPrivateCredentialController({ target: props.target, job: props.job,
      isCurrent: () => this.callbacks.isCurrent(), onPrepared: value => this.callbacks.onPrepared(value) });
  }
  update(callbacks: Pick<Props, 'isCurrent' | 'onPrepared'>) { this.callbacks = callbacks; }
}
function OwnedPrivateCredentials({ target, targets, job, isCurrent, onPrepared, onBusy }: Props) {
  const { t } = useTranslation('migrationPrivate');
  const [owner] = useState(() => new PrivateCredentialsViewOwner({ target, job, isCurrent, onPrepared }));
  useLayoutEffect(() => { owner.update({ isCurrent, onPrepared }); }, [owner, isCurrent, onPrepared]);
  const controller = owner.controller;
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot, controller.snapshot)
  useEffect(() => { controller.activate(); return () => controller.dispose() }, [controller])
  const working = state.busy || state.controlBusy
  useEffect(() => { onBusy(working); return () => onBusy(false) }, [working, onBusy])
  const [expanded, setExpanded] = useState(false), [devicePage, setDevicePage] = useState(0), [preparationPage, setPreparationPage] = useState(0)
  const [apiKeys, setApiKeys] = useState(false), [mcpPrivateFields, setMcpPrivateFields] = useState(false)
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null), [word, setWord] = useState('')
  const signature = (kind: Confirmation['kind'], side?: MigrationSourceCredentialSide) => kind === 'restore' ? JSON.stringify(state.preparation) : kind === 'cancel'
    ? JSON.stringify([state.input?.locator, state.input?.source, side])
    : JSON.stringify([state.selected, state.device, state.selections, state.included, apiKeys, mcpPrivateFields, state.input?.locator,
      side ? state.observed[side] : null])
  const confirm = (kind: Confirmation['kind'], side?: MigrationSourceCredentialSide) => {
    setWord(''); setConfirmation({ kind, side, control: side ? state.observed[side] : undefined, signature: signature(kind, side) })
  }
  const keyword = confirmation?.kind === 'run' ? 'TRANSFER' : confirmation?.kind === 'restore' ? 'PREPARE' : confirmation?.kind.toUpperCase() ?? ''
  const confirmationBusy = confirmation?.kind === 'cancel' ? state.controlBusy : working
  const submit = () => {
    if (!confirmation || confirmationBusy || word !== keyword || confirmation.signature !== signature(confirmation.kind, confirmation.side)) return
    if (confirmation.kind === 'run') void controller.run({ apiKeys, mcpPrivateFields })
    else if (confirmation.kind === 'prepare') void controller.prepare(true)
    else if (confirmation.kind === 'restore') void controller.restorePreparation(true)
    else if (confirmation.side) void controller.control(confirmation.side, confirmation.kind, confirmation.control)
    setConfirmation(null); setWord('')
  }
  const pages = (index: number, next: boolean, turn: (index: number) => void) => <div className="flex justify-between gap-2">
    <Button size="sm" variant="ghost" disabled={working || index === 0} onClick={() => turn(index - 1)}>{t('previous')}</Button>
    <Button size="sm" variant="ghost" disabled={working || !next} onClick={() => turn(index + 1)}>{t('next')}</Button></div>
  const canRun = !!state.device && Object.values(state.selections).length > 0
    && Object.values(state.selections).every(row => row.kind === 'provider' ? apiKeys : mcpPrivateFields)
  return <section data-testid="migration-private-credentials" className="studio-card-spacing space-y-3 rounded-lg border border-border text-sm">
    <Button size="sm" variant="ghost" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{t('title')} · {t('details')}</Button>
    {expanded && <div className="space-y-3">
      <p className="leading-6 text-text-secondary">{t('boundary')}</p>
      {state.error && <div role="alert"><p className="text-destructive">{t(state.error.includes('update_required') ? 'update_required' : 'request_failed')}</p><details className="text-xs text-text-secondary"><summary>{t('details')}</summary>{state.error}</details></div>}
      <Button size="sm" variant="outline" disabled={working} onClick={() => void controller.load()}>{t('load_sources')}</Button>
      {state.page && <>
        {!state.page.items.length && <p className="text-text-secondary">{t('no_sources')}</p>}
        <div className="flex flex-wrap gap-2">{state.page.items.map(row => <Button key={`${row.requestId}:${row.entryId}`} size="sm" variant={state.selected?.requestId === row.requestId && state.selected.entryId === row.entryId ? 'secondary' : 'outline'} disabled={working}
          onClick={() => { controller.select(row); setApiKeys(false); setMcpPrivateFields(false); setConfirmation(null) }}>{row.source} · {row.entryId} · {t(row.projectScoped ? 'project_source' : 'user_source')}</Button>)}</div>
        {pages(state.pageIndex, state.page.nextPage != null, index => void controller.load(index))}
      </>}
      {state.selected && <>
        <Button data-testid="migration-private-preparation-read" size="sm" variant="outline" disabled={state.controlBusy} onClick={() => { setPreparationPage(0); void controller.preparationRead() }}>{t('preparation_read')}</Button>
        <p className="text-text-secondary">{t('choose_device')}</p>
        <div className="flex flex-wrap gap-2">{targets.slice(devicePage * 10, devicePage * 10 + 10).map(value => <Button size="sm" key={value.id} disabled={working}
          variant={state.device?.id === value.id ? 'secondary' : 'outline'} onClick={() => controller.device(value)}>{value.label || value.id}</Button>)}</div>
        {pages(devicePage, (devicePage + 1) * 10 < targets.length, setDevicePage)}
        <Button size="sm" variant="outline" disabled={working} onClick={() => void controller.candidates()}>{t('load_candidates')}</Button>
      </>}
      {state.preparation && <div data-testid="migration-private-preparation" className="studio-card-spacing space-y-2 rounded-lg border border-border">
        <p role="status" data-testid="migration-private-preparation-status">{t(`preparation_${state.preparation.phase}`)}</p>
        <p className="text-text-secondary">{t('preparation_boundary')}</p>
        {state.preparation.offerIds && <details><summary>{t('preparation_offers', { count: state.preparation.offerIds.length })}</summary>
          <p className="text-text-secondary">{t('preparation_sequence', { sequence: state.preparation.expectedSequence })}</p>
          <p>{t('preparation_keys')} · {t(state.preparation.consent?.apiKeys ? 'consent_yes' : 'consent_no')}</p>
          <p>{t('preparation_mcp')} · {t(state.preparation.consent?.mcpPrivateFields ? 'consent_yes' : 'consent_no')}</p>
          <ul data-testid="migration-private-preparation-offers" className="space-y-1 break-all">{state.preparation.offerIds.slice(preparationPage * 10, preparationPage * 10 + 10).map(id => <li key={id}>{id}</li>)}</ul>
          {pages(preparationPage, (preparationPage + 1) * 10 < state.preparation.offerIds.length, setPreparationPage)}
        </details>}
        {state.preparation.phase === 'pending' && <Button data-testid="migration-private-preparation-restore" size="sm" disabled={working} onClick={() => confirm('restore')}>{t('preparation_restore')}</Button>}
      </div>}
      {state.candidates && <>
        {!state.candidates.items.length && <p className="text-text-secondary">{t('no_candidates')}</p>}
        {state.candidates.items.map(row => <Candidate key={row.itemId} row={row} value={state.selections[row.itemId]} busy={working} controller={controller}/>)}
        {pages(state.candidateIndex, state.candidates.nextPage != null, index => void controller.candidates(index))}
        <Check checked={apiKeys} disabled={working} onChange={() => setApiKeys(value => !value)}>{t('consent_keys')}</Check>
        <Check checked={mcpPrivateFields} disabled={working} onChange={() => setMcpPrivateFields(value => !value)}>{t('consent_mcp')}</Check>
        <Button size="sm" disabled={working || !canRun} onClick={() => confirm('run')}>{t('transfer')}</Button>
      </>}
      {!!state.records.length && <div className="space-y-2"><p className="text-text-secondary">{t('recovery_boundary')}</p>
        {state.records.map(record => <Button key={record.locator.offerId} size="sm" variant="outline" disabled={state.controlBusy} onClick={() => void controller.read(record)}>{t('check_offer')} · {record.locator.offerId}</Button>)}
        {pages(state.recordIndex, state.nextRecordPage !== null, index => void controller.records(index))}</div>}
      {state.input && <div className="space-y-3 rounded-lg bg-muted/40 p-3">
        <p className="text-text-secondary">{t(state.result ? `phase_${state.result.phase}` : 'unknown')}</p>
        <Button size="sm" variant="outline" disabled={state.controlBusy} onClick={() => void controller.read()}>{t('check_offer')}</Button>
        <Button size="sm" variant="outline" disabled={state.controlBusy || !state.device} onClick={() => void controller.sourceRead()}>{t('check_source')}</Button>
        <p className="text-text-secondary">{t('cancel_boundary')}</p>
        {(['source', 'target'] as const).map(side => <div key={side} className="flex flex-wrap items-center gap-2">
          <span>{t(`side_${side}`)} · {t(state.workers[side] == null ? 'worker_unknown' : state.workers[side] ? 'worker_running' : 'worker_stopped')}</span>
          <Button size="sm" variant="outline" disabled={state.controlBusy} onClick={() => confirm('cancel', side)}>{t('cancel')}</Button>
          <Button size="sm" variant="outline" disabled={working || !state.observed[side] || state.workers[side] !== false} onClick={() => confirm('resume', side)}>{t('resume')}</Button>
        </div>)}
        {state.result?.received && !state.result.keyReleased && !state.result.targetControl?.cancelled && state.result.targetWorkerRunning === false && <Check checked={state.included.some(row => row.locator.offerId === state.input?.locator.offerId)}
          disabled={working || state.included.some(row => row.locator.requestId !== state.input?.locator.requestId)} onChange={() => controller.include(!state.included.some(row => row.locator.offerId === state.input?.locator.offerId))}>{t('include_offer')}</Check>}
      </div>}
      {!!state.included.length && <div className="space-y-2"><p>{t('included', { count: state.included.length })}</p>
        {state.included.map(row => <div key={row.locator.offerId} className="flex flex-wrap items-center gap-2"><span className="break-all text-text-secondary">{row.locator.offerId}</span><Button size="sm" variant="ghost" disabled={working} onClick={() => controller.exclude(row.locator.offerId)}>{t('remove')}</Button></div>)}
        <p className="text-text-secondary">{t('same_request')}</p><Button size="sm" disabled={working} onClick={() => confirm('prepare')}>{t('prepare')}</Button></div>}
      {state.prepareUnknown && <p role="status" className="text-text-secondary">{t('prepare_unknown')}</p>}
      <Button size="sm" variant="outline" disabled={working} onClick={() => void controller.readBatch()}>{t('read_batch')}</Button>
      {confirmation && <div className="studio-card-spacing space-y-2 rounded-lg border border-border">
        <label className="block"><span>{t('confirmation', { keyword })}</span><input aria-label={t('confirmation', { keyword })} className="mt-2 w-full rounded-md border border-border bg-background px-3 py-2" value={word} onChange={event => setWord(event.target.value)}/></label>
        <div className="flex gap-2"><Button size="sm" disabled={confirmationBusy || word !== keyword || confirmation.signature !== signature(confirmation.kind, confirmation.side)} onClick={submit}>{t('confirm')}</Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirmation(null)}>{t('dismiss')}</Button></div>
      </div>}
    </div>}
  </section>
}
function Check({ checked, disabled, onChange, children }: { checked: boolean; disabled: boolean; onChange(): void; children: React.ReactNode }) {
  return <label className="flex items-start gap-2"><input type="checkbox" className="mt-1" checked={checked} disabled={disabled} onChange={onChange}/><span>{children}</span></label>
}
function Candidate({ row, value, busy, controller }: { row: MigrationSourceCredentialCandidate; value?: MigrationSourceCredentialSelection; busy: boolean; controller: StudioPrivateCredentialController }) {
  const { t } = useTranslation('migrationPrivate'), [page, setPage] = useState(0)
  const disabled = busy || row.issueCode != null || row.targets?.length !== 1
  const count = row.kind === 'provider' ? row.selectors.length : row.fields.length
  return <div className="studio-card-spacing space-y-2 rounded-lg border border-border">
    <p>{row.sourceName ?? t('source_unknown')}</p><p className="text-text-secondary">{t('exact_target')} · {row.targets?.[0]?.targetName ?? t('target_unavailable')}</p>
    {row.issueCode && <p className="text-text-secondary">{t('candidate_unavailable')}</p>}
    {row.kind === 'provider' ? row.selectors.slice(page * 10, page * 10 + 10).map((selector, at) => <Check key={page * 10 + at} disabled={disabled}
      checked={value?.kind === 'provider' && JSON.stringify(value.selector) === JSON.stringify(selector)} onChange={() => controller.choose(row.itemId,
        value?.kind === 'provider' && JSON.stringify(value.selector) === JSON.stringify(selector) ? null : { kind: 'provider', selectorIndex: page * 10 + at })}>
      {selector.kind === 'environment' ? `${t('environment')} · ${selector.variable}` : t('configuration_key')}</Check>)
      : row.fields.slice(page * 10, page * 10 + 10).map((field, at) => {
        const index = page * 10 + at, selected = value?.kind === 'mcp' ? row.fields.flatMap((item, position) => value.fields.some(chosen => chosen.kind === item.kind && chosen.name === item.name) ? [position] : []) : []
        const next = selected.includes(index) ? selected.filter(item => item !== index) : [...selected, index]
        return <Check key={`${field.kind}:${field.name}`} disabled={disabled} checked={selected.includes(index)} onChange={() => controller.choose(row.itemId, next.length ? { kind: 'mcp', fieldIndices: next } : null)}>{t(`field_${field.kind}`)} · {field.name}</Check>
      })}
    {count > 10 && <div className="flex justify-between"><Button size="sm" variant="ghost" disabled={busy || page === 0} onClick={() => setPage(value => value - 1)}>{t('previous')}</Button>
      <Button size="sm" variant="ghost" disabled={busy || (page + 1) * 10 >= count} onClick={() => setPage(value => value + 1)}>{t('next')}</Button></div>}
  </div>
}
