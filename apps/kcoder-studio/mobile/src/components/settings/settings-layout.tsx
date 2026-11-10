import type { ReactNode } from "react";
import { useEffect } from "react";
import { useRouter } from "expo-router";
import { useIsFocused } from "expo-router";
import { ChevronLeft, ChevronRight } from "lucide-react-native";
import { BackHandler, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLocale } from "@/i18n/use-locale";
import { t } from "@/i18n";
import { backOrReplace } from "@/navigation/back-or-replace";
import { radius, spacing, useTheme, useThemedStyles, type ThemeColors } from "@/theme";

export function SettingsPage({
  title,
  testID,
  titleTestID,
  fallback = "/settings",
  children,
}: {
  title: string;
  testID: string;
  titleTestID: string;
  fallback?: Parameters<typeof backOrReplace>[1];
  children: ReactNode;
}) {
  const router = useRouter();
  const isFocused = useIsFocused();
  const insets = useSafeAreaInsets();
  useLocale();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);

  useEffect(() => {
    if (testID === "settings-home" || Platform.OS !== "android" || !isFocused) return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      if (router.canGoBack()) return false;
      router.replace("/settings");
      return true;
    });
    return () => subscription.remove();
  }, [isFocused, router, testID]);

  return (
    <View testID={testID} style={[styles.root, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable
          testID="settings-detail-back"
          accessibilityRole="button"
          accessibilityLabel={t("common.back")}
          onPress={() => backOrReplace(router, fallback)}
          style={({ pressed }) => [styles.backButton, pressed && styles.pressed]}
        >
          <ChevronLeft size={23} color={colors.text} />
        </Pressable>
        <Text testID={titleTestID} accessibilityRole="header" style={styles.headerTitle}>{title}</Text>
        <View style={styles.headerBalance} />
      </View>
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[styles.content, { paddingBottom: Math.max(insets.bottom, spacing.lg) + spacing.lg }]}
      >
        {children}
      </ScrollView>
    </View>
  );
}

export function SettingsGroup({ title, testID, children }: { title?: string; testID?: string; children: ReactNode }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View testID={testID}>
      {title ? <Text accessibilityRole="header" style={styles.groupTitle}>{title}</Text> : null}
      <View style={styles.group}>{children}</View>
    </View>
  );
}

export function SettingsRow({
  testID,
  icon,
  label,
  note,
  value,
  onPress,
  last = false,
  accessibilityLabel,
  labelNumberOfLines,
  noteNumberOfLines,
  valueNumberOfLines,
}: {
  testID: string;
  icon?: ReactNode;
  label: string;
  note?: string;
  value?: string;
  onPress(): void;
  last?: boolean;
  accessibilityLabel?: string;
  labelNumberOfLines?: number;
  noteNumberOfLines?: number;
  valueNumberOfLines?: number;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      {icon ?? null}
      <View style={styles.rowCopy}>
        <Text numberOfLines={labelNumberOfLines} style={styles.rowLabel}>{label}</Text>
        {note ? <Text numberOfLines={noteNumberOfLines ?? 2} style={styles.rowNote}>{note}</Text> : null}
      </View>
      {value ? <Text numberOfLines={valueNumberOfLines ?? 2} style={styles.rowValue}>{value}</Text> : null}
      <ChevronRight size={20} color={colors.textDim} />
      {!last ? <View style={[styles.rowDivider, !icon && styles.rowDividerNoIcon, { pointerEvents: "none" }]} /> : null}
    </Pressable>
  );
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.settingsPageBackground },
  header: { minHeight: 58, flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: spacing.lg },
  backButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center", borderRadius: radius.pill, backgroundColor: colors.settingsGroupBackground },
  headerTitle: { flex: 1, minWidth: 0, marginHorizontal: spacing.sm, color: colors.text, fontSize: 17, fontWeight: "600", textAlign: "center" },
  headerBalance: { width: 44, height: 44 },
  content: { width: "100%", maxWidth: 720, alignSelf: "center", paddingHorizontal: spacing.lg, paddingTop: spacing.sm, gap: spacing.md },
  groupTitle: { color: colors.textMuted, fontSize: 12, fontWeight: "500", marginBottom: spacing.xs, marginHorizontal: spacing.xs },
  group: { overflow: "hidden", borderRadius: radius.settingsGroup, backgroundColor: colors.settingsGroupBackground },
  row: { position: "relative", minHeight: 56, flexDirection: "row", alignItems: "center", gap: spacing.md, paddingHorizontal: spacing.lg, paddingVertical: spacing.xs },
  rowCopy: { flex: 1, minWidth: 0, gap: 2 },
  rowLabel: { color: colors.text, fontSize: 16, fontWeight: "500" },
  rowNote: { color: colors.textDim, fontSize: 12, lineHeight: 17 },
  rowValue: { flexShrink: 1, maxWidth: "42%", color: colors.textMuted, fontSize: 15, textAlign: "right" },
  rowDivider: { position: "absolute", left: 56, right: spacing.lg, bottom: 0, height: StyleSheet.hairlineWidth, backgroundColor: colors.border },
  rowDividerNoIcon: { left: spacing.lg },
  pressed: { opacity: 0.72 },
});
