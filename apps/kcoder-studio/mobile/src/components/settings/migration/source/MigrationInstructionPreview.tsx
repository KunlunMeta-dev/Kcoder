import type { ReactNode } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { Button } from '@/components/ui';
import { t } from '@/i18n';
import { useThemedStyles } from '@/theme';
import type * as C from '../../../../../../shared/generated/contracts';
import { makeStyles, PageControls } from '../migration-result-ui';

export function MigrationInstructionPreview({ page, body, busy, onPage, onPreview, extra }: {
  page: C.MigrationInstructionPageResult | null; body: C.MigrationInstructionBodyResult | null; busy: boolean;
  onPage(index: number): void;
  onPreview(id: string, representation: C.InstructionRepresentation, offset?: number): void;
  extra?(item: C.MigrationInstructionItem): ReactNode;
}) {
  const styles = useThemedStyles(makeStyles);
  return <View style={styles.stack} testID="instruction-preview">
    {page?.items.map(item => <View key={item.itemId} style={styles.stack} testID={'instruction-row-' + item.itemId}>
      <Text style={styles.text}>{item.displayName}</Text>
      <Text style={styles.note}>{item.relativeScope || t('migration_instructions.root_scope')} · {t('migration_instructions.disposition_' + item.disposition)}</Text>
      {item.reasonCode ? <Text style={styles.warning}>{item.reasonCode}</Text> : null}
      <View style={styles.actions}>
        <Button testID={'instruction-original-' + item.itemId} variant="ghost" disabled={busy} onPress={() => onPreview(item.itemId, 'original')}>{t('migration_instructions.original')}</Button>
        <Button testID={'instruction-compiled-' + item.itemId} variant="ghost" disabled={busy || !item.scoped} onPress={() => onPreview(item.itemId, 'compiled')}>{t('migration_instructions.compiled')}</Button>
      </View>
      {extra?.(item)}
    </View>)}
    {page ? <PageControls previous={page.pageIndex > 0 && !busy} next={page.nextPage != null && !busy}
      onPrevious={() => onPage(page.pageIndex - 1)} onNext={() => { if (page.nextPage != null) onPage(page.nextPage); }}/> : null}
    {body ? <View style={styles.stack} testID="instruction-body">
      <Text style={styles.note}>{t('migration_instructions.window', { offset: body.offset, total: body.totalBytes })}</Text>
      <ScrollView style={{ maxHeight: 240 }} nestedScrollEnabled><Text selectable style={styles.text}>{body.text ?? t('migration_instructions.binary')}</Text></ScrollView>
      <View style={styles.actions}>
        <Button variant="ghost" disabled={busy || body.offset === 0} onPress={() => onPreview(body.itemId, body.representation, 0)}>{t('migration_instructions.first_window')}</Button>
        <Button testID="instruction-body-next" variant="ghost" disabled={busy || body.nextOffset == null} onPress={() => { if (body.nextOffset != null) onPreview(body.itemId, body.representation, body.nextOffset); }}>{t('migration_instructions.next_window')}</Button>
      </View>
      <Text style={styles.note}>{t('migration_instructions.preview_boundary')}</Text>
    </View> : null}
  </View>;
}
