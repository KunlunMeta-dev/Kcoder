import type { ReactNode } from 'react';
import { View } from 'react-native';
import { useThemedStyles } from '@/theme';
import { historySourceGroups } from '../../../../../../shared/migrationHistoryGroups';
import type { HistorySourceSummary } from '../../../../../../shared/generated/contracts';
import type { HistoryFamilyGroup } from '../../../../../../shared/migrationHistoryFamilies';
import { MigrationHistoryFamilyLabel } from './MigrationHistoryFamilyChoice';
import { makeStyles } from '../migration-result-ui';

export function MigrationHistoryGroups({ items, children, groups }: {
  items: readonly HistorySourceSummary[];
  children: (item: HistorySourceSummary) => ReactNode;
  groups?: readonly HistoryFamilyGroup[] | null;
}) {
  const styles = useThemedStyles(makeStyles);
  return <View style={styles.stack} testID="migration-history-groups">{(groups ?? historySourceGroups(items)).map(group =>
    <View key={group.key} testID="migration-history-group">
      {(group.related || group.items.length > 1 || 'lineageIssue' in group && group.lineageIssue) ? <MigrationHistoryFamilyLabel group={group}/> : null}
      {group.items.map(children)}
    </View>)}</View>;
}
