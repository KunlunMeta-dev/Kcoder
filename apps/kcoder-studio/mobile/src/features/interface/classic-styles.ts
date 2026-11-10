// Presentation differences retained from the V1 checkpoint 3b3a2aea.
// Controllers, authorization, storage and protocol remain shared with the current client.
import { StyleSheet } from "react-native";
import { spacing, radius, type ThemeColors } from "@/theme";

export const classicTaskStyles = (colors: ThemeColors) => StyleSheet.create({
  header: {
    height: 60,
    flexDirection: "row",
    alignItems: "center",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    paddingHorizontal: spacing.xs,
  },
  headerCopy: { flex: 1, minWidth: 0, alignItems: "center" },
  statusText: {
    color: colors.textDim,
    fontSize: 10,
    maxWidth: 230,
    flexShrink: 1,
  },
  messageListStage: { flex: 1, position: "relative" },
  assistantBubble: { width: "100%" },
  assistantResponseActions: { flexWrap: "wrap" },
  assistantResponseAction: { width: 32, height: 32, alignItems: "center", justifyContent: "center" },
  composerWrap: {
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: colors.background,
  },
  composer: {
    flexDirection: "column",
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.chatComposer,
    backgroundColor: colors.surface,
    overflow: "hidden",
  },
  composerInputArea: {
    height: 56,
    position: "relative",
  },
  composerInputAreaExpanded: {
    minHeight: 106,
  },
  composerActions: {
    position: "absolute",
    left: 0,
    right: 0,
    height: 44,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
  },
  composerActionsCollapsed: { top: 6 },
  composerInputCollapsed: {
    top: 6,
    left: 52,
    right: 52,
    height: 44,
    textAlignVertical: "center",
  },
  composerInputCollapsedRunning: { right: 100 },
  sendButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  sendButtonDisabled: {
    backgroundColor: colors.surfaceRaised,
  },
  composerMeta: {
    height: 44,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-start",
    gap: spacing.xs,
    paddingHorizontal: spacing.xs,
  },
  modelSelectorMeta: {
    flex: 1,
    flexShrink: 1,
    minWidth: 44,
    minHeight: 44,
    maxWidth: "68%",
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: spacing.xs,
  },
  model: { flexShrink: 1, color: colors.textMuted, fontSize: 12 },
  permissionTrigger: {
    minWidth: 44,
    minHeight: 44,
    flexShrink: 0,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.lg,
  },
  permissionTriggerLabel: {
    maxWidth: 132,
    color: colors.textMuted,
    fontSize: 12,
    lineHeight: 16,
  },

});

export const classicHomeStyles = (colors: ThemeColors) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  header: { height: 56, paddingHorizontal: spacing.md, flexDirection: "row", alignItems: "center", borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  content: { paddingHorizontal: spacing.md, paddingVertical: spacing.lg, gap: spacing.sm },
  serverSection: { overflow: "hidden", gap: spacing.sm },
  projectSection: { gap: spacing.sm },
  sectionTitle: { color: colors.textDim, fontSize: 12, fontWeight: "600", paddingHorizontal: spacing.lg, paddingTop: spacing.sm, paddingBottom: spacing.xs },
  listGroup: { gap: spacing.sm },
  workspaceRow: { minHeight: 48, flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingHorizontal: spacing.lg },
  workspaceName: { flexShrink: 1, minWidth: 0, color: colors.textMuted, fontSize: 13, fontWeight: "500" },
  threadRow: { flexDirection: "row", alignItems: "center" },
  thread: { flex: 1, minWidth: 0, minHeight: 48, paddingLeft: spacing.xl + spacing.sm, paddingRight: spacing.sm, flexDirection: "row", alignItems: "center", gap: spacing.sm, borderRadius: radius.md },
  threadTitle: { flex: 1, minWidth: 0, color: colors.textMuted, fontSize: 13, fontWeight: "500" }
});

export const classicHistoryStyles = (colors: ThemeColors) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  header: { height: 60, flexDirection: "row", alignItems: "center", borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border, paddingHorizontal: spacing.sm },
  headerTitle: { flex: 1, textAlign: "center", color: colors.text, fontSize: 16, fontWeight: "700" },
  search: { height: 48, margin: spacing.lg, marginBottom: spacing.sm, paddingLeft: spacing.md, paddingRight: spacing.xs, flexDirection: "row", alignItems: "center", gap: spacing.sm, borderWidth: 1, borderColor: colors.borderAccent, borderRadius: 12, backgroundColor: colors.surface },
  searchInput: { flex: 1, color: colors.text, fontSize: 13 },
  row: { minHeight: 48, flexDirection: "row", alignItems: "center", gap: spacing.xs },
  rowMain: { flex: 1, minWidth: 0, minHeight: 48, flexDirection: "row", alignItems: "center", gap: spacing.sm, borderRadius: radius.md },
  copy: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: spacing.xs },
  title: { minWidth: 0, flexShrink: 1, color: colors.textMuted, fontSize: 13, fontWeight: "500" }
});

export const classicContextStyles = (colors: ThemeColors) => StyleSheet.create({
  contextGroup: { marginBottom: spacing.xs },
  bar: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    minHeight: 44,
    paddingHorizontal: spacing.sm,
    backgroundColor: colors.surfaceHover,
  },
  projectButton: {
    minWidth: 0,
    flexShrink: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    height: 44,
    paddingHorizontal: spacing.xs,
  },
  projectValue: { flexShrink: 1, minWidth: 0, color: colors.text, fontSize: 12 }
});
