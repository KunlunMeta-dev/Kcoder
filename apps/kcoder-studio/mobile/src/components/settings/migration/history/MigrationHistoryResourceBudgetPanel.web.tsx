import { MigrationResourceAttachmentPanel } from '../workbench/MigrationResourceAttachmentPanel';
import { useEffect, useLayoutEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Text, View } from 'react-native';
import { Button, Field } from '@/components/ui';
import { t } from '@/i18n';
import { useThemedStyles } from '@/theme';
import { Sha256Stream } from '@/protocol/sha256-stream';
import { useSettingsTarget } from '../../SettingsTargetContext';
import { SettingsGroup } from '../../settings-layout';
import { migrationRequestId } from '@/runtime/migration-client';
import { makeStyles } from '../migration-result-ui';
import { Confirm } from '../workbench/WorkbenchUi';
import { createHistoryResourceController, HistoryBudgetLifetime } from '../../../../../../shared/migrationHistoryResourceController';
import { createResourceBudgetStorage } from '../../../../../../shared/migrationResourceBudgetStorage.mjs';
import { resourceBudgetDraft } from '../../../../../../shared/migrationResourceBudget';
import { HISTORY_RESOURCE_CAPABILITY } from '../../../../../../shared/migrationHistoryResourceBudget';
import type { HistoryBudgetProps } from './MigrationHistoryResourceBudgetPanel';
export function MigrationHistoryResourceBudgetPanel(props: HistoryBudgetProps) {
  const selected = useSettingsTarget();
  if (!selected.ready || !selected.targetIdentity || !props.client.supportsCapability(HISTORY_RESOURCE_CAPABILITY)) return null;
  return <><MigrationResourceAttachmentPanel client={props.client} identity={selected.targetIdentity} kind="history" jobId={props.jobId} disabled={props.cancelled}/><OwnedHistoryBudget key={`${selected.targetIdentity}:${props.jobId}`} {...props} identity={selected.targetIdentity}/></>;
}
export function OwnedHistoryBudget({ client, jobId, cancelled, identity }: HistoryBudgetProps & { identity: string }) {
  const styles = useThemedStyles(makeStyles);
  const lifetime = useMemo(() => new HistoryBudgetLifetime({ client, jobId, identity }), [client, jobId, identity]);
  useLayoutEffect(() => { lifetime.update(() => client.available(), !cancelled); return () => lifetime.invalidate(); }, [lifetime, client, cancelled]);
  const controller = useMemo(() => {
    const current = lifetime.isCurrent;
    return createHistoryResourceController({ api: { read: input => client.call('historyResourcesRead', input), increase: input => client.call('historyResourcesIncrease', input) },
      storage: createResourceBudgetStorage({ storage: { getItem: key => globalThis.localStorage.getItem(key) }, indexedDB: globalThis.indexedDB, isCurrent: current }),
      scope: new Sha256Stream().update(new TextEncoder().encode(identity)).digestHex(), jobId, isCurrent: current,
      canIncrease: lifetime.canIncrease, createRequestId: migrationRequestId });
  }, [client, jobId, identity, lifetime]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useEffect(() => { controller.activate(); void controller.read(); return () => controller.dispose(); }, [controller]);
  const [expanded, setExpanded] = useState(false), [bytes, setBytes] = useState(''), [files, setFiles] = useState(''), [word, setWord] = useState('');
  const [confirmation, setConfirmation] = useState<'increase' | 'resubmit' | 'archive' | null>(null);
  const view = state.view, observed = controller.observed(), draft = resourceBudgetDraft(view, bytes, files);
  const owned = observed?.ownerJobId === jobId && !cancelled;
  const permitted = confirmation === 'archive' ? !!state.pending && !!state.expiredObservation : confirmation === 'resubmit' ? !!state.pending && state.checked && !state.receipt && !state.expiredObservation && owned : owned && !!draft && view?.phase === 'active';
  const choose = (kind: 'increase' | 'resubmit' | 'archive') => { setWord(''); setConfirmation(kind); };
  if (state.error === 'updateRequired' || !state.error && !view) return null;
  return <SettingsGroup title={t('migration_resources.title')}><View testID="migration-history-resource-budget" style={styles.stack}>
    {state.error ? <Text accessibilityRole="alert" style={styles.error}>{t(`migration_resources.errors.${state.error}`)}</Text> : null}
    <Button testID="migration-history-resource-details" variant="ghost" onPress={() => setExpanded(value => !value)}>{t('migration_resources.details')}</Button>
    {expanded || state.pending ? <>
      <Text style={styles.note}>{t('migration_resources.history_boundary')}</Text>
      {view ? <Text style={styles.note}>{t(`migration_resources.phase.${view.phase}`)}</Text> : null}
      {observed?.ownerJobId && observed.ownerJobId !== jobId ? <Text selectable style={styles.note}>{t('migration_resources.parent_owner', { id: observed.ownerJobId })}</Text> : null}
      {observed?.initialLimits ? <Text style={styles.note}>{t('migration_resources.initial_frozen', { bytes: observed.initialLimits.maxTotalBytes, files: observed.initialLimits.maxPayloadFiles })}</Text> : null}
      {view?.phase === 'active' ? <><Text style={styles.note}>{t('migration_resources.current', { revision: view.policyRevision })} · {t('migration_resources.limits', { bytes: view.limits.maxTotalBytes, files: view.limits.maxPayloadFiles })}</Text><Text style={styles.note}>{t('migration_resources.usage', { bytes: view.usage.committedBytes, files: view.usage.committedFiles, reserved: view.usage.reservedBytes, reservedFiles: view.usage.reservedFiles })}</Text></> : null}
      <Button testID="migration-history-resource-read" variant="ghost" disabled={state.busy} onPress={() => { void controller.read(); }}>{t(state.pending ? 'migration_resources.check_original' : 'migration_resources.refresh')}</Button>
      {state.pending ? <><Text selectable style={styles.note}>{t('migration_resources.original_request')} · {state.pending.requestId}</Text><Text style={styles.note}>{t('migration_resources.recovery')}</Text>{!state.receipt && !state.expiredObservation ? <Button testID="migration-history-resource-resubmit" disabled={!owned || state.busy || !state.checked || state.recoveryBlocked} onPress={() => choose('resubmit')}>{t('migration_resources.resubmit')}</Button> : null}{state.expiredObservation ? <Button disabled={state.busy} onPress={() => choose('archive')}>{t('migration_resources.archive_expired')}</Button> : null}</> : null}
      {state.receipt ? <View testID="migration-history-resource-receipt"><Text style={styles.note}>{t('migration_resources.receipt', { previous: state.receipt.previousRevision, revision: state.receipt.revision })}</Text><Text style={styles.note}>{t('migration_resources.resume_separately')}</Text><Button variant="ghost" disabled={state.busy} onPress={() => { void controller.acknowledge(); }}>{t('migration_resources.acknowledge')}</Button></View> : null}
      {view?.phase === 'active' && !state.pending && owned ? <>
        <Field testID="migration-history-resource-bytes" label={t('migration_resources.bytes')} value={bytes} placeholder={String(view.limits.maxTotalBytes)} keyboardType="number-pad" maxLength={16} editable={!state.busy} onChangeText={setBytes}/>
        <Field testID="migration-history-resource-files" label={t('migration_resources.files')} value={files} placeholder={String(view.limits.maxPayloadFiles)} keyboardType="number-pad" maxLength={8} editable={!state.busy} onChangeText={setFiles}/>
        <Button testID="migration-history-resource-increase" disabled={!draft || state.busy || state.recoveryBlocked} onPress={() => choose('increase')}>{t('migration_resources.increase')}</Button>
      </> : null}
      {confirmation ? <Confirm testID="migration-history-resource-confirm" keyword={confirmation === 'archive' ? 'ARCHIVE' : 'INCREASE'} value={word} onChange={setWord} busy={state.busy || !permitted || !owned && confirmation !== 'archive'} onDismiss={() => setConfirmation(null)} onConfirm={() => { if (confirmation === 'archive') void controller.archiveExpired(true); else if (confirmation === 'resubmit') void controller.resubmit(true); else if (draft && view?.phase === 'active') void controller.increase(draft, view.policyRevision, true); setConfirmation(null); }}/> : null}
    </> : null}
  </View></SettingsGroup>;
}
