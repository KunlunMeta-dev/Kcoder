import { t } from "@/i18n";
import { useLocale } from "@/i18n/use-locale";
import { TaskRuntime } from "@/runtime/task-runtime";
import {
  ChevronLeft,
  FileCode2,
  MoreHorizontal,
  PanelLeft,
} from "lucide-react-native";
import { useSyncExternalStore } from "react";
import { Pressable, Text, View } from "react-native";
import { useTaskAppearance } from "./taskStyles";

export function TaskHeader({
  onWorkspace,
  task,
  onBack,
  onMenu,
  onMore,
}: {
  task: TaskRuntime;
  onBack(): void;
  onMenu(): void;
  onMore(): void;
  onWorkspace?(): void;
}) {
  useLocale();
  const { styles, colors } = useTaskAppearance();
  const snapshot = useSyncExternalStore(
    task.subscribe,
    task.getSnapshot,
    task.getSnapshot,
  );
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
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("task.open_task_list")}
        onPress={onMenu}
        style={styles.headerButton}
      >
        <PanelLeft size={19} color={colors.textMuted} />
      </Pressable>
      <View style={styles.headerCopy}>
        <Text
          testID="task-header-title"
          style={styles.headerTitle}
          numberOfLines={1}
        >
          {snapshot.title}
        </Text>
        <View style={styles.statusRow}>
          <View
            style={[
              styles.statusDot,
              snapshot.connected ? styles.online : styles.offline,
            ]}
          />
          <Text
            testID="task-header-status"
            style={styles.statusText}
            numberOfLines={1}
            ellipsizeMode="tail"
          >
            {snapshot.metadataUnknown?.length
              ? t("task.metadata_result_unverified")
              : snapshot.metadataPending?.length
                ? t("task.saving_task_metadata")
                : snapshot.configurationReady === false
                  ? t("task.validating_task_configuration")
                  : snapshot.running
                    ? t("task.kcoder_is_working")
                    : snapshot.connected
                      ? snapshot.cwd
                      : t("task.disconnected")}
          </Text>
        </View>
      </View>
      {onWorkspace ? (
        <Pressable
          testID="workspace-tab-switcher"
          accessibilityRole="button"
          accessibilityLabel={t("task.workspace_tabs")}
          onPress={onWorkspace}
          style={styles.headerButton}
        >
          <FileCode2 size={20} color={colors.textMuted} />
        </Pressable>
      ) : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("task.more")}
        onPress={onMore}
        style={styles.headerButton}
      >
        <MoreHorizontal size={22} color={colors.textMuted} />
      </Pressable>
    </View>
  );
}
