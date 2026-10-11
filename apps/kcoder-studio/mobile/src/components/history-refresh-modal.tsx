import { useEffect, useRef, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { GatewayRpcClient } from "@/gateway/rpc";
import type { GatewayProfile, KCoderServer } from "@/gateway/types";
import { HistoryRefreshController, type HistoryRefreshSnapshot } from "@/runtime/history-refresh";
import { t } from "@/i18n";
import { useLocale } from "@/i18n/use-locale";
import { radius, spacing, useThemedStyles, type ThemeColors } from "@/theme";

export interface HistoryRefreshTarget { profile: GatewayProfile; server: KCoderServer; workspace: string }

export function HistoryRefreshModal({ target, onClose, onReady }: {
  target: HistoryRefreshTarget; onClose: () => void; onReady: () => void;
}) {
  useLocale();
  const styles = useThemedStyles(makeStyles);
  const [acknowledged, setAcknowledged] = useState(false);
  const [snapshot, setSnapshot] = useState<HistoryRefreshSnapshot>({ phase: "idle" });
  const controller = useRef<HistoryRefreshController | null>(null);
  const ready = useRef(onReady);
  ready.current = onReady;
  useEffect(() => {
    let active = true;
    const next = new HistoryRefreshController(
      () => GatewayRpcClient.connect(target.profile, target.server, target.workspace),
      (value) => {
        if (!active) return;
        setSnapshot(value);
        if (value.phase === "ready") ready.current();
      },
    );
    controller.current = next;
    return () => { active = false; controller.current = null; void next.cancel(); };
  }, [target]);
  const phase = snapshot.phase;
  const labels = {
    idle: t("mobile.history_refresh.status_idle"),
    building: t("mobile.history_refresh.status_building"),
    paused: t("mobile.history_refresh.status_paused"),
    ready: t("mobile.history_refresh.status_ready"),
    incomplete: t("mobile.history_refresh.status_incomplete"),
    cancelled: t("mobile.history_refresh.status_cancelled"),
    error: t("mobile.history_refresh.status_error"),
  };
  return <Modal transparent animationType="fade" visible onRequestClose={onClose}>
    <View style={styles.backdrop}>
      <View style={styles.dialog} accessibilityViewIsModal>
        <ScrollView contentContainerStyle={styles.content}>
          <Text accessibilityRole="header" style={styles.title}>{t("mobile.history_refresh.title")}</Text>
          <Text style={styles.text}>{t("mobile.history_refresh.gateway", { label: target.profile.label, id: target.profile.id })}</Text>
          <Text style={styles.text}>{t("mobile.history_refresh.server", { label: target.server.label, id: target.server.id, transport: target.server.transport })}</Text>
          <Text selectable style={styles.text}>{t("mobile.history_refresh.workspace", { workspace: target.workspace })}</Text>
          <Text style={styles.text}>{t("mobile.history_refresh.explanation")}</Text>
          {phase === "idle" ? <Pressable testID="history-refresh-acknowledge" accessibilityRole="checkbox" accessibilityState={{ checked: acknowledged }} onPress={() => setAcknowledged((value) => !value)} style={styles.button}>
            <Text style={styles.text}>{acknowledged ? "☑" : "☐"} {t("mobile.history_refresh.acknowledgment")}</Text>
          </Pressable> : null}
          <Text accessibilityLiveRegion="polite" style={styles.text}>{labels[phase]}</Text>
          {snapshot.progress ? <Text style={styles.text}>{t("mobile.history_refresh.progress", { entries: snapshot.progress.examinedEntries, sessions: snapshot.progress.indexedSessions, issues: snapshot.progress.issueCount })}</Text> : null}
          {phase === "paused" ? <Text style={styles.text}>{t("mobile.history_refresh.paused_explanation")}</Text> : null}
          {snapshot.error ? <Text accessibilityRole="alert" style={styles.error}>{snapshot.error}</Text> : null}
          {phase === "idle" ? <Pressable testID="history-refresh-start" accessibilityRole="button" disabled={!acknowledged} accessibilityState={{ disabled: !acknowledged }} style={[styles.button, !acknowledged && styles.disabled]} onPress={() => { void controller.current?.start(acknowledged); }}><Text style={styles.text}>{t("mobile.history_refresh.start")}</Text></Pressable> : null}
          {phase === "paused" ? <Pressable accessibilityRole="button" style={styles.button} onPress={() => { void controller.current?.resume(); }}><Text style={styles.text}>{t("mobile.history_refresh.resume")}</Text></Pressable> : null}
          <Pressable testID="history-refresh-close" accessibilityRole="button" style={styles.button} onPress={onClose}><Text style={styles.text}>{phase === "building" || phase === "paused" ? t("mobile.history_refresh.cancel_and_close") : t("mobile.history_refresh.close")}</Text></Pressable>
        </ScrollView>
      </View>
    </View>
  </Modal>;
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: colors.overlay, justifyContent: "center", padding: spacing.lg },
  dialog: { backgroundColor: colors.background, borderRadius: radius.lg, maxHeight: "90%", width: "100%", maxWidth: 560, alignSelf: "center" },
  content: { padding: spacing.lg, gap: spacing.md },
  title: { color: colors.text, fontSize: 20, fontWeight: "600" },
  text: { color: colors.text, fontSize: 14, lineHeight: 22 },
  error: { color: colors.red, fontSize: 14 },
  button: { padding: spacing.md, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md },
  disabled: { opacity: 0.4 },
});
