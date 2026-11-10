import { useState } from 'react';
import { Text, View } from 'react-native';
import { Button } from '@/components/ui';
import { t } from '@/i18n';
import { useThemedStyles } from '@/theme';
import { migrationRequestId, type MobileMigrationClient } from '@/runtime/migration-client';
import type { MigrationHistoryCreateParams, MigrationResourceLimits } from '../../../../../../shared/generated/contracts';
import { makeStyles } from '../migration-result-ui';
import { useMigrationAction } from './useMigrationAction';
import { MigrationProblem } from './WorkbenchUi';
/** Once dispatched, this control only reads the chosen Native creation identity. */
export function MigrationStandaloneHistoryCreate({ client, catalogId, sourceHandle, resourceLimits, disabled, onCreated }: { client: MobileMigrationClient; catalogId: string; sourceHandle: string; resourceLimits?: MigrationResourceLimits; disabled: boolean; onCreated(id: string): void }) {
  const action = useMigrationAction(client), styles = useThemedStyles(makeStyles);
  const [intent, setIntent] = useState<MigrationHistoryCreateParams | null>(null);
  const create = () => {
    if (intent) return;
    const original = { catalogId, sourceHandle, requestId: migrationRequestId(), ...(resourceLimits ? { resourceLimits: { ...resourceLimits } } : {}) };
    setIntent(original);
    void action.run(() => client.call('historyCreate', original), result => onCreated(result.job.jobId));
  };
  return <View style={styles.stack}>
    <MigrationProblem code={action.error}/>
    {intent ? <><Text style={styles.note}>{t('migration_resources.initial.created_boundary')}</Text><Button testID={`migration-standalone-read-${sourceHandle}`} disabled={action.busy} variant="ghost" onPress={() => { void action.run(() => client.call('historyRead', { jobId: intent.requestId }), value => onCreated(value.job.jobId)); }}>{t('migration_workbench.reconcile')}</Button></> : <Button testID={`migration-standalone-create-${sourceHandle}`} variant="ghost" disabled={disabled || action.busy || !client.supports('historyCreate')} onPress={create}>{t('migration_resources.initial.standalone')}</Button>}
  </View>;
}
