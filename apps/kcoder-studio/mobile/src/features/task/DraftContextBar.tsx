import { useInterfaceVersion } from "@/storage/interface-version";
import { v3ContextStyles } from "@/features/interface/v3-styles";
import { classicContextStyles } from "@/features/interface/classic-styles";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Check, ChevronDown, Folder, Monitor, Server, RefreshCw, X } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useModalFocusTrap } from "@/components/use-modal-focus-trap";
import { StatusDot } from "@/components/ui";
import { t } from "@/i18n";
import { useTheme, useThemedStyles, type ThemeColors, radius, spacing } from "@/theme";

export type DraftContextStatus = "online" | "offline" | "checking" | "unknown";

export type DraftContextSelection = {
  profileId: string;
  serverId: string;
  cwd: string;
};

export type DraftContextActual = DraftContextSelection & {
  scopeToken: object;
  connectionStatus: DraftContextStatus;
  projectLabel: string;
  serverLabel?: string;
};

export type DraftContextWorkspaceSelection = Pick<DraftContextWorkspace, "serverId" | "path">;
export type DraftContextWorkspace = { serverId: string; serverLabel: string; path: string; label: string };
export type DraftContextRetry = { busy: boolean; onRetry(): void | Promise<void> };
export type DraftContextProjectAvailability = "loading" | "empty" | "failed" | null;

export function resolveDraftContextProjects(
  actual: DraftContextActual,
  workspaces: DraftContextWorkspace[],
  workspaceOptionsReady: boolean,
  defaultWorkspacePath?: string,
  error?: string | null,
): { options: DraftContextWorkspace[]; availability: DraftContextProjectAvailability } {
  const options = [...workspaces];
  const hasOption = (serverId: string, path: string) => options.some((item) => item.serverId === serverId && item.path === path);
  if (actual.serverId && actual.cwd && !hasOption(actual.serverId, actual.cwd)) {
    options.push({ serverId: actual.serverId, serverLabel: actual.serverLabel ?? "", path: actual.cwd, label: actual.projectLabel });
  }
  if (actual.serverId && defaultWorkspacePath && !hasOption(actual.serverId, defaultWorkspacePath)) {
    options.push({
      serverId: actual.serverId,
      serverLabel: actual.serverLabel ?? "",
      path: defaultWorkspacePath,
      label: defaultWorkspacePath.split(/[\\/]/).filter(Boolean).at(-1) ?? defaultWorkspacePath,
    });
  }
  if (error && options.length === 0) return { options, availability: "failed" };
  if (!workspaceOptionsReady && options.length === 0) return { options, availability: "loading" };
  return { options, availability: options.length === 0 ? "empty" : null };
}

