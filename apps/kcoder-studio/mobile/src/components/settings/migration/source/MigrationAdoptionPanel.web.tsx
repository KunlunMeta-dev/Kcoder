import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Text, View } from 'react-native';
import { Button } from '@/components/ui';
import { t } from '@/i18n';
import { useThemedStyles } from '@/theme';
import type { GatewayProfile } from '@/gateway/types';
import type { MobileMigrationClient, MigrationJobReadResult } from '@/runtime/migration-client';
import { MigrationSourceAdoptionController, adoptionProjectMappingRequired } from '@/runtime/migration-source/adoption-controller';
import type { SourceTarget } from '@/runtime/migration-source/catalog';
import type { MigrationSourceReceipt, MigrationSourceAdoptionState } from '../../../../../../shared/generated/contracts';
import { makeStyles, PageControls } from '../migration-result-ui';
import { MigrationInstructionMapping } from './MigrationInstructionMapping';
import { Check, Confirm, MigrationProblem } from '../workbench/WorkbenchUi';

export function MigrationAdoptionPanel({ client, profile, scope, target, receipt, isCurrent, onJob }: { client: MobileMigrationClient; profile: GatewayProfile; scope: string; target: SourceTarget; receipt: MigrationSourceReceipt; isCurrent(): boolean; onJob(value: MigrationJobReadResult): void }) {
  const styles = useThemedStyles(makeStyles);
  const manager = useMemo(() => new MigrationSourceAdoptionController({ profile, target, receipt: { requestId: receipt.requestId, manifestSha256: receipt.manifestSha256, bytes: receipt.bytes, entries: receipt.entries }, scope, isCurrent, storage: localStorage }), [profile, target, receipt.requestId, receipt.manifestSha256, receipt.bytes, receipt.entries, scope, isCurrent]);
  const state = useSyncExternalStore(manager.subscribe, manager.snapshot);
  const [opened, setOpened] = useState(false), [confirmation, setConfirmation] = useState<{ mode: 'resume' | 'cancel'; state: MigrationSourceAdoptionState } | null>(null), [word, setWord] = useState('');
  const [opening, setOpening] = useState(false), [error, setError] = useState<string | null>(null);
  useEffect(() => { manager.activate(); return manager.dispose; }, [manager]);
  const result = state.result?.state;
  return <View style={styles.stack} testID="migration-source-adoption">
    <Text style={styles.title}>{t('migration_source.adoption_title')}</Text><Text style={styles.note}>{t('migration_source.adoption_boundary')}</Text>
    <Button testID="source-adoption-expand" disabled={state.busy} onPress={() => { setOpened(true); void manager.load(); }}>{t('migration_source.received')}</Button>
    <MigrationProblem code={state.error ?? error}/>
    {opened ? <>
      {state.page?.items.map(row => {
        const selected = state.selected.find(value => value.item.entryId === row.entryId), mapping = adoptionProjectMappingRequired(row);
        return <View key={row.entryId} testID={`source-adoption-row-${row.entryId}`}><Check testID={`source-adoption-select-${row.entryId}`} label={`${row.source} · ${row.category ?? row.class} · ${row.files}`} checked={!!selected} disabled={state.busy || !selected && state.selected.length >= 64} onPress={() => manager.select(row.entryId, !selected)}/>{mapping && selected ? <Check testID={`source-adoption-map-${row.entryId}`} checked={selected.mapped} disabled={state.busy || !target.workspacePath} onPress={() => manager.map(row.entryId, !selected.mapped)} label={t('migration_source.map_workspace')}/> : null}{mapping && !target.workspacePath ? <Text style={styles.warning}>{t('migration_memory.no_workspace')}</Text> : null}{row.class === 'instructions' && selected ? <MigrationInstructionMapping client={client} receipt={receipt} entryId={row.entryId} mapping={state.instructionMappings.find(value => value.entryId === row.entryId)} disabled={state.busy || !selected.mapped || !target.workspacePath} isCurrent={isCurrent} onChange={manager.mapInstructions}/> : null}</View>;
      })}
      <PageControls previous={state.pageIndex > 0 && !state.busy} next={state.page?.nextPage != null && !state.busy} onPrevious={() => { void manager.load(state.pageIndex - 1); }} onNext={() => { if (state.page?.nextPage != null) void manager.load(state.page.nextPage); }}/>
      <Button testID="source-adoption-prepare" disabled={state.busy || !manager.canPrepare()} onPress={() => { void manager.prepare(); }}>{t('migration_source.prepare_preview')}</Button>
      {state.records.map(row => <Button key={row.locator.adoptionId} testID={`source-adoption-record-${row.locator.adoptionId}`} disabled={state.busy} variant="ghost" onPress={() => { void manager.read(row); }}>{t('migration_source.read_adoption', { id: row.locator.adoptionId.slice(0, 8) })}</Button>)}
    </> : null}
    {state.input ? <Button testID="source-adoption-read" disabled={state.busy} variant="ghost" onPress={() => { void manager.read(); }}>{t('migration_source.check_original')}</Button> : null}
    {result ? <View style={styles.stack} testID="source-adoption-state">
      <Text style={styles.title}>{t(`migration_source.adoption_${result.phase}`)}</Text><Text style={styles.note}>{t(`migration_source_upload.workers.${result.workerState}`)}</Text><Text style={styles.note}>{result.completedSources} / {result.totalSources}</Text>
      {!result.control ? <Text style={styles.warning}>{t('migration_source.no_control')}</Text> : null}
      <View style={styles.actions}><Button testID="source-adoption-cancel" disabled={state.busy || !result.control || result.phase === 'preview_ready' || result.cancelRequested !== false} onPress={() => { setConfirmation({ mode: 'cancel', state: result }); setWord(''); }}>{t('migration_source.cancel_adoption')}</Button><Button testID="source-adoption-resume" disabled={state.busy || !result.control || result.workerState !== 'stopped' || result.phase === 'preview_ready'} onPress={() => { setConfirmation({ mode: 'resume', state: result }); setWord(''); }}>{t('migration_source.resume_adoption')}</Button></View>
      {result.jobs.map(job => <Button key={job.jobId} testID={`source-adoption-open-${job.jobId}`} disabled={state.busy || opening || result.phase !== 'preview_ready' || !job.previewReady || job.targetScope === 'current_workspace' && !target.workspacePath} onPress={() => {
        if (!isCurrent()) return; setOpening(true); setError(null);
        void client.call('batchRead', { jobId: job.jobId }).then(value => { if (isCurrent()) onJob(value.state); }, () => { if (isCurrent()) setError('source_transfer_outcome_unknown'); }).finally(() => { if (isCurrent()) setOpening(false); });
      }}>{t('migration_source.open_preview', { id: job.jobId })}</Button>)}
      {state.pollingPaused ? <Text style={styles.note}>{t('migration_source.poll_paused')}</Text> : null}
    </View> : null}
    {confirmation ? <Confirm testID="source-adoption-confirm" keyword={confirmation.mode === 'cancel' ? 'CANCEL' : 'RESUME'} value={word} onChange={setWord} busy={state.busy} onDismiss={() => setConfirmation(null)} onConfirm={() => { void manager.operate(confirmation.mode, confirmation.state); setConfirmation(null); }}/> : null}
  </View>;
}
