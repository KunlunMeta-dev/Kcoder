import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Text, View } from 'react-native';
import { Button } from '@/components/ui';
import { t } from '@/i18n';
import { useThemedStyles } from '@/theme';
import type { MobileMigrationClient } from '@/runtime/migration-client';
import { createMobileSourceUploadApi } from '@/runtime/migration-source/upload-api';
import { createSourceUploadController } from '@/runtime/migration-source/upload-controller';
import { inspectBrowserSourceUploadFiles, SOURCE_UPLOAD_MAX_SCAN_FILES } from '@/runtime/migration-source/selection';
import type { MigrationSourceKind, SourceUploadState } from '../../../../../../shared/generated/contracts';
import { makeStyles, PageControls } from '../migration-result-ui';
import { migrationErrorTranslationKey } from '../migration-error-translation';
import { MigrationProblem } from '../workbench/WorkbenchUi';

export function MigrationUploadPanel({ client, scope, isCurrent, onReady, onIdentity }: { client: MobileMigrationClient; scope: string; isCurrent(): boolean; onReady(value: SourceUploadState): void; onIdentity(id: string | null): void }) {
  const styles = useThemedStyles(makeStyles);
  const manager = useMemo(() => createSourceUploadController({ api: createMobileSourceUploadApi(client), storage: localStorage, scope, isCurrent }), [client, scope, isCurrent]);
  const state = useSyncExternalStore(manager.subscribe, manager.getSnapshot), upload = state.observed?.upload;
  const [source, setSource] = useState<MigrationSourceKind | null>(null), [mode, setMode] = useState<'files' | 'directory' | 'package'>('files');
  const [error, setError] = useState<string | null>(null), [excluded, setExcluded] = useState({ private: 0, cache: 0 }), [page, setPage] = useState(0);
  const [recordsOpen, setRecordsOpen] = useState(false);
  const input = useRef<HTMLInputElement>(null), kind = state.selector?.manifest.source ?? source;
  useEffect(() => { manager.activate(); return () => manager.dispose(); }, [manager]);
  useEffect(() => { onIdentity(state.unknown ? null : state.selector?.operationId ?? null); }, [state.selector?.operationId, state.unknown, onIdentity]);
  useEffect(() => { if (!upload || upload.workerState !== 'running' || state.busy || state.unknown) return; const timer = setTimeout(() => { void manager.read(); }, 1000); return () => clearTimeout(timer); }, [manager, upload, state.busy, state.unknown]);
  const choose = async (files: File[]) => {
    manager.clearSelected(); setError(null); setExcluded({ private: 0, cache: 0 });
    try {
      if (!kind) throw new Error('selectionFailed');
      if (mode === 'package') { if (files.length !== 1) throw new Error('selectionFailed'); await manager.selectPackage(kind, files[0]); }
      else { const selected = inspectBrowserSourceUploadFiles(mode, files); setExcluded(selected.excluded); if (!selected.files.length) { setError('noSafeFiles'); return; } await manager.selectFiles(kind, selected.files); }
    } catch { setError('selectionFailed'); }
  };
  return <View style={styles.stack} testID="migration-source-upload">
    <Text style={styles.title}>{t('migration_source_upload.title')}</Text><Text style={styles.note}>{t('migration_source_upload.boundary')}</Text>
    <View style={styles.actions}>{(['claude-code', 'codex'] as const).map(value => <Button key={value} testID={`source-upload-product-${value}`} variant={kind === value ? 'secondary' : 'ghost'} disabled={state.busy || !!state.selector} onPress={() => { manager.newSelection(); setSource(value); }}>{value === 'codex' ? 'Codex' : 'Claude Code'}</Button>)}</View>
    <View style={styles.actions}>{(['files', 'directory', 'package'] as const).map(value => <Button key={value} testID={`source-upload-mode-${value}`} variant={mode === value ? 'secondary' : 'ghost'} disabled={state.busy} onPress={() => { manager.clearSelected(); setMode(value); setError(null); setExcluded({ private: 0, cache: 0 }); }}>{t(`migration_source_upload.${value}`)}</Button>)}</View>
    <Text style={styles.note}>{t(`migration_source_upload.${mode === 'directory' ? 'directory_help' : mode === 'package' ? 'package_help' : 'files_help'}`)}</Text>
    <input key={mode} ref={input} data-testid="source-upload-input" hidden type="file" disabled={state.busy} multiple={mode !== 'package'} {...(mode === 'directory' ? { webkitdirectory: '' } : {})} onChange={event => {
      const files = event.currentTarget.files;
      if (!files || files.length > SOURCE_UPLOAD_MAX_SCAN_FILES) { event.currentTarget.value = ''; manager.clearSelected(); setError('rawFileCount'); return; }
      const selected = Array.from(files); event.currentTarget.value = ''; void choose(selected);
    }}/>
    <View style={styles.actions}>
      <Button testID="source-upload-choose" disabled={state.busy || !kind} onPress={() => input.current?.click()}>{t(`migration_source_upload.${state.selector ? 'reselect' : 'choose'}`)}</Button>
      {!state.selector ? <Button testID="source-upload-start" disabled={state.busy || !state.selected || !client.supports('sourceUploadPrepare')} onPress={() => { void manager.start(); }}>{t('migration_source_upload.start')}</Button> : <Button testID="source-upload-read" disabled={state.busy} onPress={() => { void manager.read(); }}>{t('migration_source_upload.read')}</Button>}
      {state.selector && !upload && state.readAttempted ? <Button testID="source-upload-prepare-retry" disabled={state.busy || !state.selected} onPress={() => { void manager.retryPrepare(); }}>{t('migration_source_upload.retry_prepare')}</Button> : null}
      {state.selector && upload?.stage !== 'ready' ? <Button testID="source-upload-resume" disabled={state.busy || !state.selected || upload?.workerState !== 'stopped'} onPress={() => { void manager.resume(); }}>{t('migration_source_upload.resume')}</Button> : null}
      {state.busy || state.selector && upload?.stage !== 'ready' ? <Button testID="source-upload-cancel" onPress={() => { void manager.cancel(); }}>{t('migration_source_upload.cancel')}</Button> : null}
      {state.selector ? <Button testID="source-upload-new" disabled={state.busy} variant="ghost" onPress={() => manager.newSelection()}>{t('migration_source_upload.new_selection')}</Button> : null}
    </View>
    {!client.supports('sourceUploadPrepare') ? <MigrationProblem code="migration_update_required"/> : null}
    {error || state.error ? <Text accessibilityRole="alert" style={styles.error}>{t(migrationErrorTranslationKey('source_upload', error ?? state.error!))}</Text> : null}
    {excluded.private + excluded.cache ? <View testID="source-upload-exclusions"><Text style={styles.note}>{t('migration_source_upload.excluded_boundary')}</Text>{excluded.private ? <Text style={styles.note}>{t('migration_source_upload.excluded_private', { count: excluded.private })}</Text> : null}{excluded.cache ? <Text style={styles.note}>{t('migration_source_upload.excluded_cache', { count: excluded.cache })}</Text> : null}</View> : null}
    {state.hashing ? <Text style={styles.note}>{t(mode === 'package' ? 'migration_source_upload.package_progress' : 'migration_source_upload.hash_progress', { bytes: state.hashedBytes, total: state.hashTotalBytes })}</Text> : null}
    {state.selected ? <Text style={styles.note}>{t('migration_source_upload.selected', { files: state.selected.files.length, bytes: state.selected.manifest.files.reduce((sum, file) => sum + file.bytes, 0) })}</Text> : null}
    {upload ? <View testID="source-upload-status" style={styles.stack}>
      <Text style={styles.title}>{t(`migration_source_upload.stages.${upload.stage}`)}</Text><Text style={styles.note}>{t('migration_source_upload.progress', { received: upload.receivedBytes, total: upload.totalBytes, verified: upload.verifiedBytes })}</Text>
      <Text style={styles.note}>{t(`migration_source_upload.workers.${upload.workerState}`)}</Text>{state.unknown ? <Text style={styles.warning}>{t('migration_source_upload.unknown')}</Text> : null}
      <Button variant="ghost" disabled={state.busy} onPress={() => { void manager.files(); }}>{t('migration_source_upload.file_progress')}</Button>
      {upload.stage === 'ready' && !state.unknown ? <><Text style={styles.note}>{t('migration_source_upload.ready_boundary')}</Text><Button testID="source-upload-use" disabled={state.busy || !client.supports('sourceProductRun')} onPress={() => { if (isCurrent()) onReady(upload); }}>{t('migration_source_upload.use_ready')}</Button></> : null}
    </View> : null}
    {state.files ? <View>{state.files.page.files.map(file => <Text key={file.fileIndex} style={styles.note}>{state.selector?.manifest.files[file.fileIndex]?.relativePath} · {file.acceptedBytes}</Text>)}<Button variant="ghost" disabled={state.busy || state.files.page.nextCursor == null} onPress={() => { void manager.files(state.files!.page.nextCursor!); }}>{t('migration_source_upload.next_files')}</Button></View> : null}
    {state.cached.length ? <View style={styles.stack} testID="source-upload-records"><Button testID="source-upload-records-toggle" variant="ghost" onPress={() => setRecordsOpen(value => !value)}>{t('migration_source_upload.records')}</Button>{recordsOpen ? <><Text style={styles.note}>{t('migration_source_upload.records_boundary')}</Text>{state.cached.slice(page * 10, page * 10 + 10).map(record => <Button key={record.operationId} testID={`source-upload-record-${record.operationId}`} disabled={state.busy} variant="ghost" onPress={() => { void manager.restore(record.operationId); }}>{`${record.manifest.source} · ${record.operationId.slice(0, 8)} · ${t('migration_source_upload.read_record')}`}</Button>)}<PageControls previous={page > 0} next={(page + 1) * 10 < state.cached.length} onPrevious={() => setPage(value => value - 1)} onNext={() => setPage(value => value + 1)}/></> : null}</View> : null}
  </View>;
}