export function DraftContextBar({
  actual,
  workspaces,
  defaultWorkspacePath,
  onSelectWorkspace,
  disabled = false,
  workspaceOptionsReady = false,
  workspaceOptionsError,
  connectionRetry,
}: {
  actual: DraftContextActual;
  workspaces: DraftContextWorkspace[];
  defaultWorkspacePath?: string;
  onSelectWorkspace(selection: DraftContextWorkspaceSelection): void;
  disabled?: boolean;
  workspaceOptionsReady?: boolean;
  workspaceOptionsError?: string | null;
  connectionRetry?: DraftContextRetry;
}) {
  const { colors } = useTheme();
  const version = useInterfaceVersion();
  const classic = version === "classic";
  const styles = useThemedStyles(useCallback((colors: ThemeColors) => classic ? makeClassicStyles(colors) : version === "v3" ? { ...makeStyles(colors), ...v3ContextStyles(colors) } : makeStyles(colors), [classic, version]));
  const insets = useSafeAreaInsets();
  const [pickerState, setPickerState] = useState<{ scopeToken: object; open: boolean }>({ scopeToken: actual.scopeToken, open: false });
  const [pickerKind, setPickerKind] = useState<"project" | "server">("project");
  const [retryingScope, setRetryingScope] = useState<object | null>(null);
  const retryJob = useRef<{ scopeToken: object } | null>(null);
  const currentRetry = useRef({ scopeToken: actual.scopeToken, connectionRetry });
  currentRetry.current = { scopeToken: actual.scopeToken, connectionRetry };
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const retryBusy = Boolean(connectionRetry?.busy || retryingScope === actual.scopeToken);
  const retryConnection = async () => {
    if (!mounted.current || currentRetry.current.scopeToken !== actual.scopeToken || !connectionRetry
      || currentRetry.current.connectionRetry !== connectionRetry || connectionRetry.busy || retryJob.current?.scopeToken === actual.scopeToken) return;
    const job = { scopeToken: actual.scopeToken };
    retryJob.current = job;
    setRetryingScope(actual.scopeToken);
    try { await connectionRetry.onRetry(); }
    finally {
      if (retryJob.current === job) {
        retryJob.current = null;
        if (mounted.current) setRetryingScope(null);
      }
    }
  };
  const pickerOpen = pickerState.scopeToken === actual.scopeToken && pickerState.open;
  const showPicker = (open: boolean, kind: "project" | "server" = "project") => {
    if (!disabled || !open) { setPickerKind(kind); setPickerState({ scopeToken: actual.scopeToken, open }); }
  };
  const closePicker = () => showPicker(false);
  useEffect(() => {
    if (disabled) setPickerState({ scopeToken: actual.scopeToken, open: false });
  }, [disabled, actual.scopeToken]);
  const visiblePicker = disabled ? false : pickerOpen;
  const dialogRef = useModalFocusTrap(visiblePicker, closePicker);

  const selected = actual;
  const resolvedProjects = resolveDraftContextProjects(actual, workspaces, workspaceOptionsReady, defaultWorkspacePath, workspaceOptionsError);
  const projectOptions = resolvedProjects.options;
  const serverOptions = new Map<string, DraftContextWorkspace>();
  for (const item of projectOptions) {
    if (!serverOptions.has(item.serverId) || item.serverId === actual.serverId && item.path === actual.cwd) serverOptions.set(item.serverId, item);
  }
  const selectedOption = projectOptions.find((item) => item.serverId === selected.serverId && item.path === selected.cwd);
  const projectName = selectedOption?.label
    ?? (selected.cwd ? selected.cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? selected.cwd : t("new.draft_choose_project_action"));
  const chooseProject = (selection: DraftContextWorkspaceSelection) => {
    if (disabled) return;
    if (selection.serverId !== actual.serverId || selection.path !== actual.cwd) onSelectWorkspace(selection);
    closePicker();
  };
  const connectionLabel = actual.connectionStatus === "online" ? t("settings.status_online")
    : actual.connectionStatus === "offline" ? t("settings.status_offline")
      : actual.connectionStatus === "checking" ? t("settings.status_checking")
        : t("new.draft_context_status_unknown");

  return <View style={styles.contextGroup}>
    <View testID="draft-context-bar" style={styles.bar}>
      <View style={styles.contextIdentity}>
        <Pressable testID="draft-context-server" accessibilityRole="button"
          accessibilityLabel={`${t("v2.server")}: ${actual.serverLabel ?? t("new.draft_select_server")} · ${connectionLabel}`}
          accessibilityState={{ disabled, expanded: visiblePicker && pickerKind === "server" }} disabled={disabled}
          onPress={() => showPicker(true, "server")} hitSlop={{ top: version === "v3" ? 7 : 4, bottom: version === "v3" ? 7 : 4 }} style={[styles.serverButton, disabled && styles.disabled, classic && { display: "none" }]}>
          {version === "v3" ? <View testID="draft-context-status" accessibilityLabel={connectionLabel}><StatusDot status={actual.connectionStatus} decorative /></View> : null}
          {version === "v3" || actual.connectionStatus === "offline" ? <Server size={16} color={colors.textMuted} /> : <Monitor size={16} color={colors.textMuted} />}
          <Text numberOfLines={1} style={styles.projectValue}>{actual.serverLabel || t("new.draft_select_server")}</Text>
          <View testID={classic || version === "v3" ? undefined : "draft-context-status"} accessibilityLabel={connectionLabel} style={[styles.status, version === "v3" && { display: "none" }]}><StatusDot status={actual.connectionStatus} decorative /></View>
          <ChevronDown size={12} color={colors.textDim} />
        </Pressable>
        <Pressable testID="draft-context-project" accessibilityRole="button"
          accessibilityLabel={`${t("new.draft_context_project")}: ${projectName}${selected.cwd ? ` (${selected.cwd})` : ""}`}
          accessibilityHint={t("new.draft_context_opens_choices")}
          accessibilityState={{ disabled, expanded: visiblePicker && pickerKind === "project" }} disabled={disabled}
          onPress={() => showPicker(true, "project")} hitSlop={{ top: version === "v3" ? 7 : 4, bottom: version === "v3" ? 7 : 4 }} style={[styles.projectButton, disabled && styles.disabled]}>
          <Folder size={16} color={colors.textMuted} />
          <Text testID="draft-context-project-name" numberOfLines={1} ellipsizeMode="tail" style={styles.projectValue}>{projectName}</Text>
          {classic ? <View testID="draft-context-status" accessibilityLabel={connectionLabel} style={styles.status}><StatusDot status={actual.connectionStatus} decorative /><Text style={styles.statusText}>{connectionLabel}</Text></View> : null}
          <ChevronDown size={12} color={colors.textDim} />
        </Pressable>
      </View>
      {connectionRetry ? <Pressable testID="new-task-gateway-retry" accessibilityRole="button"
        accessibilityLabel={t("task.retry_connection")} accessibilityState={{ disabled: retryBusy, busy: retryBusy }}
        disabled={retryBusy} onPress={retryConnection} style={[styles.retryButton, retryBusy && styles.disabled]}>
        {retryBusy ? <ActivityIndicator size="small" color={colors.textMuted} /> : <RefreshCw size={17} color={colors.textMuted} />}
      </Pressable> : null}
    </View>
    <Modal testID="draft-context-project-modal" visible={visiblePicker} transparent animationType="fade" onRequestClose={closePicker}>
      <View style={styles.modalRoot}>
        <Pressable testID="draft-context-scrim" accessibilityLabel={t("new.draft_context_close")} onPress={closePicker} style={StyleSheet.absoluteFill} />
        <View ref={dialogRef} role="dialog" accessibilityViewIsModal style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, spacing.md) }]}>
          <View style={styles.sheetHeader}>
            <Text style={styles.sheetTitle}>{t(pickerKind === "server" ? "v2.server" : "new.draft_context_project")}</Text>
            <Pressable testID="draft-context-close" accessibilityRole="button" accessibilityLabel={t("new.draft_context_close")} onPress={closePicker} style={styles.closeButton}>
              <X size={18} color={colors.textMuted} />
            </Pressable>
          </View>
          <ScrollView style={styles.options} contentContainerStyle={styles.optionsContent} keyboardShouldPersistTaps="handled">
            {pickerKind === "server" ? [...serverOptions.values()].map(item => <OptionRow
              key={item.serverId} testID={`draft-context-server-option-${encodeURIComponent(item.serverId)}`}
              label={item.serverLabel || item.serverId} detail={item.path} selected={selected.serverId === item.serverId}
              onPress={() => chooseProject({ serverId: item.serverId, path: item.path })} />) : projectOptions.filter(item => classic || item.serverId === selected.serverId).map((item) => (
              <OptionRow key={JSON.stringify([item.serverId, item.path])}
                testID={`draft-context-project-option-${encodeURIComponent(item.serverId)}-${encodeURIComponent(item.path)}`} label={item.label}
                detail={item.serverLabel ? `${item.serverLabel} · ${item.path}` : item.path}
                selected={selected.serverId === item.serverId && selected.cwd === item.path}
                onPress={() => chooseProject({ serverId: item.serverId, path: item.path })} />
            ))}
            {resolvedProjects.availability
              ? <Text testID="draft-context-project-unavailable" style={styles.empty}>
                {t(resolvedProjects.availability === "failed" ? "new.draft_context_projects_failed" : resolvedProjects.availability === "loading" ? "new.draft_context_projects_loading" : "new.draft_context_no_projects")}
              </Text>
              : null}
          </ScrollView>
        </View>
      </View>
    </Modal>
  </View>;
}

