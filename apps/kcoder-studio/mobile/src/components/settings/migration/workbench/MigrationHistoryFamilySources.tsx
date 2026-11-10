import { useEffect, useMemo, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { t } from '@/i18n';
import { useThemedStyles } from '@/theme';
import { migrationRequestId, type MobileMigrationClient, type MigrationBatchHistorySource, type MigrationHistorySourcesResult } from '@/runtime/migration-client';
import { HistoryFamilyCache, type HistoryFamilyGroup, validHistorySources } from '../../../../../../shared/migrationHistoryFamilies';
import { makeStyles, PageControls, appendPage } from '../migration-result-ui';
import { Check, MigrationProblem } from './WorkbenchUi';
import { useMigrationAction } from './useMigrationAction';
import { MigrationHistoryFamilyChoice, historyFamilyProblem } from './MigrationHistoryFamilyChoice';
import { MigrationHistoryGroups } from './MigrationHistoryGroups';

type Props = { client: MobileMigrationClient; available: number; disabled: boolean; resetKey: number; onStart(): void;
  onSelection(value: { client: MobileMigrationClient; resetKey: number; sources: MigrationBatchHistorySource[]; incomplete: boolean }): void; onBusy(value: boolean): void };
export function MigrationHistoryFamilySources(props: Props) {
  const owner = useMemo(() => migrationRequestId(), [props.client, props.resetKey]);
  return <OwnedFamilySources key={owner} {...props} owner={owner}/>;
}
function OwnedFamilySources({ client, available, disabled, resetKey, onStart, onSelection, onBusy, owner }: Props & { owner: string }) {
  const styles = useThemedStyles(makeStyles), action = useMigrationAction(client);
  const [page, setPage] = useState<MigrationHistorySourcesResult | null>(null), [groups, setGroups] = useState<HistoryFamilyGroup[] | null>(null);
  const [pages, setPages] = useState<Array<string | null>>([null]), [selected, setSelected] = useState<MigrationBatchHistorySource[]>([]);
  const cache = useRef(new HistoryFamilyCache(owner));
  useEffect(() => { onBusy(action.busy); return () => onBusy(false); }, [action.busy, onBusy]);
  const publish = (sources: MigrationBatchHistorySource[], value: MigrationHistorySourcesResult | null) => onSelection({ client, resetKey, sources,
    incomplete: !!action.error || !!value && (!value.discoveryComplete || value.problems.length > 0) });
  const accept = (value: MigrationHistorySourcesResult, next: Array<string | null>, sources: MigrationBatchHistorySource[], previous?: MigrationHistorySourcesResult) => {
    if (!validHistorySources('codex', value, previous ? { catalogId: previous.catalogId, totalItems: previous.totalItems, cursor: next.at(-1) } : undefined)
      || value.nextCursor && next.includes(value.nextCursor)) throw new Error('migration_invalid_history_catalog');
    const projection = cache.current.observe(owner, value);
    setPage(value); setGroups(projection); setPages(next); setSelected(sources); publish(sources, value);
  };
  const at = (cursor: string | null, next: Array<string | null>) => {
    if (!page) return;
    const previous = page, sources = selected;
    setPage(null); setGroups(null); setSelected([]); publish([], previous);
    void action.run(() => client.call('historySources', { catalogId: previous.catalogId, cursor }), value => accept(value, next, sources, previous));
  };
  return <View testID="migration-local-history-families" style={styles.stack}>
    <MigrationHistoryFamilyChoice disabled={disabled || action.busy} available={client.supports('historyFamilies') && client.supportsCapability('migrationBatchWorkersV1')} active={!!page} error={action.error}
      onDiscover={() => { onStart(); setPage(null); setGroups(null); setSelected([]); publish([], null); cache.current = new HistoryFamilyCache(owner);
        void action.run(() => client.call('historyFamilies', { source: 'codex' }), value => accept(value, [null], [])); }}/>
    <MigrationProblem code={action.error}/>
    {page ? <>
      {!page.discoveryComplete || page.problems.length ? <Text style={styles.warning}>{t('migration_history_families.incomplete')}</Text> : null}
      <MigrationHistoryGroups items={page.items} groups={groups}>{row => <View key={row.sourceHandle}>
        <Check testID={`migration-family-source-${row.sourceHandle}`} label={row.title || row.sourceSessionId} checked={selected.some(item => item.sourceHandle === row.sourceHandle)}
          disabled={disabled || action.busy || row.importIssues.length > 0 || !selected.some(item => item.sourceHandle === row.sourceHandle) && available < 1}
          onPress={() => { const old = selected.filter(item => item.sourceHandle !== row.sourceHandle), next = old.length < selected.length ? old
            : available > 0 ? [...selected, { catalogId: page.catalogId, sourceHandle: row.sourceHandle }] : selected;
            setSelected(next); publish(next, page); }}/>
      </View>}</MigrationHistoryGroups>
      {page.problems.map(problem => <Text key={problem.code} style={styles.warning}>{historyFamilyProblem(problem.code)} · {problem.count}</Text>)}
      <PageControls previous={pages.length > 1 && !action.busy && !disabled} next={!!page.nextCursor && !action.busy && !disabled}
        onPrevious={() => { const next = pages.slice(0, -1); at(next.at(-1) ?? null, next); }}
        onNext={() => { if (page.nextCursor) at(page.nextCursor, appendPage(pages, page.nextCursor)); }}/>
    </> : null}
  </View>;
}
