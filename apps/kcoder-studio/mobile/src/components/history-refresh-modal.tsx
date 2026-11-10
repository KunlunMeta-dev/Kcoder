import { useEffect, useRef, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { GatewayRpcClient } from "@/gateway/rpc";
import type { GatewayProfile, KCoderServer } from "@/gateway/types";
import { HistoryRefreshController, type HistoryRefreshSnapshot } from "@/runtime/history-refresh";
import { HistoryRefreshBatchController, type HistoryRefreshBatchSnapshot } from "@/runtime/history-refresh-batch";
import { t } from "@/i18n";
import { useLocale } from "@/i18n/use-locale";
import { radius, spacing, useThemedStyles, type ThemeColors } from "@/theme";

export interface HistoryRefreshWorkspaceTarget {
  kind: "workspace";
  profile: GatewayProfile;
  server: KCoderServer;
  workspace: string;
  owner: string;
}

export interface HistoryRefreshKnownWorkspacesTarget {
  kind: "known-workspaces";
  profile: GatewayProfile;
  server: KCoderServer;
  workspaces: string[];
  owner: string;
}

export type HistoryRefreshTarget = HistoryRefreshWorkspaceTarget | HistoryRefreshKnownWorkspacesTarget;
type HistoryRefreshModalSnapshot = HistoryRefreshSnapshot | HistoryRefreshBatchSnapshot;
type AnyHistoryRefreshController = HistoryRefreshController | HistoryRefreshBatchController;

export function HistoryRefreshModal({ target, onClose, onReady, isTargetCurrent }: {
  target: HistoryRefreshTarget; onClose: () => void; onReady: () => void; isTargetCurrent: () => boolean;
}) {
  useLocale();
  const styles = useThemedStyles(makeStyles);
  const [acknowledged, setAcknowledged] = useState(false);
  const [closing, setClosing] = useState(false);
  const [snapshot, setSnapshot] = useState<HistoryRefreshModalSnapshot>({ phase: "idle" });
  const controller = useRef<AnyHistoryRefreshController | null>(null);
  const current = useRef(isTargetCurrent);
  current.current = isTargetCurrent;
  const ready = useRef(onReady);
  ready.current = onReady;
  const closingRef = useRef(false);
  const commandPending = useRef(false);
  const reportCommandError = (error: unknown) => {
    commandPending.current = false;
    setSnapshot((previous) => ({ ...previous, phase: "error", error: error instanceof Error ? error.message : String(error) }));
  };
  const runControllerCommand = (command: (current: AnyHistoryRefreshController) => Promise<void>) => {
    const active = controller.current;
    if (!active || closingRef.current || commandPending.current) return;
    commandPending.current = true;
    try { void command(active).catch(reportCommandError); }
    catch (error) { reportCommandError(error); }
  };
  const closeAndWait = () => {
    if (closingRef.current) return;
    closingRef.current = true;
    setClosing(true);
    void (async () => {
      try { await controller.current?.cancel(); }
      catch (error) {
        setSnapshot((previous) => ({ ...previous, phase: "error", error: error instanceof Error ? error.message : String(error) }));
      }
      finally { onClose(); }
    })();
  };
  useEffect(() => {
    let active = true;
    const onChange = (value: HistoryRefreshModalSnapshot) => {
      if (!active || !current.current()) return;
      if (value.phase !== "building") commandPending.current = false;
      setSnapshot(value);
      if (value.phase === "ready") ready.current();
    };
    const connect = (workspace: string) => async () => {
      if (!current.current()) throw new Error("刷新目标归属已变化");
      return GatewayRpcClient.connect(target.profile, target.server, workspace);
    };
    const next: AnyHistoryRefreshController = target.kind === "workspace"
      ? new HistoryRefreshController(
        connect(target.workspace),
        onChange,
      )
      : new HistoryRefreshBatchController(
        target.workspaces,
        (workspace, childOnChange) => new HistoryRefreshController(
          connect(workspace),
          childOnChange,
        ),
        onChange,
        () => current.current(),
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
  return <Modal transparent animationType="fade" visible onRequestClose={closeAndWait}>
    <View style={styles.backdrop}>
      <View testID="history-refresh-dialog" style={styles.dialog} accessibilityViewIsModal>
        <ScrollView contentContainerStyle={styles.content}>
          <Text accessibilityRole="header" style={styles.title}>{t("mobile.history_refresh.title")}</Text>
          <Text style={styles.text}>{t("mobile.history_refresh.gateway", { label: target.profile.label, id: target.profile.id })}</Text>
          <Text style={styles.text}>{t("mobile.history_refresh.server", { label: target.server.label, id: target.server.id, transport: target.server.transport })}</Text>
          {target.kind === "workspace"
            ? <Text selectable style={styles.text}>{t("mobile.history_refresh.workspace", { workspace: target.workspace })}</Text>
            : <View testID="history-refresh-workspaces" style={styles.workspaceList}>
              <Text style={styles.text}>{t("mobile.history_refresh.known_workspaces", { count: target.workspaces.length })}</Text>
              {target.workspaces.map((workspace, index) => <Text key={`${index}:${workspace}`} testID={`history-refresh-workspace-${index}`} selectable style={styles.text}>{workspace}</Text>)}
            </View>}
          <Text style={styles.text}>{t(target.kind === "workspace" ? "mobile.history_refresh.explanation" : "mobile.history_refresh.batch_explanation")}</Text>
          {phase === "idle" ? <Pressable testID="history-refresh-acknowledge" accessibilityRole="checkbox" disabled={closing} accessibilityState={{ checked: acknowledged, disabled: closing }} onPress={() => setAcknowledged((value) => !value)} style={[styles.button, closing && styles.disabled]}>
            <Text style={styles.text}>{acknowledged ? "☑" : "☐"} {t("mobile.history_refresh.acknowledgment")}</Text>
          </Pressable> : null}
          <Text accessibilityLiveRegion="polite" style={styles.text}>{labels[phase]}</Text>
          {"totalWorkspaces" in snapshot ? <Text testID="history-refresh-batch-progress" accessibilityLiveRegion="polite" style={styles.text}>{t("mobile.history_refresh.batch_progress", {
            completed: snapshot.completedWorkspaces.length,
            total: snapshot.totalWorkspaces,
            current: snapshot.currentWorkspace ?? "—",
          })}</Text> : null}
          {"errorWorkspace" in snapshot && snapshot.errorWorkspace ? <Text style={styles.text}>{t("mobile.history_refresh.scope_result", { workspace: snapshot.errorWorkspace })}</Text> : null}
          {snapshot.progress ? <Text style={styles.text}>{t("mobile.history_refresh.progress", { entries: snapshot.progress.examinedEntries, sessions: snapshot.progress.indexedSessions, issues: snapshot.progress.issueCount })}</Text> : null}
          {phase === "paused" ? <Text style={styles.text}>{t("mobile.history_refresh.paused_explanation")}</Text> : null}
          {snapshot.error ? <Text accessibilityRole="alert" style={styles.error}>{snapshot.error}</Text> : null}
          {phase === "idle" ? <Pressable testID="history-refresh-start" accessibilityRole="button" disabled={!acknowledged || closing} accessibilityState={{ disabled: !acknowledged || closing }} style={[styles.button, (!acknowledged || closing) && styles.disabled]} onPress={() => runControllerCommand((active) => active.start(acknowledged))}><Text style={styles.text}>{t("mobile.history_refresh.start")}</Text></Pressable> : null}
          {phase === "paused" ? <Pressable accessibilityRole="button" disabled={closing} accessibilityState={{ disabled: closing }} style={[styles.button, closing && styles.disabled]} onPress={() => runControllerCommand((active) => active.resume())}><Text style={styles.text}>{t("mobile.history_refresh.resume")}</Text></Pressable> : null}
          <Pressable testID="history-refresh-close" accessibilityRole="button" disabled={closing} accessibilityState={{ disabled: closing }} style={[styles.button, closing && styles.disabled]} onPress={closeAndWait}><Text style={styles.text}>{closing ? t("mobile.history_refresh.cancelling") : phase === "building" || phase === "paused" ? t("mobile.history_refresh.cancel_and_close") : t("mobile.history_refresh.close")}</Text></Pressable>
        </ScrollView>
      </View>
    </View>
  </Modal>;
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: colors.overlay, justifyContent: "center", padding: spacing.lg },
  dialog: { backgroundColor: colors.background, borderRadius: radius.lg, maxHeight: "90%", width: "100%", maxWidth: 560, alignSelf: "center" },
  content: { padding: spacing.lg, gap: spacing.md },
  workspaceList: { gap: spacing.xs },
  title: { color: colors.text, fontSize: 20, fontWeight: "600" },
  text: { color: colors.text, fontSize: 14, lineHeight: 22 },
  error: { color: colors.red, fontSize: 14 },
  button: { padding: spacing.md, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md },
  disabled: { opacity: 0.4 },
});
