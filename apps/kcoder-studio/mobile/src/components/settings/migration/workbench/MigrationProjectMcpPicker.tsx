import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { Text, View } from 'react-native';
import { Button } from '@/components/ui';
import { t } from '@/i18n';
import { useThemedStyles } from '@/theme';
import type { MobileMigrationClient } from '@/runtime/migration-client';
import { ProjectMcpCatalogController } from '../../../../../../shared/migrationProjectMcp';
import { makeStyles, PageControls } from '../migration-result-ui';
import { Check } from './WorkbenchUi';

export function useProjectMcpCatalog(client: MobileMigrationClient, jobId: string) {
  const controller = useMemo(() => new ProjectMcpCatalogController(jobId,
    params => client.call('projectMcpCatalog', params), () => client.available()), [client, jobId]);
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot);
  useEffect(() => {
    if (client.supports('projectMcpCatalog')) void controller.load();
    return () => controller.invalidate();
  }, [client, controller]);
  return { controller, state };
}

export function MigrationProjectMcpPicker({ controller, state, disabled }: ReturnType<typeof useProjectMcpCatalog> & { disabled: boolean }) {
  const styles = useThemedStyles(makeStyles);
  if (state.page?.status !== 'selection_required' && !state.error) return null;
  const busy = disabled || state.busy;
  return <View testID="migration-project-mcp-picker" style={styles.row}>
    <Text style={styles.title}>{t('migration_project_mcp.title')}</Text>
    <Text style={styles.note}>{t('migration_project_mcp.boundary')}</Text>
    {state.error ? <Text accessibilityRole="alert" style={styles.error}>{t('migration_project_mcp.failed')}</Text> : <>
      {state.page?.names.map(name => <Check key={name} testID={`migration-project-mcp-name-${name}`} disabled={busy} checked={state.selected.includes(name)} onPress={() => controller.choose(name)} label={name}/>)}
      <Text style={styles.note}>{t('migration_project_mcp.selected', { count: state.selected.length, total: state.page?.totalNames ?? 0 })}</Text>
      <PageControls previous={!busy && state.pageIndex > 0} next={!busy && state.page?.nextPageIndex != null} onPrevious={() => void controller.load(state.pageIndex - 1)} onNext={() => void controller.load(state.pageIndex + 1)}/>
      <Check testID="migration-project-mcp-confirm" disabled={busy} checked={state.confirmed} onPress={() => controller.confirm(!state.confirmed)} label={t('migration_project_mcp.confirm')}/>
    </>}
    <Button variant="ghost" disabled={busy} onPress={() => void controller.load(0, true)}>{t('migration_project_mcp.refresh')}</Button>
  </View>;
}
