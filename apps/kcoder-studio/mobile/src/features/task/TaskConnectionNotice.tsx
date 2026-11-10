import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { CircleAlert, Info, WifiOff } from "lucide-react-native";
import { t } from "@/i18n";
import { useLocale } from "@/i18n/use-locale";
import type { TaskSnapshot } from "@/runtime/task-runtime";
import { useTaskAppearance } from "./taskStyles";

export function TaskConnectionNotice({ snapshot, onReconnect, onReauthorize }: {
  snapshot: Pick<TaskSnapshot, "connected" | "connectionPhase" | "error">;
  onReconnect(): Promise<void>;
  onReauthorize(): void;
}) {
  useLocale();
  const { styles, colors } = useTaskAppearance();
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const owner = useRef(0);
  useEffect(() => {
    owner.current += 1;
    setExpanded(false);
    setBusy(false);
    return () => { owner.current += 1; };
  }, [snapshot.connected, snapshot.connectionPhase]);
  if (snapshot.connected) return null;
  const phase = snapshot.connectionPhase;
  const recovering = phase === "reconnecting";
  const authorization = phase === "reauthorization-required";
  const failed = phase === "failed" || authorization;
  const message = recovering ? t("task.connection_recovering")
    : authorization ? t("task.connection_authorization_required")
    : phase === "failed" ? t("task.connection_recovery_stopped") : t("task.disconnected");
  return <View testID="task-connection-notice" accessibilityRole={failed ? "alert" : undefined}
    accessibilityLiveRegion={failed ? "assertive" : "polite"}
    style={[styles.connectionBanner, failed && { borderColor: colors.red }]}>
    <View style={styles.connectionBannerRow}>
      {recovering ? <ActivityIndicator testID="connection-recovering" size="small" color={colors.textMuted} />
        : failed ? <CircleAlert size={16} color={colors.red} /> : <WifiOff size={16} color={colors.textMuted} />}
      <Text testID="connection-notice-text" style={[styles.connectionBannerText, failed && { color: colors.red }]}>{message}</Text>
      {!recovering ? <Pressable testID={authorization ? "connection-reauthorize" : "connection-retry"}
        accessibilityRole="button" disabled={busy} accessibilityState={{ disabled: busy, busy }}
        onPress={() => {
          if (authorization) { onReauthorize(); return; }
          if (busy) return;
          const generation = owner.current;
          setBusy(true);
          void onReconnect().catch(() => {}).finally(() => {
            if (owner.current === generation) setBusy(false);
          });
        }} style={styles.connectionBannerAction}>
        <Text style={styles.connectionBannerActionText}>{authorization ? t("task.connection_sign_in") : t("task.retry")}</Text>
      </Pressable> : null}
      {snapshot.error ? <Pressable testID="connection-notice-details" accessibilityRole="button"
        accessibilityLabel={expanded ? t("task.hide_technical_details") : t("task.view_technical_details")}
        accessibilityState={{ expanded }} aria-expanded={expanded}
        onPress={() => setExpanded(value => !value)} style={styles.connectionBannerAction}>
        <Info size={16} color={colors.textMuted} />
      </Pressable> : null}
    </View>
    {expanded && snapshot.error ? <Text testID="connection-notice-technical-details" selectable style={styles.connectionBannerDetails}>{snapshot.error}</Text> : null}
  </View>;
}
