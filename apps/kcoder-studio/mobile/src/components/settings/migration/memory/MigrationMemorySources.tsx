import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { Button } from '@/components/ui';
import { t } from '@/i18n';
import { useThemedStyles } from '@/theme';
import type { MobileMigrationClient, MigrationCalls, MigrationSourceKind } from '@/runtime/migration-client';
import { makeStyles, PageControls, appendPage } from '../migration-result-ui';
import { Check, MigrationProblem } from '../workbench/WorkbenchUi';
import { useMigrationAction } from '../workbench/useMigrationAction';

/** Source group labels remain provenance; they never select a target workspace. */
export function MigrationMemorySources({ client, source, available, onSelection, onBusy }: { client: MobileMigrationClient; source: MigrationSourceKind; available: number; onSelection(ids: string[], incomplete: boolean): void; onBusy(busy: boolean): void }) {
  const styles = useThemedStyles(makeStyles), action = useMigrationAction(client);
  const [page, setPage] = useState<MigrationCalls['memoryDiscover'][1] | null>(null);
  const [pages, setPages] = useState<Array<string | null>>([null]), [selected, setSelected] = useState<string[]>([]);
  const [problemsSeen, setProblemsSeen] = useState(false);
  useEffect(() => { onBusy(action.busy); return () => onBusy(false); }, [action.busy, onBusy]);
  useEffect(() => { if (action.error) { setSelected([]); onSelection([], true); } }, [action.error]);
  const accept = (value: MigrationCalls['memoryDiscover'][1], next: Array<string | null>, ids = selected, fresh = false) => {
    if (value.nextCursor && next.includes(value.nextCursor)) throw new Error('migration_invalid_response');
    const partial = !fresh && problemsSeen || !!value.problems.length;
    setProblemsSeen(partial); setPage(value); setPages(next); onSelection(ids, partial);
  };
  const pageAt = (cursor: string | null, next: Array<string | null>) => {
    if (!page) return;
    void action.run(() => client.call('memorySources', { catalogId: page.catalogId, cursor }), value => accept(value, next));
  };
  const incomplete = problemsSeen || !!page?.problems.length;
  return <View style={styles.stack} testID="migration-memory-sources">
    <Text style={styles.note}>{t('migration_memory.source_boundary')}</Text>
    <MigrationProblem code={action.error}/>
    <Button testID="migration-discover-memory" disabled={action.busy || !client.supports('memoryDiscover')} onPress={() => {
      setSelected([]); setPage(null); setProblemsSeen(false); onSelection([], false);
      void action.run(() => client.call('memoryDiscover', { source }), value => accept(value, [null], [], true));
    }}>{t('migration_memory.discover')}</Button>
    {page?.items.map(row => <View key={row.sourceId}>
      <Check testID={`migration-memory-source-${row.sourceId}`} label={`${row.sourceGroup} · ${row.layout} · ${row.files}`} checked={selected.includes(row.sourceId)} disabled={action.busy || !selected.includes(row.sourceId) && available < 1} onPress={() => {
        const next = selected.includes(row.sourceId) ? selected.filter(id => id !== row.sourceId) : available > 0 ? [...selected, row.sourceId] : selected;
        setSelected(next); onSelection(next, incomplete);
      }}/>{row.blockedItems ? <Text style={styles.warning}>{t('migration_memory.blocked', { count: row.blockedItems })}</Text> : null}
    </View>)}
    {page?.problems.map((problem, i) => <Text key={i} style={styles.warning}>{problem.code} · {problem.count}</Text>)}
    {page?.unobserved.map((code, i) => <Text key={i} style={styles.note}>{code}</Text>)}
    {page ? <PageControls previous={pages.length > 1 && !action.busy} next={!!page.nextCursor && !action.busy} onPrevious={() => { const next = pages.slice(0, -1); pageAt(next.at(-1) ?? null, next); }} onNext={() => { if (page.nextCursor) pageAt(page.nextCursor, appendPage(pages, page.nextCursor)); }}/> : null}
  </View>;
}
