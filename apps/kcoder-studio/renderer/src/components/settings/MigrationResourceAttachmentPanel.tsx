import { useEffect, useLayoutEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { createMigrationApi } from '@/kcoder/gatewayMigration'
import { createResourceAttachmentController } from '../../../../shared/migrationResourceAttachmentController.mjs'
import { createResourceBudgetStorage } from '../../../../shared/migrationResourceBudgetStorage.mjs'
import { HistoryBudgetLifetime } from '../../../../shared/migrationHistoryResourceController'
import { RESOURCE_ATTACHMENT_METHODS, validResourceAttachment, validAttachmentIntent, type AttachmentKind } from '../../../../shared/migrationResourceAttachment'
import { createInitialResourceDraft, initialResourceSelection } from '../../../../shared/migrationInitialResourceLimits'
import type * as C from '../../../../shared/generated/contracts'
import { MigrationInitialResourceForm } from './MigrationInitialResourceForm'

type Props = { deviceId: string; workspacePath?: string; scope: string; kind: AttachmentKind; jobId: string; disabled?: boolean; isCurrent(): boolean; onObservation?(view: C.MigrationHistoryResourceAttachmentResult): void }
/** Observation never claims execution; only BIND authorizes this original accounting intent. */
export function MigrationResourceAttachmentPanel(props: Props) {
  const { t } = useTranslation('migrationResources')
  const lifetime = useMemo(() => new HistoryBudgetLifetime([props.scope, props.kind, props.jobId]), [props.scope, props.kind, props.jobId])
  useLayoutEffect(() => { lifetime.update(props.isCurrent, !props.disabled); return () => lifetime.invalidate() }, [lifetime, props.isCurrent, props.disabled])
  const controller = useMemo(() => {
    const api = createMigrationApi(props.deviceId, props.workspacePath)
    return createResourceAttachmentController({
      api: { read: props.kind === 'history' ? api.historyResourceAttachmentRead : api.batchResourceAttachmentRead,
        attach: input => { if (!lifetime.canIncrease()) throw Error('attachment_scope_changed'); return props.kind === 'history' ? api.historyResourcesAttach(input as C.MigrationHistoryResourceAttachParams) : api.batchResourcesAttach(input as C.MigrationHistoryParentResourceAttachParams) } },
      storage: createResourceBudgetStorage({ storage: { getItem: key => window.localStorage.getItem(key) }, indexedDB: globalThis.indexedDB, isCurrent: lifetime.isCurrent }),
      scope: props.scope, kind: props.kind, jobId: props.jobId, isCurrent: lifetime.isCurrent,
      validView: (input, result) => validResourceAttachment(RESOURCE_ATTACHMENT_METHODS[props.kind], input, result), validIntent: input => validAttachmentIntent(props.kind, input),
    })
  }, [props.deviceId, props.workspacePath, props.scope, props.kind, props.jobId, lifetime])
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
  useEffect(() => { controller.activate(); void controller.read(); return () => controller.dispose() }, [controller])
  const onObservation = props.onObservation
  useEffect(() => { if (state.view && state.checked && lifetime.isCurrent()) onObservation?.(state.view) }, [state.view, state.checked, onObservation, lifetime])
  const [draft, setDraft] = useState(() => ({ ...createInitialResourceDraft(), enabled: true })), [word, setWord] = useState(''), [review, setReview] = useState<'bind' | 'resume' | null>(null), [parent, setParent] = useState(false)
  const view = state.view, selection = initialResourceSelection(draft)
  if (state.error === 'attachment_update_required' || !view && !state.error || view?.phase === 'not_applicable') return null
  const mutable = !props.disabled && !state.busy && !state.recoveryBlocked && state.checked
  return <details className="studio-card-spacing rounded-lg border border-border text-sm" data-testid={`migration-resource-attachment-${props.kind}`}>
    <summary className="cursor-pointer font-medium">{t('attachment.title')}</summary>
    <div className="mt-3 space-y-3" aria-busy={state.busy}>
      <p className="text-xs leading-5 text-text-secondary">{t('attachment.boundary')}</p>
      {state.error && <p role="alert" className="text-destructive">{t(`attachment.errors.${state.error}`, { defaultValue: t('attachment.errors.attachment_outcome_unknown') })}</p>}
      {view && <p data-testid="migration-attachment-phase">{t(`attachment.phase.${view.phase}`)}</p>}
      <Button size="sm" variant="outline" disabled={state.busy} data-testid="migration-attachment-read" onClick={() => { setReview(null); setWord(''); void controller.read() }}>{t('attachment.read')}</Button>
      {view?.phase === 'parent_owned' && view.ownerJobId && <><p className="break-all">{t('parentOwner', { id: view.ownerJobId })}</p><Button size="sm" variant="outline" onClick={() => setParent(true)}>{t('attachment.openParent')}</Button>{parent && <MigrationResourceAttachmentPanel {...props} kind="batch" jobId={view.ownerJobId} onObservation={undefined}/>}</>}
      {view?.originalIntent && <div data-testid="migration-attachment-original"><p className="break-all">{t('attachment.original', { sequence: view.originalIntent.expectedSequence, plan: view.originalIntent.planId ?? '—' })}</p><p>{t('limits', { bytes: view.originalIntent.initialLimits.maxTotalBytes, files: view.originalIntent.initialLimits.maxPayloadFiles })}</p><p>{t('margins', { bytes: view.originalIntent.initialLimits.minFreeBytes, files: view.originalIntent.initialLimits.minFreeFileNodes })}</p></div>}
      {view?.phase === 'untracked' && !state.pending && <><MigrationInitialResourceForm purpose="attachment" draft={draft} onChange={setDraft} disabled={!mutable || !!review}/><Button size="sm" data-testid="migration-attachment-review" disabled={!mutable || !selection.valid || !selection.limits} onClick={() => { setWord(''); setReview('bind') }}>{t('attachment.review')}</Button></>}
      {(view?.phase === 'pending' && view.originalIntent || view?.phase === 'untracked' && state.pending) && <Button size="sm" data-testid="migration-attachment-resume" disabled={!mutable} onClick={() => { setWord(''); setReview('resume') }}>{t('attachment.restore')}</Button>}
      {view?.phase === 'untracked' && state.pending && <div><p>{t('attachment.unconfirmed')}</p><p>{t('attachment.original', { sequence: state.pending.expectedSequence, plan: 'planId' in state.pending ? state.pending.planId : '—' })}</p><p>{t('limits', { bytes: state.pending.limits.maxTotalBytes, files: state.pending.limits.maxPayloadFiles })}</p></div>}
      {review && <div className="space-y-2"><label className="block">{t('attachment.confirm')}<input className="mt-1 min-h-11 w-full rounded-md border border-border bg-background px-3" data-testid="migration-attachment-word" value={word} maxLength={4} onChange={event => setWord(event.target.value)}/></label><Button size="sm" data-testid="migration-attachment-confirm" disabled={!mutable || word !== 'BIND' || review === 'bind' && !selection.limits} onClick={() => { if (review === 'resume') void controller.resume(true); else if (selection.limits) void controller.bind(selection.limits, true); setReview(null); setWord('') }}>{t('attachment.bind')}</Button><Button size="sm" variant="ghost" onClick={() => setReview(null)}>{t('dismiss')}</Button></div>}
    </div>
  </details>
}
