import { useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import {
  ChevronDown,
  ChevronRight,
  Lightbulb,
  Wrench,
} from "lucide-react-native";
import {
  chatTypography,
  radius,
  spacing,
  useTheme,
  useThemedStyles,
  type ThemeColors,
} from "@/theme";
import { t } from "@/i18n";
import { useLocale } from "@/i18n/use-locale";
import { getAppPreferencesSnapshot, subscribeAppPreferences } from "@/storage/app-preferences";
import { resolveDisclosureExpanded, toggleDisclosureChoice } from "@/features/task/disclosure-state";
import { useInterfaceVersion } from "@/storage/interface-version";
import { v3ConversationPalette, v3TaskStyles } from "@/features/interface/v3-styles";

export function ProcessingDisclosure({
  count,
  title,
  running,
  failed,
  hasThinking = false,
  unknown = 0,
  cancelled = 0,
  children,
}: {
  count: number;
  title?: string;
  running: boolean;
  failed: number;
  hasThinking?: boolean;
  unknown?: number;
  cancelled?: number;
  children: ReactNode;
}) {
  useLocale();
  const { colors } = useTheme();
  const baseStyles = useThemedStyles(makeStyles);
  const v3Styles = useThemedStyles(v3TaskStyles);
  const v3 = useInterfaceVersion() === "v3";
  const styles = v3 ? { ...baseStyles, processing: v3Styles.orderedProcessingGroup, title: v3Styles.orderedProcessingTitle } : baseStyles;
  const preferences = useSyncExternalStore(
    subscribeAppPreferences,
    getAppPreferencesSnapshot,
    getAppPreferencesSnapshot,
  );
  const [defaultExpanded] = useState(() => (
    hasThinking && !preferences.thinkingCollapsedByDefault
  ) || (count > 0 && !preferences.toolsCollapsedByDefault));
  const [userExpanded, setUserExpanded] = useState<boolean | null>(null);
  const expanded = resolveDisclosureExpanded(userExpanded, defaultExpanded);
  const statuses = [
    failed > 0
      ? { key: "failed", text: t("output.failed", { count: failed }) }
      : null,
    unknown > 0
      ? { key: "unknown", text: t("output.unknown", { count: unknown }) }
      : null,
    cancelled > 0
      ? { key: "cancelled", text: t("output.cancelled", { count: cancelled }) }
      : null,
    running ? { key: "running", text: t("output.running") } : null,
  ].filter((item): item is NonNullable<typeof item> => Boolean(item));
  return (
    <View testID="message-processing" style={styles.processing}>
      <Pressable
        testID="message-processing-toggle"
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        aria-expanded={expanded}
        onPress={() => setUserExpanded((value) => toggleDisclosureChoice(value, defaultExpanded))}
        style={styles.processingHeader}
      >
        {running ? (
          <ActivityIndicator size="small" color={colors.textMuted} />
        ) : count ? (
          hasThinking && v3 ? <Lightbulb size={20} color={v3ConversationPalette(colors).thinkingIcon} /> : <Wrench size={20} color={colors.textMuted} />
        ) : (
          <Lightbulb size={20} color={v3 ? v3ConversationPalette(colors).thinkingIcon : colors.textMuted} />
        )}
        <View style={styles.copy}>
          <Text style={styles.title}>
            {title ?? t(count ? "output.tools" : "output.process", { count })}
          </Text>
          {statuses.length ? (
            statuses.map((item) => (
              <Text
                key={item.key}
                numberOfLines={item.key === "running" ? 1 : undefined}
                style={[
                  styles.status,
                  item.key === "failed" && styles.failed,
                  item.key === "unknown" && { color: colors.yellow },
                ]}
              >
                {item.text}
              </Text>
            ))
          ) : !v3 || !expanded ? (
            <Text style={styles.status}>{t("output.complete")}</Text>
          ) : null}
        </View>
        {expanded ? (
          <ChevronDown size={20} color={colors.textDim} />
        ) : (
          <ChevronRight size={20} color={colors.textDim} />
        )}
      </Pressable>
      {expanded ? (
        <View testID="message-processing-details" style={styles.details}>
          {children}
        </View>
      ) : null}
    </View>
  );
}
export function BoundedOutput({ value }: { value: unknown }) {
  useLocale();
  const v3 = useInterfaceVersion() === "v3";
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [limit, setLimit] = useState(8000);
  const text = useMemo(() => {
    if (typeof value === "string") return value;
    try {
      return JSON.stringify(value, null, 2) ?? String(value);
    } catch {
      return String(value);
    }
  }, [value]);
  let end = Math.min(limit, text.length);
  if (end < text.length && /^[\uD800-\uDBFF]$/.test(text[end - 1] ?? "")) end--;
  return (
    <View>
      <ScrollView
        testID="bounded-output"
        nestedScrollEnabled
        style={[styles.outputScroll, v3 && { backgroundColor: v3ConversationPalette(colors).processing, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border }]}
      >
        <ScrollView horizontal nestedScrollEnabled>
          <Text selectable style={styles.code}>
            {text.slice(0, end)}
          </Text>
        </ScrollView>
      </ScrollView>
      {end < text.length ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => setLimit((value) => value + 8000)}
          style={styles.header}
        >
          <Text style={styles.status}>{t("output.more")}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
export function CodeDisclosure({
  content,
  language,
}: {
  content: string;
  language?: string;
}) {
  useLocale();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [expanded, setExpanded] = useState(false);
  return (
    <View style={styles.codeGroup} testID="code-disclosure">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        aria-expanded={expanded}
        onPress={() => setExpanded((value) => !value)}
        style={styles.header}
      >
        {expanded ? (
          <ChevronDown size={16} color={colors.textMuted} />
        ) : (
          <ChevronRight size={16} color={colors.textMuted} />
        )}
        <Text style={styles.title}>
          {language?.slice(0, 24) || t("output.code")}
        </Text>
        <Text style={styles.status}>
          {t("output.lines", { count: content.split("\n").length })}
        </Text>
      </Pressable>
      {expanded ? <BoundedOutput value={content} /> : null}
    </View>
  );
}
const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    processing: {
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.xs,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      borderRadius: radius.chatOutputGroup,
      backgroundColor: colors.surface,
    },
    header: {
      minHeight: 44,
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.sm,
      paddingHorizontal: spacing.sm,
    },
    processingHeader: {
      minHeight: 48,
      paddingVertical: spacing.xs,
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.md,
    },
    copy: { flex: 1, minWidth: 0 },
    title: {
      color: colors.textMuted,
      ...chatTypography.step,
      fontWeight: "500",
    },
    status: { color: colors.textDim, ...chatTypography.status },
    failed: { color: colors.red },
    details: {
      paddingTop: spacing.xs,
    },
    outputScroll: {
      maxHeight: 240,
      backgroundColor: colors.background,
      borderRadius: radius.md,
    },
    code: {
      color: colors.textMuted,
      fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
      fontSize: 12,
      lineHeight: 18,
      letterSpacing: 0,
      padding: spacing.sm,
    },
    codeGroup: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      borderRadius: radius.md,
      overflow: "hidden",
    },
  });
