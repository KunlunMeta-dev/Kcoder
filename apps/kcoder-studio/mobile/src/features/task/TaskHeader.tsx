import { TaskRuntime } from "@/runtime/task-runtime";
import { colors } from "@/theme";
import {
  ChevronLeft,
  FileCode2,
  MoreHorizontal,
  PanelLeft,
} from "lucide-react-native";
import { useSyncExternalStore } from "react";
import { Pressable, Text, View } from "react-native";
import { styles } from "./taskStyles";

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
  const snapshot = useSyncExternalStore(
    task.subscribe,
    task.getSnapshot,
    task.getSnapshot,
  );
  return (
    <View testID="task-header" style={styles.header}>
      <Pressable
        accessibilityLabel="返回"
        onPress={onBack}
        style={styles.headerButton}
      >
        <ChevronLeft size={23} color={colors.text} />
      </Pressable>
      <Pressable
        accessibilityLabel="打开任务列表"
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
            {snapshot.running
              ? "KCoder 正在工作"
              : snapshot.connected
                ? snapshot.cwd
                : "连接已断开"}
          </Text>
        </View>
      </View>
      {onWorkspace ? (
        <Pressable
          testID="workspace-tab-switcher"
          accessibilityRole="button"
          accessibilityLabel="工作区标签"
          onPress={onWorkspace}
          style={styles.headerButton}
        >
          <FileCode2 size={20} color={colors.textMuted} />
        </Pressable>
      ) : null}
      <Pressable
        accessibilityLabel="更多"
        onPress={onMore}
        style={styles.headerButton}
      >
        <MoreHorizontal size={22} color={colors.textMuted} />
      </Pressable>
    </View>
  );
}
