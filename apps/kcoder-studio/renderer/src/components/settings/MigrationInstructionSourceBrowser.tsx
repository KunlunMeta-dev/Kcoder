import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { useMigrationInstructionSources } from '@/kcoder/useMigrationInstructionSources'
import { useMigrationSourceTransfer } from '@/kcoder/useMigrationSourceTransfer'
import type { GatewayServer } from '@/kcoder/gatewayRpc'
import type { MigrationSourceKind } from '../../../../shared/generated/contracts'
import { MigrationSourceTransferStatus } from './MigrationSourceTransferStatus'
import { MigrationSourceAdoptionPanel } from './MigrationSourceAdoptionPanel'
import { MigrationInstructionBodyView } from './MigrationInstructionBodyView'

export function MigrationInstructionSourceBrowser({ source, destination, isCurrent, onBusy, onOpenBatch }: {
  source: GatewayServer; destination: GatewayServer; isCurrent(): boolean; onBusy(value: boolean): void; onOpenBatch?: (job: string) => void
}) {
  const { t } = useTranslation('migrationInstructions')
  const [kind, setKind] = useState<MigrationSourceKind>('claude-code')
  const [root, setRoot] = useState(source.workspacePath ?? ''), [cwd, setCwd] = useState(source.workspacePath ?? '')
  const [descendants, setDescendants] = useState(false), [consent, setConsent] = useState(false), [transferConsent, setTransferConsent] = useState(false)
  const [adoptionBusy, setAdoptionBusy] = useState(false)
  const model = useMigrationInstructionSources(source.id, isCurrent), transfer = useMigrationSourceTransfer(destination, isCurrent)
  const busy = model.busy || transfer.busy || adoptionBusy, fixed = !!model.intent || !!transfer.requestId
  useEffect(() => { onBusy(busy); return () => onBusy(false) }, [busy, onBusy])
  const login = source.security?.identity.mode === 'kcoder-account' && !source.accountIdentity || destination.security?.identity.mode === 'kcoder-account' && !destination.accountIdentity
  const start = () => {
    if (!isCurrent() || !model.session || !model.intent || !model.page?.totalItems || !transferConsent || transfer.requestId) return
    void transfer.start(model.session, [{ kind: 'instructions', captureId: model.intent.captureId }])
  }
  const body = model.body
  return <section data-testid="migration-instruction-source-browser" className="space-y-3" aria-busy={busy}>
    <p className="text-sm leading-6 text-text-secondary">{t('boundary')}</p>
    <div className="flex flex-wrap gap-2">{(['claude-code', 'codex'] as const).map(value => <Button key={value} size="sm" disabled={busy || fixed} variant={kind === value ? 'secondary' : 'ghost'} aria-pressed={kind === value} onClick={() => setKind(value)}>{value === 'codex' ? 'Codex' : 'Claude Code'}</Button>)}</div>
    <label className="block space-y-1 text-sm"><span>{t('sourceRoot')}</span><input data-testid="instruction-source-root" className="min-h-11 w-full rounded-md border border-border bg-background px-3" value={root} disabled={busy || fixed} onChange={event => setRoot(event.target.value)} autoComplete="off"/></label>
    <label className="block space-y-1 text-sm"><span>{t('sourceCwd')}</span><input data-testid="instruction-source-cwd" className="min-h-11 w-full rounded-md border border-border bg-background px-3" value={cwd} disabled={busy || fixed} onChange={event => setCwd(event.target.value)} autoComplete="off"/></label>
    <p className="text-xs leading-5 text-text-secondary">{t('authority')}</p>
    <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" data-testid="instruction-descendants" checked={descendants} disabled={busy || fixed} onChange={event => setDescendants(event.target.checked)}/>{t('descendants')}</label>
    <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" data-testid="instruction-static-consent" checked={consent} disabled={busy || fixed} onChange={event => setConsent(event.target.checked)}/>{t('staticConsent')}</label>
    {login && <p className="text-sm text-destructive">{t('login')}</p>}
    <div className="flex flex-wrap gap-2">
      <Button data-testid="instruction-capture" disabled={busy || fixed || login || !consent || !root.trim() || !cwd.trim()} onClick={() => void model.captureSource({ source: kind, format: 'static_v2', sourceRoot: root, sourceCwd: cwd, includeDescendants: descendants, confirmStaticSubset: true })}>{t('capture')}</Button>
      {model.intent && <Button variant="ghost" data-testid="instruction-observe" disabled={busy} onClick={() => void model.observe()}>{t('observe')}</Button>}
      {model.session && <Button variant="ghost" disabled={busy || !!transfer.requestId} onClick={() => void model.close()}>{t('disconnect')}</Button>}
    </div>
    {model.error && <div role="alert" className="space-y-1 text-sm text-destructive"><p>{t(model.error.endsWith('update_required') ? 'updateRequired' : 'failed')}</p><details className="text-xs"><summary className="cursor-pointer">{t('details')}</summary><p>{model.error}</p></details></div>}
    {model.releasePending && <p className="text-sm text-text-secondary">{t('releasePending')}</p>}
    {model.intent && !model.page && <p className="text-sm text-text-secondary">{t('unknown')}</p>}
    {model.page && <>
      {!model.page.totalItems && <p className="text-sm text-text-secondary">{t('empty')}</p>}
      <ul className="divide-y divide-border">{model.page.items.map(row => <li key={row.itemId} data-testid="instruction-source-row" className="space-y-2 py-3 text-sm">
        <p className="break-words">{row.displayName}</p><p className="text-xs text-text-secondary">{t('sourceScope', { scope: row.relativeScope || t('rootScope') })} · {t(`trigger.${row.trigger}`)} · {t(`disposition.${row.disposition}`)}</p>
        <div className="flex flex-wrap gap-2"><Button size="sm" variant="ghost" data-testid={`instruction-original-${row.itemId}`} disabled={busy} onClick={() => void model.preview(row.itemId, 'original')}>{t('original')}</Button><Button size="sm" variant="ghost" data-testid={`instruction-compiled-${row.itemId}`} disabled={busy || row.disposition !== 'selected'} onClick={() => void model.preview(row.itemId, 'compiled')}>{t('compiled')}</Button></div>
        {row.reasonCode && <details className="text-xs text-text-secondary"><summary className="cursor-pointer">{t('details')}</summary><p>{row.reasonCode}</p></details>}
      </li>)}</ul>
      <div className="flex items-center justify-between"><Button size="sm" variant="ghost" disabled={busy || !model.page.pageIndex} onClick={() => void model.changePage(model.page!.pageIndex - 1)}>{t('previous')}</Button><span className="text-xs text-text-secondary">{model.page.pageIndex + 1}</span><Button size="sm" variant="ghost" disabled={busy || model.page.nextPage == null} onClick={() => void model.changePage(model.page!.nextPage!)}>{t('next')}</Button></div>
      {body && <MigrationInstructionBodyView body={body} busy={busy} onNext={() => { if (body.nextOffset != null) void model.preview(body.itemId, body.representation, body.nextOffset) }}/> }
      {!!model.page.totalItems && !transfer.requestId && <><label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" data-testid="instruction-transfer-consent" checked={transferConsent} disabled={busy} onChange={event => setTransferConsent(event.target.checked)}/>{t('transferConsent')}</label><Button data-testid="instruction-transfer" disabled={busy || login || !transferConsent} onClick={start}>{t('transfer')}</Button></>}
    </>}
    <MigrationSourceTransferStatus model={transfer}/>
    {transfer.result?.result?.phase === 'ready' && transfer.result.result.receipt && <MigrationSourceAdoptionPanel target={destination} receipt={transfer.result.result.receipt} isCurrent={isCurrent} onBusy={setAdoptionBusy} onOpenBatch={onOpenBatch}/>}
  </section>
}
