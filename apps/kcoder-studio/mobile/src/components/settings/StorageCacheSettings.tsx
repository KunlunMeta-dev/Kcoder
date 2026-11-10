import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { RefreshCw, Trash2 } from "lucide-react-native";
import { useApp } from "@/state/AppContext";
import { t } from "@/i18n";
import { useLocale } from "@/i18n/use-locale";
import { requestConfirmation } from "@/platform/confirmation";
import { sessionTranscriptCache } from "@/storage/session-transcript-cache";
import {
  clearRebuildableCatalogCaches,
  readBrowserOriginStorageEstimate,
  type BrowserOriginStorageEstimate,
} from "@/storage/cache-management";
import { SettingsGroup } from "@/components/settings/settings-layout";
import { spacing, useTheme, useThemedStyles, type ThemeColors } from "@/theme";

type EstimateState = { status: "loading" } | BrowserOriginStorageEstimate;

function formatBytes(bytes: number, locale: string): string {
  if (bytes < 1024) return `${Math.round(bytes).toLocaleString(locale)} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes / 1024;
  let unit = units[0];
  for (let index = 1; value >= 1024 && index < units.length; index += 1) {
    value /= 1024;
    unit = units[index];
  }
  return `${value.toLocaleString(locale, { maximumFractionDigits: 1 })} ${unit}`;
}

export default function StorageCacheSettings() {
  const locale = useLocale();
  const { activeProfile } = useApp();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [estimate, setEstimate] = useState<EstimateState>({ status: "loading" });
  const [refreshing, setRefreshing] = useState(false);
  const [cacheBusy, setCacheBusy] = useState(false);
  const [cacheStatus, setCacheStatus] = useState<string | null>(null);
  const generation = useRef(0);
  const activeProfileRef = useRef(activeProfile);
  const cacheBusyRef = useRef(false);
  const mountedRef = useRef(false);
  activeProfileRef.current = activeProfile;

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const refreshEstimate = useCallback(async () => {
    const current = ++generation.current;
    setRefreshing(true);
    const result = await readBrowserOriginStorageEstimate();
    if (current === generation.current) {
      setEstimate(result);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void refreshEstimate();
    return () => {
      generation.current += 1;
    };
  }, [refreshEstimate]);

  const confirmCacheClear = () => {
    const profile = activeProfile;
    if (!profile || cacheBusyRef.current) return;
    const owner = cacheProfileIdentity(profile);
    requestConfirmation({
      title: t("storage.cache_confirm_title"),
      message: t("storage.cache_confirm_body"),
      confirmLabel: t("storage.cache_confirm"),
      cancelLabel: t("storage.cache_cancel"),
      destructive: true,
      onConfirm: async () => {
        if (!mountedRef.current || cacheProfileIdentity(activeProfileRef.current) !== owner || cacheBusyRef.current) return;
        cacheBusyRef.current = true;
        setCacheBusy(true);
        setCacheStatus(null);
        try {
          clearRebuildableCatalogCaches(profile.id);
          await sessionTranscriptCache.invalidateProfile(profile, () => mountedRef.current && cacheProfileIdentity(activeProfileRef.current) === owner);
          if (mountedRef.current && cacheProfileIdentity(activeProfileRef.current) === owner) setCacheStatus(t("storage.cache_cleared"));
        } catch {
          if (mountedRef.current && cacheProfileIdentity(activeProfileRef.current) === owner) setCacheStatus(t("storage.cache_failed", { reason: "unknown error" }));
        } finally {
          cacheBusyRef.current = false;
          if (mountedRef.current) setCacheBusy(false);
        }
      },
    });
  };

  const usageText = estimate.status === "loading"
    ? t("storage.loading")
    : estimate.status === "unavailable"
      ? t(estimate.reason === "api-unsupported"
        ? "storage.unsupported"
        : estimate.reason === "no-measurement"
          ? "storage.no_measurement"
          : "storage.read_failed")
      : estimate.usageBytes === undefined
        ? t("storage.no_measurement")
        : formatBytes(estimate.usageBytes, locale);
  const quotaText = estimate.status === "available" && estimate.quotaBytes !== undefined
    ? formatBytes(estimate.quotaBytes, locale)
    : t(estimate.status === "unavailable" && estimate.reason === "read-failed"
      ? "storage.read_failed"
      : "storage.no_measurement");

  return (
    <View style={styles.content}>
      <SettingsGroup title={t("storage.device_title")} testID="settings-storage-estimate-group">
        <View testID="settings-storage-usage" style={styles.metricRow}>
          <Text style={styles.metricLabel}>{t("storage.usage")}</Text>
          <Text accessibilityLiveRegion="polite" style={styles.metricValue}>{usageText}</Text>
        </View>
        <View style={styles.divider} />
        <View testID="settings-storage-quota" style={styles.metricRow}>
          <Text style={styles.metricLabel}>{t("storage.quota")}</Text>
          <Text style={styles.metricValue}>{quotaText}</Text>
        </View>
        <Text style={styles.note}>{t("storage.estimate_note")}</Text>
        <Pressable
          testID="settings-storage-refresh"
          accessibilityRole="button"
          accessibilityState={{ disabled: refreshing }}
          disabled={refreshing}
          onPress={() => void refreshEstimate()}
          style={({ pressed }) => [styles.action, pressed && styles.pressed]}
        >
          <RefreshCw size={18} color={colors.text} />
          <Text style={styles.actionText}>{refreshing ? t("storage.loading") : t("storage.refresh")}</Text>
        </Pressable>
      </SettingsGroup>

      <SettingsGroup title={t("storage.cache_title")} testID="settings-storage-cache-group">
        {activeProfile ? (
          <Text testID="settings-storage-cache-gateway" style={styles.note}>
            {t("storage.cache_gateway", { name: activeProfile.label })}
          </Text>
        ) : (
          <Text style={styles.note}>{t("storage.cache_no_gateway")}</Text>
        )}
        <Text style={styles.note}>{t("storage.cache_description")}</Text>
        <Text style={styles.note}>{t("storage.offline_retention")}</Text>
        <Pressable
          testID="settings-storage-cache-clear"
          accessibilityRole="button"
          accessibilityLabel={t("storage.cache_clear")}
          accessibilityState={{ disabled: !activeProfile || cacheBusy }}
          disabled={!activeProfile || cacheBusy}
          onPress={confirmCacheClear}
          style={({ pressed }) => [styles.action, pressed && styles.pressed, (!activeProfile || cacheBusy) && styles.disabled]}
        >
          <Trash2 size={18} color={activeProfile && !cacheBusy ? colors.text : colors.textDim} />
          <Text style={[styles.actionText, (!activeProfile || cacheBusy) && styles.disabledText]}>
            {cacheBusy ? t("storage.cache_busy") : t("storage.cache_clear")}
          </Text>
        </Pressable>
        {cacheStatus ? <Text testID="settings-storage-cache-status" accessibilityLiveRegion="polite" style={styles.status}>{cacheStatus}</Text> : null}
      </SettingsGroup>
    </View>
  );
}

function cacheProfileIdentity(profile: {
  id: string;
  baseUrl: string;
  deviceId?: string;
  authorizationGeneration?: string;
  authMode?: string;
} | null): string | null {
  if (!profile) return null;
  return JSON.stringify([
    profile.id,
    profile.baseUrl,
    profile.deviceId ?? null,
    profile.authorizationGeneration ?? null,
    profile.authMode ?? "legacy",
  ]);
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  content: { gap: spacing.md },
  metricRow: { minHeight: 48, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.md, paddingHorizontal: spacing.lg },
  metricLabel: { flex: 1, color: colors.text, fontSize: 14, lineHeight: 20 },
  metricValue: { flexShrink: 1, color: colors.textMuted, fontSize: 14, lineHeight: 20, textAlign: "right" },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border, marginHorizontal: spacing.lg },
  note: { color: colors.textMuted, fontSize: 12, lineHeight: 18, paddingHorizontal: spacing.lg, paddingVertical: spacing.xs },
  action: { minHeight: 48, flexDirection: "row", alignItems: "center", gap: spacing.md, paddingHorizontal: spacing.lg },
  actionText: { color: colors.text, fontSize: 14, fontWeight: "500", lineHeight: 20 },
  status: { color: colors.textMuted, fontSize: 12, lineHeight: 18, paddingHorizontal: spacing.lg, paddingBottom: spacing.md },
  disabled: { opacity: 0.55 },
  disabledText: { color: colors.textDim },
  pressed: { opacity: 0.72 },
});
