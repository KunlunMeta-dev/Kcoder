import { useModalFocusTrap } from "@/components/use-modal-focus-trap";
import { t } from "@/i18n";
import { useLocale } from "@/i18n/use-locale";
import type { GatewayProfile, KCoderServer } from "@/gateway/types";
import { TASK_PERMISSION_MODES, type PermissionMode } from "@/protocol/task-permission-mode";
import type { TaskRuntime } from "@/runtime/task-runtime";
import type { TaskSnapshot } from "@/runtime/task-runtime/types";
import { spacing } from "@/theme";
import {
  Bot,
  Check,
  FilePenLine,
  Flame,
  RotateCcw,
  ShieldOff,
  Shield,
  ShieldQuestion,
  ShieldX,
  X,
} from "lucide-react-native";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  AppState,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTaskAppearance } from "./taskStyles";
import { canChangePermission } from "./task-permission-availability";
export { canChangePermission } from "./task-permission-availability";

const MODE_ICONS = {
  default: RotateCcw,
  ask: ShieldQuestion,
  auto: Bot,
  accept_edits: FilePenLine,
  dont_ask: ShieldX,
  bypass: ShieldOff,
  yolo: Flame,
} as const;

export function PermissionModeIcon({ disabled = false }: { mode: PermissionMode; disabled?: boolean }) {
  const { colors } = useTaskAppearance();
  return <Shield size={18} color={disabled ? colors.textDim : colors.textMuted} />;
}

export function PermissionOverrideMarker({ mode }: { mode: PermissionMode }) {
  const { styles } = useTaskAppearance();
  return mode !== "default" ? <View accessible={false} style={[styles.permissionOverrideMarker, { pointerEvents: "none" }]} /> : null;
}

type PermissionScope = {
  task: TaskRuntime;
  threadId: string;
  profileScope: string;
  serverScope: string;
};

function sameScope(left: PermissionScope | null, right: PermissionScope): boolean {
  return Boolean(
    left &&
      left.task === right.task &&
      left.threadId === right.threadId &&
      left.profileScope === right.profileScope &&
      left.serverScope === right.serverScope,
  );
}

