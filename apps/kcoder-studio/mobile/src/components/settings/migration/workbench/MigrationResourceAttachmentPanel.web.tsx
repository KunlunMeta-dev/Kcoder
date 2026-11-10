import { useEffect, useLayoutEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Text, View } from 'react-native';
import { Button } from '@/components/ui';
import { t } from '@/i18n';
import { useThemedStyles } from '@/theme';
import { Sha256Stream } from '@/protocol/sha256-stream';
import { SettingsGroup } from '../../settings-layout';
import { makeStyles } from '../migration-result-ui';
import { Confirm } from './WorkbenchUi';
import { MigrationInitialResourceForm } from './MigrationInitialResourceForm';
import { createResourceAttachmentController } from '../../../../../../shared/migrationResourceAttachmentController.mjs';
import { createResourceBudgetStorage } from '../../../../../../shared/migrationResourceBudgetStorage.mjs';
import { HistoryBudgetLifetime } from '../../../../../../shared/migrationHistoryResourceController';
import { RESOURCE_ATTACHMENT_CAPABILITY, RESOURCE_ATTACHMENT_METHODS, validAttachmentIntent, validResourceAttachment } from '../../../../../../shared/migrationResourceAttachment';
import { createInitialResourceDraft, initialResourceSelection } from '../../../../../../shared/migrationInitialResourceLimits';
import type * as C from '../../../../../../shared/generated/contracts';
import type { ResourceAttachmentProps } from './MigrationResourceAttachmentPanel';
export function MigrationResourceAttachmentPanel(props: ResourceAttachmentProps) {
  return props.client.supportsCapability(RESOURCE_ATTACHMENT_CAPABILITY) ? <OwnedResourceAttachment key={`${props.identity}:${props.kind}:${props.jobId}`} {...props}/> : null;
}
export function OwnedResourceAttachment({ client, identity, kind, jobId, disabled, onObservation }: ResourceAttachmentProps) {
  const styles = useThemedStyles(makeStyles);
  const lifetime = useMemo(() => new HistoryBudgetLifetime({ client, identity, kind, jobId }), [client, identity, kind, jobId]);
  useLayoutEffect(() => { lifetime.update(() => client.available(), !disabled); return () => lifetime.invalidate(); }, [lifetime, client, disabled]);
  const controller = useMemo(() => createResourceAttachmentController({
    api: { read: input => kind === 'history' ? client.call('historyResourceAttachmentRead', input) : client.call('batchResourceAttachmentRead', input),
      attach: input => { if (!lifetime.canIncrease()) throw Error('attachment_scope_changed'); return kind === 'history' ? client.call('historyResourcesAttach', input as C.MigrationHistoryResourceAttachParams) : client.call('batchResourcesAttach', input as C.MigrationHistoryParentResourceAttachParams); } },
    storage: createResourceBudgetStorage({ storage: { getItem: key => globalThis.localStorage.getItem(key) }, indexedDB: globalThis.indexedDB, isCurrent: lifetime.isCurrent }),
    scope: new Sha256Stream().update(new TextEncoder().encode(identity)).digestHex(), kind, jobId, isCurrent: lifetime.isCurrent,
    validView: (input, result) => validResourceAttachment(RESOURCE_ATTACHMENT_METHODS[kind], input, result), validIntent: input => validAttachmentIntent(kind, input),
  }), [client, identity, kind, jobId, lifetime]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useEffect(() => { controller.activate(); void controller.read(); return () => controller.dispose(); }, [controller]);
  useEffect(() => { if (state.view && state.checked && lifetime.isCurrent()) onObservation?.(state.view); }, [state.view, state.checked, onObservation, lifetime]);
  const [draft, setDraft] = useState(() => ({ ...createInitialResourceDraft(), enabled: true })), [word, setWord] = useState(''), [review, setReview] = useState<'bind' | 'resume' | null>(null), [parent, setParent] = useState(false), [expanded, setExpanded] = useState(false);
  const view = state.view, selection = initialResourceSelection(draft), mutable = !disabled && !state.busy && !state.recoveryBlocked && state.checked;
  if (state.error === 'attachment_update_required' || !view && !state.error || view?.phase === 'not_applicable') return null;
  const original = view?.originalIntent;
  return <SettingsGroup title={t('migration_resources.attachment.title')}><View testID={`migration-resource-attachment-${kind}`} style={styles.stack}>
    <Button testID="migration-attachment-details" variant="ghost" onPress={() => setExpanded(value => !value)}>{t('migration_resources.details')}</Button>
    {expanded ? <>
      <Text style={styles.note}>{t('migration_resources.attachment.boundary')}</Text>
      {state.error ? <Text accessibilityRole="alert" style={styles.error}>{t(`migration_resources.attachment.errors.${state.error}`)}</Text> : null}
      {view ? <Text testID="migration-attachment-phase" style={styles.note}>{t(`migration_resources.attachment.phase.${view.phase}`)}</Text> : null}
      <Button testID="migration-attachment-read" variant="ghost" disabled={state.busy} onPress={() => { setReview(null); setWord(''); void controller.read(); }}>{t('migration_resources.attachment.read')}</Button>
      {view?.phase === 'parent_owned' && view.ownerJobId ? <><Text selectable style={styles.note}>{t('migration_resources.parent_owner', { id: view.ownerJobId })}</Text><Button variant="ghost" onPress={() => setParent(true)}>{t('migration_resources.attachment.open_parent')}</Button>{parent ? <MigrationResourceAttachmentPanel client={client} identity={identity} kind="batch" jobId={view.ownerJobId} disabled={disabled}/> : null}</> : null}
      {original ? <View testID="migration-attachment-original"><Text selectable style={styles.note}>{t('migration_resources.attachment.original', { sequence: original.expectedSequence, plan: original.planId ?? '—' })}</Text><Text style={styles.note}>{t('migration_resources.limits', { bytes: original.initialLimits.maxTotalBytes, files: original.initialLimits.maxPayloadFiles })}</Text><Text style={styles.note}>{t('migration_resources.margins', { bytes: original.initialLimits.minFreeBytes, files: original.initialLimits.minFreeFileNodes })}</Text></View> : null}
      {view?.phase === 'untracked' && !state.pending ? <><MigrationInitialResourceForm purpose="attachment" draft={draft} onChange={setDraft} disabled={!mutable || !!review}/><Button testID="migration-attachment-review" disabled={!mutable || !selection.valid || !selection.limits} onPress={() => { setWord(''); setReview('bind'); }}>{t('migration_resources.attachment.review')}</Button></> : null}
      {view?.phase === 'pending' && original || view?.phase === 'untracked' && state.pending ? <Button testID="migration-attachment-resume" disabled={!mutable} onPress={() => { setWord(''); setReview('resume'); }}>{t('migration_resources.attachment.restore')}</Button> : null}
      {view?.phase === 'untracked' && state.pending ? <><Text style={styles.note}>{t('migration_resources.attachment.unconfirmed')}</Text><Text style={styles.note}>{t('migration_resources.attachment.original', { sequence: state.pending.expectedSequence, plan: 'planId' in state.pending ? state.pending.planId : '—' })}</Text><Text style={styles.note}>{t('migration_resources.limits', { bytes: state.pending.limits.maxTotalBytes, files: state.pending.limits.maxPayloadFiles })}</Text></> : null}
      {review ? <Confirm testID="migration-attachment-confirm" keyword="BIND" value={word} onChange={setWord} busy={state.busy} disabled={!mutable || review === 'bind' && !selection.limits} onDismiss={() => setReview(null)} onConfirm={() => { if (word !== 'BIND' || !mutable) return; if (review === 'resume') void controller.resume(true); else if (selection.limits) void controller.bind(selection.limits, true); setReview(null); setWord(''); }}/> : null}
    </> : null}
  </View></SettingsGroup>;
}
