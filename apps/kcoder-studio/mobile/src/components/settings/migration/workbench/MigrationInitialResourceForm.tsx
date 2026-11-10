import { useState } from 'react';
import { Text, View } from 'react-native';
import { Button, Field } from '@/components/ui';
import { t } from '@/i18n';
import { useThemedStyles } from '@/theme';
import { INITIAL_RESOURCE_FIELDS, initialResourceSelection, type InitialResourceDraft } from '../../../../../../shared/migrationInitialResourceLimits';
import { makeStyles } from '../migration-result-ui';
import { Check } from './WorkbenchUi';
type Props = { draft: InitialResourceDraft; onChange(value: InitialResourceDraft): void; disabled?: boolean; purpose?: 'attachment' };
const fieldLabels = {
  maxTotalBytes: 'migration_resources.initial.max_total_bytes',
  maxPayloadFiles: 'migration_resources.initial.max_payload_files',
  minFreeBytes: 'migration_resources.initial.min_free_bytes',
  minFreeFileNodes: 'migration_resources.initial.min_free_file_nodes',
};
export function MigrationInitialResourceForm({ draft, onChange, disabled, purpose }: Props) {
  const styles = useThemedStyles(makeStyles), [open, setOpen] = useState(false);
  return <View testID="migration-initial-resources" style={styles.stack}>
    <Button variant="ghost" testID="migration-initial-details" onPress={() => setOpen(value => !value)}>{t('migration_resources.initial.title')}</Button>
    {open ? <>
      <Text style={styles.note}>{t(purpose === 'attachment' ? 'migration_resources.attachment.form_boundary' : 'migration_resources.initial.boundary')}</Text>
      <Check testID="migration-initial-enabled" checked={draft.enabled} disabled={disabled} onPress={() => onChange({ ...draft, enabled: !draft.enabled })} label={t(purpose === 'attachment' ? 'migration_resources.attachment.custom' : 'migration_resources.initial.custom')}/>
      {draft.enabled ? INITIAL_RESOURCE_FIELDS.map(key => <Field key={key} testID={`migration-initial-${key}`} label={t(fieldLabels[key])} value={draft[key]} editable={!disabled} maxLength={16} keyboardType="number-pad" onChangeText={value => onChange({ ...draft, [key]: value })}/>) : null}
      {!initialResourceSelection(draft).valid ? <Text accessibilityRole="alert" style={styles.error}>{t('migration_resources.initial.invalid')}</Text> : null}
    </> : null}
  </View>;
}
