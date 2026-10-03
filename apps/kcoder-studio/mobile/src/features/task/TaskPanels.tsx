import { useModalFocusTrap } from "@/components/use-modal-focus-trap";
import { type WorkspaceTab } from "@/storage/workspace-preferences";
import { colors } from "@/theme";
import { FileCode2, Globe2, TerminalSquare, X } from "lucide-react-native";
import { Modal, Pressable, Text, View } from "react-native";
import { styles } from "./taskStyles";

export function RetainedPanel({
  active,
  bottomInset = 0,
  children,
}: {
  active: boolean;
  bottomInset?: number;
  children: React.ReactNode;
}) {
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
      accessibilityLabel="新建工作区标签"
      onRequestClose={onClose}
    >
      <Pressable style={styles.sheetOverlay} onPress={onClose} />
      <View ref={modalRef} style={styles.panelMenu}>
        <View style={styles.attachmentSheetHeader}>
          <Text style={styles.attachmentSheetTitle}>新建标签</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="关闭"
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
            已达到 12 个工作区标签上限，请先关闭一个标签。
          </Text>
        ) : null}
        {option(
          "terminal",
          <TerminalSquare size={20} color={colors.text} />,
          "终端",
          "启动一个独立 PTY 会话",
        )}
        {option(
          "browser",
          <Globe2 size={20} color={colors.text} />,
          "浏览器",
          "启动一个独立远程浏览器",
        )}
        {option(
          "files",
          <FileCode2 size={20} color={colors.text} />,
          "文件",
          "打开另一个文件浏览与编辑标签",
        )}
      </View>
    </Modal>
  );
}
