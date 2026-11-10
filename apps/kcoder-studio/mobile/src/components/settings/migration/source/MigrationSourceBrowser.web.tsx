import { MigrationInstructionSourceBrowser } from './MigrationInstructionSourceBrowser.web';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Text, View } from 'react-native';
import { Button, Field } from '@/components/ui';
import { t } from '@/i18n';
import { useThemedStyles } from '@/theme';
import type { GatewayProfile } from '@/gateway/types';
import type { MobileMigrationClient, MigrationJobReadResult } from '@/runtime/migration-client';
import { MobileSourceCatalog, type SourceTarget, type SourceMode } from '@/runtime/migration-source/catalog';
import { validSourceDirectory } from '@/runtime/migration-source/directory-intent';
import { MobileSourceTransfer } from '@/runtime/migration-source/transfer-controller';
import type { MigrationSourceKind, SourceUploadState, MigrationSourceTransferResult } from '../../../../../../shared/generated/contracts';
import { makeStyles, PageControls } from '../migration-result-ui';
import { Check, Confirm, MigrationProblem } from '../workbench/WorkbenchUi';
import { MigrationAdoptionPanel } from './MigrationAdoptionPanel.web';
import { MigrationHistoryFamilyChoice, MigrationHistoryFamilyLabel, historyFamilyProblem } from '../workbench/MigrationHistoryFamilyChoice';

