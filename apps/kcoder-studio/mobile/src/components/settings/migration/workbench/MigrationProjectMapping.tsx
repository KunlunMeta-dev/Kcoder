import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Text, View } from 'react-native';
import { Button, Field } from '@/components/ui';
import { t } from '@/i18n';
import { useThemedStyles } from '@/theme';
import { useSettingsTarget } from '../../SettingsTargetContext';
import { migrationRequestId, type MobileMigrationClient, type MigrationBatchChoice } from '@/runtime/migration-client';
import { ProjectMappingController, type ProjectTargetCatalogCache } from '../../../../../../shared/migrationProjectMapping';
import { makeStyles, PageControls } from '../migration-result-ui';

export function MigrationProjectMapping({ client, jobId, itemId, onSave, onClose, readOnly = false, catalog }: {
  client: MobileMigrationClient; jobId: string; itemId: string; onSave?(choice: MigrationBatchChoice): void; onClose?(): void; readOnly?: boolean; catalog?: ProjectTargetCatalogCache;
}) {
  const styles = useThemedStyles(makeStyles), target = useSettingsTarget();
  const model = useMemo(() => new ProjectMappingController({
    projectReport: p => client.call('projectReport', p), projectTargets: p => client.call('projectTargets', p),
    projectTargetRoots: p => client.call('projectTargetRoots', p), projectsDiscover: p => client.call('projectsDiscover', p),
    projectsSources: p => client.call('projectsSources', p), projectSourceRoots: p => client.call('projectSourceRoots', p),
  }, () => client.supports('projectReport'), () => client.available(), error => error instanceof Error ? error.message : 'migration_request_failed', catalog), [client,catalog]);
  const state = useSyncExternalStore(model.subscribe, model.snapshot, model.snapshot);
  const [page, setPage] = useState(0), [path, setPath] = useState(''), [name, setName] = useState('');
  const [registering, setRegistering] = useState(false), [unknown, setUnknown] = useState(false), [conflict, setConflict] = useState(false);
  const lifecycle = useRef({ generation: 0 });
  useEffect(() => { const holder = lifecycle.current; holder.generation++; void model.load(jobId, itemId, !readOnly); return () => { holder.generation++; model.dispose(); }; }, [model, jobId, itemId, readOnly, lifecycle]);
  const register = async () => {
    if (!client.available() || !target.ready || !target.server || registering || unknown || !path.trim() || !name.trim() || !client.supports('projectReport') || state.error || !state.report.length) return;
    const holder = lifecycle.current, owner = holder.generation, current = () => client.available() && owner === holder.generation;
    const key = migrationRequestId(); setRegistering(true); setConflict(false);
    try {
      const result = await target.request<{ accepted: boolean; projectKey: string }>('runtime.projects.upsert_local', {
        deviceId: target.server.id, runtime: 'kcoder', preserveExisting: true, projectKey: key, name: name.trim(), roots: [path.trim()],
      });
      if (!current()) return;
      if (!result.accepted || result.projectKey !== key) throw new Error('unknown');
      setPath(''); setName(''); catalog?.reset(); await model.load(jobId, itemId);
    } catch (error) { if (current()) { const conflict = error instanceof Error && error.message.includes('workspace_project_already_registered'); setUnknown(!conflict); setConflict(conflict); } }
    finally { if (current()) setRegistering(false); }
  };
  return <View style={styles.stack} testID="migration-project-mapping">
    <Text style={styles.note}>{t('migration_projects.boundary')}</Text>
    {state.unsupported ? <Text accessibilityRole="alert" style={styles.error}>{t('migration_projects.update_required')}</Text>:null}
    {state.error ? <Text accessibilityRole="alert" style={styles.error}>{t('migration_projects.failed')} · {state.error}</Text> : null}
    {state.report.slice(page * 10, page * 10 + 10).map((row, i) => <Text selectable key={i} style={styles.note}>{t(`migration_projects.field_${row.field}`)} · {row.value ?? '—'}</Text>)}
    <PageControls previous={page > 0} next={(page + 1) * 10 < state.report.length} onPrevious={() => setPage(value => value - 1)} onNext={() => setPage(value => value + 1)}/>
    {readOnly ? null : <>
      <Text style={styles.title}>{t('migration_projects.target')}</Text>
      {state.targets?.items.map(row => <Button key={row.targetHandle} testID="migration-project-target" variant={state.selectedTarget === row.targetHandle ? 'secondary' : 'ghost'} disabled={state.busy || registering} onPress={() => { void model.selectTarget(row.targetHandle); }}>{row.displayName}</Button>)}
      <PageControls previous={!!state.targets?.pageIndex && !state.busy} next={state.targets?.nextPage != null && !state.busy} onPrevious={() => { void model.targetPage(state.targets!.pageIndex - 1); }} onNext={() => { void model.targetPage(state.targets!.nextPage!); }}/>
      {state.sourceRoots.map(row => <View key={row.id} style={styles.stack}><Text selectable style={styles.text}>{row.path}</Text>{state.targetRoots?.roots.map(root => <Button key={root.targetRootHandle} testID="migration-project-root-map" variant={state.mappings[row.id] === root.targetRootHandle ? 'secondary' : 'ghost'} disabled={state.busy || registering || !root.trusted || !root.available} onPress={() => model.map(row.id, root.targetRootHandle)}>{root.path} · {t(root.trusted && root.available ? 'migration_projects.trusted' : 'migration_projects.untrusted')}</Button>)}</View>)}
      <PageControls previous={!!state.targetRoots?.pageIndex && !state.busy} next={state.targetRoots?.nextPage != null && !state.busy} onPrevious={() => { void model.rootPage(state.targetRoots!.pageIndex - 1); }} onNext={() => { void model.rootPage(state.targetRoots!.nextPage!); }}/>
      <Text style={styles.note}>{t('migration_projects.register_boundary')}</Text>
      <Field testID="migration-project-register-name" label={t('migration_projects.name')} value={name} editable={!registering && !unknown} onChangeText={setName} maxLength={256}/>
      <Field testID="migration-project-register-path" label={t('migration_projects.directory')} value={path} editable={!registering && !unknown} onChangeText={setPath} maxLength={4096} autoCorrect={false} autoCapitalize="none"/>
      <Button testID="migration-project-register" disabled={state.busy || registering || unknown || !!state.error || !state.report.length || !name.trim() || !path.trim()} onPress={() => { void register(); }}>{t('migration_projects.register')}</Button>
      {conflict ? <Text accessibilityRole="alert" style={styles.warning}>{t('migration_projects.registration_conflict')}</Text> : null}
      {unknown ? <Text accessibilityRole="alert" style={styles.warning}>{t('migration_projects.registration_unknown')}</Text> : null}
      <Button testID="migration-project-refresh" variant="ghost" disabled={state.busy || registering} onPress={() => { catalog?.reset(); void model.load(jobId, itemId); }}>{t('migration_projects.refresh')}</Button>
      <Button testID="migration-project-map-save" disabled={state.busy || registering || !state.canSave} onPress={() => { const choice = model.choice(itemId); if (choice && client.available()) onSave?.(choice); }}>{t('migration_projects.select')}</Button>
      <Button variant="ghost" onPress={() => onClose?.()}>{t('migration_projects.close')}</Button>
    </>}
  </View>;
}
