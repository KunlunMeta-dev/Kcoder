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
import { ChevronDown, ChevronRight } from "lucide-react-native";
import { colors, radius, spacing } from "@/theme";
import { getLocale, subscribeLocale, t } from "@/i18n";

export function ProcessingDisclosure({
  count,
  running,
  failed,
  children,
}: {
  count: number;
  running: boolean;
  failed: number;
  children: ReactNode;
}) {
  useSyncExternalStore(subscribeLocale, getLocale, getLocale);
  const [expanded, setExpanded] = useState(false);
  return (
    <View testID="message-processing" style={styles.processing}>
      <Pressable
        testID="message-processing-toggle"
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        aria-expanded={expanded}
        onPress={() => setExpanded((value) => !value)}
        style={styles.header}
      >
        {running ? (
          <ActivityIndicator size="small" color={colors.textMuted} />
        ) : expanded ? (
          <ChevronDown size={16} color={colors.textMuted} />
        ) : (
          <ChevronRight size={16} color={colors.textMuted} />
        )}
        <Text numberOfLines={1} style={styles.title}>
          {t(count ? "output.tools" : "output.process", { count })}
        </Text>
        <Text style={[styles.status, failed > 0 && styles.failed]}>
          {failed
            ? t("output.failed", { count: failed })
            : t(running ? "output.running" : "output.complete")}
        </Text>
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
  useSyncExternalStore(subscribeLocale, getLocale, getLocale);
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
        style={styles.outputScroll}
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
  useSyncExternalStore(subscribeLocale, getLocale, getLocale);
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
const styles = StyleSheet.create({
  processing: { marginBottom: spacing.sm },
  header: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.sm,
  },
  title: {
    flex: 1,
    minWidth: 0,
    color: colors.textMuted,
    fontSize: 12,
    fontWeight: "500",
  },
  status: { color: colors.textDim, fontSize: 11 },
  failed: { color: colors.red },
  details: {
    paddingLeft: spacing.sm,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: colors.border,
    gap: spacing.sm,
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
    padding: spacing.sm,
  },
  codeGroup: {
    marginVertical: spacing.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: radius.md,
    overflow: "hidden",
  },
});
