import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { Button } from '@/components/ui';
import { t } from '@/i18n';
import { useThemedStyles } from '@/theme';
import type { MobileMigrationClient } from '@/runtime/migration-client';
import { DefinitionPreviewController } from '../../../../../../shared/migrationDefinitionPreview';
import { migrationErrorTranslationKey } from '../migration-error-translation';
import { makeStyles, PageControls } from '../migration-result-ui';
export function MigrationDefinitionPreview({ client, jobId, itemId }: { client: MobileMigrationClient; jobId: string; itemId: string }) {
  const styles = useThemedStyles(makeStyles);
  const model = useMemo(() => new DefinitionPreviewController({ definitionReport: p => client.call('definitionReport', p), definitionBody: p => client.call('definitionBody', p) }, { jobId, itemId }, () => client.available()), [client, jobId, itemId]);
  const state = useSyncExternalStore(model.subscribe, model.snapshot, model.snapshot), report = state.report;
  useEffect(() => { model.activate(); return model.dispose; }, [model]);
  return <View style={styles.stack} testID="migration-definition-preview">
    <Text style={styles.warning}>{t('migration_definitions.pending')} · {t('migration_definitions.review')}</Text>
    <View style={styles.actions}><Button testID="definition-report" disabled={state.busy || !client.supports('definitionReport')} onPress={() => { void model.report(); }}>{t('migration_definitions.report')}</Button><Button testID="definition-body" disabled={state.busy || !client.supports('definitionBody')} onPress={() => { void model.body(); }}>{t('migration_definitions.read_body')}</Button></View>
    {!client.supports('definitionReport') ? <Text style={styles.warning}>{t('migration_definitions.update_required')}</Text> : null}
    {state.error ? <Text accessibilityRole="alert" style={styles.error}>{t(migrationErrorTranslationKey('definitions', state.error))}</Text> : null}
    {report ? <View testID="definition-field-report"><Text style={styles.note}>{t(`migration_definitions.${report.report.parseStatus}`)} · {t('migration_definitions.report_page', { count: report.totalFields, bytes: report.totalBytes })}</Text>{report.report.fields.map(row => <View key={`${row.element}:${row.ordinal}`} testID="definition-field"><Text style={styles.text}>{row.field ? t(`migration_definitions.fields.${row.field}`) : t('migration_definitions.unknown_field', { ordinal: row.ordinal + 1 })}</Text><Text style={styles.note}>{t('migration_definitions.element', { element: row.element + 1 })}</Text></View>)}<PageControls previous={report.pageIndex > 0 && !state.busy} next={report.nextPage != null && !state.busy} onPrevious={() => { void model.report(report.pageIndex - 1); }} onNext={() => { if (report.nextPage != null) void model.report(report.nextPage); }}/></View> : null}
    {state.body ? <View testID="definition-body-window"><Text style={styles.note}>{t('migration_definitions.body_boundary')}</Text><Text style={styles.note}>{t('migration_definitions.body_bytes', { offset: state.body.offset, end: state.body.nextOffset ?? state.body.totalBytes, total: state.body.totalBytes })}</Text>{state.body.encoding === 'utf8' ? <ScrollView nestedScrollEnabled style={{ maxHeight: 320 }}><Text selectable style={styles.text}>{state.body.text}</Text></ScrollView> : <Text style={styles.note}>{t('migration_definitions.binary')}</Text>}<PageControls previous={state.offsets.length > 1 && !state.busy} next={state.body.nextOffset != null && !state.busy} onPrevious={() => { void model.previous(); }} onNext={() => { void model.next(); }}/></View> : null}
  </View>;
}
