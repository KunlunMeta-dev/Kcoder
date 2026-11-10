import { MigrationResourceAttachmentPanel } from './MigrationResourceAttachmentPanel';
import { createResourceBudgetStorage } from '../../../../../../shared/migrationResourceBudgetStorage.mjs';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Text, View } from 'react-native';
import { Button, Field } from '@/components/ui';
import { t } from '@/i18n';
import { useThemedStyles } from '@/theme';
import { useSettingsTarget } from '../../SettingsTargetContext';
import { SettingsGroup } from '../../settings-layout';
import { migrationRequestId, type MobileMigrationClient, type MigrationJobReadResult } from '@/runtime/migration-client';
import { Sha256Stream } from '@/protocol/sha256-stream';
import { createResourceBudgetController } from '../../../../../../shared/migrationResourceBudgetController.mjs';
import { resourceBudgetDraft, resourceBudgetMutable, validResourceIntent, validResourceCall, RESOURCE_BUDGET_CAPABILITY } from '../../../../../../shared/migrationResourceBudget';
import { makeStyles } from '../migration-result-ui';
import { Confirm } from './WorkbenchUi';
import { migrationErrorTranslationKey } from '../migration-error-translation';
type Props = { client: MobileMigrationClient; job: MigrationJobReadResult; completedBudgetVerified?: boolean };
export function MigrationResourceBudgetPanel(props: Props) {
  const selected = useSettingsTarget();
  const [proof, setProof] = useState<string | null>(null);
  const proofKey = JSON.stringify([selected.targetIdentity, props.job.job.jobId, props.job.batch?.planId]);
  const onObservation = useCallback((view: import('../../../../../../shared/generated/contracts').MigrationHistoryResourceAttachmentResult) => { setProof(view.jobId === props.job.job.jobId && view.ownerJobId === props.job.job.jobId && view.currentPlanId === props.job.batch?.planId && ['attached', 'tracked'].includes(view.phase) ? proofKey : null); }, [props.job.job.jobId, props.job.batch?.planId, proofKey]);
  if (!selected.ready || !selected.targetIdentity || !props.client.supportsCapability(RESOURCE_BUDGET_CAPABILITY)) return null;
  return <><MigrationResourceAttachmentPanel client={props.client} identity={selected.targetIdentity} kind="batch" onObservation={onObservation} jobId={props.job.job.jobId} disabled={['cancelled', 'rolled_back', 'rollback_failed'].includes(props.job.job.status)}/><OwnedResourceBudget key={`${selected.targetIdentity}:${props.job.job.jobId}:${props.job.batch?.planId ?? ''}`} {...props} identity={selected.targetIdentity} completedBudgetVerified={proof === proofKey}/></>;
}
export function OwnedResourceBudget({ client, job, identity, completedBudgetVerified }: Props & { identity: string }) {
  const styles = useThemedStyles(makeStyles);
  const mutable = resourceBudgetMutable(job.job.status, job.batch?.unresolvedActions) || job.job.status === 'completed' && completedBudgetVerified === true;
  const latest = useRef({ client, identity, mutable });
  useLayoutEffect(() => { latest.current = { client, identity, mutable }; }, [client, identity, mutable]);
  const jobId = job.job.jobId, planId = job.batch?.planId;
  const controller = useMemo(() => createResourceBudgetController({
    api: { read: input => client.call('resourcesRead', input), increase: input => client.call('resourcesIncrease', input) },
    storage: createResourceBudgetStorage({ storage: { getItem: key => globalThis.localStorage.getItem(key) }, indexedDB: globalThis.indexedDB, isCurrent: () => client.available() && latest.current.client === client && latest.current.identity === identity }),
    scope: new Sha256Stream().update(new TextEncoder().encode(identity)).digestHex(), jobId, planId,
    isCurrent: () => client.available() && latest.current.client === client && latest.current.identity === identity,
    canIncrease: () => latest.current.mutable, createRequestId: migrationRequestId, validIntent: validResourceIntent, validView: (query, view) => validResourceCall('migration/batch/resources/read', query, view),
  }), [client, identity, jobId, planId]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useEffect(() => { controller.activate(); void controller.read(); return () => controller.dispose(); }, [controller]);
  const [expanded, setExpanded] = useState(false), [bytes, setBytes] = useState(''), [files, setFiles] = useState(''), [word, setWord] = useState('');
  const [confirmation, setConfirmation] = useState<{ kind: 'increase' | 'resubmit' | 'archive'; bytes: string; files: string; revision: number; requestId: string | null } | null>(null);
  const view = state.view, receipt = state.receipt, draft = resourceBudgetDraft(view, bytes, files);
  const validConfirmation = confirmation?.kind === 'archive' ? !!state.expiredObservation && !!state.pending && state.pending.requestId === confirmation.requestId
    : confirmation?.kind === 'resubmit' ? !!state.pending && state.pending.requestId === confirmation.requestId && state.checked && !receipt && !state.expiredObservation : !!confirmation && mutable && view?.phase === 'active' && view.policyRevision === confirmation.revision && bytes === confirmation.bytes && files === confirmation.files && !!draft;
  const change = (kind: 'increase' | 'resubmit' | 'archive') => { setWord(''); setConfirmation({ kind, bytes, files, revision: view?.phase === 'active' ? view.policyRevision : -1, requestId: state.pending?.requestId ?? null }); };
  if (state.error === 'updateRequired' || !view && !state.error || view?.phase === 'not_applicable') return null;
  return <SettingsGroup title={t('migration_resources.title')}>
    <View testID="migration-resource-budget" style={styles.stack}>
      {state.error ? <Text accessibilityRole="alert" style={styles.error}>{t(migrationErrorTranslationKey('resources', state.error))}</Text> : null}
      {state.recoveryBlocked ? <Text style={styles.error}>{t('migration_resources.errors.recovery_unavailable')}</Text> : null}
      {state.pending && !expanded ? <Text style={styles.warning}>{t('migration_resources.recovery')}</Text> : null}
      <Button testID="migration-resource-details" variant="ghost" onPress={() => setExpanded(value => !value)}>{t('migration_resources.details')}</Button>
      {expanded ? <>
        <Text style={styles.note}>{t('migration_resources.boundary')}</Text>
        {view ? <Text style={styles.note}>{t(`migration_resources.phase.${view.phase}`)}</Text> : null}
        {view?.phase === 'planned' ? <Text style={styles.note}>{t('migration_resources.limits', { bytes: view.limits.maxTotalBytes, files: view.limits.maxPayloadFiles })}</Text> : null}
        {view?.phase === 'active' ? <>
          <Text testID="migration-resource-current" style={styles.note}>{t('migration_resources.current', { revision: view.policyRevision })} · {t('migration_resources.limits', { bytes: view.limits.maxTotalBytes, files: view.limits.maxPayloadFiles })}</Text>
          <Text style={styles.note}>{t('migration_resources.usage', { bytes: view.usage.committedBytes, reserved: view.usage.reservedBytes, files: view.usage.committedFiles, reservedFiles: view.usage.reservedFiles })}</Text>
          <Text style={styles.note}>{t('migration_resources.margins', { bytes: view.limits.minFreeBytes, files: view.limits.minFreeFileNodes })}</Text>
        </> : null}
        <Button testID="migration-resource-read" variant="ghost" disabled={state.busy} onPress={() => { void controller.read(); }}>{t(state.pending ? 'migration_resources.check_original' : 'migration_resources.refresh')}</Button>
        {state.pending ? <View testID="migration-resource-pending" style={styles.row}>
          <Text selectable style={styles.note}>{t('migration_resources.original_request')} · {state.pending.requestId}</Text>
          <Text style={styles.note}>{t('migration_resources.limits', { bytes: state.pending.limits.maxTotalBytes, files: state.pending.limits.maxPayloadFiles })}</Text>
          <Text style={styles.note}>{t('migration_resources.recovery')}</Text>
          {state.checked && !receipt ? <Text style={styles.warning}>{t('migration_resources.unknown')}</Text> : null}
          {state.expiredObservation ? <><Text testID="migration-resource-expired" style={styles.warning}>{t('migration_resources.expired', { previous: state.pending.expectedPolicyRevision, revision: state.expiredObservation.view.policyRevision })}</Text><Text style={styles.note}>{t('migration_resources.archive_boundary')}</Text><Button testID="migration-resource-archive-expired" variant="ghost" disabled={state.busy || state.recoveryBlocked} onPress={() => change('archive')}>{t('migration_resources.archive_expired')}</Button></> : null}
          {!receipt && !state.expiredObservation ? <Button testID="migration-resource-resubmit" variant="ghost" disabled={state.busy || !state.checked || state.recoveryBlocked || state.pending.planId !== planId} onPress={() => change('resubmit')}>{t('migration_resources.resubmit')}</Button> : null}
        </View> : null}
        {receipt ? <View testID="migration-resource-receipt" style={styles.row}>
          <Text style={styles.note}>{t('migration_resources.receipt', { previous: receipt.previousRevision, revision: receipt.revision })}</Text><Text selectable style={styles.note}>{receipt.requestId}</Text>
          <Text style={styles.note}>{t('migration_resources.limits', { bytes: receipt.limits.maxTotalBytes, files: receipt.limits.maxPayloadFiles })}</Text><Text style={styles.note}>{t('migration_resources.resume_separately')}</Text>
          {state.pending ? <Button variant="ghost" disabled={state.busy} onPress={() => { void controller.acknowledge(); setConfirmation(null); }}>{t('migration_resources.acknowledge')}</Button> : null}
        </View> : null}
        {view?.phase === 'active' && !state.pending ? <>
          {!mutable ? <Text style={styles.note}>{t('migration_resources.terminal')}</Text> : null}
          <Field testID="migration-resource-bytes" label={t('migration_resources.bytes')} value={bytes} placeholder={String(view.limits.maxTotalBytes)} keyboardType="number-pad" maxLength={16} editable={mutable && !state.busy} onChangeText={setBytes}/>
          <Field testID="migration-resource-files" label={t('migration_resources.files')} value={files} placeholder={String(view.limits.maxPayloadFiles)} keyboardType="number-pad" maxLength={8} editable={mutable && !state.busy} onChangeText={setFiles}/>
          <Button testID="migration-resource-increase" disabled={!draft || !mutable || !planId || state.busy || state.recoveryBlocked} onPress={() => change('increase')}>{t('migration_resources.increase')}</Button>
        </> : null}
        {confirmation ? <Confirm testID="migration-resource-confirm" keyword={confirmation.kind === 'archive' ? 'ARCHIVE' : 'INCREASE'} value={word} onChange={setWord} onDismiss={() => setConfirmation(null)} busy={state.busy} disabled={!validConfirmation} onConfirm={() => { if (word !== (confirmation.kind === 'archive' ? 'ARCHIVE' : 'INCREASE') || !validConfirmation) return; if (confirmation.kind === 'archive') void controller.archiveExpired(true); else if (confirmation.kind === 'resubmit') void controller.resubmit(true); else if (draft && view?.phase === 'active') void controller.increase(draft, view.policyRevision, true); setConfirmation(null); setWord(''); }}/> : null}
        {!state.pending ? state.historyRows?.filter(row => row.kind === 'expired').map(row => row.kind === 'expired' ? <View key={row.requestId} testID="migration-resource-expired-history" style={styles.row}><Text selectable style={styles.note}>{t('migration_resources.expired_history')} · {row.requestId}</Text><Text style={styles.note}>{t('migration_resources.expired', { previous: row.intent.expectedPolicyRevision, revision: row.observation.view.policyRevision })}</Text><Text style={styles.note}>{t('migration_resources.limits', { bytes: row.intent.limits.maxTotalBytes, files: row.intent.limits.maxPayloadFiles })}</Text></View> : null) : null}
        {!state.pending && state.history.length ? <View style={styles.stack}><Text style={styles.note}>{t('migration_resources.history')}</Text>{state.history.map(id => <Button key={id} variant="ghost" disabled={state.busy} onPress={() => { void controller.read(id); }}>{id}</Button>)}</View> : null}
      </> : null}
    </View>
  </SettingsGroup>;
}
