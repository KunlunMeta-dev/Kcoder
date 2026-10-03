import { useEffect, useRef, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { GatewayRpcClient } from "@/gateway/rpc";
import type { GatewayProfile, KCoderServer } from "@/gateway/types";
import { HistoryRefreshController, type HistoryRefreshSnapshot } from "@/runtime/history-refresh";
import { colors, radius, spacing } from "@/theme";

export interface HistoryRefreshTarget { profile: GatewayProfile; server: KCoderServer; workspace: string }

export function HistoryRefreshModal({ target, onClose, onReady }: {
  target: HistoryRefreshTarget; onClose: () => void; onReady: () => void;
}) {
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
  const labels = { idle: "等待确认", building: "正在刷新", paused: "已暂停，可继续", ready: "刷新完成", incomplete: "刷新不完整，仍使用权威列表", cancelled: "已取消", error: "刷新失败" };
  return <Modal transparent animationType="fade" visible onRequestClose={onClose}>
    <View style={styles.backdrop}>
      <View style={styles.dialog} accessibilityViewIsModal>
        <ScrollView contentContainerStyle={styles.content}>
          <Text accessibilityRole="header" style={styles.title}>刷新历史索引</Text>
          <Text style={styles.text}>Gateway：{target.profile.label}（{target.profile.id}）</Text>
          <Text style={styles.text}>服务器：{target.server.label}（{target.server.id} / {target.server.transport}）</Text>
          <Text selectable style={styles.text}>工作区：{target.workspace}</Text>
          <Text style={styles.text}>仅为此工作区显式重建历史索引，不改写原始历史。启用后，手工编辑或旧版写入器写入的历史需要再次手动刷新；请先停止这些外部写入。不会启用其他工作区，也不会修改全局偏好。</Text>
          {phase === "idle" ? <Pressable testID="history-refresh-acknowledge" accessibilityRole="checkbox" accessibilityState={{ checked: acknowledged }} onPress={() => setAcknowledged((value) => !value)} style={styles.button}>
            <Text style={styles.text}>{acknowledged ? "☑" : "☐"} 我理解并确认上述约定</Text>
          </Pressable> : null}
          <Text accessibilityLiveRegion="polite" style={styles.text}>{labels[phase]}</Text>
          {snapshot.progress ? <Text style={styles.text}>已检查 {snapshot.progress.examinedEntries} 项 · 已索引 {snapshot.progress.indexedSessions} 会话 · 问题 {snapshot.progress.issueCount}</Text> : null}
          {phase === "paused" ? <Text style={styles.text}>本轮达到 200 步或 2 分钟上限。继续将复用同一连接及游标；关闭将取消。</Text> : null}
          {snapshot.error ? <Text accessibilityRole="alert" style={styles.error}>{snapshot.error}</Text> : null}
          {phase === "idle" ? <Pressable testID="history-refresh-start" accessibilityRole="button" disabled={!acknowledged} accessibilityState={{ disabled: !acknowledged }} style={[styles.button, !acknowledged && styles.disabled]} onPress={() => { void controller.current?.start(acknowledged); }}><Text style={styles.text}>确认并开始</Text></Pressable> : null}
          {phase === "paused" ? <Pressable accessibilityRole="button" style={styles.button} onPress={() => { void controller.current?.resume(); }}><Text style={styles.text}>继续刷新</Text></Pressable> : null}
          <Pressable testID="history-refresh-close" accessibilityRole="button" style={styles.button} onPress={onClose}><Text style={styles.text}>{phase === "building" || phase === "paused" ? "取消并关闭" : "关闭"}</Text></Pressable>
        </ScrollView>
      </View>
    </View>
  </Modal>;
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.65)", justifyContent: "center", padding: spacing.lg },
  dialog: { backgroundColor: colors.background, borderRadius: radius.lg, maxHeight: "90%", width: "100%", maxWidth: 560, alignSelf: "center" },
  content: { padding: spacing.lg, gap: spacing.md },
  title: { color: colors.text, fontSize: 20, fontWeight: "600" },
  text: { color: colors.text, fontSize: 14, lineHeight: 22 },
  error: { color: colors.red, fontSize: 14 },
  button: { padding: spacing.md, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md },
  disabled: { opacity: 0.4 },
});
