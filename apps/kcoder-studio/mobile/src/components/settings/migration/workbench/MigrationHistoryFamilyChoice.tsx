import { Text, View } from 'react-native';
import { useState } from 'react';
import { Button } from '@/components/ui';
import { t } from '@/i18n';
import { useThemedStyles } from '@/theme';
import { makeStyles } from '../migration-result-ui';
import type { SourceRow } from '@/runtime/migration-source/catalog';

export function MigrationHistoryFamilyChoice({ disabled, active = false, available = true, error, onDiscover }: {
  disabled: boolean; active?: boolean; available?: boolean; error?: string | null; onDiscover(): void;
}) {
  const styles = useThemedStyles(makeStyles);
  const [limits, setLimits] = useState(false);
  return <View testID="migration-history-family-choice" style={styles.stack}>
    <Text style={styles.note}>{t('migration_history_families.boundary')}</Text>
    <Button testID="migration-history-family-limits" variant="ghost" onPress={() => setLimits(value => !value)}>{t('migration_history_families.limits_title')}</Button>
    {limits ? <Text style={styles.note}>{t('migration_history_families.limits')}</Text> : null}
    <Button testID="migration-history-families-discover" disabled={disabled || !available} variant={active ? 'secondary' : 'ghost'} onPress={onDiscover}>{t('migration_history_families.discover')}</Button>
    {!available || active && error && (error.endsWith('update_required') || error === 'source_transfer_unsupported_native') ? <Text style={styles.warning}>{t('migration_history_families.update_required')}</Text> : null}
    {error && ['source_transfer_history_catalog_unavailable', 'source_transfer_catalog_expired', 'history_discovery_catalog_unavailable', 'history_discovery_family_metadata_changed', 'history_discovery_expired'].includes(error) ? <Text style={styles.warning}>{t('migration_history_families.catalog_unavailable')}</Text> : null}
  </View>;
}
const problems = new Set(['history_discovery_family_budget_exceeded', 'history_discovery_family_metadata_incomplete',
  'history_discovery_family_parent_conflict', 'history_discovery_family_parent_missing', 'history_discovery_family_cycle']);
export const historyFamilyProblem = (code: string) => t(problems.has(code) ? `migration_history_families.problem_${code}` : 'migration_history_families.incomplete');
export function MigrationHistoryFamilyLabel({ group }: { group: NonNullable<SourceRow['historyGroup']> }) {
  const styles = useThemedStyles(makeStyles);
  return <View testID="migration-history-family-label">
    <Text style={styles.title}>{t('migration_workbench.history_group', { title: group.title ?? group.sessionId })}</Text>
    <Text style={styles.note}>{t(group.lineageIssue ? `migration_history_families.issue_${group.lineageIssue}`
      : group.parentObserved && !group.parentOnPage ? 'migration_history_families.parent_observed'
        : group.related && !group.parentOnPage ? 'migration_workbench.history_parent_elsewhere' : 'migration_workbench.history_explicit')}</Text>
  </View>;
}