export function TaskPermissionSheet({
  visible,
  supported,
  selected,
  canChange,
  demo = false,
  error,
  onClose,
  onSelect,
  subtitle,
}: {
  visible: boolean;
  supported: boolean;
  selected: PermissionMode;
  subtitle?: string;
  canChange: boolean;
  demo?: boolean;
  error: string | null;
  onClose(): void;
  onSelect(mode: PermissionMode): void;
}) {
  useLocale();
  const { styles, colors } = useTaskAppearance();
  const insets = useSafeAreaInsets();
  const window = useWindowDimensions();
  const sheetRef = useModalFocusTrap(visible, onClose);

  return (
    <Modal
      testID="permission-mode-sheet"
      visible={visible}
      transparent
      animationType="none"
      onRequestClose={onClose}
      accessibilityLabel={t("task.permission_mode")}
    >
      <View style={{ flex: 1, justifyContent: "flex-end" }}>
        <Pressable
          testID="permission-mode-backdrop"
          accessibilityRole="button"
          accessibilityLabel={t("common.close")}
          style={styles.permissionSheetBackdrop}
          onPress={onClose}
        />
        <View
          ref={sheetRef}
          role="dialog"
          accessibilityViewIsModal
          style={[
            styles.permissionSheet,
            {
              width: "100%",
              maxWidth: 720,
              maxHeight: Math.max(0, window.height - insets.top),
              paddingBottom: Math.max(insets.bottom, spacing.lg),
            },
          ]}
        >
          <View style={styles.permissionSheetHeader}>
            <View style={{ flex: 1, minWidth: 0, paddingRight: spacing.sm }}>
              <Text accessibilityRole="header" style={styles.permissionSheetTitle}>
                {t("task.permission_mode")}
              </Text>
              <Text style={styles.permissionSheetSubtitle}>
                {subtitle ?? t(demo ? "task.permission_mode_demo_readonly" : "task.permission_mode_next_turn")}
              </Text>
            </View>
            <Pressable
              testID="permission-mode-close"
              accessibilityRole="button"
              accessibilityLabel={t("common.close")}
              onPress={onClose}
              style={styles.permissionSheetClose}
            >
              <X size={20} color={colors.textMuted} />
            </Pressable>
          </View>
          {!supported ? (
            <Text
              testID="permission-mode-unavailable"
              accessibilityRole="alert"
              style={styles.permissionError}
            >
              {t("task.permission_mode_unavailable")}
            </Text>
          ) : null}
          {error ? (
            <Text
              testID="permission-mode-error"
              accessibilityRole="alert"
              style={styles.permissionError}
            >
              {error}
            </Text>
          ) : null}
          <ScrollView
            testID="task-permission-options"
            style={{ flexShrink: 1 }}
            contentContainerStyle={{ gap: spacing.sm, paddingBottom: spacing.xs }}
            showsVerticalScrollIndicator
          >
            {TASK_PERMISSION_MODES.filter((mode) => supported || mode === "default").map((mode) => {
              const checked = mode === selected;
              const optionDisabled = !canChange || (!supported && mode !== "default");
              const Icon = MODE_ICONS[mode];
              return (
                <Pressable
                  key={mode}
                    testID={`permission-mode-${mode}`}
                  accessibilityRole="radio"
                  accessibilityLabel={`${t(`task.permission_mode_${mode}`)}. ${t(`task.permission_mode_${mode}_description`)}`}
                  accessibilityState={{ checked, disabled: optionDisabled }}
                  aria-checked={Platform.OS === "web" ? checked : undefined}
                  disabled={optionDisabled}
                  onPress={() => onSelect(mode)}
                  style={({ pressed }) => [
                    styles.permissionOption,
                    checked && styles.permissionOptionSelected,
                    optionDisabled && !demo && styles.sendDisabled,
                    pressed && !optionDisabled && { opacity: 0.72 },
                  ]}
                >
                  <Icon size={18} color={checked ? colors.text : colors.textMuted} />
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={styles.permissionOptionText}>
                      {t(`task.permission_mode_${mode}`)}
                    </Text>
                    <Text style={styles.permissionOptionDescription}>
                      {t(`task.permission_mode_${mode}_description`)}
                    </Text>
                  </View>
                  {checked ? <Check size={18} color={colors.text} /> : <View style={{ width: 18, height: 18 }} />}
                </Pressable>
              );
            })}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

export function TaskPermissionSelector({
  task,
  snapshot,
  profile,
  server,
  demo,
  onTriggerPressIn,
  onOpenChange,
  scopeActive = true,
  openRequest,
  hideTrigger = false,
}: {
  task: TaskRuntime;
  snapshot: TaskSnapshot;
  profile?: GatewayProfile;
  server?: KCoderServer;
  demo: boolean;
  /** Holds composer presentation steady before the native press opens the sheet. */
  onTriggerPressIn?: () => void;
  /** Notifies composer presentation state; it does not change task state. */
  onOpenChange?: (visible: boolean) => void;
  /** False when this retained task route loses navigation focus. */
  scopeActive?: boolean;
  openRequest?: object;
  hideTrigger?: boolean;
}) {
  useLocale();
  const { styles, colors } = useTaskAppearance();
  const [visible, setVisible] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Demo options are a UI preview; they are not a claim about target support.
  const supported = demo || (!task.isDisposed() && task.supportsTurnPermissions());
  const mutable = canChangePermission(task, snapshot);
  const disabled = !scopeActive || (!demo && !mutable);
  const selected = snapshot.permissionMode ?? "default";
  const currentScope: PermissionScope = {
    task,
    threadId: snapshot.threadId,
    profileScope: JSON.stringify([
      profile?.id,
      profile?.baseUrl,
      profile?.authorizationGeneration,
      profile?.deviceId,
    ]),
    serverScope: JSON.stringify([
      server?.id,
      server?.transport,
      server?.workspacePath,
      server?.host,
      server?.user,
      server?.port,
      server?.command,
      server?.settingsFile,
      server?.profile,
    ]),
  };
  const currentScopeRef = useRef(currentScope);
  currentScopeRef.current = currentScope;
  const scopeActiveRef = useRef(scopeActive);
  scopeActiveRef.current = scopeActive;
  const openedScopeRef = useRef<PermissionScope | null>(null);
  const previousScopeRef = useRef(currentScope);

  const close = useCallback(() => {
    setVisible(false);
    setError(null);
    openedScopeRef.current = null;
    onOpenChange?.(false);
  }, [onOpenChange]);

  useEffect(() => {
    if (!sameScope(previousScopeRef.current, currentScope)) {
      previousScopeRef.current = currentScope;
      close();
    }
  }, [close, task, snapshot.threadId, currentScope.profileScope, currentScope.serverScope]);

  useEffect(() => {
    if (!scopeActive) close();
  }, [close, scopeActive]);

  useEffect(() => {
    if (visible && !demo && !mutable) close();
  }, [close, demo, mutable, visible]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") close();
    });
    return () => subscription.remove();
  }, [close]);

  const open = () => {
    if (!scopeActive || (!demo && !mutable)) return;
    openedScopeRef.current = currentScope;
    setError(null);
    setVisible(true);
    onOpenChange?.(true);
  };

  const consumedRequest = useRef<object | undefined>(undefined);
  useEffect(() => {
    if (!openRequest || consumedRequest.current === openRequest) return;
    consumedRequest.current = openRequest;
    // Consume unavailable requests too; reconnect must not replay a stale menu action.
    if (!disabled) open();
  }, [openRequest, disabled]);

  const select = (mode: PermissionMode) => {
    if (demo) {
      close();
      return;
    }
    const expectedScope = openedScopeRef.current;
    if (
      !scopeActiveRef.current ||
      !scopeActive ||
      !expectedScope ||
      !sameScope(expectedScope, currentScopeRef.current)
    ) {
      close();
      return;
    }
    const liveSnapshot = task.getSnapshot();
    if (!canChangePermission(task, liveSnapshot)) {
      setError(
        liveSnapshot.archivedAt
          ? t("task.permission_mode_restore_task")
          : t("task.permission_mode_wait_for_turn"),
      );
      return;
    }
    if (mode !== "default" && !task.supportsTurnPermissions()) {
      setError(t("task.permission_mode_unavailable"));
      return;
    }
    try {
      task.setPermissionMode(mode);
      close();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    }
  };

  const modeLabel = t(`task.permission_mode_${selected}`);
  const selectedAccessibleLabel =
    selected === "default"
      ? modeLabel
      : `${t("task.permission_mode")}: ${modeLabel}`;
  const triggerText = selected === "default" ? t("v2.permission_default") : modeLabel;
  return (
    <>
      <Pressable
        testID="composer-permission-selector"
        accessibilityRole="button"
        accessibilityLabel={
          demo
            ? `${selectedAccessibleLabel}. ${t("task.permission_mode_demo_trigger_hint")}`
            : selectedAccessibleLabel
        }
        accessibilityHint={t(
          demo
            ? "task.permission_mode_demo_trigger_hint"
            : "task.permission_mode_next_turn",
        )}
        accessibilityState={{ disabled, selected: selected !== "default" }}
        disabled={disabled}
        onPressIn={onTriggerPressIn}
        onPress={open}
        style={[
          styles.permissionTrigger,
          hideTrigger && { display: "none" },
          disabled && styles.sendDisabled,
        ]}
      >
        <PermissionModeIcon mode={selected} disabled={disabled} />
        <Text
          numberOfLines={1}
          ellipsizeMode="tail"
          style={styles.permissionTriggerLabel}
        >
          {triggerText}
        </Text>
        <PermissionOverrideMarker mode={selected} />
      </Pressable>
      <TaskPermissionSheet
        visible={visible && scopeActive}
        supported={supported}
        selected={selected}
        canChange={mutable && !demo}
        demo={demo}
        error={error}
        onClose={close}
        onSelect={select}
      />
    </>
  );
}
