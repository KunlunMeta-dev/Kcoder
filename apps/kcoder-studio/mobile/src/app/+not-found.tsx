import { usePathname, useRouter } from "expo-router";
import { Platform, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button } from "@/components/ui";
import { useTranslation } from "@/i18n/use-translation";
import { getSafeNotFoundPathname, goToNotFoundHome, returnFromNotFound } from "@/navigation/not-found-presentation";
import { radius, spacing, useTheme, useThemedStyles, type ThemeColors } from "@/theme";

export default function MobileNotFoundRoute() {
  const router = useRouter();
  const routePathname = usePathname();
  const insets = useSafeAreaInsets();
  const [translate] = useTranslation();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const browserPathname = Platform.OS === "web" && typeof window !== "undefined"
    ? window.location.pathname
    : undefined;
  const pathname = getSafeNotFoundPathname(browserPathname ?? routePathname);

  return (
    <View
      testID="mobile-not-found-screen"
      style={[
        styles.root,
        {
          paddingTop: Math.max(insets.top, spacing.lg),
          paddingBottom: Math.max(insets.bottom, spacing.lg),
        },
      ]}
    >
      <View style={styles.content}>
        <Text style={styles.status}>404</Text>
        <Text testID="mobile-not-found-title" accessibilityRole="header" style={styles.title}>
          {translate("not_found.title")}
        </Text>
        <Text style={styles.description}>{translate("not_found.description")}</Text>

        <View style={styles.pathCard}>
          <Text style={styles.pathLabel}>{translate("not_found.path_label")}</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator style={styles.pathScroller}>
            <Text testID="mobile-not-found-path" selectable style={styles.path}>{pathname}</Text>
          </ScrollView>
        </View>

        <View style={styles.actions}>
          <Button
            testID="mobile-not-found-back"
            onPress={() => returnFromNotFound(router)}
            style={styles.actionButton}
          >
            {translate("not_found.go_back")}
          </Button>
          <Button
            testID="mobile-not-found-home"
            variant="primary"
            onPress={() => goToNotFoundHome(router)}
            style={styles.actionButton}
          >
            {translate("not_found.go_home")}
          </Button>
        </View>
      </View>
    </View>
  );
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  root: {
    flex: 1,
    justifyContent: "center",
    backgroundColor: colors.pageCanvas,
    paddingHorizontal: spacing.lg,
  },
  content: {
    width: "100%",
    maxWidth: 560,
    alignSelf: "center",
    gap: spacing.md,
  },
  status: {
    color: colors.textDim,
    fontSize: 13,
    fontWeight: "600",
    letterSpacing: 1,
    textAlign: "center",
  },
  title: {
    color: colors.text,
    fontSize: 22,
    fontWeight: "600",
    textAlign: "center",
  },
  description: {
    color: colors.textMuted,
    fontSize: 14,
    lineHeight: 21,
    textAlign: "center",
  },
  pathCard: {
    marginTop: spacing.sm,
    gap: spacing.xs,
    padding: spacing.md,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  pathLabel: {
    color: colors.textDim,
    fontSize: 12,
    fontWeight: "500",
  },
  pathScroller: { maxWidth: "100%" },
  path: {
    color: colors.text,
    fontFamily: Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" }),
    fontSize: 12,
    lineHeight: 18,
  },
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  actionButton: { flexGrow: 1, flexBasis: 140 },
});
