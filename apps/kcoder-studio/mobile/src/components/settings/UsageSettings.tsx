import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { RefreshCw, Server } from "lucide-react-native";
import { SettingsGroup } from "@/components/settings/settings-layout";
import { SettingsTargetChangedError, useSettingsTarget } from "@/components/settings/SettingsTargetContext";
import { t } from "@/i18n";
import { useLocale } from "@/i18n/use-locale";
import { errorText, formatUsageMessage, parseUsageStats, requiresExplicitProfile, summarizeUsage, type UsageCounters, type UsageStats } from "@/components/settings/settings-tools-usage-model";
import { spacing, useTheme, useThemedStyles, type ThemeColors } from "@/theme";

type TargetState = ReturnType<typeof useSettingsTarget>;

export function UsageSettings() {
  const target = useSettingsTarget();
  return <UsageSettingsForTarget key={target.targetIdentity ?? "no-selected-target"} target={target} />;
}

function UsageSettingsForTarget({ target }: { target: TargetState }) {
  const locale = useLocale();
  const text = (key: string) => t(key);
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [stats, setStats] = useState<UsageStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [range, setRange] = useState<7 | 30>(30);
  const requestGeneration = useRef(0);
  const selected = Boolean(target.profile && target.server && target.serverId && target.targetIdentity);
  const ready = selected && target.ready;
  const supportsUsage = target.capabilities.appServer?.experimental?.usageHistory === true;

  const read = useCallback(async () => {
    const current = ++requestGeneration.current;
    setStats(null);
    setError(null);
    if (!ready || target.error || !supportsUsage) {
      setLoading(false);
      return;
    }

    setLoading(true);
    try {
      const value = await target.request<unknown>("usage/stats", {});
      if (requestGeneration.current !== current) return;
      setStats(parseUsageStats(value));
    } catch (failure) {
      if (requestGeneration.current !== current) return;
      const reason = errorText(failure);
      if (failure instanceof SettingsTargetChangedError) {
        setError(text("settings_tools_usage.usage_target_changed"));
      } else if (requiresExplicitProfile(failure)) {
        setError(text("settings_tools_usage.usage_profile_required"));
      } else if (/invalid usage (statistics response|counters)|usage counters exceed/i.test(reason)) {
        setError(text("settings_tools_usage.usage_invalid_response"));
      } else {
        setError(reason
          ? `${text("settings_tools_usage.usage_load_failed")} ${reason}`
          : text("settings_tools_usage.usage_load_failed"));
      }
    } finally {
      if (requestGeneration.current === current) setLoading(false);
    }
  }, [ready, target.error, target.request, supportsUsage, locale]);

  useEffect(() => {
    void read();
    return () => {
      requestGeneration.current++;
    };
  }, [read]);

  const summary = useMemo(() => stats ? summarizeUsage(stats, range) : null, [stats, range]);
  const providerError = target.error;
  const waitingForTarget = target.loading || (selected && !target.ready && !providerError);
  const waitingForUsage = ready && supportsUsage && loading;
  const hasUsageHistory = Boolean(stats?.history);
  const numberLocale = locale === "zh-CN" ? "zh-CN" : "en";
  const count = (value: number) => new Intl.NumberFormat(numberLocale).format(value);
  const compact = (value: number) => new Intl.NumberFormat(numberLocale, {
    notation: value < 10_000 ? "standard" : "compact",
    maximumFractionDigits: 1,
  }).format(value);
  const date = (value: number) => new Intl.DateTimeFormat(numberLocale, {
    dateStyle: "medium",
    timeZone: "UTC",
  }).format(value);

  const metric = (title: string, value: string, testID: string, last: boolean) => (
    <View key={testID} testID={testID} style={[styles.metric, last && styles.metricLast]}>
      <Text style={styles.metricLabel}>{title}</Text>
      <Text style={styles.metricValue}>{value}</Text>
    </View>
  );

  return (
    <>
      <SettingsGroup title={text("settings_tools_usage.target_label")} testID="usage-target-context">
        <View style={styles.targetRow}>
          <Server size={18} color={colors.textMuted} />
          <Text testID="usage-target-name" numberOfLines={1} style={styles.targetName}>
            {target.server?.label ?? text("settings_tools_usage.target_required")}
          </Text>
          {waitingForTarget || waitingForUsage ? <ActivityIndicator size="small" color={colors.textMuted} /> : null}
          {ready && supportsUsage && !loading && !error ? (
            <Pressable
              testID="usage-refresh"
              accessibilityRole="button"
              accessibilityLabel={text("settings_tools_usage.usage_refresh")}
              disabled={loading}
              onPress={() => void read()}
              style={({ pressed }) => [styles.refreshButton, pressed && styles.pressed]}
            >
              <RefreshCw size={18} color={colors.textMuted} />
            </Pressable>
          ) : null}
        </View>
      </SettingsGroup>

      <SettingsGroup title={text("settings_tools_usage.usage_group")} testID="usage-settings">
        <View style={styles.intro}>
          <Text style={styles.note}>{text("settings_tools_usage.usage_description")}</Text>
          <Text style={styles.note}>{text("settings_tools_usage.usage_cost_unavailable")}</Text>
        </View>

        {(!selected && !target.loading) ? <Text testID="usage-no-target" style={styles.noteBlock}>{text("settings_tools_usage.target_required")}</Text> : null}
        {waitingForTarget ? <StatusLine testID="usage-target-loading" label={text("settings_tools_usage.target_loading")} loading styles={styles} colors={colors} /> : null}
        {providerError ? <ErrorNotice message={providerError} styles={styles} /> : null}
        {ready && !supportsUsage ? <ErrorNotice testID="usage-unsupported" message={text("settings_tools_usage.usage_unsupported")} styles={styles} /> : null}
        {waitingForUsage ? <StatusLine testID="usage-loading" label={text("settings_tools_usage.usage_loading")} loading styles={styles} colors={colors} /> : null}
        {error ? <RetryNotice message={error} onRetry={() => void read()} text={text("settings_tools_usage.retry")} styles={styles} colors={colors} /> : null}

        {stats && !stats.history ? (
          <Text testID="usage-empty" style={styles.noteBlock}>{text("settings_tools_usage.usage_empty")}</Text>
        ) : null}
        {stats?.history && summary ? (
          <>
            <Text testID="usage-coverage" style={styles.noteBlock}>
              {formatUsageMessage(text("settings_tools_usage.usage_coverage"), { date: date(stats.history.trackedSinceMs) })}
            </Text>
            <View style={styles.rangeRow} accessibilityRole="radiogroup" accessibilityLabel={text("settings_tools_usage.usage_range")}>
              {([7, 30] as const).map((days) => {
                const active = range === days;
                return (
                  <Pressable
                    key={days}
                    testID={`usage-history-window-${days}`}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: active }}
                    onPress={() => setRange(days)}
                    style={({ pressed }) => [styles.rangeOption, active && styles.rangeOptionActive, pressed && styles.pressed]}
                  >
                    <Text style={[styles.rangeText, active && styles.rangeTextActive]}>
                      {text(days === 7 ? "settings_tools_usage.usage_range_7" : "settings_tools_usage.usage_range_30")}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
            {summary.total.requests === 0 ? <Text testID="usage-no-requests" style={styles.noteBlock}>{text("settings_tools_usage.usage_no_requests")}</Text> : null}
            <View testID="usage-summary" style={styles.metrics}>
              {metric(text("settings_tools_usage.usage_requests"), count(summary.total.requests), "usage-summary-requests", false)}
              {metric(text("settings_tools_usage.usage_total_tokens"), compact(summary.total.totalTokens), "usage-summary-total-tokens", true)}
              {metric(text("settings_tools_usage.usage_input_tokens"), compact(summary.total.inputTokens), "usage-summary-input-tokens", false)}
              {metric(text("settings_tools_usage.usage_output_tokens"), compact(summary.total.outputTokens), "usage-summary-output-tokens", true)}
              {metric(text("settings_tools_usage.usage_cache_read"), compact(summary.total.cacheReadTokens), "usage-summary-cache-read", false)}
              {metric(text("settings_tools_usage.usage_cache_creation"), compact(summary.total.cacheCreationTokens), "usage-summary-cache-creation", true)}
            </View>
            {summary.total.unreportedRequests > 0 ? (
              <Text testID="usage-unreported" style={styles.noteBlock}>
                {formatUsageMessage(text("settings_tools_usage.usage_missing"), { count: count(summary.total.unreportedRequests) })}
              </Text>
            ) : null}
            {summary.total.estimatedTotalRequests > 0 ? (
              <Text testID="usage-estimated" style={styles.noteBlock}>
                {formatUsageMessage(text("settings_tools_usage.usage_estimated"), { count: count(summary.total.estimatedTotalRequests) })}
              </Text>
            ) : null}
            <Text style={styles.noteBlock}>{text("settings_tools_usage.usage_accounting")}</Text>
          </>
        ) : null}
      </SettingsGroup>

      {hasUsageHistory && summary && summary.models.length > 0 ? (
        <SettingsGroup title={text("settings_tools_usage.usage_by_model")} testID="usage-by-model">
          {summary.models.map((model, index) => (
            <ModelRow
              key={model.label}
              model={model}
              last={index === summary.models.length - 1}
              requests={count(model.requests)}
              tokens={compact(model.totalTokens)}
              styles={styles}
            />
          ))}
        </SettingsGroup>
      ) : null}
    </>
  );
}

function StatusLine({ testID, label, loading, styles, colors }: { testID: string; label: string; loading: boolean; styles: ReturnType<typeof makeStyles>; colors: ThemeColors }) {
  return (
    <View testID={testID} accessibilityState={{ busy: loading }} style={styles.statusRow}>
      {loading ? <ActivityIndicator size="small" color={colors.textMuted} /> : null}
      <Text style={styles.note}>{label}</Text>
    </View>
  );
}

function ErrorNotice({ testID = "usage-error", message, styles }: { testID?: string; message: string; styles: ReturnType<typeof makeStyles> }) {
  return <Text accessibilityRole="alert" testID={testID} selectable style={styles.error}>{message}</Text>;
}

function RetryNotice({ message, onRetry, text, styles, colors }: { message: string; onRetry(): void; text: string; styles: ReturnType<typeof makeStyles>; colors: ThemeColors }) {
  return (
    <View style={styles.retryRow}>
      <ErrorNotice message={message} styles={styles} />
      <Pressable testID="usage-retry" accessibilityRole="button" accessibilityLabel={text} onPress={onRetry} style={({ pressed }) => [styles.retryButton, pressed && styles.pressed]}>
        <RefreshCw size={16} color={colors.textMuted} />
        <Text style={styles.retryText}>{text}</Text>
      </Pressable>
    </View>
  );
}

function ModelRow({ model, last, requests, tokens, styles }: { model: UsageCounters & { label: string }; last: boolean; requests: string; tokens: string; styles: ReturnType<typeof makeStyles> }) {
  return (
    <View testID={`usage-model-${model.label}`} style={[styles.modelRow, !last && styles.divider]}>
      <View style={styles.modelCopy}>
        <Text selectable numberOfLines={1} style={styles.modelName}>{model.label}</Text>
        <Text style={styles.note}>{requests} · {tokens}</Text>
      </View>
    </View>
  );
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  targetRow: { minHeight: 52, flexDirection: "row", alignItems: "center", gap: spacing.md, paddingLeft: spacing.lg, paddingRight: spacing.sm },
  targetName: { flex: 1, minWidth: 0, color: colors.text, fontSize: 15, fontWeight: "500" },
  refreshButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center", borderRadius: 999 },
  intro: { gap: spacing.xs, paddingHorizontal: spacing.lg, paddingTop: spacing.md, paddingBottom: spacing.sm },
  note: { color: colors.textDim, fontSize: 12, lineHeight: 18 },
  noteBlock: { color: colors.textDim, fontSize: 12, lineHeight: 18, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
  statusRow: { minHeight: 44, flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingHorizontal: spacing.lg },
  error: { color: colors.red, fontSize: 13, lineHeight: 19, paddingHorizontal: spacing.lg, paddingTop: spacing.sm },
  retryRow: { gap: spacing.sm, paddingBottom: spacing.md },
  retryButton: { minHeight: 44, flexDirection: "row", alignItems: "center", alignSelf: "flex-start", gap: spacing.sm, paddingHorizontal: spacing.lg, borderRadius: 6 },
  retryText: { color: colors.text, fontSize: 14 },
  rangeRow: { flexDirection: "row", gap: spacing.sm, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
  rangeOption: { minHeight: 40, justifyContent: "center", paddingHorizontal: spacing.md, borderRadius: 8, backgroundColor: colors.settingsPageBackground },
  rangeOptionActive: { backgroundColor: colors.surfaceRaised },
  rangeText: { color: colors.textDim, fontSize: 13 },
  rangeTextActive: { color: colors.text, fontWeight: "500" },
  metrics: { flexDirection: "row", flexWrap: "wrap", paddingHorizontal: spacing.md, paddingBottom: spacing.sm },
  metric: { width: "50%", minHeight: 66, justifyContent: "center", paddingHorizontal: spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  metricLast: { borderBottomWidth: 0 },
  metricLabel: { color: colors.textDim, fontSize: 12, lineHeight: 18 },
  metricValue: { color: colors.text, fontSize: 17, lineHeight: 23, fontWeight: "500", fontVariant: ["tabular-nums"] },
  modelRow: { minHeight: 54, justifyContent: "center", paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
  modelCopy: { gap: 2 },
  modelName: { color: colors.text, fontSize: 14, fontWeight: "500" },
  divider: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  pressed: { opacity: 0.72 },
});
