import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { t } from "@/i18n";
import { useLocale } from "@/i18n/use-locale";
import {
  getAppPreferencesStorageStatus,
  retryAppPreferencesSave,
  retryHydrateAppPreferences,
  subscribeAppPreferencesStorageStatus,
} from "@/storage/app-preferences";
import { spacing, useTheme, useThemedStyles, type ThemeColors } from "@/theme";

/** Device-local persistence feedback; retry never touches a Gateway or target setting. */
export function LocalPreferenceStorageStatus({ testID }: { testID: string }) {
  useLocale();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const status = useSyncExternalStore(subscribeAppPreferencesStorageStatus, getAppPreferencesStorageStatus, getAppPreferencesStorageStatus);
  const [retrying, setRetrying] = useState(false);
  const retryInFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const retry = async (kind: "hydrate" | "write") => {
    if (retryInFlight.current) return;
    retryInFlight.current = true;
    setRetrying(true);
    try {
      if (kind === "hydrate") await retryHydrateAppPreferences();
      else await retryAppPreferencesSave();
    } catch {
      // The shared storage status retains the failure for the current local snapshot.
    } finally {
      retryInFlight.current = false;
      if (mounted.current) setRetrying(false);
    }
  };
  const notice = (kind: "hydrate" | "write", message: string) => (
    <View testID={`${testID}-${kind}-error`} style={styles.notice}>
      <Text accessibilityRole="alert" style={styles.message}>{message}</Text>
      <Pressable testID={`${testID}-${kind}-retry`} accessibilityRole="button" disabled={retrying}
        accessibilityState={{ disabled: retrying, busy: retrying }} onPress={() => void retry(kind)} style={styles.retry}>
        {retrying ? <ActivityIndicator size="small" color={colors.text} /> : <Text style={styles.retryText}>{t("settings_personalization.retry")}</Text>}
      </Pressable>
    </View>
  );
  return <>
    {status.hydration === "error" ? notice("hydrate", t("settings_personalization.load_error")) : null}
    {status.writeError ? notice("write", t("settings_personalization.save_error")) : null}
  </>;
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  notice: { flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingHorizontal: spacing.xs },
  message: { flex: 1, color: colors.text, fontSize: 13, lineHeight: 19 },
  retry: { minHeight: 44, paddingHorizontal: spacing.sm, alignItems: "center", justifyContent: "center" },
  retryText: { color: colors.text, fontSize: 14, fontWeight: "600" },
});
