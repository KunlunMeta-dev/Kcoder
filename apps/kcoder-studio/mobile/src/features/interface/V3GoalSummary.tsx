import { CirclePause, ChevronDown, ChevronUp, PencilLine, Play, Trash2 } from 'lucide-react-native';
import Svg, { Path } from 'react-native-svg';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { t } from '@/i18n';
import { radius, spacing, useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { v3ConversationPalette } from './v3-styles';

type Props = {
  title: string; usage: string; expanded: boolean; busy: boolean; disabled: boolean;
  editable: boolean; active: boolean; resumable: boolean;
  onToggle(): void; onEdit(): void; onPauseResume(): void; onClear(): void;
};

/** V3 presentation only; the caller retains Goal revisions and mutations. */
export function V3GoalSummary(props: Props) {
  const { colors } = useTheme();
  const styles = useThemedStyles(v3GoalStyles);
  const palette = v3ConversationPalette(colors);
  const actionColor = palette.goalAction;
  return <>
    <View style={styles.header}>
      <View style={styles.copy}>
        <Pressable testID="task-goal-expand" accessibilityRole="button" accessibilityLabel={t('task.goal_details')}
          accessibilityState={{ expanded: props.expanded }} onPress={props.onToggle} style={styles.heading}>
          <Svg width={16} height={16} viewBox="0 0 24 24" aria-hidden>
            <Path d="M12 2a10 10 0 1 1-10 10" fill="none" stroke={palette.goalProgress} strokeWidth={2} strokeLinecap="round" />
            <Path d="M12 18a6 6 0 1 1 6-6" fill="none" stroke={palette.goalOrbit} strokeWidth={2} strokeLinecap="round" />
          </Svg>
          <Text testID="task-goal-status" numberOfLines={2} style={styles.title}>{props.title}</Text>
          {props.expanded ? <ChevronUp size={14} color={colors.textMuted} /> : <ChevronDown size={14} color={colors.textMuted} />}
        </Pressable>
        <Text testID="task-goal-usage" style={styles.metrics}>{props.usage}</Text>
      </View>
      <View style={styles.actions}>
        {props.editable ? <Pressable testID="task-goal-edit" accessibilityRole="button" accessibilityLabel={t('task.goal_edit')}
          disabled={props.disabled} accessibilityState={{ disabled: props.disabled }} onPress={props.onEdit}
          style={[styles.action, props.disabled && styles.disabled]}><PencilLine size={18} color={actionColor} /></Pressable> : null}
        {props.active || props.resumable ? <Pressable testID={props.resumable ? 'task-goal-resume' : 'task-goal-pause'}
          accessibilityRole="button" accessibilityLabel={t(props.resumable ? 'task.goal_resume' : 'task.goal_pause')}
          disabled={props.disabled} accessibilityState={{ disabled: props.disabled, busy: props.busy }} onPress={props.onPauseResume}
          style={[styles.action, props.disabled && styles.disabled]}>
          {props.busy ? <ActivityIndicator size="small" color={actionColor} /> : props.resumable ? <Play size={18} color={actionColor} /> : <CirclePause size={18} color={actionColor} />}
        </Pressable> : null}
        <Pressable testID="task-goal-clear" accessibilityRole="button" accessibilityLabel={t('task.goal_clear')}
          disabled={props.disabled} accessibilityState={{ disabled: props.disabled, busy: props.busy }} onPress={props.onClear}
          style={[styles.action, props.disabled && styles.disabled]}>
          {props.busy && !props.active && !props.resumable ? <ActivityIndicator size="small" color={actionColor} /> : <Trash2 size={18} color={actionColor} />}
        </Pressable>
      </View>
    </View>
  </>;
}

export const v3GoalStyles = (colors: ThemeColors) => StyleSheet.create({
  root: { marginHorizontal: spacing.md, marginBottom: spacing.xs, paddingHorizontal: spacing.sm, paddingBottom: spacing.xs,
    borderWidth: 1, borderColor: colors.surfaceRaised, borderRadius: radius.md, backgroundColor: v3ConversationPalette(colors).goalSurface },
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  copy: { flex: 1, minWidth: 0 }, heading: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: spacing.xs, paddingVertical: spacing.xs },
  title: { flexShrink: 1, color: colors.text, fontSize: 12, lineHeight: 17, fontWeight: '600' },
  metrics: { color: colors.textDim, fontSize: 12, lineHeight: 17, paddingBottom: spacing.sm },
  actions: { flexDirection: 'row', alignItems: 'center' }, action: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  disabled: { opacity: 0.4 },
  details: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, paddingTop: spacing.sm, paddingBottom: spacing.xs },
});
