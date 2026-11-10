import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { Text, View } from 'react-native';
import { Button } from '@/components/ui';
import { t } from '@/i18n';
import { useThemedStyles } from '@/theme';
import type { MobileMigrationClient } from '@/runtime/migration-client';
import { createMobileSourceUploadApi } from '@/runtime/migration-source/upload-api';
import { createSourceProductController } from '@/runtime/migration-source/product-controller';
import type { SourceUploadState } from '../../../../../../shared/generated/contracts';
import { makeStyles } from '../migration-result-ui';
import { migrationErrorTranslationKey } from '../migration-error-translation';

export function MigrationProductPanel({ client, scope, upload, isCurrent, onInspect, onUnavailable }: { client: MobileMigrationClient; scope: string; upload: SourceUploadState; isCurrent(): boolean; onInspect(value: SourceUploadState): void; onUnavailable(id: string): void }) {
  const styles = useThemedStyles(makeStyles);
  const manager = useMemo(() => createSourceProductController({ api: createMobileSourceUploadApi(client), storage: localStorage, scope, upload, isCurrent }), [client, scope, upload, isCurrent]);
  const state = useSyncExternalStore(manager.subscribe, manager.getSnapshot), product = state.observed?.materialization;
  useEffect(() => { manager.activate(); return () => manager.dispose(); }, [manager]);
  useEffect(() => { if (state.unknown || product && product.stage !== 'ready') onUnavailable(upload.operationId); }, [state.unknown, product, upload.operationId, onUnavailable]);
  useEffect(() => { if (!product || product.workerState !== 'running' || state.busy || state.unknown) return; const timer = setTimeout(() => { void manager.read(); }, 1000); return () => clearTimeout(timer); }, [manager, product, state.busy, state.unknown]);
  const retry = state.pending && state.readAttempted && (state.pending.kind === 'cancel' || !product || state.pending.params.expectedSequence === product.sequence);
  return <View testID="migration-source-product" style={styles.stack}>
    <Text style={styles.title}>{t('migration_source_upload.product.title')}</Text><Text style={styles.note}>{t('migration_source_upload.product.boundary')}</Text>
    <View style={styles.actions}>
      {!state.requested ? <Button testID="source-product-run" disabled={state.busy} onPress={() => { void manager.run(); }}>{t('migration_source_upload.product.start')}</Button> : null}
      <Button testID="source-product-read" disabled={state.busy} onPress={() => { void manager.read(); }}>{t('migration_source_upload.product.read')}</Button>
      {state.pending ? <Button testID="source-product-retry" disabled={state.busy || !retry} onPress={() => { void manager.retry(); }}>{t('migration_source_upload.product.retry')}</Button> : null}
      {state.requested && product?.stage !== 'ready' ? <><Button testID="source-product-resume" disabled={state.busy || product?.workerState !== 'stopped'} onPress={() => { void manager.resume(); }}>{t('migration_source_upload.product.resume')}</Button><Button testID="source-product-cancel" onPress={() => { void manager.cancel(); }}>{t('migration_source_upload.product.cancel')}</Button></> : null}
    </View>
    {state.error ? <Text accessibilityRole="alert" style={styles.error}>{t(migrationErrorTranslationKey('source_upload', state.error))}</Text> : null}
    {product ? <View testID="source-product-status" style={styles.stack}>
      <Text style={styles.title}>{t(`migration_source_upload.product.stages.${product.stage}`)}</Text><Text style={styles.note}>{t('migration_source_upload.product.progress', { bytes: product.verifiedBytes, total: product.totalBytes })}</Text><Text style={styles.note}>{t(`migration_source_upload.workers.${product.workerState}`)}</Text>
      {state.unknown ? <Text style={styles.warning}>{t('migration_source_upload.unknown')}</Text> : null}
      {product.stage === 'ready' && !state.unknown ? <><Text style={styles.note}>{t('migration_source_upload.product.ready')}</Text><Button testID="source-product-inspect" onPress={() => { if (isCurrent()) onInspect(product); }}>{t('migration_source_upload.product.inspect')}</Button></> : null}
    </View> : null}
  </View>;
}
