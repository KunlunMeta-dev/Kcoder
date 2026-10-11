import { t } from "@/i18n";
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import {
  Bot,
  Check,
  ChevronDown,
  FileCode2,
  GitCompareArrows,
  Globe2,
  Plus,
  TerminalSquare,
  X,
} from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type {
  WorkspacePanelState,
  WorkspaceTab,
} from "@/storage/workspace-preferences";
import { radius, spacing, useTheme, useThemedStyles, type ThemeColors } from "@/theme";
import { useLocale } from "@/i18n/use-locale";
import { useModalFocusTrap } from "./use-modal-focus-trap";

// Restore known UI defaults in the current locale; file names remain user data.
function panelTitle(panel: WorkspacePanelState): string {
  const defaults: Record<string, { key: string; titles: readonly string[] }> = {
    agent: { key: "task.agent", titles: ["智能体", "Agent"] },
    changes: { key: "task.changes", titles: ["变更", "Changes"] },
    "terminal-1": { key: "task.terminal_1", titles: ["终端 1", "Terminal 1"] },
    "browser-1": { key: "task.browser_1", titles: ["浏览器 1", "Browser 1"] },
    "files-1": { key: "task.files_1", titles: ["文件 1", "Files 1"] },
  };
  const preset = defaults[panel.id];
  return preset?.titles.includes(panel.title) ? t(preset.key) : panel.title;
}

function PanelIcon({
  kind,
  active = false,
  colors,
}: {
  kind: WorkspaceTab;
  active?: boolean;
  colors: ThemeColors;
}) {
  const color = active ? colors.text : colors.textMuted;
  if (kind === "agent") return <Bot size={16} color={color} />;
  if (kind === "changes") return <GitCompareArrows size={16} color={color} />;
  if (kind === "terminal") return <TerminalSquare size={16} color={color} />;
  if (kind === "browser") return <Globe2 size={16} color={color} />;
  return <FileCode2 size={16} color={color} />;
}

