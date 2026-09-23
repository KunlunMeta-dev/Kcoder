import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Bot, Check, ChevronDown, FileCode2, GitCompareArrows, Globe2, Plus, TerminalSquare, X } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { WorkspacePanelState, WorkspaceTab } from "@/storage/workspace-preferences";
import { colors, radius, spacing } from "@/theme";
import { useModalFocusTrap } from "./use-modal-focus-trap";

function PanelIcon({ kind, active = false }: { kind: WorkspaceTab; active?: boolean }) {
  const color = active ? colors.text : colors.textMuted;
  if (kind === "agent") return <Bot size={16} color={color} />;
  if (kind === "changes") return <GitCompareArrows size={16} color={color} />;
  if (kind === "terminal") return <TerminalSquare size={16} color={color} />;
  if (kind === "browser") return <Globe2 size={16} color={color} />;
  return <FileCode2 size={16} color={color} />;
}

export function WorkspaceTabSwitcher({
  panels,
  activePanelId,
  open,
  onOpenChange,
  onSelect,
  onClose,
  onAdd,
}: {
  panels: readonly WorkspacePanelState[];
  activePanelId: string;
  open: boolean;
  onOpenChange(open: boolean): void;
  onSelect(panel: WorkspacePanelState): void;
  onClose(panelId: string): void;
  onAdd(): void;
}) {
  const insets = useSafeAreaInsets();
  const active = panels.find((panel) => panel.id === activePanelId) ?? panels[0];
  const modalRef = useModalFocusTrap(open, () => onOpenChange(false));
  const select = (panel: WorkspacePanelState) => {
    onSelect(panel);
    onOpenChange(false);
  };
  return (
    <>
      <View style={styles.bar}>
        <Pressable testID="workspace-tab-switcher" accessibilityRole="button" aria-expanded={open} accessibilityState={{ expanded: open }} onPress={() => onOpenChange(true)} style={({ pressed }) => [styles.trigger, pressed && styles.pressed]}>
          {active ? <PanelIcon kind={active.kind} active /> : null}
          <Text numberOfLines={1} style={styles.triggerText}>{active?.title ?? "工作区"}</Text>
          <Text style={styles.count}>{panels.length} 个</Text>
          <ChevronDown size={16} color={colors.textDim} />
        </Pressable>
        <Pressable testID="workspace-add-panel" accessibilityRole="button" accessibilityLabel="新建工作区标签" onPress={onAdd} style={styles.add}><Plus size={18} color={colors.textMuted} /></Pressable>
      </View>
      <Modal visible={open} transparent animationType="slide" accessibilityLabel="工作区标签" onRequestClose={() => onOpenChange(false)}>
        <Pressable style={styles.overlay} onPress={() => onOpenChange(false)} />
        <View ref={modalRef} style={[styles.sheet, { paddingBottom: Math.max(spacing.lg, insets.bottom + spacing.sm) }]}>
          <View style={styles.sheetHeader}><Text style={styles.sheetTitle}>工作区标签</Text><Pressable accessibilityLabel="关闭" onPress={() => onOpenChange(false)} style={styles.headerAction}><X size={19} color={colors.textMuted} /></Pressable></View>
          <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
            {panels.map((panel) => {
              const selected = panel.id === activePanelId;
              return (
                <View key={panel.id} style={[styles.row, selected && styles.selectedRow]}>
                  <Pressable testID={`workspace-tab-${panel.id}`} accessibilityRole="tab" accessibilityState={{ selected }} onPress={() => select(panel)} style={styles.rowMain}>
                    <PanelIcon kind={panel.kind} active={selected} />
                    <View style={styles.rowCopy}><Text numberOfLines={1} style={[styles.rowTitle, selected && styles.selectedText]}>{panel.title}</Text><Text style={styles.rowKind}>{panel.kind === "agent" ? "对话" : panel.kind === "changes" ? "文件差异" : panel.kind === "terminal" ? "PTY 终端" : panel.kind === "browser" ? "远程浏览器" : "文件工作区"}</Text></View>
                    {selected ? <Check size={17} color={colors.accentBright} /> : null}
                  </Pressable>
                  {panel.kind !== "agent" && panel.kind !== "changes" ? <Pressable accessibilityLabel={`关闭${panel.title}`} onPress={() => onClose(panel.id)} style={styles.close}><X size={16} color={colors.textDim} /></Pressable> : null}
                </View>
              );
            })}
          </ScrollView>
          <Pressable testID="workspace-new-panel" accessibilityRole="button" accessibilityLabel="新建工作区标签" onPress={() => { onOpenChange(false); onAdd(); }} style={styles.newTab}><Plus size={17} color={colors.textMuted} /><Text style={styles.newTabText}>新建标签</Text></Pressable>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  bar: { height: 44, flexDirection: "row", alignItems: "center", borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border, backgroundColor: colors.surface },
  trigger: { flex: 1, height: 44, flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingHorizontal: spacing.md },
  pressed: { backgroundColor: colors.surfaceHover },
  triggerText: { flexShrink: 1, color: colors.text, fontSize: 13, fontWeight: "600" },
  count: { minWidth: 32, height: 18, paddingHorizontal: 6, borderRadius: radius.pill, overflow: "hidden", color: colors.textDim, backgroundColor: colors.surfaceRaised, fontSize: 9, lineHeight: 18, textAlign: "center" },
  add: { width: 48, height: 44, alignItems: "center", justifyContent: "center", borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: colors.border },
  overlay: { ...StyleSheet.absoluteFillObject, backgroundColor: colors.overlay },
  sheet: { maxHeight: "72%", marginTop: "auto", borderTopLeftRadius: 20, borderTopRightRadius: 20, borderWidth: 1, borderColor: colors.borderAccent, backgroundColor: colors.surfaceRaised },
  sheetHeader: { height: 56, flexDirection: "row", alignItems: "center", paddingLeft: spacing.lg, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  sheetTitle: { flex: 1, color: colors.text, fontSize: 16, fontWeight: "600" },
  headerAction: { width: 48, height: 48, alignItems: "center", justifyContent: "center" },
  list: { flexGrow: 0 },
  listContent: { padding: spacing.sm },
  row: { minHeight: 58, flexDirection: "row", alignItems: "center", borderRadius: radius.lg },
  selectedRow: { backgroundColor: colors.surfaceHover },
  rowMain: { flex: 1, minWidth: 0, minHeight: 58, flexDirection: "row", alignItems: "center", gap: spacing.md, paddingLeft: spacing.md },
  rowCopy: { flex: 1, minWidth: 0 },
  rowTitle: { color: colors.textMuted, fontSize: 14, fontWeight: "500" },
  selectedText: { color: colors.text },
  rowKind: { color: colors.textDim, fontSize: 10, marginTop: 3 },
  close: { width: 48, height: 48, alignItems: "center", justifyContent: "center" },
  newTab: { minHeight: 48, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: spacing.sm, marginHorizontal: spacing.md, marginTop: spacing.sm, borderWidth: 1, borderStyle: "dashed", borderColor: colors.borderAccent, borderRadius: radius.lg },
  newTabText: { color: colors.textMuted, fontSize: 13, fontWeight: "500" },
});
