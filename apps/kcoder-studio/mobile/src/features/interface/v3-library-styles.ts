import { Platform, StyleSheet } from "react-native";
import type { ThemeColors } from "@/theme";

// Each V3 page owns its presentation; V1/V2 keep their existing recipes.
const palette = (colors: ThemeColors) => {
  const light = colors.background === "#FFFFFF";
  return { canvas: light ? "#FAFAFF" : colors.pageCanvas,
    surface: light ? "#FFFFFF" : colors.surfaceRaised,
    home: light ? "#F8F9F7" : colors.pageCanvas,
    blue: light ? "#275DA1" : "#76AEF1", tint: light ? "#E5F0FF" : colors.actionTint };
};

export const v3HomeStyles = (colors: ThemeColors) => {
  const p = palette(colors);
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: p.home },
    header: { height: 64, paddingHorizontal: 12, flexDirection: "row", alignItems: "center", gap: 0 },
    content: { paddingHorizontal: 16, paddingTop: 6, gap: 24 },
    sectionTitle: { color: colors.text, fontSize: 21, fontWeight: "700", paddingTop: 8, paddingBottom: 12 },
    projectSection: { gap: 20 }, serverSection: { gap: 20 },
    workspaceRow: { minHeight: 56, flexDirection: "row", alignItems: "flex-start", gap: 4, marginBottom: 4 },
    workspaceName: { flexShrink: 1, minWidth: 0, color: colors.text, fontSize: 18, fontWeight: "700" },
    workspaceTargetLabel: { flexShrink: 1, color: colors.textDim, fontSize: 14 },
    workspaceIdentity: { flex: 1, minWidth: 0, gap: 6 },
    workspaceTarget: { flexDirection: "row", alignItems: "center", gap: 8 },
    thread: { flex: 1, minWidth: 0, minHeight: 52, paddingHorizontal: 4, flexDirection: "row", alignItems: "center", gap: 8, borderRadius: 10 },
    threadTitle: { flex: 1, minWidth: 0, color: colors.textMuted, fontSize: 16, fontWeight: "400" },
    threadMeta: { color: colors.textDim, fontSize: 12 },
    inboxButton: { minHeight: 36, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, borderRadius: 22, backgroundColor: p.tint },
    inboxLabel: { color: p.blue, fontSize: 14, fontWeight: "600" },
    inboxBadge: { minWidth: 26, height: 22, paddingHorizontal: 6, borderRadius: 12, alignItems: "center", justifyContent: "center", backgroundColor: "#5099DC" },
    floatingNew: { position: "absolute", right: 12, width: 64, height: 64, borderRadius: 32, backgroundColor: "#5099DC", borderWidth: 2, borderColor: p.surface, alignItems: "center", justifyContent: "center", ...(Platform.OS === "web" ? { boxShadow: `0px 4px 12px ${p.blue}33` } : { shadowColor: p.blue, shadowOpacity: 0.2, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 5 }) },
  });
};

export const v3HistoryStyles = (colors: ThemeColors) => {
  const p = palette(colors);
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: p.canvas },
    header: { height: 64, flexDirection: "row", alignItems: "center", paddingHorizontal: 8, backgroundColor: p.surface },
    headerTitle: { flex: 1, color: colors.text, fontSize: 18, fontWeight: "600", textAlign: "center" },
    search: { height: 48, margin: 14, marginBottom: 12, paddingLeft: 14, paddingRight: 6, flexDirection: "row", alignItems: "center", gap: 8, borderRadius: 12, backgroundColor: p.surface },
    searchIcon: { flexShrink: 0 },
    searchInput: { flex: 1, minWidth: 0, color: colors.text, fontSize: 14 },
    searchActionButton: { flexShrink: 0, minWidth: 56, height: 36, paddingHorizontal: 12, alignItems: "center", justifyContent: "center", borderRadius: 11, backgroundColor: "#275DA1" },
    searchAction: { color: "#FFFFFF", fontSize: 14, fontWeight: "500" },
    content: { flexGrow: 1, paddingHorizontal: 14, backgroundColor: p.surface, borderRadius: 16 },
    dateGroup: { color: colors.textMuted, fontSize: 14, fontWeight: "600", paddingTop: 20, paddingBottom: 10, borderBottomWidth: 0 },
    row: { minHeight: 68, flexDirection: "row", alignItems: "center", borderBottomWidth: 0, marginBottom: 4 },
    rowMain: { flex: 1, minWidth: 0, minHeight: 68, paddingHorizontal: 8, flexDirection: "row", alignItems: "center", gap: 8, borderRadius: 12 },
    rowPressed: { backgroundColor: p.tint },
    copy: { flex: 1, minWidth: 0, gap: 8, paddingVertical: 10 },
    titleRow: { minWidth: 0, flexDirection: "row", alignItems: "center", gap: 8 },
    title: { minWidth: 0, flex: 1, color: colors.text, fontSize: 16, fontWeight: "600" },
    rowTime: { color: colors.textDim, fontSize: 13, flexShrink: 0 },
    rowDetail: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 0 },
    rowScope: { flex: 1, color: colors.textMuted, fontSize: 14 },
    selectedTitle: { color: p.blue },
  });
};

export const v3FilterStyles = (colors: ThemeColors) => {
  const p = palette(colors);
  return StyleSheet.create({
    page: { flex: 1, backgroundColor: p.surface },
    header: { height: 64, flexDirection: "row", alignItems: "center", paddingHorizontal: 8 },
    title: { flex: 1, color: colors.text, fontSize: 18, fontWeight: "600", textAlign: "center" },
    resetButton: { minWidth: 58, minHeight: 36, paddingHorizontal: 10, marginRight: 8, borderRadius: 11, backgroundColor: "#275DA1", justifyContent: "center", alignItems: "center" },
    reset: { color: "#FFFFFF", fontSize: 14, fontWeight: "500" },
    content: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 24 },
    sectionHeading: { flexDirection: "row", alignItems: "center", gap: 4, paddingTop: 14, paddingBottom: 8 },
    sectionTitle: { color: colors.text, fontSize: 16, fontWeight: "600" },
    nextSection: { marginTop: 24 },
    option: { flexDirection: "row", alignItems: "center", minHeight: 70, gap: 12, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
    allOption: { minHeight: 52 },
    optionTitle: { flexShrink: 1, flex: 1, color: colors.text, fontSize: 16, fontWeight: "400" },
    projectTitle: { fontWeight: "400" },
    caption: { color: colors.textDim, fontSize: 13, lineHeight: 20 },
    radio: { width: 19, height: 19, borderRadius: 10, borderWidth: 1.3, borderColor: colors.textDim, alignItems: "center", justifyContent: "center" },
    radioSelected: { borderColor: p.blue, backgroundColor: "transparent" },
    radioDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: p.blue },
  });
};
