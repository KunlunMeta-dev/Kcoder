import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { Text, View } from 'react-native';
import { Button } from '@/components/ui';
import { t } from '@/i18n';
import { useThemedStyles } from '@/theme';
import type { MobileMigrationClient, MigrationJobReadResult, MigrationSourceKind } from '@/runtime/migration-client';
import { ProjectSourcesController } from '../../../../../../shared/migrationProjectSources';
import { makeStyles, PageControls } from '../migration-result-ui';
import { Check } from './WorkbenchUi';
export function MigrationProjectSources({ client, source, onJob }: { client: MobileMigrationClient; source: MigrationSourceKind; onJob(job: MigrationJobReadResult): void }) {
  const styles = useThemedStyles(makeStyles);
  const model = useMemo(() => new ProjectSourcesController({ discover: value => client.call('projectsDiscover',{source:value}),
    page: (catalogId,pageIndex) => client.call('projectsSources',{catalogId,pageIndex}),
    prepare: async projectSources => (await client.call('scan',{sourceIds:[],projectSources})).job.jobId },()=>client.available()),[client]);
  const state = useSyncExternalStore(model.subscribe,model.snapshot,model.snapshot);
  useEffect(()=>{model.activate();model.configure(source);return model.dispose;},[model,source]);
  return <View style={styles.stack} testID="migration-project-sources">
    <Text style={styles.title}>{t('migration_projects.title')}</Text><Text style={styles.note}>{t('migration_projects.boundary')}</Text>
    <Button testID="migration-project-discover" disabled={state.busy || state.unknown || !client.supports('projectsDiscover')} onPress={()=>{void model.discover();}}>{t('migration_projects.discover')}</Button>
    {!client.supports('projectsDiscover') ? <Text style={styles.warning}>{t('migration_projects.update_required')}</Text>:null}
    {state.error ? <Text accessibilityRole="alert" style={styles.error}>{t(state.error === 'updateRequired' ? 'migration_projects.update_required' : 'migration_projects.failed')}</Text>:null}
    {state.page ? <>
      {state.page.items.map(row=><Check key={row.sourceHandle} testID="migration-project-source-row" label={`${row.displayName} · ${t('migration_projects.roots',{count:row.roots})}`} checked={state.selected.some(value=>value.sourceHandle===row.sourceHandle)} disabled={state.busy||state.unknown} onPress={()=>model.select(row.sourceHandle)}/>)}
      <PageControls previous={!state.busy&&!state.unknown&&state.page.pageIndex>0} next={!state.busy&&!state.unknown&&state.page.nextPage!=null} onPrevious={()=>{void model.page(state.page!.pageIndex-1);}} onNext={()=>{void model.page(state.page!.nextPage!);}}/>
      {!state.page.knownRowsComplete||state.page.problems.length ? <Check testID="migration-project-partial" label={t('migration_projects.partial')} checked={state.partial} disabled={state.busy||state.unknown} onPress={()=>model.consent(!state.partial)}/>:null}
      <Button testID="migration-project-prepare" disabled={state.busy||state.unknown||!state.selected.length||(!state.page.knownRowsComplete||state.page.problems.length>0)&&!state.partial} onPress={()=>{void model.prepare().then(async id=>{if(id&&model.current()){const result=await client.call('batchRead',{jobId:id});if(model.current())onJob(result.state);}});}}>{t('migration_projects.prepare')}</Button>
    </>:null}
  </View>;
}
