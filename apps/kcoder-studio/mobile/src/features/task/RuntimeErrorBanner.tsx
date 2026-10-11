import { t } from "@/i18n";
import { useLocale } from "@/i18n/use-locale";
import { runtimeErrorSummary } from "@/components/runtime-error";
import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useTaskAppearance } from "./taskStyles";

export function RuntimeErrorBanner({
  error,
  onReconnect,
  onReconcile,
}: {
  error: string;
  onReconnect?: () => Promise<void>;
  onReconcile?: () => Promise<void>;
}) {
  useLocale();
  const { styles } = useTaskAppearance();
  const [reconnecting, setReconnecting] = useState(false);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => setExpanded(false), [error]);
  const summary = runtimeErrorSummary(error);
  const hasDetails = summary !== error;
  return (
    <View
      testID="runtime-error-banner"
      accessibilityRole="alert"
      accessibilityLiveRegion="assertive"
      style={styles.errorBanner}
    >
      <Text style={styles.errorText}>{expanded ? error : summary}</Text>
      {onReconcile ? (
        <Pressable
          testID="runtime-reconcile-send"
          accessibilityRole="button"
          disabled={reconnecting}
          onPress={() => {
            setReconnecting(true);
            void onReconcile()
              .catch(() => {})
              .finally(() => setReconnecting(false));
          }}
          style={[styles.errorDetailsButton, { minHeight: 44 }]}
        >
          <Text style={styles.errorDetailsText}>
            {reconnecting
              ? t("task.checking")
              : t("task.check_execution_status")}
          </Text>
        </Pressable>
      ) : null}
      {onReconnect ? (
        <Pressable
          testID="runtime-reconnect"
          accessibilityRole="button"
          disabled={reconnecting}
          onPress={() => {
            setReconnecting(true);
            void onReconnect()
              .catch(() => {})
              .finally(() => setReconnecting(false));
          }}
          style={[styles.errorDetailsButton, { minHeight: 44 }]}
        >
          <Text style={styles.errorDetailsText}>
            {reconnecting ? t("task.reconnecting") : t("task.retry_connection")}
          </Text>
        </Pressable>
      ) : null}
      {hasDetails ? (
        <Pressable
          testID="runtime-error-details"
          accessibilityRole="button"
          aria-expanded={expanded}
          accessibilityState={{ expanded }}
          onPress={() => setExpanded((value) => !value)}
          style={styles.errorDetailsButton}
        >
          <Text style={styles.errorDetailsText}>
            {expanded
              ? t("task.hide_technical_details")
              : t("task.view_technical_details")}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}
