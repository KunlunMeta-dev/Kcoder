import { t } from "@/i18n";
import { useLocale } from "@/i18n/use-locale";
import { useModalFocusTrap } from "@/components/use-modal-focus-trap";
import { type WorkspaceTab } from "@/storage/workspace-preferences";
import { FileCode2, Globe2, TerminalSquare, X } from "lucide-react-native";
import { Modal, Pressable, Text, View } from "react-native";
import { useTaskAppearance } from "./taskStyles";

export function RetainedPanel({
  active,
  bottomInset = 0,
  children,
}: {
  active: boolean;
  bottomInset?: number;
  children: React.ReactNode;
}) {
  const { styles } = useTaskAppearance();
  return (
    <View
      accessibilityElementsHidden={!active}
      importantForAccessibility={active ? "auto" : "no-hide-descendants"}
      pointerEvents={active ? "auto" : "none"}
      style={[
        styles.retainedPanel,
        !active && styles.hiddenPanel,
        bottomInset > 0 && { paddingBottom: bottomInset },
      ]}
    >
      {children}
    </View>
  );
}

export function PanelMenu({
  visible,
  canAdd,
  onClose,
  onAdd,
}: {
  visible: boolean;
  canAdd: boolean;
  onClose(): void;
  onAdd(kind: Exclude<WorkspaceTab, "agent">): void;
}) {
  useLocale();
  const { styles, colors } = useTaskAppearance();
  const modalRef = useModalFocusTrap(visible, onClose);
  const option = (
    kind: Exclude<WorkspaceTab, "agent">,
    icon: React.ReactNode,
    title: string,
    body: string,
  ) => (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !canAdd }}
      disabled={!canAdd}
      onPress={() => onAdd(kind)}
      style={[styles.panelMenuRow, !canAdd && styles.sendDisabled]}
    >
      {icon}
      <View>
        <Text style={styles.panelMenuTitle}>{title}</Text>
        <Text style={styles.panelMenuBody}>{body}</Text>
      </View>
    </Pressable>
  );
  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      accessibilityLabel={t("task.new_workspace_tab")}
      onRequestClose={onClose}
    >
      <Pressable style={styles.sheetOverlay} onPress={onClose} />
      <View ref={modalRef} style={styles.panelMenu}>
        <View style={styles.attachmentSheetHeader}>
          <Text style={styles.attachmentSheetTitle}>{t("task.new_tab")}</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("task.close")}
            onPress={onClose}
            style={styles.modalClose}
          >
            <X size={20} color={colors.textMuted} />
          </Pressable>
        </View>
        {!canAdd ? (
          <Text
            accessibilityRole="alert"
            accessibilityLiveRegion="assertive"
            style={styles.panelLimitText}
          >
            {t("task.the_workspace_has_reached_its_12tab_limit_close")}
          </Text>
        ) : null}
        {option(
          "terminal",
          <TerminalSquare size={20} color={colors.text} />,
          t("task.terminal"),
          t("task.start_an_independent_pty_session"),
        )}
        {option(
          "browser",
          <Globe2 size={20} color={colors.text} />,
          t("task.browser"),
          t("task.start_an_independent_remote_browser"),
        )}
        {option(
          "files",
          <FileCode2 size={20} color={colors.text} />,
          t("task.files"),
          t("task.open_another_file_browsing_and_editing_tab"),
        )}
      </View>
    </Modal>
  );
}
