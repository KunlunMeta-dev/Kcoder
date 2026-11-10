import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { Text, View } from 'react-native';
import { Field } from '@/components/ui';
import { t } from '@/i18n';
import { useThemedStyles } from '@/theme';
import type { MobileMigrationClient } from '@/runtime/migration-client';
import { InstructionPreviewController } from '../../../../../../shared/migrationInstructionPreview';
import type * as C from '../../../../../../shared/generated/contracts';
import { makeStyles } from '../migration-result-ui';
import { Check, MigrationProblem } from '../workbench/WorkbenchUi';
import { MigrationInstructionPreview } from './MigrationInstructionPreview';

export function MigrationInstructionMapping({ client, receipt, entryId, mapping, disabled, isCurrent, onChange }: {
  client: MobileMigrationClient; receipt: C.MigrationSourceReceipt; entryId: string;
  mapping?: C.MigrationSourceInstructionMapping; disabled: boolean; isCurrent(): boolean;
  onChange(value: C.MigrationSourceInstructionMapping): void;
}) {
  const styles = useThemedStyles(makeStyles);
  const controller = useMemo(() => new InstructionPreviewController({
    instructionPage: input => client.call('instructionPage', input),
    instructionBody: input => client.call('instructionBody', input),
  }, { kind: 'received', requestId: receipt.requestId, manifestSha256: receipt.manifestSha256, entryId }, () => isCurrent() && client.available()),
  [client, receipt.requestId, receipt.manifestSha256, entryId, isCurrent]);
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot);
  useEffect(() => { controller.activate(); void controller.load(); return controller.dispose; }, [controller]);
  const change = (patch: Partial<C.MigrationSourceInstructionMapping>) => {
    if (!disabled && isCurrent()) onChange({ entryId, items: mapping?.items ?? [], archiveIncompleteChain: mapping?.archiveIncompleteChain ?? false, ...patch });
  };
  return <View style={styles.stack} testID={'instruction-mapping-' + entryId}>
    <Text style={styles.note}>{t('migration_instructions.mapping_boundary')}</Text>
    <MigrationProblem code={state.error}/>
    <Check testID={'instruction-archive-' + entryId} checked={mapping?.archiveIncompleteChain === true} disabled={disabled || state.busy}
      label={t('migration_instructions.archive_incomplete')} onPress={() => change({ archiveIncompleteChain: !mapping?.archiveIncompleteChain })}/>
    <MigrationInstructionPreview page={state.page} body={state.body} busy={disabled || state.busy}
      onPage={index => { void controller.load(index); }} onPreview={(id, representation, offset) => { void controller.preview(id, representation, offset); }}
      extra={item => {
        const choice = mapping?.items.find(row => row.itemId === item.itemId);
        return <View style={styles.stack}>
          <Check testID={'instruction-map-select-' + item.itemId} checked={!!choice} disabled={disabled || state.busy}
            label={t('migration_instructions.map_item')} onPress={() => change({ items: choice
              ? (mapping?.items ?? []).filter(row => row.itemId !== item.itemId)
              : [...(mapping?.items ?? []), { itemId: item.itemId, targetRelativeScope: '' }] })}/>
          {choice ? <Field testID={'instruction-map-scope-' + item.itemId} label={t('migration_instructions.target_scope')}
            hint={t('migration_instructions.target_scope_hint')} value={choice.targetRelativeScope} editable={!disabled && !state.busy}
            autoCapitalize="none" autoCorrect={false} maxLength={4096}
            onChangeText={targetRelativeScope => change({ items: (mapping?.items ?? []).map(row => row.itemId === item.itemId ? { ...row, targetRelativeScope } : row) })}/> : null}
        </View>;
      }}/>
  </View>;
}
