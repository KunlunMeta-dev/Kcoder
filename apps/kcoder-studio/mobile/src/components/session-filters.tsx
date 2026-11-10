import { useCallback, useEffect, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Check, ChevronLeft, CornerUpLeft, Monitor } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useModalFocusTrap } from "./use-modal-focus-trap";
import { t } from "@/i18n";
import { radius, spacing, useThemedStyles, useTheme, type ThemeColors } from "@/theme";
import { useInterfaceVersion } from "@/storage/interface-version";
import { v3FilterStyles } from "@/features/interface/v3-library-styles";

export interface SessionFilters {
  serverId: string;
  workspaceKey: string | null;
  archived: boolean;
}
export interface SessionFilterProject { key: string; serverId: string; label: string; path: string; serverLabel: string; count: number }

export function SessionFiltersPage({ visible, owner, value, servers, projects, onClose, onApply }: {
  visible: boolean; owner: string; value: SessionFilters;
  servers: { id: string; label: string; count: number }[];
  projects: SessionFilterProject[];
  onClose(): void; onApply(value: SessionFilters): void;
}) {
  const { colors } = useTheme();
  const version = useInterfaceVersion();
  const v3 = version === "v3";
  const v3Styles = useThemedStyles(v3FilterStyles);
  const styles = useThemedStyles(useCallback((colors: ThemeColors) => v3 ? { ...makeStyles(colors), ...v3FilterStyles(colors) } : makeStyles(colors), [v3]));
  const insets = useSafeAreaInsets();
  const [draft, setDraft] = useState(value);
  useEffect(() => { if (visible) setDraft(value); }, [visible, owner]);
  const leave = () => { if (v3) onApply(draft); onClose(); };
  const dialogRef = useModalFocusTrap(visible, leave);
  const matchingProjects = projects.filter(project => draft.serverId === "all" || project.serverId === draft.serverId);
  const marker = (selected: boolean) => <View style={[styles.radio, selected && styles.radioSelected]}>{selected ? v3 ? <View style={v3Styles.radioDot} /> : <Check size={14} color={colors.actionPrimaryText} /> : null}</View>;
  return <Modal visible={visible} animationType="slide" onRequestClose={leave}>
    <View ref={dialogRef} role="dialog" accessibilityViewIsModal testID="sessions-filter-page" nativeID={`sessions-filter-interface-${version}`} style={[styles.page, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable testID="sessions-filter-close" accessibilityRole="button" accessibilityLabel={t("common.back")} accessibilityHint={v3 ? t("v3.filters_apply_on_back") : undefined} onPress={leave} style={styles.iconButton}>{v3 ? <CornerUpLeft size={21} color={colors.textMuted} /> : <ChevronLeft size={23} color={colors.textMuted} />}</Pressable>
        <Text style={styles.title}>{t("v2.filter")}</Text>
        <Pressable testID="sessions-filter-reset" accessibilityRole="button" hitSlop={v3 ? 6 : undefined} onPress={() => setDraft({ serverId: "all", workspaceKey: null, archived: false })} style={styles.resetButton}><Text style={styles.reset}>{t("v2.reset")}</Text></Pressable>
      </View>
      <ScrollView contentContainerStyle={[styles.content, v3 && { paddingBottom: Math.max(insets.bottom, spacing.lg) }]}>
        <View style={styles.sectionHeading}><Text style={styles.sectionTitle}>{t("v2.servers")}</Text><Text style={styles.caption}>{v3 ? `(${servers.length})` : t("v2.available", { count: servers.length })}</Text></View>
        <Pressable testID="sessions-host-all" accessibilityRole="radio" accessibilityState={{ selected: draft.serverId === "all", checked: draft.serverId === "all" }} onPress={() => setDraft(current => ({ ...current, serverId: "all", workspaceKey: null }))} style={[styles.option, v3 && v3Styles.allOption]}><Text style={styles.optionTitle}>{t(v3 ? "v3.select_all" : "v2.all_servers")}</Text>{marker(draft.serverId === "all")}</Pressable>
        {servers.map(server => <Pressable key={server.id} testID={`sessions-host-${server.id}`} accessibilityRole="radio" accessibilityState={{ selected: draft.serverId === server.id, checked: draft.serverId === server.id }} onPress={() => setDraft(current => ({ ...current, serverId: server.id, workspaceKey: null }))} style={styles.option}>
          <View style={styles.copy}><Text numberOfLines={1} style={styles.optionTitle}>{server.label}</Text><View style={styles.detail}><Monitor size={12} color={colors.textDim} /><Text style={styles.caption}>{t("v2.loaded_conversations", { count: server.count })}</Text></View></View>{marker(draft.serverId === server.id)}
        </Pressable>)}
        <View style={[styles.sectionHeading, styles.nextSection]}><Text style={styles.sectionTitle}>{t(v3 ? "v3.project_folders" : "v2.projects")}</Text><Text style={styles.caption}>{v3 ? `(${matchingProjects.length})` : t("v2.available", { count: matchingProjects.length })}</Text></View>
        <Pressable testID="sessions-project-all" accessibilityRole="radio" accessibilityState={{ selected: draft.workspaceKey === null, checked: draft.workspaceKey === null }} onPress={() => setDraft(current => ({ ...current, workspaceKey: null }))} style={[styles.option, v3 && v3Styles.allOption]}><Text style={styles.optionTitle}>{t(v3 ? "v3.select_all" : "v2.all_projects")}</Text>{marker(draft.workspaceKey === null)}</Pressable>
        {matchingProjects.map(project => <Pressable key={project.key} testID={`sessions-project-${encodeURIComponent(project.key)}`} accessibilityRole="radio" accessibilityLabel={`${project.label} · ${project.serverLabel} · ${project.path}`} accessibilityState={{ selected: draft.workspaceKey === project.key, checked: draft.workspaceKey === project.key }} onPress={() => setDraft(current => ({ ...current, serverId: project.serverId, workspaceKey: project.key }))} style={styles.option}>
          <View style={styles.copy}><Text numberOfLines={1} style={[styles.optionTitle, styles.projectTitle]}>{project.label}</Text><Text numberOfLines={1} style={styles.caption}>{project.serverLabel} · {t("v2.loaded_conversations", { count: project.count })}</Text></View>{marker(draft.workspaceKey === project.key)}
        </Pressable>)}
        {v3 ? <><View style={[styles.sectionHeading, styles.nextSection]}><Text style={styles.sectionTitle}>{t("v2.show_archived")}</Text></View>
          {[false, true].map(archived => <Pressable key={String(archived)} testID={archived ? "sessions-archived" : "sessions-active"} accessibilityRole="radio" accessibilityState={{ checked: draft.archived === archived }} onPress={() => setDraft(current => ({ ...current, archived }))} style={[styles.option, v3Styles.allOption]}><Text style={styles.optionTitle}>{t(archived ? "v2.show_archived" : "sessions.recent_tasks")}</Text>{marker(draft.archived === archived)}</Pressable>)}
        </> : <Pressable testID={draft.archived ? "sessions-active" : "sessions-archived"} accessibilityRole="checkbox" accessibilityState={{ checked: draft.archived }} onPress={() => setDraft(current => ({ ...current, archived: !current.archived }))} style={[styles.option, styles.nextSection]}><Text style={styles.optionTitle}>{t("v2.show_archived")}</Text>{marker(draft.archived)}</Pressable>}
      </ScrollView>
      {!v3 ? <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, spacing.lg) }]}><Pressable testID="sessions-filter-apply" accessibilityRole="button" onPress={() => onApply(draft)} style={styles.apply}><Text style={styles.applyLabel}>{t("v2.apply_filters")}</Text></Pressable></View> : null}
    </View>
  </Modal>;
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.pageCanvas },
  header: { height: 64, flexDirection: "row", alignItems: "center", paddingHorizontal: spacing.sm },
  iconButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  title: { flex: 1, color: colors.text, fontSize: 19, fontWeight: "700" },
  resetButton: { minWidth: 64, minHeight: 44, justifyContent: "center", alignItems: "center" },
  reset: { color: colors.blue, fontSize: 14, fontWeight: "600" },
  content: { paddingHorizontal: spacing.lg, paddingTop: spacing.lg, paddingBottom: spacing.xl },
  sectionHeading: { flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingVertical: spacing.md },
  sectionTitle: { color: colors.textDim, fontSize: 14, fontWeight: "600" },
  caption: { color: colors.textDim, fontSize: 13, lineHeight: 20 },
  nextSection: { marginTop: spacing.xxl },
  option: { flexDirection: "row", alignItems: "center", minHeight: 64, gap: spacing.md, paddingVertical: spacing.md, paddingHorizontal: spacing.xs, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  copy: { flex: 1, minWidth: 0, gap: spacing.xs },
  optionTitle: { flexShrink: 1, flex: 1, color: colors.text, fontSize: 16 },
  projectTitle: { fontWeight: "600" },
  detail: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  radio: { width: 24, height: 24, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.border, alignItems: "center", justifyContent: "center" },
  radioSelected: { borderColor: colors.actionPrimary, backgroundColor: colors.actionPrimary },
  footer: { paddingHorizontal: spacing.lg, paddingTop: spacing.md },
  apply: { minHeight: 50, borderRadius: radius.lg, backgroundColor: colors.actionPrimary, alignItems: "center", justifyContent: "center" },
  applyLabel: { color: colors.actionPrimaryText, fontSize: 16, fontWeight: "700" },
});
