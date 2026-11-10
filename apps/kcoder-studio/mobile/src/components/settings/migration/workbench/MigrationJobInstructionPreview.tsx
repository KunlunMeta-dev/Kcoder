import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { Text, View } from 'react-native';
import { Button } from '@/components/ui';
import { t } from '@/i18n';
import { useThemedStyles } from '@/theme';
import type { MobileMigrationClient } from '@/runtime/migration-client';
import { InstructionPreviewController } from '../../../../../../shared/migrationInstructionPreview';
import { makeStyles } from '../migration-result-ui';
import { MigrationProblem } from './WorkbenchUi';
import { MigrationInstructionPreview } from '../source/MigrationInstructionPreview';

export function MigrationJobInstructionPreview({ client, jobId, itemId }: { client: MobileMigrationClient; jobId: string; itemId: string }) {
  const styles = useThemedStyles(makeStyles);
  const controller = useMemo(() => new InstructionPreviewController({
    instructionPage: input => client.call('instructionPage', input),
    instructionBody: input => client.call('instructionBody', input),
  }, { kind: 'job', jobId }, () => client.available()), [client, jobId, itemId]);
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot);
  useEffect(() => { controller.activate(); return controller.dispose; }, [controller]);
  return <View style={styles.stack} testID="migration-job-instruction-preview">
    <Text style={styles.note}>{t('migration_instructions.job_preview')}</Text>
    <View style={styles.actions}>
      <Button testID="instruction-job-original" variant="ghost" disabled={state.busy || !client.supports('instructionBody')}
        onPress={() => { void controller.preview(itemId, 'original'); }}>{t('migration_instructions.original')}</Button>
      <Button testID="instruction-job-compiled" variant="ghost" disabled={state.busy || !client.supports('instructionBody')}
        onPress={() => { void controller.preview(itemId, 'compiled'); }}>{t('migration_instructions.compiled')}</Button>
    </View>
    <MigrationProblem code={state.error}/>
    <MigrationInstructionPreview page={null} body={state.body} busy={state.busy} onPage={() => {}}
      onPreview={(id, representation, offset) => { void controller.preview(id, representation, offset); }}/>
  </View>;
}
