import { useEffect, useMemo, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { Button } from '@/components/ui';
import { t } from '@/i18n';
import { useThemedStyles } from '@/theme';
import type { GatewayProfile } from '@/gateway/types';
import type { MobileMigrationClient, MigrationJobReadResult } from '@/runtime/migration-client';
import { createMigrationTargetRecovery } from '@/runtime/migration-source/target-recovery';
import type { SourceTarget } from '@/runtime/migration-source/catalog';
import type { MigrationSourceTransferResult } from '../../../../../../shared/generated/contracts';
import { makeStyles, PageControls } from '../migration-result-ui';
import { MigrationProblem } from '../workbench/WorkbenchUi';
import { MigrationAdoptionPanel } from './MigrationAdoptionPanel.web';

export function MigrationTransferRecords({ client, profile, target, scope, isCurrent, onJob }: { client: MobileMigrationClient; profile: GatewayProfile; target: SourceTarget; scope: string; isCurrent(): boolean; onJob(job: MigrationJobReadResult): void }) {
  const styles = useThemedStyles(makeStyles), active = useRef(true), generation = useRef(0);
  const manager = useMemo(() => createMigrationTargetRecovery({ profile, target, recoveryScope: scope, storage: localStorage, captureScope: () => isCurrent() && active.current ? scope : '', captureCleanupScope: () => scope }), [profile, target, scope, isCurrent]);
  const [opened, setOpened] = useState(false), [pageIndex, setPageIndex] = useState(0), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<ReturnType<typeof manager.list> | null>(null), [result, setResult] = useState<MigrationSourceTransferResult | null>(null);
  useEffect(() => { active.current = true; return () => { active.current = false; generation.current++; void manager.release().catch(() => {}); }; }, [manager]);
  const load = (index: number) => { try { if (!active.current || !isCurrent()) return; setRows(manager.list(index)); setPageIndex(index); setError(null); setOpened(true); } catch { setError('source_transfer_recovery_invalid'); } };
  const read = async (requestId: string) => {
    if (busy || !active.current || !isCurrent()) return;
    const ticket = ++generation.current; setBusy(true); setError(null); setResult(null);
    try { const next = await manager.read(requestId); if (active.current && isCurrent() && ticket === generation.current) setResult(next); }
    catch { if (active.current && isCurrent() && ticket === generation.current) setError('source_transfer_outcome_unknown'); }
    finally { if (active.current && isCurrent() && ticket === generation.current) setBusy(false); }
  };
  const receipt = result?.result?.receipt;
  return <View style={styles.stack} testID="migration-transfer-records">
    <Button testID="source-transfer-records-open" disabled={busy} variant="ghost" onPress={() => load(0)}>{t('migration_source.records')}</Button>
    <MigrationProblem code={error}/>
    {opened ? <><Text style={styles.note}>{t('migration_source.records_boundary')}</Text>{rows?.records.map(row => <Button key={row.request.requestId} testID={`source-transfer-record-${row.request.requestId}`} disabled={busy} variant="ghost" onPress={() => { void read(row.request.requestId); }}>{`${row.request.source.targetId} → ${row.request.target.targetId} · ${row.request.requestId.slice(0, 8)}`}</Button>)}{rows?.invalidRequestIds.length ? <Text style={styles.warning}>{t('migration_source.invalid_records')}</Text> : null}<PageControls previous={pageIndex > 0 && !busy} next={!!rows && (pageIndex + 1) * 10 < rows.total && !busy} onPrevious={() => load(pageIndex - 1)} onNext={() => load(pageIndex + 1)}/></> : null}
    {result ? <View><Text selectable style={styles.note}>{result.requestId}</Text><Text style={styles.note}>{t(result.result?.phase === 'ready' && receipt ? 'migration_source.received_not_imported' : 'migration_source.unconfirmed')}</Text><Text style={styles.note}>{t('migration_source.target_only')}</Text></View> : null}
    {receipt && result?.result?.phase === 'ready' && !error ? <MigrationAdoptionPanel client={client} profile={profile} target={target} scope={scope} receipt={receipt} isCurrent={isCurrent} onJob={onJob}/> : null}
  </View>;
}
