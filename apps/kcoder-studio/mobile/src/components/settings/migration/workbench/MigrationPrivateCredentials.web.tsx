import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Text, View } from 'react-native';
import { Button } from '@/components/ui';
import { t } from '@/i18n';
import { useThemedStyles } from '@/theme';
import { useSettingsTarget } from '../../SettingsTargetContext';
import { SettingsGroup } from '../../settings-layout';
import { MobilePrivateCredentialController } from '@/runtime/migration-source/private-credential-controller';
import type { MobileMigrationClient, MigrationJobReadResult } from '@/runtime/migration-client';
import type { MigrationSourceCredentialSide, MigrationSourceCredentialWatermark, MigrationSourceCredentialCandidate } from '../../../../../../shared/generated/contracts';
import { CREDENTIAL_SOURCES_CAPABILITY } from '../../../../../../shared/migrationCredentialSources';
import { Sha256Stream } from '@/protocol/sha256-stream';
import { makeStyles, PageControls } from '../migration-result-ui';
import { Check, Confirm } from './WorkbenchUi';

type Props = { client: MobileMigrationClient; job: MigrationJobReadResult; onPrepared(): void };
type Confirmation = { kind: 'run' | 'prepare' | 'restore'; signature: string }
  | { kind: 'cancel'; side: MigrationSourceCredentialSide; signature: string }
  | { kind: 'resume'; side: MigrationSourceCredentialSide; control: MigrationSourceCredentialWatermark; signature: string };
