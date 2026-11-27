import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { createMigrationApi } from '@/kcoder/gatewayMigration'
import { captureAccountContextRevision } from '@/kcoder/accountContextEvents'
import type { GatewayServer } from '@/kcoder/gatewayRpc'
import type { MigrationInstructionItem, MigrationSourceInstructionMapping, MigrationSourceReceipt } from '../../../../shared/generated/contracts'
import { InstructionPreviewController } from '../../../../shared/migrationInstructionPreview'
import { validInstructionMappings } from '../../../../shared/migrationInstructionMappings'
import { MigrationInstructionBodyView } from './MigrationInstructionBodyView'

export function MigrationInstructionMapping({ target, receipt, entryId, disabled, isCurrent, value, onChange }: {
  target: GatewayServer; receipt: MigrationSourceReceipt; entryId: string; disabled: boolean; isCurrent(): boolean
  value?: MigrationSourceInstructionMapping; onChange(value: MigrationSourceInstructionMapping | null): void
}) {
  const { t } = useTranslation('migrationInstructions')
  const model = useMemo(() => {
    const account = captureAccountContextRevision()
    return new InstructionPreviewController(createMigrationApi(target.id, target.workspacePath), {
      kind: 'received', requestId: receipt.requestId, manifestSha256: receipt.manifestSha256, entryId,
    }, () => isCurrent() && account(target.id))
  }, [target.id, target.workspacePath, receipt.requestId, receipt.manifestSha256, entryId, isCurrent])
  const state = useSyncExternalStore(model.subscribe, model.snapshot, model.snapshot)
  const [choices, setChoices] = useState<Record<string, { row: MigrationInstructionItem; scope: string }>>({})
  const [consent, setConsent] = useState(false), [archive, setArchive] = useState(false)
  useEffect(() => { model.activate(); return model.dispose }, [model])
  const selected = Object.values(choices)
  const mapping: MigrationSourceInstructionMapping = { entryId, items: selected.map(item => ({ itemId: item.row.itemId, targetRelativeScope: item.scope })), archiveIncompleteChain: archive }
  const requiresArchive = selected.some(item => !item.row.completeAuthorizedStaticChain || item.row.disposition !== 'selected')
  const valid = consent && (!requiresArchive || archive) && validInstructionMappings([mapping], [{ entryId, projectMapping: 'current_workspace' }])
  const change = (next: Record<string, { row: MigrationInstructionItem; scope: string }>) => { setChoices(next); setConsent(false); onChange(null) }
  const busy = disabled || state.busy, body = state.body
  return <section className="studio-card-spacing space-y-3 rounded-md border border-border" data-testid={`instruction-mapping-${entryId}`}>
    <p className="text-sm font-medium">{t('mappingTitle')}</p><p className="text-sm leading-6 text-text-secondary">{t('mappingBoundary')}</p>
    <Button size="sm" variant="ghost" data-testid="instruction-mapping-read" disabled={busy} onClick={() => void model.load()}>{t('readItems')}</Button>
    {state.error && <p role="alert" className="text-sm text-destructive">{t('failed')}</p>}
    {state.page && <>
      <ul className="divide-y divide-border">{state.page.items.map(row => <li key={row.itemId} className="space-y-2 py-3 text-sm" data-testid="instruction-mapping-row">
        <label className="flex min-h-11 items-center gap-2"><input type="checkbox" data-testid={`instruction-map-select-${row.itemId}`} checked={!!choices[row.itemId]} disabled={busy || !row.scoped} onChange={event => {
          const next = { ...choices }
          if (event.target.checked) next[row.itemId] = { row, scope: '' }; else delete next[row.itemId]
          change(next)
        }}/><span className="break-words">{row.displayName}</span></label>
        <p className="text-xs text-text-secondary">{t('sourceScope', { scope: row.relativeScope || t('rootScope') })} · {t(`trigger.${row.trigger}`)} · {t(`disposition.${row.disposition}`)}</p>
        {choices[row.itemId] && <label className="block space-y-1"><span>{t('targetScope')}</span><input className="min-h-11 w-full rounded-md border border-border bg-background px-3" data-testid={`instruction-map-scope-${row.itemId}`} value={choices[row.itemId].scope} disabled={busy} onChange={event => change({ ...choices, [row.itemId]: { row, scope: event.target.value } })} autoComplete="off"/></label>}
        <div className="flex flex-wrap gap-2"><Button size="sm" variant="ghost" disabled={busy} onClick={() => void model.preview(row.itemId, 'original')}>{t('original')}</Button><Button size="sm" variant="ghost" disabled={busy || row.disposition !== 'selected'} onClick={() => void model.preview(row.itemId, 'compiled')}>{t('compiled')}</Button></div>
      </li>)}</ul>
      <div className="flex justify-between gap-2"><Button size="sm" variant="ghost" disabled={busy || !state.page.pageIndex} onClick={() => void model.load(state.page!.pageIndex - 1)}>{t('previous')}</Button><Button size="sm" variant="ghost" disabled={busy || state.page.nextPage == null} onClick={() => void model.load(state.page!.nextPage!)}>{t('next')}</Button></div>
      {body && <MigrationInstructionBodyView body={body} busy={busy} onNext={() => { if (body.nextOffset != null) void model.preview(body.itemId, body.representation, body.nextOffset) }}/> }
      {requiresArchive && <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" data-testid="instruction-map-archive" checked={archive} disabled={busy} onChange={event => { setArchive(event.target.checked); setConsent(false); onChange(null) }}/>{t('archiveIncomplete')}</label>}
      <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" data-testid="instruction-map-consent" checked={consent} disabled={busy || !selected.length} onChange={event => { setConsent(event.target.checked); if (!event.target.checked) onChange(null) }}/>{t('mapConsent')}</label>
      <Button size="sm" data-testid="instruction-map-confirm" disabled={busy || !valid} onClick={() => { if (model.current() && valid) onChange(mapping) }}>{t('confirmMapping')}</Button>
      {value && <p role="status" className="text-sm text-text-secondary">{t('mappingConfirmed')}</p>}
    </>}
  </section>
}
