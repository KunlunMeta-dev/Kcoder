import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { Text, View } from 'react-native';
import { Button } from '@/components/ui';
import { t } from '@/i18n';
import { useThemedStyles } from '@/theme';
import type { MobileMigrationClient, MigrationJobReadResult } from '@/runtime/migration-client';
import { DefinitionSourcesController } from '../../../../../../shared/migrationDefinitionSources';
import { migrationErrorTranslationKey } from '../migration-error-translation';
import { makeStyles, PageControls } from '../migration-result-ui';
import { Check } from '../workbench/WorkbenchUi';
export function MigrationDefinitionSources({ client, onJob }: { client: MobileMigrationClient; onJob(job: MigrationJobReadResult): void }) {
  const styles = useThemedStyles(makeStyles);
  const model = useMemo(() => new DefinitionSourcesController({ definitionsDiscover: p => client.call('definitionsDiscover', p), scan: async ids => (await client.call('scan', { sourceIds: ids })).job.jobId }, () => client.available()), [client]);
  const state = useSyncExternalStore(model.subscribe, model.snapshot, model.snapshot);
  useEffect(() => { model.activate(); return model.dispose; }, [model]);
  return <View style={styles.stack} testID="migration-definition-sources">
    <Text style={styles.title}>{t('migration_definitions.title')}</Text><Text style={styles.note}>{t('migration_definitions.boundary')}</Text>
    <View style={styles.actions}>{(['claude-code', 'codex'] as const).map(kind => <Button key={kind} testID={`definition-source-${kind}`} disabled={state.busy || state.scanUnknown} variant={kind === state.kind ? 'secondary' : 'ghost'} onPress={() => model.configure(kind, state.includeProject)}>{kind === 'codex' ? 'Codex' : 'Claude Code'}</Button>)}</View>
    <Check testID="definition-project" checked={state.includeProject} disabled={state.busy || state.scanUnknown || !client.workspaceAvailable()} label={t('migration_definitions.include_project')} onPress={() => model.configure(state.kind, !state.includeProject)}/>
    <Button testID="definition-discover" disabled={state.busy || state.scanUnknown || !client.supports('definitionsDiscover')} onPress={() => { void model.discover(); }}>{t('migration_definitions.discover')}</Button>
    {!client.supports('definitionsDiscover') ? <Text style={styles.warning}>{t('migration_definitions.update_required')}</Text> : null}
    {state.error ? <Text accessibilityRole="alert" style={styles.error}>{t(migrationErrorTranslationKey('definitions', state.error))}</Text> : null}
    {state.page ? <>
      {state.page.sources.map(row => <View key={row.sourceId} testID="definition-source-row"><Check testID={`definition-select-${row.sourceId}`} disabled={state.busy || state.scanUnknown} checked={state.selected.some(value => value.sourceId === row.sourceId)} label={`${row.displayName} · ${row.availableCategories.map(kind => t(`migration_definitions.${kind}`)).join(' · ')}`} onPress={() => model.select(row.sourceId)}/><Text style={styles.note}>{t('migration_definitions.pending')}</Text></View>)}
      <PageControls previous={state.index > 0 && !state.busy} next={state.page.nextPage != null && !state.busy} onPrevious={() => { void model.page(state.index - 1); }} onNext={() => { if (state.page?.nextPage != null) void model.page(state.page.nextPage); }}/>
      {state.page.problems.length ? <Check testID="definition-partial" checked={state.partial} disabled={state.busy} label={t('migration_definitions.partial')} onPress={() => model.consent(!state.partial)}/> : null}
      <Text style={styles.note}>{t('migration_definitions.selected', { count: state.selected.length })}</Text>
      <Button testID="definition-prepare" disabled={state.busy || state.scanUnknown || !state.selected.length || !!state.page.problems.length && !state.partial} onPress={() => { void model.prepare().then(async id => { if (id && model.current()) { const value = await client.call('batchRead', { jobId: id }); if (model.current()) onJob(value.state); } }).catch(() => {}); }}>{t('migration_definitions.prepare')}</Button>
    </> : null}
  </View>;
}