export function MigrationPrivateCredentials(props: Props) {
  const selected = useSettingsTarget();
  if (!selected.ready || !selected.profile || !selected.server || !selected.targetIdentity || !props.job.batch?.planId
    || !props.client.supportsCapability(CREDENTIAL_SOURCES_CAPABILITY)) return null;
  return <OwnedPrivateCredentials key={`${selected.targetIdentity}:${props.job.job.jobId}:${props.job.batch.planId}:${props.job.job.sequence}`} {...props}
    profile={selected.profile} server={selected.server} servers={selected.servers} workspacePath={selected.workspacePath} identity={selected.targetIdentity}/>;
}
function OwnedPrivateCredentials({ client, job, onPrepared, profile, server, servers, workspacePath, identity }: Props & {
  profile: NonNullable<ReturnType<typeof useSettingsTarget>['profile']>; server: NonNullable<ReturnType<typeof useSettingsTarget>['server']>;
  servers: ReturnType<typeof useSettingsTarget>['servers']; workspacePath?: string; identity: string;
}) {
  const styles = useThemedStyles(makeStyles), latest = useRef({ client, identity, onPrepared });
  useLayoutEffect(() => { latest.current = { client, identity, onPrepared }; }, [client, identity, onPrepared]);
  const controller = useMemo(() => new MobilePrivateCredentialController({ client, job, profile,
    target: { id: server.id, ...(workspacePath === undefined ? {} : { workspacePath }) },
    scope: new Sha256Stream().update(new TextEncoder().encode(identity)).digestHex(),
    isCurrent: () => latest.current.client === client && latest.current.identity === identity && client.available(),
    onPrepared: () => latest.current.onPrepared(),
  }), [client, job.job.jobId, job.job.sequence, job.batch?.planId, profile, server.id, workspacePath, identity]);
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot, controller.snapshot);
  const busy = state.busy || state.controlBusy;
  useEffect(() => { controller.activate(); return () => controller.dispose(); }, [controller]);
  const [expanded, setExpanded] = useState(false), [deviceIndex, setDeviceIndex] = useState(0), [preparationPage, setPreparationPage] = useState(0);
  const [apiKeys, setApiKeys] = useState(false), [mcpPrivateFields, setMcpPrivateFields] = useState(false);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null), [word, setWord] = useState('');
  const signature = (kind: Confirmation['kind'], side?: MigrationSourceCredentialSide) => kind === 'restore' ? JSON.stringify(state.preparation) : kind === 'cancel'
    ? JSON.stringify([state.input?.locator, state.input?.source, state.device, side])
    : kind === 'resume' && side ? JSON.stringify([state.input?.locator, state.input?.source, state.device, side, state.observed[side], state.workers[side]])
      : JSON.stringify([state.selected, state.device, state.selections, state.included, apiKeys, mcpPrivateFields, state.input?.locator]);
  const canRun = !!state.device && Object.values(state.selections).length > 0
    && Object.values(state.selections).every(row => row.kind === 'provider' ? apiKeys : mcpPrivateFields);
  const confirm = (value: Omit<Extract<Confirmation, { kind: 'run' | 'prepare' | 'restore' }>, 'signature'> | Omit<Extract<Confirmation, { kind: 'cancel' }>, 'signature'> | Omit<Extract<Confirmation, { kind: 'resume' }>, 'signature'>) => {
    setWord(''); setConfirmation({ ...value, signature: signature(value.kind, 'side' in value ? value.side : undefined) } as Confirmation);
  };
  const keyword = confirmation?.kind === 'run' ? 'TRANSFER' : confirmation?.kind === 'restore' ? 'PREPARE' : confirmation?.kind.toUpperCase() ?? '';
  const confirmationBusy = state.controlBusy || (confirmation?.kind !== 'cancel' && state.busy);
  const confirmationChanged = !!confirmation && confirmation.signature !== signature(confirmation.kind, 'side' in confirmation ? confirmation.side : undefined);
  const submit = () => {
    if (!confirmation || confirmationChanged || word !== keyword || confirmationBusy) return;
    if (confirmation.kind === 'run') void controller.run({ apiKeys, mcpPrivateFields });
    else if (confirmation.kind === 'prepare') void controller.prepare(true);
    else if (confirmation.kind === 'restore') void controller.restorePreparation(true);
    else if (confirmation.kind === 'cancel') void controller.control(confirmation.side, 'cancel');
    else if (confirmation.kind === 'resume') void controller.control(confirmation.side, 'resume', confirmation.control);
    setConfirmation(null); setWord('');
  };
  return <SettingsGroup title={t('migration_private.title')}>
    <View style={styles.stack} testID="migration-private-credentials">
      <Button testID="migration-private-details" variant="ghost" onPress={() => setExpanded(value => !value)}>{t('migration_private.details')}</Button>
      {expanded ? <>
        <Text style={styles.note}>{t('migration_private.boundary')}</Text>
        {state.error ? <View><Text accessibilityRole="alert" style={styles.error}>{t(state.error.includes('update_required') ? 'migration_private.update_required' : 'migration_private.request_failed')}</Text><Text selectable style={styles.note}>{state.error}</Text></View> : null}
        <Button testID="migration-private-sources" variant="ghost" disabled={busy} onPress={() => { void controller.load(); }}>{t('migration_private.load_sources')}</Button>
        {state.page ? <>
          {state.page.items.map(row => <Button key={`${row.requestId}:${row.entryId}`} testID={`migration-private-source-${row.entryId}`}
            variant={state.selected?.requestId === row.requestId && state.selected.entryId === row.entryId ? 'secondary' : 'ghost'} disabled={busy}
            onPress={() => { controller.select(row); setApiKeys(false); setMcpPrivateFields(false); setConfirmation(null); }}>
            {`${row.source} · ${row.entryId} · ${t(row.projectScoped ? 'migration_private.project_source' : 'migration_private.user_source')}`}
          </Button>)}
          {!state.page.items.length ? <Text style={styles.note}>{t('migration_private.no_sources')}</Text> : null}
          <PageControls previous={state.pageIndex > 0 && !busy} next={state.page.nextPage != null && !busy}
            onPrevious={() => { void controller.load(state.pageIndex - 1); }} onNext={() => { if (state.page?.nextPage != null) void controller.load(state.page.nextPage); }}/>
        </> : null}
        {state.selected ? <>
          <Text selectable style={styles.note}>{t('migration_private.original_source')} · {state.selected.requestId} · {state.selected.sourceBindingRevision}</Text>
          <Button testID="migration-private-preparation-read" variant="ghost" disabled={state.controlBusy} onPress={() => { setPreparationPage(0); void controller.preparationRead(); }}>{t('migration_private.preparation_read')}</Button>
          <Text style={styles.note}>{t('migration_private.choose_device')}</Text>
          <View style={styles.actions}>{servers.slice(deviceIndex * 10, deviceIndex * 10 + 10).map(value => <Button key={value.id} testID={`migration-private-device-${value.id}`}
            variant={state.device?.id === value.id ? 'secondary' : 'ghost'} disabled={busy} onPress={() => controller.device({ id: value.id, ...(value.workspacePath === undefined ? {} : { workspacePath: value.workspacePath }) })}>{value.label || value.id}</Button>)}</View>
          <PageControls previous={deviceIndex > 0 && !busy} next={(deviceIndex + 1) * 10 < servers.length && !busy} onPrevious={() => setDeviceIndex(value => value - 1)} onNext={() => setDeviceIndex(value => value + 1)}/>
          <Button testID="migration-private-candidates" variant="ghost" disabled={busy} onPress={() => { void controller.candidates(); }}>{t('migration_private.load_candidates')}</Button>
        </> : null}
        {state.preparation ? <View testID="migration-private-preparation" style={styles.row}>
          <Text testID="migration-private-preparation-status" style={styles.title}>{t(`migration_private.preparation_${state.preparation.phase}`)}</Text>
          <Text style={styles.note}>{t('migration_private.preparation_boundary')}</Text>
          {state.preparation.offerIds ? <View>
            <Text style={styles.note}>{t('migration_private.preparation_offers', { count: state.preparation.offerIds.length })}</Text>
            <Text style={styles.note}>{t('migration_private.preparation_sequence', { sequence: state.preparation.expectedSequence ?? '—' })}</Text>
            <Text style={styles.note}>{t('migration_private.preparation_keys')} · {t(state.preparation.consent?.apiKeys ? 'migration_private.consent_yes' : 'migration_private.consent_no')}</Text>
            <Text style={styles.note}>{t('migration_private.preparation_mcp')} · {t(state.preparation.consent?.mcpPrivateFields ? 'migration_private.consent_yes' : 'migration_private.consent_no')}</Text>
            <View testID="migration-private-preparation-offers">{state.preparation.offerIds.slice(preparationPage * 10, preparationPage * 10 + 10).map(id => <Text selectable style={styles.note} key={id}>{id}</Text>)}</View>
            <PageControls previous={preparationPage > 0 && !busy} next={(preparationPage + 1) * 10 < state.preparation.offerIds.length && !busy} onPrevious={() => setPreparationPage(value => value - 1)} onNext={() => setPreparationPage(value => value + 1)}/>
          </View> : null}
          {state.preparation.phase === 'pending' ? <Button testID="migration-private-preparation-restore" disabled={busy} onPress={() => confirm({ kind: 'restore' })}>{t('migration_private.preparation_restore')}</Button> : null}
        </View> : null}
        {state.candidates ? <>
          {state.candidates.items.map(row => <Candidate key={row.itemId} row={row} value={state.selections[row.itemId]} busy={busy} controller={controller}/>)}
          {!state.candidates.items.length ? <Text style={styles.note}>{t('migration_private.no_candidates')}</Text> : null}
          <PageControls previous={state.candidateIndex > 0 && !busy} next={state.candidates.nextPage != null && !busy}
            onPrevious={() => { void controller.candidates(state.candidateIndex - 1); }} onNext={() => { if (state.candidates?.nextPage != null) void controller.candidates(state.candidates.nextPage); }}/>
          <Check testID="migration-private-consent-keys" checked={apiKeys} disabled={busy} onPress={() => setApiKeys(value => !value)} label={t('migration_private.consent_keys')}/>
          <Check testID="migration-private-consent-mcp" checked={mcpPrivateFields} disabled={busy} onPress={() => setMcpPrivateFields(value => !value)} label={t('migration_private.consent_mcp')}/>
          <Button testID="migration-private-transfer" disabled={busy || !canRun} onPress={() => confirm({ kind: 'run' })}>{t('migration_private.transfer')}</Button>
        </> : null}
        {state.records.length ? <View testID="migration-private-records">
          <Text style={styles.note}>{t('migration_private.recovery_boundary')}</Text>
          {state.records.map(record => <Button key={record.locator.offerId} testID={`migration-private-recover-${record.locator.offerId}`} variant="ghost" disabled={busy} onPress={() => { void controller.read(record); }}>{t('migration_private.check_offer')} · {record.locator.offerId}</Button>)}
          <PageControls previous={state.recordIndex > 0 && !busy} next={state.nextRecordPage != null && !busy} onPrevious={() => { void controller.records(state.recordIndex - 1); }} onNext={() => { if (state.nextRecordPage != null) void controller.records(state.nextRecordPage); }}/>
        </View> : null}
        {state.input ? <View style={styles.row} testID="migration-private-offer">
          <Text selectable style={styles.note}>{state.input.locator.offerId}</Text>
          <Text style={styles.note}>{t('migration_private.original_device')} · {state.input.source?.targetId}</Text>
          <Text style={styles.note}>{t('migration_private.cancel_boundary')}</Text>
          <Button testID="migration-private-read" variant="ghost" disabled={state.controlBusy} onPress={() => { void controller.read(); }}>{t('migration_private.check_offer')}</Button>
          <Button testID="migration-private-source-read" variant="ghost" disabled={state.controlBusy || !state.device} onPress={() => { void controller.sourceRead(); }}>{t('migration_private.check_source')}</Button>
          <Text style={styles.note}>{t(state.result ? `migration_private.phase_${state.result.phase}` : 'migration_private.unknown')}</Text>
          {(['source', 'target'] as const).map(side => <View key={side}>
            <Text style={styles.note}>{t(`migration_private.side_${side}`)} · {t(state.workers[side] == null ? 'migration_private.worker_unknown' : state.workers[side] ? 'migration_private.worker_running' : 'migration_private.worker_stopped')}</Text>
            {state.observed[side]?.cancelled ? <Text testID={`migration-private-cancelled-${side}`} style={styles.warning}>{t(state.workers[side] === false ? 'migration_private.phase_cancelled' : 'migration_private.cancellation_unconfirmed')}</Text> : null}
            <View style={styles.actions}><Button testID={`migration-private-cancel-${side}`} variant="ghost" disabled={state.controlBusy || side === 'source' && !state.device} onPress={() => confirm({ kind: 'cancel', side })}>{t('migration_private.cancel')}</Button>
              <Button testID={`migration-private-resume-${side}`} variant="ghost" disabled={busy || !state.observed[side] || state.workers[side] !== false} onPress={() => { const control = state.observed[side]; if (control) confirm({ kind: 'resume', side, control }); }}>{t('migration_private.resume')}</Button></View>
          </View>)}
          {state.result?.received && !state.result.keyReleased && !state.result.targetControl?.cancelled && state.result.targetWorkerRunning === false ? <Check testID="migration-private-include-offer" checked={state.included.some(row => row.locator.offerId === state.input?.locator.offerId)} disabled={busy || state.included.some(row => row.locator.requestId !== state.input?.locator.requestId)} onPress={() => controller.include(!state.included.some(row => row.locator.offerId === state.input?.locator.offerId))} label={t('migration_private.include_offer')}/> : null}
        </View> : null}
        {state.included.length ? <View testID="migration-private-included" style={styles.row}>
          <Text style={styles.note}>{t('migration_private.included', { count: state.included.length })}</Text>
          {state.included.map(row => <View key={row.locator.offerId}><Text selectable style={styles.note}>{row.locator.offerId}</Text><Button testID={`migration-private-exclude-${row.locator.offerId}`} variant="ghost" disabled={busy} onPress={() => controller.exclude(row.locator.offerId)}>{t('migration_workbench.remove')}</Button></View>)}
          <Text style={styles.note}>{t('migration_private.same_request')}</Text>
          <Button testID="migration-private-prepare" disabled={busy} onPress={() => confirm({ kind: 'prepare' })}>{t('migration_private.prepare')}</Button>
        </View> : null}
        {state.prepareUnknown ? <Text style={styles.warning}>{t('migration_private.prepare_unknown')}</Text> : null}
        <Button testID="migration-private-batch-read" variant="ghost" disabled={busy} onPress={() => { void controller.readBatch(); }}>{t('migration_private.read_batch')}</Button>
        {confirmation ? <Confirm testID="migration-private-confirm" keyword={keyword} value={word} onChange={setWord} onDismiss={() => setConfirmation(null)} busy={confirmationBusy} disabled={confirmationChanged} onConfirm={submit}/> : null}
      </> : null}
    </View>
  </SettingsGroup>;
}
function Candidate({ row, value, busy, controller }: { row: MigrationSourceCredentialCandidate; value?: import('../../../../../../shared/generated/contracts').MigrationSourceCredentialSelection; busy: boolean; controller: MobilePrivateCredentialController }) {
  const styles = useThemedStyles(makeStyles), disabled = busy || row.issueCode != null || row.targets?.length !== 1;
  const [pageIndex, setPageIndex] = useState(0);
  const count = row.kind === 'provider' ? row.selectors.length : row.fields.length;
  return <View testID={`migration-private-candidate-${row.itemId}`} style={styles.row}>
    <Text style={styles.title}>{row.sourceName ?? t('migration_private.source_unknown')}</Text>
    <Text style={styles.note}>{t('migration_private.exact_target')} · {row.targets?.[0]?.targetName ?? t('migration_private.target_unavailable')}</Text>
    {row.issueCode ? <Text style={styles.warning}>{t('migration_private.candidate_unavailable')}</Text> : null}
    {row.kind === 'provider' ? row.selectors.slice(pageIndex * 10, pageIndex * 10 + 10).map((selector, at) => { const index = pageIndex * 10 + at; return <Check key={index} testID={`migration-private-selector-${row.itemId}-${index}`} disabled={disabled}
      checked={value?.kind === 'provider' && JSON.stringify(value.selector) === JSON.stringify(selector)} label={selector.kind === 'environment' ? `${t('migration_private.environment')} · ${selector.variable}` : t('migration_private.configuration_key')}
      onPress={() => controller.choose(row.itemId, value?.kind === 'provider' && JSON.stringify(value.selector) === JSON.stringify(selector) ? null : { kind: 'provider', selectorIndex: index })}/>; })
      : row.fields.slice(pageIndex * 10, pageIndex * 10 + 10).map((field, at) => {
        const index = pageIndex * 10 + at;
        const selected = value?.kind === 'mcp' ? row.fields.flatMap((item, position) => value.fields.some(chosen => chosen.kind === item.kind && chosen.name === item.name) ? [position] : []) : [];
        const next = selected.includes(index) ? selected.filter(item => item !== index) : [...selected, index];
        return <Check key={`${field.kind}:${field.name}`} testID={`migration-private-field-${row.itemId}-${index}`} disabled={disabled} checked={selected.includes(index)} label={`${t(`migration_private.field_${field.kind}`)} · ${field.name}`} onPress={() => controller.choose(row.itemId, next.length ? { kind: 'mcp', fieldIndices: next } : null)}/>;
      })}
    <PageControls previous={pageIndex > 0 && !busy} next={(pageIndex + 1) * 10 < count && !busy} onPrevious={() => setPageIndex(value => value - 1)} onNext={() => setPageIndex(value => value + 1)}/>
  </View>;
}