export function MigrationSourceBrowser({ client, profile, scope, target, sourceTarget, uploaded, isCurrent, onJob }: { client: MobileMigrationClient; profile: GatewayProfile; scope: string; target: SourceTarget; sourceTarget: SourceTarget; uploaded?: SourceUploadState; isCurrent(): boolean; onJob(job: MigrationJobReadResult): void }) {
  const styles = useThemedStyles(makeStyles);
  const [instructionMode, setInstructionMode] = useState(false);
  const [mode, setMode] = useState<SourceMode>('configuration'), [kind, setKind] = useState<MigrationSourceKind | null>(uploaded?.source ?? null), [resuming, setResuming] = useState<MigrationSourceTransferResult | null>(null), [word, setWord] = useState('');
  const catalog = useMemo(() => new MobileSourceCatalog({ profile, captureScope: () => scope, target: sourceTarget, isCurrent, uploaded }), [profile, scope, sourceTarget, isCurrent, uploaded]);
  const transfer = useMemo(() => new MobileSourceTransfer({ profile, captureScope: () => scope, target, isCurrent, scope, storage: localStorage }), [profile, scope, target, isCurrent]);
  const state = useSyncExternalStore(catalog.subscribe, catalog.snapshot), copying = useSyncExternalStore(transfer.subscribe, transfer.snapshot);
  const [starting, setStarting] = useState(false), [error, setError] = useState<string | null>(null);
  const [includeProject, setIncludeProject] = useState(false);
  const [directory, setDirectory] = useState({ explicit: false, path: '' });
  useEffect(() => { catalog.activate(); transfer.activate(); return () => { catalog.dispose(); transfer.dispose(); }; }, [catalog, transfer]);
  useEffect(() => {
    if (!copying.result || copying.result.coordinatorState !== 'running' || copying.busy || copying.error) return;
    const timer = setTimeout(() => { void transfer.read(); }, 1000); return () => clearTimeout(timer);
  }, [transfer, copying.result, copying.busy, copying.error]);
  const busy = state.busy || copying.busy || starting, observation = copying.result?.result, receipt = observation?.receipt;
  const start = async () => {
    if (busy || copying.input || !isCurrent()) return;
    setStarting(true); setError(null);
    try { const selected = await catalog.selections(); if (isCurrent()) await transfer.start(selected.session, selected.selections); }
    catch { if (isCurrent()) setError('source_transfer_outcome_unknown'); }
    finally { if (isCurrent()) setStarting(false); }
  };
  if (instructionMode && !uploaded) return <MigrationInstructionSourceBrowser key={JSON.stringify([profile.id, scope, sourceTarget.id, sourceTarget.workspacePath ?? null, target.id, target.workspacePath ?? null])} client={client} profile={profile} scope={scope} target={target} sourceTarget={sourceTarget} isCurrent={isCurrent} onJob={onJob} onBack={() => setInstructionMode(false)}/>;
  return <View style={styles.stack} testID="migration-source-browser">
    {!uploaded ? <Button testID="source-browser-mode-instructions" variant="ghost" disabled={busy || !!copying.input} onPress={() => { void catalog.close(); setInstructionMode(true); }}>{t('migration_instructions.title')}</Button> : null}
    <Text style={styles.note}>{t(uploaded ? 'migration_source_upload.user_supplied' : 'migration_source.remote_boundary')}</Text>
    {mode === 'projects' ? <Text style={styles.note}>{t('migration_projects.boundary')}</Text> : null}
    <Text style={styles.note}>{t('migration_source.device_pair', { source: sourceTarget.id, target: target.id })}</Text>
    <View style={styles.actions}>{(['configuration', 'history', 'memory', 'definitions', 'plugins', ...(!uploaded ? ['projects' as const] : [])] as const).map(value => <Button key={value} testID={`source-browser-mode-${value}`} disabled={busy || !!copying.input} variant={mode === value ? 'secondary' : 'ghost'} onPress={() => { void catalog.close(); setMode(value); }}>{t(value === 'projects' ? 'migration_projects.title' : `migration_source.mode_${value}`)}</Button>)}</View>
    <View style={styles.actions}>{(['claude-code', 'codex'] as const).map(value => <Button key={value} testID={`source-browser-product-${value}`} disabled={busy || !!copying.input || !!uploaded} variant={kind === value ? 'secondary' : 'ghost'} onPress={() => { void catalog.close(); setKind(value); }}>{value === 'codex' ? 'Codex' : 'Claude Code'}</Button>)}</View>
    {!uploaded ? <View testID="source-directory-choice" style={styles.stack}>
      <Check testID="source-directory-explicit" checked={directory.explicit} disabled={busy || !!state.session || !!copying.input} label={t('migration_source.directory_explicit')} onPress={() => setDirectory(value => ({ ...value, explicit: !value.explicit }))}/>
      {directory.explicit ? <><Field testID="source-directory-path" value={directory.path} label={t('migration_source.directory_path')} editable={!busy && !state.session && !copying.input} accessibilityState={{ disabled: busy || !!state.session || !!copying.input }} onChangeText={path => { if (!busy && !state.session && !copying.input) setDirectory(value => ({ ...value, path })); }} autoCapitalize="none" autoCorrect={false} maxLength={4096}/><Text style={styles.note}>{t('migration_source.directory_boundary')}</Text>{directory.path && !validSourceDirectory(directory.path) ? <Text style={styles.warning}>{t('migration_source.directory_absolute')}</Text> : null}</> : <Text style={styles.note}>{t('migration_source.directory_automatic')}</Text>}
    </View> : null}
    {!uploaded && (mode === 'configuration' || mode === 'definitions' || mode === 'plugins') ? <Check testID="source-browser-project-consent" checked={includeProject} disabled={busy || !!state.session || !!copying.input || !sourceTarget.workspacePath} label={t('migration_source.include_project')} onPress={() => setIncludeProject(value => !value)}/> : null}
    <View style={styles.actions}><Button testID="source-browser-discover" disabled={!kind || busy || !!copying.input || state.releasePending || directory.explicit && !validSourceDirectory(directory.path)} onPress={() => { if (kind) void catalog.discover(mode, kind, includeProject, directory.explicit ? directory.path : undefined); }}>{t(mode === 'history' && state.familyMode ? 'migration_history_families.basic' : 'migration_source.discover')}</Button><Button testID="source-browser-release" disabled={busy || !!copying.input || !state.session} variant="ghost" onPress={() => { void catalog.close(); }}>{t('migration_source.release')}</Button></View>
    {mode === 'history' && kind === 'codex' ? <MigrationHistoryFamilyChoice disabled={busy || !!copying.input || state.releasePending || directory.explicit && !validSourceDirectory(directory.path)} active={state.familyMode} error={state.error}
      onDiscover={() => { void catalog.discover('history_families', 'codex', false, directory.explicit ? directory.path : undefined); }}/> : null}
    {mode === 'plugins' ? <Text style={styles.note}>{t('migration_source.plugin_boundary')}</Text> : null}
    {mode === 'plugins' && uploaded ? <Text style={styles.note}>{t('migration_source.plugin_uploaded')}</Text> : null}
    {mode === 'definitions' ? <Text style={styles.warning}>{t('migration_definitions.boundary')}</Text> : null}
    <MigrationProblem code={state.error ?? error ?? copying.error}/>
    {state.problems.map((code, i) => <Text key={i} style={styles.note}>{state.familyMode ? historyFamilyProblem(code) : code}</Text>)}
    {state.rows.map(row => <View key={row.id} testID={`source-browser-row-${row.id}`}>{row.historyGroup ? <MigrationHistoryFamilyLabel group={row.historyGroup}/> : null}<Check testID={`source-browser-select-${row.id}`} checked={state.selected.some(value => value.id === row.id)} disabled={busy || !!copying.input || row.blocked} label={row.label} onPress={() => catalog.select(row.id)}/><Text style={styles.note}>{row.detail}{row.compressed ? ` · ${t('migration_source.compressed')}` : ''}{row.archived ? ` · ${t('migration_source.archived')}` : ''}</Text>{row.blocked ? <Text style={styles.warning}>{t('migration_source.blocked')}</Text> : null}{mode === 'configuration' && kind === 'codex' && includeProject && !uploaded && row.detail === 'user' ? <Button testID={`source-codex-merge-${row.id}`} disabled={busy || !!copying.input} variant="ghost" onPress={() => { void catalog.mergeCodex(row.id); }}>{t('migration_codex.merge')}</Button> : null}{mode === 'configuration' && row.detail === 'codex-project-layers' ? <Button testID={`source-codex-report-${row.id}`} disabled={busy || !!copying.input} variant="ghost" onPress={() => { void catalog.readCodex(row.id); }}>{t('migration_codex.title')}</Button> : null}{mode === 'configuration' && kind === 'claude-code' ? <Button testID={`source-layer-report-${row.id}`} disabled={busy || !!copying.input} variant="ghost" onPress={() => { void catalog.report(row.id); }}>{t('migration_layers.title')}</Button> : null}</View>)}
    {state.report ? <View testID="source-layer-report" style={styles.stack}>
      <Text style={styles.note}>{t('migration_layers.boundary')}</Text>
      {state.report.status !== 'available' ? <Text style={styles.note}>{t(`migration_layers.${state.report.status}`)}</Text> : null}
      {state.report.fields.map(field => <View key={field.ordinal} testID="source-layer-field"><Text style={styles.text}>{field.field ?? t('migration_layers.unknown', { n: field.ordinal + 1 })}</Text><Text style={styles.note}>{t(field.supported ? 'migration_layers.supported' : 'migration_layers.unsupported')}{field.private ? ` · ${t('migration_layers.private')}` : ''} · {field.scopes.map(value => t(`migration_layers.${value}`)).join(' → ')}</Text></View>)}
      <PageControls previous={state.report.pageIndex > 0 && !busy} next={state.report.nextPage != null && !busy} onPrevious={() => { if (state.report?.target.kind === 'source') void catalog.report(state.report.target.sourceId, state.report.pageIndex - 1); }} onNext={() => { if (state.report?.target.kind === 'source' && state.report.nextPage != null) void catalog.report(state.report.target.sourceId, state.report.nextPage); }}/>
    </View> : null}
    {state.codexReport ? <View testID="source-codex-report" style={styles.stack}>
      <Text style={styles.note}>{t('migration_codex.boundary')}</Text>
      {state.codexReport.status !== 'available' ? <Text style={styles.note}>{t(`migration_layers.${state.codexReport.status}`)}</Text> : null}
      {state.codexReport.fields.map((field, i) => <View key={i} testID="source-codex-field"><Text style={styles.text}>{field.field ?? t('migration_layers.unknown', { n: state.codexReport!.pageIndex * 10 + i + 1 })}</Text><Text style={styles.note}>{t(field.ignored ? 'migration_codex.ignored' : field.supported ? 'migration_layers.supported' : 'migration_layers.unsupported')}{field.private ? ` · ${t('migration_layers.private')}` : ''}</Text></View>)}
      <PageControls previous={state.codexReport.pageIndex > 0 && !busy} next={state.codexReport.nextPage != null && !busy} onPrevious={() => { if (state.codexReport?.target.kind === 'source') void catalog.readCodex(state.codexReport.target.sourceId, state.codexReport.pageIndex - 1); }} onNext={() => { if (state.codexReport?.target.kind === 'source' && state.codexReport.nextPage != null) void catalog.readCodex(state.codexReport.target.sourceId, state.codexReport.nextPage); }}/>
    </View> : null}
    <PageControls previous={state.pageIndex > 0 && !busy && !copying.input} next={state.hasNext && !busy && !copying.input} onPrevious={() => { void catalog.page(state.pageIndex - 1); }} onNext={() => { void catalog.page(state.pageIndex + 1); }}/>
    <Text style={styles.note}>{t('migration_source.selected', { count: state.selected.length })}</Text>
    <Button testID="source-browser-transfer" disabled={busy || !!copying.input || !state.selected.length} onPress={() => { void start(); }}>{t('migration_source.transfer')}</Button>
    {copying.input ? <View style={styles.stack} testID="source-transfer-status">
      <Text selectable style={styles.note}>{copying.input.requestId}</Text><Text style={styles.title}>{t(!copying.error && observation ? observation.phase === 'ready' && receipt ? 'migration_source.received_not_imported' : `migration_source.transfer_${observation.phase}` : 'migration_source.unconfirmed')}</Text>
      <Text style={styles.note}>{t(`migration_source.coordinator_${copying.result?.coordinatorState ?? 'unknown'}`)}</Text>
      {copying.result?.progress?.phase === 'transferring' ? <Text style={styles.note}>{copying.result.progress.acceptedBytes} / {copying.result.progress.totalBytes}</Text> : null}
      <View style={styles.actions}><Button testID="source-transfer-read" disabled={copying.busy} variant="ghost" onPress={() => { void transfer.read(); }}>{t('migration_source.check_original')}</Button><Button testID="source-transfer-cancel" disabled={observation?.phase === 'ready'} onPress={() => { void transfer.cancel(); }}>{t('migration_source.cancel_transfer')}</Button><Button testID="source-transfer-resume" disabled={copying.busy || !copying.result || copying.result.coordinatorState === 'running' || !observation || 'scope' in observation || observation.targetWorkerRunning || !observation.sourceState || !observation.targetAdmissionControl || observation.phase === 'ready'} onPress={() => { setResuming(copying.result); setWord(''); }}>{t('migration_source.resume_transfer')}</Button></View>
      {resuming ? <Confirm testID="source-transfer-confirm" keyword="RESUME" value={word} onChange={setWord} busy={copying.busy} onDismiss={() => setResuming(null)} onConfirm={() => { void transfer.resume(resuming); setResuming(null); }}/> : null}
    </View> : null}
    {receipt && observation?.phase === 'ready' && !copying.error ? <MigrationAdoptionPanel client={client} profile={profile} scope={scope} target={target} receipt={receipt} isCurrent={isCurrent} onJob={onJob}/> : null}
  </View>;
}