export function WorkspaceTabSwitcher({
  hideBar = false,
  panels,
  activePanelId,
  open,
  onOpenChange,
  onSelect,
  onClose,
  savingPanelIds,
  onAdd,
}: {
  hideBar?: boolean;
  panels: readonly WorkspacePanelState[];
  activePanelId: string;
  open: boolean;
  onOpenChange(open: boolean): void;
  onSelect(panel: WorkspacePanelState): void;
  onClose(panelId: string): void;
  savingPanelIds?: ReadonlySet<string>;
  onAdd(): void;
}) {
  useLocale();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const active =
    panels.find((panel) => panel.id === activePanelId) ?? panels[0];
  const modalRef = useModalFocusTrap(open, () => onOpenChange(false));
  const select = (panel: WorkspacePanelState) => {
    onSelect(panel);
    onOpenChange(false);
  };
  return (
    <>
      {!hideBar ? (
        <View style={styles.bar}>
          <Pressable
            testID="workspace-tab-switcher"
            accessibilityRole="button"
            aria-expanded={open}
            accessibilityState={{ expanded: open }}
            onPress={() => onOpenChange(true)}
            style={({ pressed }) => [styles.trigger, pressed && styles.pressed]}
          >
            {active ? <PanelIcon kind={active.kind} active colors={colors} /> : null}
            <Text numberOfLines={1} style={styles.triggerText}>
              {active ? panelTitle(active) : t("task.workspace")}
            </Text>
            <Text style={styles.count}>
              {panels.length} {t("task.tabs")}
            </Text>
            <ChevronDown size={16} color={colors.textDim} />
          </Pressable>
          <Pressable
            testID="workspace-add-panel"
            accessibilityRole="button"
            accessibilityLabel={t("task.new_workspace_tab")}
            onPress={onAdd}
            style={styles.add}
          >
            <Plus size={18} color={colors.textMuted} />
          </Pressable>
        </View>
      ) : null}
      <Modal
        visible={open}
        transparent
        animationType="slide"
        accessibilityLabel={t("task.workspace_tabs")}
        onRequestClose={() => onOpenChange(false)}
      >
        <Pressable style={styles.overlay} onPress={() => onOpenChange(false)} />
        <View
          ref={modalRef}
          style={[
            styles.sheet,
            { paddingBottom: Math.max(spacing.lg, insets.bottom + spacing.sm) },
          ]}
        >
          <View style={styles.sheetHeader}>
            <Text style={styles.sheetTitle}>{t("task.workspace_tabs")}</Text>
            <Pressable
              accessibilityLabel={t("task.close")}
              onPress={() => onOpenChange(false)}
              style={styles.headerAction}
            >
              <X size={19} color={colors.textMuted} />
            </Pressable>
          </View>
          <ScrollView
            style={styles.list}
            contentContainerStyle={styles.listContent}
          >
            {panels.map((panel) => {
              const selected = panel.id === activePanelId;
              const savePending = savingPanelIds?.has(panel.id) ?? false;
              return (
                <View
                  key={panel.id}
                  style={[styles.row, selected && styles.selectedRow]}
                >
                  <Pressable
                    testID={`workspace-tab-${panel.id}`}
                    accessibilityRole="tab"
                    accessibilityState={{ selected }}
                    onPress={() => select(panel)}
                    style={styles.rowMain}
                  >
                    <PanelIcon kind={panel.kind} active={selected} colors={colors} />
                    <View style={styles.rowCopy}>
                      <Text
                        numberOfLines={1}
                        style={[
                          styles.rowTitle,
                          selected && styles.selectedText,
                        ]}
                      >
                        {panelTitle(panel)}
                      </Text>
                      <Text style={styles.rowKind}>
                        {panel.kind === "agent"
                          ? t("task.conversation")
                          : panel.kind === "changes"
                            ? t("task.file_diff")
                            : panel.kind === "terminal"
                              ? t("task.pty_terminal")
                              : panel.kind === "browser"
                                ? t("task.remote_browser")
                                : t("task.file_workspace")}
                      </Text>
                    </View>
                    {selected ? (
                      <Check size={17} color={colors.accentBright} />
                    ) : null}
                  </Pressable>
                  {panel.kind !== "agent" && panel.kind !== "changes" ? <Pressable accessibilityLabel={t("mobile.workspace_tab.close_panel", { panel: panel.title })} accessibilityHint={savePending ? t("mobile.workspace_tab.save_before_close") : undefined} accessibilityState={{ disabled: savePending }} disabled={savePending} onPress={() => onClose(panel.id)} style={[styles.close, savePending && styles.closeDisabled]}><X size={16} color={colors.textDim} /></Pressable> : null}
                </View>
              );
            })}
          </ScrollView>
          <Pressable
            testID="workspace-new-panel"
            accessibilityRole="button"
            accessibilityLabel={t("task.new_workspace_tab")}
            onPress={() => {
              onOpenChange(false);
              onAdd();
            }}
            style={styles.newTab}
          >
            <Plus size={17} color={colors.textMuted} />
            <Text style={styles.newTabText}>{t("task.new_tab")}</Text>
          </Pressable>
        </View>
      </Modal>
    </>
  );
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  bar: {
    height: 44,
    flexDirection: "row",
    alignItems: "center",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    backgroundColor: colors.surface,
  },
  trigger: {
    flex: 1,
    height: 44,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
  },
  pressed: { backgroundColor: colors.surfaceHover },
  triggerText: {
    flexShrink: 1,
    color: colors.text,
    fontSize: 13,
    fontWeight: "600",
  },
  count: {
    minWidth: 32,
    height: 18,
    paddingHorizontal: 6,
    borderRadius: radius.pill,
    overflow: "hidden",
    color: colors.textDim,
    backgroundColor: colors.surfaceRaised,
    fontSize: 9,
    lineHeight: 18,
    textAlign: "center",
  },
  add: {
    width: 48,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: colors.border,
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: colors.overlay,
  },
  sheet: {
    maxHeight: "72%",
    marginTop: "auto",
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderWidth: 1,
    borderColor: colors.borderAccent,
    backgroundColor: colors.surfaceRaised,
  },
  sheetHeader: {
    height: 56,
    flexDirection: "row",
    alignItems: "center",
    paddingLeft: spacing.lg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  sheetTitle: { flex: 1, color: colors.text, fontSize: 16, fontWeight: "600" },
  headerAction: {
    width: 48,
    height: 48,
    alignItems: "center",
    justifyContent: "center",
  },
  list: { flexGrow: 0 },
  listContent: { padding: spacing.sm },
  row: {
    minHeight: 58,
    flexDirection: "row",
    alignItems: "center",
    borderRadius: radius.lg,
  },
  selectedRow: { backgroundColor: colors.surfaceHover },
  rowMain: {
    flex: 1,
    minWidth: 0,
    minHeight: 58,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingLeft: spacing.md,
  },
  rowCopy: { flex: 1, minWidth: 0 },
  rowTitle: { color: colors.textMuted, fontSize: 14, fontWeight: "500" },
  selectedText: { color: colors.text },
  rowKind: { color: colors.textDim, fontSize: 10, marginTop: 3 },
  close: { width: 48, height: 48, alignItems: "center", justifyContent: "center" },
  closeDisabled: { opacity: 0.45 },
  newTab: { minHeight: 48, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: spacing.sm, marginHorizontal: spacing.md, marginTop: spacing.sm, borderWidth: 1, borderStyle: "dashed", borderColor: colors.borderAccent, borderRadius: radius.lg },
  newTabText: { color: colors.textMuted, fontSize: 13, fontWeight: "500" },
});
