import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { Button } from '@/components/ui';
import { SettingsGroup, SettingsRow } from '../../settings-layout';
import { t } from '@/i18n';
import { useLocale } from '@/i18n/use-locale';
import { useThemedStyles } from '@/theme';
import { migrationRequestId, type MobileMigrationClient, type MigrationCalls, type MigrationJobReadResult } from '@/runtime/migration-client';
import type { MigrationIntent } from '@/storage/migration-intents';
import type { ImportedMemoryRecordSummary, MigrationMemoryControlParams } from '../../../../../../shared/generated/contracts';
import { makeStyles, PageControls } from '../migration-result-ui';
import { Confirm, MigrationProblem } from '../workbench/WorkbenchUi';
import { useMigrationAction } from '../workbench/useMigrationAction';

/** Notes and control receipts remain target-owned; this page never deletes or promotes source claims. */
export function MigrationMemoryManager({ client, onJob }: { client: MobileMigrationClient; onJob(job: MigrationJobReadResult): void }) {
  const styles = useThemedStyles(makeStyles), action = useMigrationAction(client);
  const locale = useLocale();
  const [pageIndex, setPageIndex] = useState(0), [revision, setRevision] = useState(0);
  const [page, setPage] = useState<MigrationCalls['memoryList'][1] | null>(null);
  const [locators, setLocators] = useState<MigrationIntent[]>([]), [locatorPage, setLocatorPage] = useState(0);
  const [record, setRecord] = useState<ImportedMemoryRecordSummary | null>(null);
  const [text, setText] = useState<MigrationCalls['memoryRead'][1] | null>(null), [offsets, setOffsets] = useState([0]);
  const [details, setDetails] = useState(false), [confirmation, setConfirmation] = useState('');
  const [control, setControl] = useState<{ record: ImportedMemoryRecordSummary; enabled: boolean } | null>(null);
  const [pending, setPending] = useState<MigrationMemoryControlParams | null>(null);
  const [result, setResult] = useState<MigrationCalls['memoryControl'][1] | null>(null), [readAttempted, setReadAttempted] = useState(false);
  const applyCurrent = (request: MigrationMemoryControlParams, value: MigrationCalls['memoryControl'][1]) => setRecord(current =>
    current?.id === request.id && current.ownerOperationId === request.ownerOperationId ? value.current ?? null : current);
  useEffect(() => {
    if (!client.supports('memoryList')) return;
    void action.run(async () => ({ page: await client.call('memoryList', { pageIndex }), rows: await client.intents() }), value => {
      setPage(value.page); setLocators(value.rows.filter(row => row.memoryControl));
    });
  }, [client, pageIndex, revision]);
  const select = (value: ImportedMemoryRecordSummary) => { setRecord(value); setText(null); setOffsets([0]); setDetails(false); };
  const readText = (offset: number, next: number[]) => {
    if (!record) return;
    void action.run(async () => {
      const value = await client.call('memoryRead', { id: record.id, offset });
      if (value.record.ownerOperationId !== record.ownerOperationId || value.record.revision !== record.revision) throw new Error('migration_memory_record_changed');
      return value;
    }, value => { setText(value); setOffsets(next); });
  };
  const readOriginal = (request: MigrationMemoryControlParams) => {
    setPending(request); setResult(null); setReadAttempted(false);
    void action.run(() => client.call('memoryControlRead', { requestId: request.requestId }), value => { setResult(value); applyCurrent(request, value); setReadAttempted(true); });
  };
  return <SettingsGroup title={t('migration_memory.title')} testID="migration-memory-manager">
    <Text style={styles.note}>{t('migration_memory.boundary')}</Text>
    <MigrationProblem code={action.error}/>
    {!client.supports('memoryList') ? <MigrationProblem code="migration_update_required"/> : <>
      <Button testID="migration-memory-refresh" disabled={action.busy} variant="ghost" onPress={() => setRevision(value => value + 1)}>{t('migration_results.refresh')}</Button>
      {page?.items.map(row => <SettingsRow key={row.id} testID={`migration-memory-record-${row.id}`} label={row.name} note={`${t(row.enabled ? 'migration_memory.enabled' : 'migration_memory.disabled')} · ${t(row.scope.kind === 'global' ? 'migration_memory.mapping_global' : 'migration_memory.scope_project')}`} onPress={() => { if (!action.busy) select(row); }}/>) }
      {page?.items.length === 0 ? <Text style={styles.note}>{t('migration_results.empty')}</Text> : null}
      <PageControls previous={pageIndex > 0 && !action.busy} next={page?.nextPage != null && !action.busy} onPrevious={() => setPageIndex(value => value - 1)} onNext={() => { if (page?.nextPage != null) setPageIndex(page.nextPage); }}/>
    </>}
    {record ? <View style={styles.stack} testID="migration-memory-selected">
      <Text style={styles.title}>{record.name}</Text><Text selectable style={styles.note}>{record.id}</Text>
      <Text style={styles.note}>{t(record.enabled ? 'migration_memory.enabled' : 'migration_memory.disabled')}</Text>
      <Button testID="migration-memory-read" disabled={action.busy} variant="ghost" onPress={() => readText(0, [0])}>{t('migration_memory.read')}</Button>
      {text ? <View><Text selectable style={styles.text}>{text.text}</Text><PageControls previous={offsets.length > 1 && !action.busy} next={text.nextOffset != null && !action.busy} onPrevious={() => { const next = offsets.slice(0, -1); readText(next.at(-1) ?? 0, next); }} onNext={() => { if (text.nextOffset != null) readText(text.nextOffset, [...offsets, text.nextOffset]); }}/></View> : null}
      <Button variant="ghost" onPress={() => setDetails(value => !value)}>{t('migration_memory.provenance')}</Button>
      {details ? <View><Text style={styles.note}>{t('migration_memory.unverified')}</Text><Text selectable style={styles.text}>{record.scope.kind === 'global' ? t('migration_memory.mapping_global') : t('migration_memory.project_root', { root: record.scope.root })}</Text>{record.provenance ? <><Text selectable style={styles.text}>{record.provenance.source} · {record.provenance.layout}</Text><Text selectable style={styles.text}>{record.provenance.sourceGroup} · {record.provenance.sourceFile}</Text><Text style={styles.note}>{record.provenance.sourceModifiedAtMs == null ? t('migration_memory.unknown_time') : new Date(record.provenance.sourceModifiedAtMs).toLocaleString(locale)}</Text></> : <Text style={styles.note}>{t('migration_memory.no_provenance')}</Text>}</View> : null}
      <Button testID="migration-memory-toggle" disabled={action.busy || !client.supports('memoryControl')} onPress={() => { setControl({ record, enabled: !record.enabled }); setConfirmation(''); }}>{t(record.enabled ? 'migration_memory.disable' : 'migration_memory.enable')}</Button>
      {record.provenance?.migrationJobId ? <><Text style={styles.warning}>{t('migration_memory.undo_batch')}</Text><Button testID="migration-memory-origin" disabled={action.busy} variant="ghost" onPress={() => { void action.run(() => client.call('batchRead', { jobId: record.provenance!.migrationJobId! }), value => onJob(value.state)); }}>{t('migration_memory.open_origin')}</Button></> : null}
    </View> : null}
    {control ? <View><Text style={styles.warning}>{t(control.enabled ? 'migration_memory.enable_warning' : 'migration_memory.disable_warning')}</Text><Confirm testID="migration-memory-confirm" keyword={control.enabled ? 'ENABLE' : 'DISABLE'} value={confirmation} onChange={setConfirmation} busy={action.busy} onDismiss={() => setControl(null)} onConfirm={() => {
      const request: MigrationMemoryControlParams = { requestId: migrationRequestId(), id: control.record.id, ownerOperationId: control.record.ownerOperationId, expectedRevision: control.record.revision, enabled: control.enabled, confirmUnverifiedNotes: control.enabled };
      setPending(request); setReadAttempted(false); setResult(null); setControl(null);
      void action.run(() => client.call('memoryControl', request), value => { setResult(value); applyCurrent(request, value); setRevision(value => value + 1); });
    }}/></View> : null}
    {pending ? <View testID="migration-memory-operation" style={styles.stack}>
      <Text selectable style={styles.note}>{pending.requestId}</Text><Text style={styles.note}>{t('migration_memory.recovery_note')}</Text>
      <Button testID="migration-memory-control-read" disabled={action.busy} variant="ghost" onPress={() => readOriginal(pending)}>{t('migration_memory.check_original')}</Button>
      {result ? <><Text style={styles.note}>{t(result.receipt ? result.receipt.request.enabled ? 'migration_memory.receipt_enabled' : 'migration_memory.receipt_disabled' : 'migration_memory.no_receipt')}</Text><Text style={styles.note}>{t(!result.current ? 'migration_memory.current_missing' : result.current.enabled ? 'migration_memory.current_enabled' : 'migration_memory.current_disabled')}</Text></> : null}
      {readAttempted && result && !result.receipt ? <Button testID="migration-memory-control-retry" disabled={action.busy} onPress={() => { void action.run(() => client.call('memoryControl', pending), value => { setResult(value); applyCurrent(pending, value); setRevision(value => value + 1); }); }}>{t('migration_memory.retry_original')}</Button> : null}
    </View> : null}
    {locators.length ? <View style={styles.stack}><Text style={styles.title}>{t('migration_memory.recovery')}</Text>{locators.slice(locatorPage * 10, locatorPage * 10 + 10).map(row => <Button key={row.id} testID={`migration-memory-control-record-${row.id}`} disabled={action.busy} variant="ghost" onPress={() => readOriginal(row.memoryControl!)}>{row.requestId}</Button>)}<PageControls previous={locatorPage > 0} next={(locatorPage + 1) * 10 < locators.length} onPrevious={() => setLocatorPage(value => value - 1)} onNext={() => setLocatorPage(value => value + 1)}/></View> : null}
  </SettingsGroup>;
}
