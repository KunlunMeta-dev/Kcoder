import { chooseMigrationDownload } from '@/runtime/migration-local-files';
import { receiveMigrationAttachment } from '@/runtime/migration-local-transfer';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { Button } from '@/components/ui';
import { t } from '@/i18n';
import { useThemedStyles } from '@/theme';
import { migrationError, type MobileMigrationClient } from '@/runtime/migration-client';
import type { HistoricalAttachmentSelection, HistoricalLocalAttachmentBinding, HistoricalLocalAttachmentJob, MigrationUploadCollection } from '../../../../../../shared/generated/contracts';
import { attachmentSelectionIdentity } from '@/runtime/migration-client/history-validation';
import { PageControls, appendPage, makeStyles } from '../migration-result-ui';
import { Check, Confirm, MigrationProblem } from '../workbench/WorkbenchUi';
import { useMigrationAction } from '../workbench/useMigrationAction';
import { useHistoricalRead } from './useHistoricalRead';
import { useHistoricalWorker } from './useHistoricalWorker';

type Props = { client: MobileMigrationClient; selection: HistoricalAttachmentSelection; operationId?: string; bindings?: HistoricalLocalAttachmentBinding[]; onBinding?(binding: HistoricalLocalAttachmentBinding, selected: boolean): void };
export function MigrationUploadCollectionPanel(props: Props) {
  const [expanded, setExpanded] = useState(false), styles = useThemedStyles(makeStyles);
  return <View style={styles.stack} testID="migration-upload-collection">
    <Button variant="ghost" testID="migration-collection-expand" onPress={() => setExpanded(value => !value)}>{t('migration_history.upload_collection.title')}</Button>
    {expanded ? <><Text style={styles.note}>{t('migration_history.upload_collection.boundary')}</Text><CollectionContent {...props}/></> : null}
  </View>;
}
function CollectionContent({ client, selection, operationId, bindings = [], onBinding }: Props) {
  const styles = useThemedStyles(makeStyles), action = useMigrationAction(client);
  const identity = attachmentSelectionIdentity(selection);
  const scope = useMemo(() => ({ client, identity }), [client, identity]), owner = useRef(scope); owner.current = scope;
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const currentUpload = useRef(operationId); currentUpload.current = operationId;
  const [selected, setSelected] = useState<{ scope: typeof scope; id: string } | null>(null);
  const id = selected?.scope === scope ? selected.id : null;
  const [pagination, setPagination] = useState<{ scope: typeof scope; pages: Array<string | null> }>({ scope, pages: [null] });
  const pages = pagination.scope === scope ? pagination.pages : [null];
  const [revision, setRevision] = useState(0), [cancelError, setCancelError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<{ scope: typeof scope; job: MigrationUploadCollection; mode: 'COLLECT' | 'RESUME'; word: string } | null>(null);
  const valid = () => mounted.current && owner.current === scope && client.available();
  const check = () => { if (!valid()) throw new Error('migration_scope_changed'); };
  const task = useHistoricalWorker(client, 'uploadCollectionRead', { operationId: id ?? '', selection }, id !== null);
  const list = useHistoricalRead(client, 'uploadCollectionList', { selection, cursor: pages.at(-1) }, true, revision);
  const value = task.result?.collection;
  const [final, setFinal] = useState<{ scope: typeof scope; job: HistoricalLocalAttachmentJob } | null>(null);
  const finalJob = final?.scope === scope && final.job.state.operationId === id ? final.job : null;
  const binding = finalJob?.state.stage === 'ready' && finalJob.state.receipt ? { operationId: finalJob.state.operationId, selection: finalJob.selection, receipt: finalJob.state.receipt } : null;
  const confirm = confirmation?.scope === scope && value?.operationId === confirmation.job.operationId && value.collectionId === confirmation.job.collectionId && value.sequence === confirmation.job.sequence ? confirmation : null;
  const running = task.result?.workerRunning || task.result?.workerScheduled;
  const problem = action.error ?? task.error ?? cancelError ?? task.result?.workerError ?? value?.failureCode ?? list.error;
  const refresh = () => { setRevision(value => value + 1); task.refresh(); setCancelError(null); };
  async function prepare() {
    const operation = currentUpload.current;
    if (!operation || !valid()) return;
    setSelected({ scope, id: operation });
    await action.run(async () => {
      const fresh = await client.call('localRead', { operationId: operation }); check();
      if (currentUpload.current !== operation || attachmentSelectionIdentity(fresh.upload.selection) !== identity) throw new Error('local_upload_collection_selection_changed');
      return client.call('uploadCollectionPrepare', { operationId: operation, selection, expectedUploadSequence: fresh.upload.sequence });
    }, () => { if (valid()) refresh(); });
  }
  async function operate() {
    if (!confirm || !valid()) return;
    const original = confirm;
    await task.perform(async () => {
      check();
      const params = { operationId: original.job.operationId, selection, collectionId: original.job.collectionId, expectedSequence: original.job.sequence };
      if (original.mode === 'COLLECT') return client.call('uploadCollectionRun', params);
      let sequence = original.job.uploadSequence;
      if (!original.job.storageRetired) {
        const fresh = await client.call('localRead', { operationId: original.job.operationId }); check();
        if (attachmentSelectionIdentity(fresh.upload.selection) !== identity) throw new Error('local_upload_collection_selection_changed');
        sequence = fresh.upload.sequence;
      }
      return client.call('uploadCollectionResume', { ...params, expectedUploadSequence: sequence });
    });
    if (valid()) { setConfirmation(null); setRevision(value => value + 1); }
  }
  async function download() {
    if (!value || value.stage !== 'collected' || !valid()) return;
    await action.run(async () => {
      const result = await client.call('uploadCollectionAttachment', { operationId: value.operationId, selection }); check();
      setFinal({ scope, job: result.job });
      const receipt = result.job.state.receipt;
      if (!receipt) throw new Error('local_attachment_not_ready');
      const sink = await chooseMigrationDownload(receipt.bytes, result.job.info.displayName || receipt.attachmentId);
      if (!sink) return;
      try { check(); } catch (error) { await sink.abort(); throw error; }
      await receiveMigrationAttachment(client, selection, receipt, sink, check, value.operationId);
    });
  }
  async function cancel() {
    if (!value || !valid()) return;
    try { await client.call('uploadCollectionCancel', { operationId: value.operationId, selection, collectionId: value.collectionId }); if (valid()) refresh(); }
    catch (error) { if (valid()) setCancelError(migrationError(error)); }
  }
  return <View style={styles.stack}>
    <MigrationProblem code={problem}/>
    <View style={styles.actions}>
      <Button testID="migration-collection-prepare" disabled={!operationId || action.busy || task.busy || running || !!task.error} onPress={() => { void prepare(); }}>{t('migration_history.upload_collection.prepare')}</Button>
      <Button variant="ghost" onPress={refresh}>{t('migration_results.refresh')}</Button>
    </View>
    {value ? <View style={styles.stack}>
      <Text style={styles.title} testID="migration-collection-status">{t(`migration_history.upload_collection.stages.${value.stage}`)}</Text>
      {task.result?.workerRunning ? <Text style={styles.note}>{t('migration_history.upload_collection.working')}</Text> : task.result?.workerScheduled ? <Text style={styles.note}>{t('migration_history.upload_collection.scheduled')}</Text> : null}
      {value.cancelRequested ? <Text style={styles.warning}>{t('migration_history.upload_collection.cancel_requested')}</Text> : null}
      {value.storageRetired ? <Text style={styles.note}>{t('migration_history.upload_collection.retired')}</Text> : null}
      <Text style={styles.note}>{t('migration_history.upload_collection.progress', { bytes: value.deletedBytes, reserved: value.releasedReservationBytes })}</Text>
      <View style={styles.actions}>
        {value.stage === 'collected' ? <Button testID="migration-collection-download" disabled={action.busy || task.busy} onPress={() => { void download(); }}>{t('migration_history.upload_collection.download')}</Button> : null}
        {value.stage !== 'collected' && !running && !value.cancelRequested && ['prepared', 'collecting'].includes(value.stage) ? <Button testID="migration-collection-run" disabled={task.busy || action.busy || !!task.error} onPress={() => setConfirmation({ scope, job: value, mode: 'COLLECT', word: '' })}>{t('migration_history.upload_collection.run')}</Button> : null}
        {value.stage !== 'collected' && !running && (value.cancelRequested || ['cancelled', 'blocked', 'outcome_unknown'].includes(value.stage)) ? <Button testID="migration-collection-resume" disabled={task.busy || action.busy || !!task.error} onPress={() => setConfirmation({ scope, job: value, mode: 'RESUME', word: '' })}>{t('migration_history.upload_collection.resume')}</Button> : null}
        {value.stage !== 'collected' ? <Button testID="migration-collection-cancel" variant="ghost" disabled={value.cancelRequested} onPress={() => { void cancel(); }}>{t('migration_history.upload_collection.cancel')}</Button> : null}
      </View>
    </View> : null}
    {confirm ? <><Text style={styles.note}>{t(confirm.mode === 'COLLECT' ? 'migration_history.upload_collection.confirmation' : 'migration_history.upload_collection.resume_confirmation')}</Text><Confirm testID="migration-collection-confirm" keyword={confirm.mode} value={confirm.word} onChange={word => setConfirmation({ ...confirm, word })} onConfirm={() => { void operate(); }} onDismiss={() => setConfirmation(null)} busy={task.busy || action.busy}/></> : null}
    {binding && selection.viewId && onBinding ? <Check testID="migration-collection-bind" label={t('migration_history.bind_supplement')} checked={bindings.some(item => item.operationId === binding.operationId)} disabled={action.busy || bindings.length >= 256 && !bindings.some(item => item.operationId === binding.operationId)} onPress={() => { if (valid()) onBinding(binding, !bindings.some(item => item.operationId === binding.operationId)); }}/> : null}
    {list.result?.items.map(item => item.collection ? <Button key={item.collection.operationId} variant="ghost" disabled={task.busy || action.busy || running} onPress={() => { setSelected({ scope, id: item.collection!.operationId }); setConfirmation(null); }}>{item.collection.operationId.slice(0, 8)} · {t(`migration_history.upload_collection.stages.${item.collection.stage}`)}</Button> : null)}
    <PageControls previous={pages.length > 1} next={!!list.result?.nextCursor} onPrevious={() => setPagination({ scope, pages: pages.slice(0, -1) })} onNext={() => { const next = list.result?.nextCursor; if (next) setPagination({ scope, pages: appendPage(pages, next) }); }}/>
  </View>;
}
