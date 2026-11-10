import { useLocale } from "@/i18n/use-locale";
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { Pencil, Pin, PinOff, RefreshCw, X } from "lucide-react-native";
import { useRef, useState } from "react";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { KCoderServer } from "@/gateway/types";
import { useModalFocusTrap } from "@/components/use-modal-focus-trap";
import type { ProjectWorkspaceThreadGroup } from "@/components/thread-list-presentation";
import { radius, spacing, useTheme, useThemedStyles, type ThemeColors } from "@/theme";
import { t } from "@/i18n";
import { projectNameValidation } from "@/protocol/project-display-name";

export function WorkspaceHistoryActionsSheet({ server, workspace, workspaceLabel, workspaceAccessibleName, targetLabel, workspaceIndex, onClose, onSelect, projectPin, projectRename }: {
  server: KCoderServer;
  workspace: ProjectWorkspaceThreadGroup;
  workspaceLabel: string;
  workspaceAccessibleName: string;
  targetLabel: string;
  workspaceIndex: number;
  onClose(): void;
  onSelect(workspace: string): void;
  projectPin?: { name: string; pinned: boolean; enabled: boolean; unsupported?: boolean; onToggle(): Promise<void> };
  projectRename?: { name: string; enabled: boolean; onSave(name: string): Promise<void> };
}) {
  useLocale();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const modalRef = useModalFocusTrap(true, onClose);
  const title = t("home.workspace_actions_for", { p0: workspaceAccessibleName });
  const workspacePath = workspace.path;
  const [pinPending, setPinPending] = useState(false);
  const [pinFailed, setPinFailed] = useState(false);
  const pinBusy = useRef(false);
  const [renameEditing, setRenameEditing] = useState(false);
  const [renameName, setRenameName] = useState("");
  const [renamePending, setRenamePending] = useState(false);
  const [renameFailed, setRenameFailed] = useState(false);
  const renameValidation = projectNameValidation(renameName);
  const Overlay = projectRename ? KeyboardAvoidingView : View;
  const saveRename = () => {
    if (!projectRename?.enabled || pinBusy.current || renameValidation) return;
    pinBusy.current = true;
    setRenamePending(true); setRenameFailed(false);
    void projectRename.onSave(renameName.trim()).catch(() => setRenameFailed(true)).finally(() => { pinBusy.current = false; setRenamePending(false); });
  };
  if (!workspacePath) return null;

  return <Modal
    testID={`workspace-actions-menu-${server.id}-${workspaceIndex}`}
    transparent
    animationType={Platform.OS === "web" ? "none" : "slide"}
    visible
    onRequestClose={onClose}
    accessibilityLabel={title}
  >
    <Overlay style={styles.menuOverlayRoot} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <Pressable testID={`workspace-actions-dismiss-${server.id}-${workspaceIndex}`} accessibilityRole="button" accessibilityLabel={t("common.close")} style={styles.menuOverlay} onPress={onClose} />
      <View ref={modalRef} role="dialog" accessibilityViewIsModal style={[styles.menuSheet, { paddingBottom: Math.max(insets.bottom, spacing.lg) }]}>
        <View style={styles.menuHeader}>
          <View style={styles.menuActionCopy}>
            <Text accessibilityRole="header" accessibilityLabel={workspaceAccessibleName} style={styles.menuTitle} numberOfLines={2}>{workspaceLabel}</Text>
            <Text style={styles.menuActionPath} numberOfLines={1}>{targetLabel}</Text>
          </View>
          <Pressable testID={`workspace-actions-close-${server.id}-${workspaceIndex}`} accessibilityRole="button" accessibilityLabel={t("common.close")} onPress={onClose} style={styles.menuClose}>
            <X size={20} color={colors.textMuted} />
          </Pressable>
        </View>
        <ScrollView style={styles.menuActions} showsVerticalScrollIndicator={false}>
          <Text testID={`workspace-actions-path-${server.id}-${workspaceIndex}`} selectable style={styles.menuWorkspacePath}>{workspacePath}</Text>
          {renameEditing && projectRename ? <View testID={`rename-project-editor-${server.id}-${workspaceIndex}`} style={styles.renameEditor}>
            <Text accessibilityRole="header" style={styles.menuActionTitle}>{t("home.rename_project")}</Text>
            <TextInput testID={`rename-project-name-${server.id}-${workspaceIndex}`} accessibilityLabel={t("home.project_name")}
              autoFocus selectTextOnFocus value={renameName} editable={!renamePending} returnKeyType="done"
              onChangeText={(name) => { setRenameName(name); setRenameFailed(false); }} onSubmitEditing={saveRename}
              style={styles.renameInput} />
            {renameValidation ? <Text accessibilityRole="alert" style={styles.menuActionError}>{t(renameValidation === "empty" ? "home.project_name_required" : "home.project_name_too_long")}</Text> : null}
            {renameFailed ? <Text accessibilityRole="alert" style={styles.menuActionError}>{t("home.project_rename_failed")}</Text> : null}
            <View style={styles.renameActions}>
              <Pressable testID={`rename-project-cancel-${server.id}-${workspaceIndex}`} accessibilityRole="button" accessibilityLabel={t("common.cancel")}
                disabled={renamePending} accessibilityState={{ disabled: renamePending }} onPress={() => { if (!pinBusy.current) { setRenameEditing(false); setRenameFailed(false); } }} style={styles.renameButton}>
                <Text style={styles.menuActionTitle}>{t("common.cancel")}</Text>
              </Pressable>
              <Pressable testID={`rename-project-save-${server.id}-${workspaceIndex}`} accessibilityRole="button" accessibilityLabel={t("common.save")}
                disabled={renamePending || !projectRename.enabled || Boolean(renameValidation)} accessibilityState={{ disabled: renamePending || !projectRename.enabled || Boolean(renameValidation), busy: renamePending }} onPress={saveRename}
                style={[styles.renameButton, styles.renameSave, (renamePending || !projectRename.enabled || Boolean(renameValidation)) && styles.menuActionDisabled]}>
                <Text style={styles.menuActionTitle}>{t(renamePending ? "home.saving_project_name" : "common.save")}</Text>
              </Pressable>
            </View>
          </View> : <>
          {projectRename ? <Pressable testID={`rename-project-${server.id}-${workspaceIndex}`} accessibilityRole="button"
            accessibilityLabel={t("home.rename_project_for", { p0: projectRename.name })} disabled={pinPending || !projectRename.enabled}
            accessibilityState={{ disabled: pinPending || !projectRename.enabled }} style={[styles.menuAction, (pinPending || !projectRename.enabled) && styles.menuActionDisabled]}
            onPress={() => { if (pinBusy.current || !projectRename.enabled) return; setRenameName(projectRename.name); setRenameFailed(false); setRenameEditing(true); }}>
            <Pencil size={17} color={colors.textMuted} /><Text style={styles.menuActionTitle}>{t("home.rename_project")}</Text>
          </Pressable> : null}
          {projectPin ? <>
            <Pressable testID={`pin-project-${server.id}-${workspaceIndex}`} accessibilityRole="button"
              accessibilityLabel={t(projectPin.pinned ? "home.unpin_project_for" : "home.pin_project_for", { p0: projectPin.name })}
              accessibilityState={{ disabled: pinPending || !projectPin.enabled, busy: pinPending }}
              disabled={pinPending || !projectPin.enabled}
              onPress={() => {
                if (pinBusy.current || !projectPin.enabled) return;
                pinBusy.current = true;
                setPinPending(true); setPinFailed(false);
                void projectPin.onToggle().catch(() => setPinFailed(true)).finally(() => { pinBusy.current = false; setPinPending(false); });
              }} style={[styles.menuAction, (pinPending || !projectPin.enabled) && styles.menuActionDisabled]}>
              {projectPin.pinned ? <PinOff size={17} color={colors.textMuted} /> : <Pin size={17} color={colors.textMuted} />}
              <Text numberOfLines={1} style={styles.menuActionTitle}>{t(pinPending ? "home.saving_project_pin" : projectPin.pinned ? "home.unpin_project" : "home.pin_project")}</Text>
            </Pressable>
            {pinFailed ? <Text accessibilityRole="alert" style={styles.menuActionError}>{t("home.project_pin_failed")}</Text> : null}
            {!projectPin.enabled ? <Text style={styles.menuActionPath}>{t(projectPin.unsupported ? "home.project_pin_requires_upgrade" : "home.project_pin_requires_connection")}</Text> : null}
          </> : null}
          <Pressable
            testID={`refresh-history-${server.id}-${workspaceIndex}`}
            accessibilityRole="button"
            accessibilityLabel={t("home.refresh_history_for", { p0: workspaceAccessibleName, p1: workspacePath })}
            onPress={() => onSelect(workspacePath)}
            style={styles.menuAction}
          >
            <RefreshCw size={17} color={colors.textMuted} />
            <View style={styles.menuActionCopy}>
              <Text numberOfLines={1} style={styles.menuActionTitle}>{t("home.refresh_history_index")}</Text>
            </View>
          </Pressable>
          </>}
        </ScrollView>
      </View>
    </Overlay>
  </Modal>;
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  menuOverlayRoot: { flex: 1, justifyContent: "flex-end", alignItems: "center" },
  menuOverlay: { ...StyleSheet.absoluteFill, backgroundColor: colors.overlay },
  menuSheet: { width: "100%", maxWidth: 720, maxHeight: "84%", padding: spacing.lg, borderRadius: radius.settingsGroup, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  menuHeader: { minHeight: 48, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.md, marginBottom: spacing.sm },
  menuTitle: { flex: 1, color: colors.text, fontSize: 16, fontWeight: "600" },
  menuClose: { width: 44, height: 44, alignItems: "center", justifyContent: "center", borderRadius: radius.md },
  menuActions: { flexShrink: 1 },
  menuAction: { minHeight: 58, flexDirection: "row", alignItems: "center", gap: spacing.md, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  menuActionDisabled: { opacity: 0.45 },
  menuActionError: { color: colors.red, fontSize: 12, lineHeight: 18, paddingVertical: spacing.sm },
  menuActionCopy: { flex: 1, minWidth: 0 },
  menuActionTitle: { color: colors.text, fontSize: 14, fontWeight: "500" },
  menuActionPath: { color: colors.textDim, fontSize: 11, marginTop: 3 },
  menuWorkspacePath: { color: colors.textDim, fontSize: 12, lineHeight: 18, marginBottom: spacing.sm, ...(Platform.OS === "web" ? { overflowWrap: "anywhere" as const, wordBreak: "break-word" as const } : {}) },
  renameEditor: { gap: spacing.sm, paddingVertical: spacing.sm },
  renameInput: { minHeight: 46, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, paddingHorizontal: spacing.md, color: colors.text, backgroundColor: colors.surfaceRaised, fontSize: 14 },
  renameActions: { flexDirection: "row", justifyContent: "flex-end", gap: spacing.sm },
  renameButton: { minHeight: 44, minWidth: 76, alignItems: "center", justifyContent: "center", paddingHorizontal: spacing.md, borderRadius: radius.md },
  renameSave: { backgroundColor: colors.surfaceRaised, borderWidth: 1, borderColor: colors.border },
});