function OptionRow({ testID, label, detail, selected, onPress }: {
  testID: string;
  label: string;
  detail?: string;
  selected: boolean;
  onPress(): void;
}) {
  const { colors } = useTheme();
  const version = useInterfaceVersion();
  const classic = version === "classic";
  const styles = useThemedStyles(useCallback((colors: ThemeColors) => classic ? makeClassicStyles(colors) : version === "v3" ? { ...makeStyles(colors), ...v3ContextStyles(colors) } : makeStyles(colors), [classic, version]));
  return <Pressable testID={testID} accessibilityRole="button" accessibilityState={{ selected }} aria-pressed={selected} onPress={onPress} style={[styles.option, selected && styles.optionSelected]}>
    <View style={styles.optionCopy}>
      <Text numberOfLines={1} style={styles.optionTitle}>{label}</Text>
      {detail ? <Text numberOfLines={1} style={styles.optionDetail}>{detail}</Text> : null}
    </View>
    {selected ? <Check size={16} color={colors.blue} /> : null}
  </Pressable>;
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  contextGroup: { marginTop: spacing.md },
  bar: { flexDirection: "row", alignItems: "center", minHeight: 44, gap: spacing.xs },
  contextIdentity: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: spacing.sm },
  serverButton: { flexShrink: 1, maxWidth: "60%", minWidth: 0, minHeight: 36, paddingHorizontal: spacing.md, flexDirection: "row", alignItems: "center", gap: spacing.sm, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surfaceRaised, borderRadius: radius.pill },
  projectButton: { flexShrink: 1, minWidth: 0, minHeight: 36, paddingHorizontal: spacing.md, flexDirection: "row", alignItems: "center", gap: spacing.sm, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surfaceRaised, borderRadius: radius.pill },
  projectValue: { flexShrink: 1, minWidth: 0, color: colors.text, fontSize: 13, fontWeight: "600" },
  status: { flexShrink: 0, flexDirection: "row", alignItems: "center", gap: spacing.xs },
  retryButton: { flexShrink: 0, width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  statusText: { flexShrink: 1, color: colors.textMuted, fontSize: 12 },
  disabled: { opacity: 0.55 },
  modalRoot: { flex: 1, justifyContent: "flex-end", backgroundColor: colors.overlay, padding: spacing.md },
  sheet: { maxHeight: "78%", borderRadius: radius.xl, backgroundColor: colors.surfaceRaised, overflow: "hidden" },
  sheetHeader: { minHeight: 56, flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: spacing.lg, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  sheetTitle: { color: colors.text, fontSize: 16, fontWeight: "500" },
  closeButton: { width: 40, height: 40, alignItems: "center", justifyContent: "center", borderRadius: radius.md },
  options: { flexGrow: 0 },
  optionsContent: { padding: spacing.sm },
  option: { minHeight: 48, flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingHorizontal: spacing.sm, borderRadius: radius.md },
  optionSelected: { backgroundColor: colors.surfaceHover },
  optionCopy: { flex: 1, minWidth: 0, justifyContent: "center", gap: spacing.xs },
  optionTitle: { color: colors.text, fontSize: 14 },
  optionDetail: { color: colors.textMuted, fontSize: 12 },
  empty: { padding: spacing.lg, color: colors.textMuted, fontSize: 13, lineHeight: 19 },
});

const makeClassicStyles = (colors: ThemeColors) => ({ ...makeStyles(colors), ...classicContextStyles(colors) });
