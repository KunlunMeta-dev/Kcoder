import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Text, View } from 'react-native';
import { Button, Field } from '@/components/ui';
import { t } from '@/i18n';
import { useThemedStyles } from '@/theme';
import type { GatewayProfile } from '@/gateway/types';
import { migrationRequestId, type MobileMigrationClient, type MigrationJobReadResult } from '@/runtime/migration-client';
import { createMigrationSourceSessionClient } from '@/runtime/migration-source/sessions';
import { validSourceDirectory } from '@/runtime/migration-source/directory-intent';
import { MobileSourceTransfer } from '@/runtime/migration-source/transfer-controller';
import type { SourceTarget } from '@/runtime/migration-source/catalog';
import { InstructionSourcesController } from '../../../../../../shared/migrationInstructionSources';
import type * as C from '../../../../../../shared/generated/contracts';
import { makeStyles } from '../migration-result-ui';
import { Check, Confirm, MigrationProblem } from '../workbench/WorkbenchUi';
import { MigrationInstructionPreview } from './MigrationInstructionPreview';
import { MigrationAdoptionPanel } from './MigrationAdoptionPanel.web';

export function MigrationInstructionSourceBrowser({ client, profile, scope, sourceTarget, target, isCurrent, onJob, onBack }: {
  client: MobileMigrationClient; profile: GatewayProfile; scope: string; sourceTarget: SourceTarget; target: SourceTarget;
  isCurrent(): boolean; onJob(value: MigrationJobReadResult): void; onBack(): void;
}) {
  const styles = useThemedStyles(makeStyles);
  const [source, setSource] = useState<C.MigrationSourceKind | null>(null), [root, setRoot] = useState(''),
    [cwd, setCwd] = useState(sourceTarget.workspacePath ?? ''), [descendants, setDescendants] = useState(false),
    [confirmed, setConfirmed] = useState(false), [resume, setResume] = useState<C.MigrationSourceTransferResult | null>(null), [word, setWord] = useState('');
  const controller = useMemo(() => {
    const owner = migrationRequestId();
    return new InstructionSourcesController({ targetId: sourceTarget.id, newId: migrationRequestId, isCurrent,
      api: createMigrationSourceSessionClient({ profile, captureScope: () => isCurrent() ? owner : '' }),
      cleanup: createMigrationSourceSessionClient({ profile, captureScope: () => owner }) });
  }, [profile, sourceTarget.id, scope, isCurrent]);
  const transfer = useMemo(() => new MobileSourceTransfer({ profile, captureScope: () => scope, target, isCurrent, scope, storage: localStorage }), [profile, scope, target, isCurrent]);
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot), copying = useSyncExternalStore(transfer.subscribe, transfer.snapshot);
  useEffect(() => { controller.activate(); transfer.activate(); return () => { controller.dispose(); transfer.dispose(); }; }, [controller, transfer]);
  useEffect(() => {
    if (copying.result?.coordinatorState !== 'running' || copying.busy || copying.error) return;
    const timer = setTimeout(() => { void transfer.read(); }, 1000);
    return () => clearTimeout(timer);
  }, [transfer, copying.result, copying.busy, copying.error]);
  const busy = state.busy || copying.busy, fixed = !!state.intent || !!copying.input;
  const observation = copying.result?.result, receipt = observation?.phase === 'ready' ? observation.receipt : null;
  return <View style={styles.stack} testID="migration-instruction-source">
    <Button variant="ghost" disabled={busy} onPress={onBack}>{t('migration_instructions.back')}</Button>
    <Text style={styles.title}>{t('migration_instructions.title')}</Text>
    <Text style={styles.note}>{t('migration_instructions.source_boundary')}</Text>
    <Text style={styles.note}>{t('migration_source.device_pair', { source: sourceTarget.id, target: target.id })}</Text>
    <View style={styles.actions}>{(['claude-code', 'codex'] as const).map(kind => <Button key={kind} testID={'instruction-source-' + kind}
      variant={source === kind ? 'secondary' : 'ghost'} disabled={busy || fixed} onPress={() => setSource(kind)}>{kind === 'codex' ? 'Codex' : 'Claude Code'}</Button>)}</View>
    <Field testID="instruction-source-root" label={t('migration_instructions.source_root')} value={root} editable={!busy && !fixed}
      autoCapitalize="none" autoCorrect={false} maxLength={4096} onChangeText={setRoot}/>
    <Field testID="instruction-source-cwd" label={t('migration_instructions.source_cwd')} value={cwd} editable={!busy && !fixed}
      autoCapitalize="none" autoCorrect={false} maxLength={4096} onChangeText={setCwd}/>
    <Check testID="instruction-source-descendants" checked={descendants} disabled={busy || fixed} label={t('migration_instructions.descendants')} onPress={() => setDescendants(value => !value)}/>
    <Check testID="instruction-source-confirm" checked={confirmed} disabled={busy || fixed} label={t('migration_instructions.static_consent')} onPress={() => setConfirmed(value => !value)}/>
    <View style={styles.actions}>
      <Button testID="instruction-source-capture" disabled={busy || fixed || !source || !confirmed || !validSourceDirectory(root) || !validSourceDirectory(cwd)}
        onPress={() => { if (source) void controller.capture({ source, sourceRoot: root, sourceCwd: cwd, format: 'static_v2', includeDescendants: descendants, confirmStaticSubset: true }); }}>{t('migration_instructions.capture')}</Button>
      <Button testID="instruction-source-observe" variant="ghost" disabled={busy || !state.intent || !!copying.input} onPress={() => { void controller.observe(); }}>{t('migration_source.check_original')}</Button>
      <Button testID="instruction-source-release" variant="ghost" disabled={busy || !state.session || !!copying.input} onPress={() => { void controller.close(); }}>{t('migration_source.release')}</Button>
    </View>
    <MigrationProblem code={state.error ?? copying.error}/>
    {state.capture ? <Text style={styles.note}>{t('migration_instructions.captured', { count: state.capture.totalItems })}</Text> : null}
    <MigrationInstructionPreview page={state.page} body={state.body} busy={busy}
      onPage={index => { void controller.page(index); }} onPreview={(id, representation, offset) => { void controller.preview(id, representation, offset); }}/>
    <Button testID="instruction-source-transfer" disabled={busy || !!copying.input || !state.page || !state.session || !state.intent || !!state.error}
      onPress={() => { if (state.session && state.intent) void transfer.start(state.session, [{ kind: 'instructions', captureId: state.intent.captureId }]); }}>{t('migration_source.transfer')}</Button>
    {copying.input ? <View style={styles.stack} testID="instruction-transfer-status">
      <Text selectable style={styles.note}>{copying.input.requestId}</Text>
      <Text style={styles.title}>{t(receipt ? 'migration_source.received_not_imported' : 'migration_source.unconfirmed')}</Text>
      <Text style={styles.note}>{t('migration_source.coordinator_' + (copying.result?.coordinatorState ?? 'unknown'))}</Text>
      <View style={styles.actions}>
        <Button testID="instruction-transfer-read" variant="ghost" disabled={copying.busy} onPress={() => { void transfer.read(); }}>{t('migration_source.check_original')}</Button>
        <Button testID="instruction-transfer-cancel" disabled={!!receipt} onPress={() => { void transfer.cancel(); }}>{t('migration_source.cancel_transfer')}</Button>
        <Button testID="instruction-transfer-resume" disabled={copying.busy || !copying.result || copying.result.coordinatorState === 'running' || !observation || 'scope' in observation || observation.targetWorkerRunning || !observation.sourceState || !observation.targetAdmissionControl || !!receipt}
          onPress={() => { setResume(copying.result); setWord(''); }}>{t('migration_source.resume_transfer')}</Button>
      </View>
      {resume ? <Confirm testID="instruction-transfer-confirm" keyword="RESUME" value={word} onChange={setWord} busy={copying.busy} onDismiss={() => setResume(null)}
        onConfirm={() => { void transfer.resume(resume); setResume(null); }}/> : null}
    </View> : null}
    {receipt && !copying.error ? <MigrationAdoptionPanel client={client} profile={profile} scope={scope} target={target} receipt={receipt} isCurrent={isCurrent} onJob={onJob}/> : null}
  </View>;
}
