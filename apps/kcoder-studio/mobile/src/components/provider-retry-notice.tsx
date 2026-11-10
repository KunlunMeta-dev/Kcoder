import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { t } from '@/i18n';
import { useLocale } from '@/i18n/use-locale';
import { useThemedStyles, type ThemeColors } from '@/theme';
import type { TaskActivityView } from '@/runtime/task-runtime/types';
import { providerRetryCount, providerRetryProgress } from './provider-retry-presentation';

/** Retry diagnostics have one neutral disclosure, never success badges per attempt. */
export function ProviderRetryNotice({ activities, running = false }: { activities: readonly TaskActivityView[]; running?: boolean }) {
  useLocale();
  const styles = useThemedStyles(makeStyles);
  const [expanded, setExpanded] = useState(false);
  const count = providerRetryCount(activities);
  const progress = activities.map(providerRetryProgress).filter(Boolean).at(-1);
  if (!count || !progress) return null;
  return <View testID="provider-retry-notice">
    <Pressable testID="provider-retry-toggle" accessibilityRole="button" accessibilityState={{ expanded }}
      onPress={() => setExpanded(value => !value)} style={styles.toggle}>
      <Text accessibilityRole={running ? 'text' : undefined} style={styles.summary}>{running
        ? t('task.provider_retry_in_progress', { attempt: progress.attempt, total: progress.maxRetries })
        : t('task.provider_retry_history', { count })}</Text>
      <Text style={styles.detail}>{t(expanded ? 'task.hide_technical_details' : 'task.view_technical_details')}</Text>
    </Pressable>
    {expanded ? <View testID="provider-retry-details" style={styles.details}>{activities.map(activity => <Text key={activity.id} selectable style={styles.detail}>{activity.detail ?? activity.label}</Text>)}</View> : null}
  </View>;
}
const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  toggle: { minHeight: 44, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  summary: { color: colors.textMuted, fontSize: 13, lineHeight: 20, flexShrink: 1 },
  detail: { color: colors.textMuted, fontSize: 12, lineHeight: 18 },
  details: { gap: 8 },
});
