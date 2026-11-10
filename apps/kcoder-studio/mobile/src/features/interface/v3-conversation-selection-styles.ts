import { StyleSheet } from "react-native";
import type { ThemeColors } from "@/theme";

/** Selection-page recipe from the V3 reference; history and V1/V2 keep their own recipes. */
export const v3ConversationSelectionStyles = (colors: ThemeColors) => {
  const light = colors.background === "#FFFFFF";
  const surface = light ? "#FFFFFF" : colors.surfaceRaised;
  const text = light ? "#333333" : colors.text;
  const muted = light ? "#999999" : colors.textDim;
  const border = light ? "#E7E7E7" : colors.border;
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: light ? "#FBFBFF" : colors.pageCanvas },
    header: { height: 44, paddingHorizontal: 1, flexDirection: "row", alignItems: "center", backgroundColor: surface },
    icon: { color: text },
    iconButton: { width: 44, height: 44, borderRadius: 8, alignItems: "center", justifyContent: "center" },
    pendingIcon: { width: 24, height: 24, transform: [{ translateX: 8 }] },
    hourglass: { position: "absolute", right: -1, bottom: 0, backgroundColor: surface },
    badge: { position: "absolute", right: 1, top: 1, minWidth: 16, height: 16, paddingHorizontal: 3, borderRadius: 8, backgroundColor: colors.blue, alignItems: "center", justifyContent: "center" },
    badgeText: { color: "#FFFFFF", fontSize: 10, fontWeight: "600" },
    scroll: { flex: 1, backgroundColor: surface, borderRadius: 8 },
    scrollContent: { flexGrow: 1, padding: 0, gap: 0 },
    content: { flexGrow: 1, paddingHorizontal: 13, paddingTop: 2, paddingBottom: 8 },
    servers: { gap: 16 },
    sectionHeader: { minHeight: 44, flexDirection: "row", alignItems: "center", marginRight: -10 },
    sectionToggle: { flex: 1, minWidth: 0, minHeight: 44, flexDirection: "row", alignItems: "center", gap: 8 },
    sectionCopy: { flex: 1, minWidth: 0, minHeight: 44, flexDirection: "row", alignItems: "center", gap: 8 },
    sectionName: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 6 },
    sectionLabel: { minWidth: 0, flexShrink: 1, minHeight: 44, justifyContent: "center" },
    sectionTitle: { flexShrink: 1, minWidth: 0, color: light ? "#222222" : colors.text, fontSize: 14, lineHeight: 20, fontWeight: "600" },
    count: { color: light ? "#666666" : colors.textMuted, fontSize: 13, fontWeight: "600" },
    thread: { minHeight: 40, flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: border },
    threadCopy: { flex: 1, minWidth: 0 },
    threadTitle: { color: text, fontSize: 14, lineHeight: 20, fontWeight: "400" },
    time: { color: muted, fontSize: 14, lineHeight: 20, flexShrink: 0 },
    activity: { fontSize: 10, flexShrink: 1 },
    folders: { marginTop: 16 },
    all: { minHeight: 40, justifyContent: "center", borderBottomWidth: 1, borderBottomColor: border },
    projectRow: { borderBottomWidth: 1, borderBottomColor: border },
    projectGroupTitle: { color: colors.textMuted, fontSize: 13, lineHeight: 18, fontWeight: "600", paddingTop: 16, paddingBottom: 4 },
    project: { minWidth: 0, minHeight: 70, justifyContent: "center", gap: 6, paddingVertical: 12 },
    regularProject: { minWidth: 0, minHeight: 70, paddingVertical: 12, flexDirection: "row", alignItems: "center", gap: 8 },
    regularCopy: { flex: 1, minWidth: 0, gap: 6 },
    pinControl: { flexShrink: 0, maxWidth: "50%" },
    pinHitTarget: { width: 32, height: 32, marginVertical: -6, marginHorizontal: -10 },
    pinButton: { width: 32, height: 32, borderRadius: 8, alignItems: "center", justifyContent: "center" },
    pinError: { color: colors.red, fontSize: 12, lineHeight: 18, paddingBottom: 8 },
    projectName: { minWidth: 0, flexDirection: "row", alignItems: "center", gap: 6 },
    projectLabel: { minWidth: 0, flexShrink: 1, justifyContent: "center", minHeight: 32, marginVertical: -6 },
    projectTitle: { flexShrink: 1, minWidth: 0, color: text, fontSize: 14, lineHeight: 20 },
    projectDetail: { flexDirection: "row", alignItems: "center", gap: 3, minWidth: 0 },
    caption: { color: muted, fontSize: 13, lineHeight: 18, flexShrink: 1 },
    serverCaption: { flex: 1, minWidth: 0 },
    more: { minHeight: 40, justifyContent: "center" },
    filler: { flex: 1, minHeight: 24 },
    bottomLine: { height: 1, backgroundColor: border },
    pressed: { backgroundColor: colors.surfaceHover },
    selected: { backgroundColor: light ? "#F2F6FC" : colors.surface },
    disabled: { opacity: 0.45 },
  });
};
