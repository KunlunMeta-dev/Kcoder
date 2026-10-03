import { runtimeErrorSummary } from "@/components/runtime-error";
import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { styles } from "./taskStyles";

export function RuntimeErrorBanner({
  error,
  onReconnect,
  onReconcile,
}: {
  error: string;
  onReconnect?: () => Promise<void>;
  onReconcile?: () => Promise<void>;
}) {
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
            {reconnecting ? "正在核对…" : "核对执行状态"}
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
            {reconnecting ? "正在重新连接…" : "重试连接"}
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
            {expanded ? "收起技术详情" : "查看技术详情"}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}
