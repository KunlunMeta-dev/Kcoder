import { ConversationV3Header, type ConversationV3Navigation } from "@/features/interface/ConversationV3";
import { t } from "@/i18n";
import { useLocale } from "@/i18n/use-locale";
import { TaskRuntime } from "@/runtime/task-runtime";
import { useInterfaceVersion } from "@/storage/interface-version";
import {
  ChevronLeft,
  CirclePlus,
  MoreHorizontal,
  UserRound,
  Search,
  FileCode2,
} from "lucide-react-native";
import { useSyncExternalStore } from "react";
import { Pressable, Text, View } from "react-native";
import { useTaskAppearance } from "./taskStyles";

export function TaskHeader({
  onNew,
  onSearch,
  onWorkspace,
  task,
  onBack,
  onMenu,
  onMore,
  navigation,
}: {
  task: TaskRuntime;
  onBack(): void;
  onMenu?(): void;
  onMore?(): void;
  onNew?(): void;
  onSearch?(): void;
  onWorkspace?(): void;
  navigation?: ConversationV3Navigation;
}) {
  useLocale();
  const snapshot = useSyncExternalStore(task.subscribe, task.getSnapshot, task.getSnapshot);
  return <TaskDisplayHeader title={snapshot.title} connected={snapshot.connected} targetLabel={task.reconnectContext?.server.label}
    status={snapshot.metadataUnknown?.length ? t("task.metadata_result_unverified")
      : snapshot.metadataPending?.length ? t("task.saving_task_metadata")
      : snapshot.configurationReady === false ? t("task.validating_task_configuration")
      : snapshot.running ? t("task.kcoder_is_working")
      : snapshot.connected ? task.reconnectContext?.server.label ?? snapshot.cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? snapshot.cwd : t("task.disconnected")}
    onBack={onBack} onMenu={onMenu} onMore={onMore} onNew={onNew} onSearch={onSearch} onWorkspace={onWorkspace} navigation={navigation} />;
}

export function TaskDisplayHeader({ title, status, targetLabel, connected, onBack, onMenu, onMore, onNew, onSearch, onWorkspace, disabledActions, navigation }: {
  title: string; status: string; targetLabel?: string; connected: boolean; onBack(): void;
  onMenu?(): void; onMore?(): void; onNew?(): void;
  onSearch?(): void; onWorkspace?(): void;
  disabledActions?: { menu?: boolean; more?: boolean; new?: boolean };
  navigation?: ConversationV3Navigation;
}) {
  useLocale();
  const version = useInterfaceVersion();
  const classic = version === "classic";
  const { styles, colors } = useTaskAppearance();
  const menuDisabled = Boolean(disabledActions?.menu || !onMenu);
  const newDisabled = Boolean(disabledActions?.new || !onNew);
  const moreDisabled = Boolean(disabledActions?.more || !onMore);
  if (version === "v3") return <ConversationV3Header title={title} subtitle={targetLabel ?? status}
    statusLabel={`${status} · ${t(connected ? "task.connected" : "task.offline")}`} onBack={onBack}
    onNew={newDisabled ? undefined : onNew}
    navigation={navigation}
    onMore={moreDisabled ? undefined : onMore} />;
  return (
    <View testID="task-header" style={styles.header}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("task.back")}
        onPress={onBack}
        style={styles.headerButton}
      >
        <ChevronLeft size={23} color={colors.text} />
      </Pressable>
      <Pressable accessibilityRole={onMenu || disabledActions?.menu ? "button" : undefined} accessibilityLabel={t("task.open_task_list")} disabled={menuDisabled} accessibilityState={{ disabled: menuDisabled }} onPress={onMenu} style={[styles.headerCopy, disabledActions?.menu && styles.sendDisabled]}>
        <Text
          testID="task-header-title"
          style={styles.headerTitle}
          numberOfLines={1}
        >
          {title}
        </Text>
        <View style={styles.statusRow}>
          <View testID={classic ? "task-header-connection" : "task-header-person"} style={{ pointerEvents: "none" }}>
            {classic ? <View style={[styles.statusDot, connected ? styles.online : styles.offline]} /> : <UserRound size={12} color={colors.textDim} />}
          </View>
          <Text
            testID="task-header-status"
            style={styles.statusText}
            numberOfLines={1}
            ellipsizeMode="tail"
            accessibilityLabel={`${status} · ${t(connected ? "task.connected" : "task.offline")}`}
          >
            {status}
          </Text>
        </View>
      </Pressable>
      {classic && onSearch ? <Pressable testID="task-search" accessibilityRole="button" accessibilityLabel={t("task.search_loaded_body")} onPress={onSearch} style={styles.headerButton}><Search size={19} color={colors.textMuted} /></Pressable> : null}
      {classic && onWorkspace ? <Pressable testID="workspace-tab-switcher" accessibilityRole="button" accessibilityLabel={t("task.workspace_tabs")} onPress={onWorkspace} style={styles.headerButton}><FileCode2 size={20} color={colors.textMuted} /></Pressable> : null}
      {!classic && (onNew || disabledActions?.new) ? (
        <Pressable
          testID="task-new"
          accessibilityRole="button"
          accessibilityLabel={t("task.new_task")}
          accessibilityState={{ disabled: newDisabled }}
          disabled={newDisabled}
          onPress={onNew}
          style={[styles.headerButton, newDisabled && styles.sendDisabled]}
        >
          <View style={styles.headerActionOutline}>
            <CirclePlus size={18} color={newDisabled ? colors.textDim : colors.textMuted} />
          </View>
        </Pressable>
      ) : null}
      {onMore || disabledActions?.more ? <Pressable
        testID="task-more"
        accessibilityRole="button"
        accessibilityLabel={t("task.more")}
        accessibilityState={{ disabled: moreDisabled }}
        disabled={moreDisabled}
        onPress={onMore}
        style={[styles.headerButton, moreDisabled && styles.sendDisabled]}
      >
        <View style={!classic ? styles.headerActionOutline : undefined}>
          <MoreHorizontal size={20} color={moreDisabled ? colors.textDim : colors.textMuted} />
        </View>
      </Pressable> : null}
    </View>
  );
}
