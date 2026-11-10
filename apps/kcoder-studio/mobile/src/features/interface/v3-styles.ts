import { Platform, StyleSheet } from "react-native";
import { spacing, type ThemeColors } from "@/theme";

export const v3ConversationPalette = (colors: ThemeColors) => colors.background === "#FFFFFF"
  ? { reply: "#FFFFFF", control: "#F5F5F5", user: "#E5F0FF", userText: "#275DA1", processing: "#F5F4FA", thinkingIcon: "#D59B35",
    goalSurface: "#F7F7F7", goalAction: "#1E53A3", goalProgress: "#0066F6", goalOrbit: "#09DADC" }
  : { reply: colors.surfaceRaised, control: colors.surface, user: "#243D5B", userText: "#AFD0FF", processing: "#292737", thinkingIcon: "#E7B65C",
    goalSurface: colors.surface, goalAction: colors.accentBright, goalProgress: colors.blue, goalOrbit: "#42D8D4" };

// Conversation-specific V3 presentation; list pages have their own V3 recipes.
export const v3TaskStyles = (colors: ThemeColors) => {
  const p = v3ConversationPalette(colors);
  return StyleSheet.create({
  root: { flex: 1, backgroundColor: "transparent" },
  panel: { flex: 1, backgroundColor: "transparent" },
  jumpToLatestPosition: { alignSelf: "center" },
  jumpToLatest: {
    position: "absolute", bottom: spacing.lg, zIndex: 4,
    alignItems: "center", justifyContent: "center", flexDirection: "row",
    width: 36, height: 36, minHeight: 36, paddingHorizontal: 0, gap: 0, borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, backgroundColor: colors.surfaceRaised,
    ...(Platform.OS === "web" ? { boxShadow: "0px 2px 5px rgba(0,0,0,0.1)" } : {
      shadowColor: "#000", shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.1, shadowRadius: 4, elevation: 2,
    }),
  },
  header: { height: 60, paddingHorizontal: spacing.sm, flexDirection: "row", alignItems: "center" },
  headerCopy: { flex: 1, minWidth: 0, alignItems: "center", justifyContent: "center" },
  headerActionOutline: { width: 36, height: 36, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  messageRow: { paddingHorizontal: 16, marginBottom: 20, alignItems: "flex-start" },
  userMessageRow: { alignItems: "flex-end" },
  userBubble: { maxWidth: "92%", backgroundColor: p.user, borderWidth: 0, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 8 },
  userText: { color: p.userText },
  assistantBubble: { width: "100%", maxWidth: 760, minWidth: 0, borderWidth: 0, borderRadius: 10, padding: 12, backgroundColor: p.reply },
  assistantResponseAction: { width: 28, height: 28, borderWidth: 0, alignItems: "center", justifyContent: "center" },
  assistantResponseActions: { flexWrap: "wrap", borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, marginTop: 10, paddingTop: 2, gap: 0 },
  orderedProcessingGroup: { width: "100%", minWidth: 0, paddingHorizontal: 10, paddingVertical: 4, borderWidth: 0, borderRadius: 12, backgroundColor: p.processing },
  orderedProcessingTitle: { color: colors.text, fontSize: 16, lineHeight: 24, fontWeight: "700" },
  orderedProcessingDetails: { paddingTop: 4, paddingBottom: 8 },
  processingStepGlyph: { width: 22, height: 22, flexShrink: 0, alignItems: "center", justifyContent: "center", backgroundColor: p.processing, zIndex: 1 },
  thinkingContent: { maxHeight: 240, minWidth: 0, marginLeft: 0 },
  toolDetails: { gap: 8, marginLeft: 22, paddingVertical: 4 },
  composerWrap: { paddingTop: spacing.xs, paddingHorizontal: 0, backgroundColor: "transparent" },
  composer: { flexDirection: "column", borderRadius: 16, backgroundColor: colors.surfaceRaised, overflow: "hidden" },
  draftComposer: { borderRadius: 16 },
  composerInputArea: { height: 48, position: "relative" },
  composerInputAreaExpanded: { minHeight: 48 },
  composerInputCollapsed: { top: 2, left: 14, right: 14, height: 44, textAlignVertical: "center" },
  composerInputCollapsedRunning: { right: 14 },
  composerInputExpanded: { top: 12, left: 14, right: 14, textAlignVertical: "top" },
  composerActions: { minHeight: 44, paddingHorizontal: 14, paddingBottom: 6, flexDirection: "row", alignItems: "center", gap: 8 },
  conversationComposerActions: {},
  attachButton: { width: 24, height: 24, borderRadius: 12, backgroundColor: p.control, alignItems: "center", justifyContent: "center" },
  composerMeta: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 4 },
  modelSelectorMeta: { minWidth: 60, maxWidth: 180, minHeight: 28, flexShrink: 1, flexDirection: "row", alignItems: "center", gap: 4, backgroundColor: p.control, borderRadius: 12, paddingHorizontal: 12 },
  draftModelSelector: {},
  model: { flexShrink: 1, color: colors.textMuted, fontSize: 13 },
  sendButton: { minWidth: 66, height: 32, paddingHorizontal: 12, borderRadius: 18, flexDirection: "row", gap: 4, alignItems: "center", justifyContent: "center", backgroundColor: "#275DA1" },
  sendButtonDisabled: { opacity: 0.45 },
  conversationSendButtonDisabled: { opacity: 0.45 },
  sendLabel: { color: "#FFFFFF", fontSize: 13 },
  });
};

export const v3ContextStyles = (colors: ThemeColors) => StyleSheet.create({
  contextGroup: { marginTop: 0, marginBottom: 6, paddingHorizontal: 14 },
  bar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", minHeight: 38, gap: 12 },
  contextIdentity: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 8 },
  serverButton: { flexShrink: 1, maxWidth: "57%", minWidth: 0, minHeight: 30, paddingHorizontal: 8, flexDirection: "row", alignItems: "center", gap: 4, backgroundColor: colors.surfaceRaised, borderRadius: 18 },
  projectButton: { flexShrink: 1, maxWidth: "43%", minWidth: 0, minHeight: 30, paddingHorizontal: 8, flexDirection: "row", alignItems: "center", gap: 4, backgroundColor: colors.surfaceRaised, borderRadius: 18 },
  projectValue: { flexShrink: 1, minWidth: 0, color: colors.text, fontSize: 13 },
});
