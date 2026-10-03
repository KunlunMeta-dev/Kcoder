import { BoundedOutput } from "@/components/output-disclosure";
import { type ChatMessage, type FileChangesView } from "@/runtime/task-runtime";
import { colors } from "@/theme";
import {
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  GitCompareArrows,
  ListTodo,
  ShieldCheck,
  Wrench,
} from "lucide-react-native";
import { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { styles } from "./taskStyles";

export function InteractionSummaryCard({
  summary,
}: {
  summary: NonNullable<ChatMessage["interactionSummaries"]>[number];
}) {
  return (
    <View
      testID={`interaction-summary-${summary.id}`}
      style={styles.timelineCard}
    >
      <View style={styles.timelineHeader}>
        <ShieldCheck size={15} color={colors.green} />
        <View style={styles.toolCopy}>
          <Text style={styles.timelineTitle}>{summary.header}</Text>
          {summary.prompt ? (
            <Text selectable style={styles.timelineDetail}>
              {summary.prompt}
            </Text>
          ) : null}
          <Text selectable style={styles.interactionAnswer}>
            {summary.answers.join("、")}
          </Text>
        </View>
      </View>
    </View>
  );
}

export function TodoCard({
  todos,
}: {
  todos: NonNullable<ChatMessage["todos"]>;
}) {
  const [expanded, setExpanded] = useState(false);
  const completed = todos.filter(
    (todo) => todo.status === "completed" || todo.status === "cancelled",
  ).length;
  const next =
    todos.find((todo) => todo.status === "in_progress") ??
    todos.find((todo) => todo.status === "pending");
  return (
    <View testID="todo-card" style={styles.timelineCard}>
      <Pressable
        accessibilityRole="button"
        aria-expanded={expanded}
        accessibilityState={{ expanded }}
        onPress={() => setExpanded((value) => !value)}
        style={styles.timelineHeader}
      >
        <ListTodo size={15} color={colors.blue} />
        <View style={styles.toolCopy}>
          <Text style={styles.timelineTitle}>
            任务清单 · {completed}/{todos.length}
          </Text>
          {!expanded && next ? (
            <Text numberOfLines={1} style={styles.timelineDetail}>
              {next.content}
            </Text>
          ) : null}
        </View>
        {expanded ? (
          <ChevronDown size={15} color={colors.textDim} />
        ) : (
          <ChevronRight size={15} color={colors.textDim} />
        )}
      </Pressable>
      {expanded ? (
        <View style={styles.todoList}>
          {todos.map((todo, index) => {
            const done =
              todo.status === "completed" || todo.status === "cancelled";
            return (
              <View key={`${todo.content}-${index}`} style={styles.todoRow}>
                <View style={[styles.todoDot, done && styles.todoDotDone]}>
                  {done ? <Check size={11} color={colors.background} /> : null}
                </View>
                <Text style={[styles.todoText, done && styles.todoTextDone]}>
                  {todo.content}
                </Text>
              </View>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}

export function ActivityCard({
  activity,
  onSteer,
}: {
  activity: NonNullable<ChatMessage["activities"]>[number];
  onSteer?: (message: string) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tone =
    activity.status === "failed"
      ? colors.red
      : activity.status === "running"
        ? colors.yellow
        : activity.status === "cancelled" || activity.status === "paused"
          ? colors.textDim
          : colors.green;
  const steerLabel =
    activity.steerStatus === "applied"
      ? "调整已应用"
      : activity.steerStatus?.startsWith("queued")
        ? "调整已排队"
        : activity.steerStatus === "resuming"
          ? "正在恢复"
          : null;
  return (
    <View
      testID={`activity-${encodeURIComponent(activity.id)}`}
      accessibilityRole={activity.status === "failed" ? "alert" : undefined}
      style={styles.activityCard}
    >
      <View style={styles.activityHeader}>
        <View style={[styles.activityDot, { backgroundColor: tone }]} />
        <View style={styles.toolCopy}>
          <Text style={styles.activityLabel}>{activity.label}</Text>
          {activity.detail ? (
            <Text selectable style={styles.timelineDetail}>
              {activity.detail}
            </Text>
          ) : null}
          {steerLabel ? (
            <Text testID="subagent-steer-status" style={styles.timelineDetail}>
              {steerLabel}
            </Text>
          ) : null}
        </View>
        <Text style={[styles.activityStatus, { color: tone }]}>
          {activity.status === "running"
            ? "进行中"
            : activity.status === "paused"
              ? "已暂停"
              : activity.status === "failed"
                ? "失败"
                : activity.status === "cancelled"
                  ? "已取消"
                  : "完成"}
        </Text>
        {onSteer && activity.status === "running" ? (
          <Pressable
            testID="subagent-steer-open"
            accessibilityRole="button"
            accessibilityLabel={`调整 ${activity.label}`}
            onPress={() => {
              setEditing((value) => !value);
              setError(null);
            }}
            style={styles.activitySteerButton}
          >
            <Text style={styles.activitySteerButtonText}>调整</Text>
          </Pressable>
        ) : null}
      </View>
      {editing && onSteer ? (
        <View style={styles.activitySteerForm}>
          <TextInput
            testID="subagent-steer-input"
            accessibilityLabel="新的子智能体指令"
            multiline
            value={draft}
            editable={!pending}
            onChangeText={setDraft}
            style={styles.activitySteerInput}
          />
          {error ? (
            <Text accessibilityRole="alert" style={styles.activitySteerError}>
              {error}
            </Text>
          ) : null}
          <View style={styles.activitySteerActions}>
            <Pressable
              accessibilityRole="button"
              onPress={() => setEditing(false)}
              style={styles.activitySteerCancel}
            >
              <Text style={styles.activitySteerCancelText}>取消</Text>
            </Pressable>
            <Pressable
              testID="subagent-steer-submit"
              accessibilityRole="button"
              disabled={!draft.trim() || pending}
              onPress={() => {
                const message = draft.trim();
                if (!message || pending) return;
                setPending(true);
                setError(null);
                void onSteer(message)
                  .then((accepted) => {
                    if (accepted) {
                      setEditing(false);
                      setDraft("");
                    } else setError("指令未能进入队列");
                  })
                  .catch((value) =>
                    setError(
                      value instanceof Error ? value.message : String(value),
                    ),
                  )
                  .finally(() => setPending(false));
              }}
              style={[
                styles.activitySteerSubmit,
                (!draft.trim() || pending) && styles.disabledButton,
              ]}
            >
              <ArrowUp size={16} color={colors.background} />
              <Text style={styles.activitySteerSubmitText}>
                {pending ? "发送中…" : "发送"}
              </Text>
            </Pressable>
          </View>
        </View>
      ) : null}
    </View>
  );
}

export function ToolCallCard({
  tool,
}: {
  tool: NonNullable<ChatMessage["tools"]>[number];
}) {
  const [expanded, setExpanded] = useState(false);
  const hasDetails = tool.input !== undefined || tool.output !== undefined;
  return (
    <View
      testID={`tool-call-${encodeURIComponent(tool.id)}`}
      style={styles.tool}
    >
      <Pressable
        disabled={!hasDetails}
        accessibilityRole="button"
        aria-expanded={hasDetails ? expanded : undefined}
        accessibilityState={{
          expanded: hasDetails ? expanded : undefined,
          disabled: !hasDetails,
        }}
        onPress={() => setExpanded((value) => !value)}
        style={styles.toolHeader}
      >
        <Wrench
          size={15}
          color={
            tool.status === "failed"
              ? colors.red
              : tool.status === "running"
                ? colors.yellow
                : colors.textMuted
          }
        />
        <View style={styles.toolCopy}>
          <Text style={styles.toolName}>{tool.name}</Text>
        </View>
        <Text
          style={[
            styles.toolStatus,
            tool.status === "running" && styles.toolRunning,
            tool.status === "failed" && styles.toolFailed,
          ]}
        >
          {tool.status === "running"
            ? "运行中"
            : tool.status === "failed"
              ? "失败"
              : "完成"}
        </Text>
        {hasDetails ? (
          expanded ? (
            <ChevronDown size={15} color={colors.textDim} />
          ) : (
            <ChevronRight size={15} color={colors.textDim} />
          )
        ) : null}
      </Pressable>
      {expanded ? (
        <View style={styles.toolDetails}>
          {tool.input !== undefined ? (
            <View>
              <Text style={styles.toolDetailLabel}>输入</Text>
              <BoundedOutput value={tool.input} />
            </View>
          ) : null}
          {tool.output !== undefined ? (
            <View>
              <Text style={styles.toolDetailLabel}>输出</Text>
              <BoundedOutput value={tool.output} />
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

export function FileChangesCard({
  changes,
  onOpenChanges,
}: {
  changes: FileChangesView;
  onOpenChanges(): void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`审查 ${changes.fileCount} 个文件变更`}
      onPress={onOpenChanges}
      style={({ pressed }) => [
        styles.changesCard,
        pressed && styles.changeCardPressed,
      ]}
    >
      <View style={styles.changesHeader}>
        <View style={styles.changesHeading}>
          <GitCompareArrows size={15} color={colors.textMuted} />
          <Text style={styles.changesTitle}>
            文件变更 · {changes.fileCount}
          </Text>
        </View>
        <View style={styles.changeSummary}>
          <Text style={styles.changeAdditions}>+{changes.additions}</Text>
          <Text style={styles.changeDeletions}>-{changes.deletions}</Text>
          <ChevronRight size={16} color={colors.textDim} />
        </View>
      </View>
      {changes.status === "reverted" ? (
        <Text style={styles.reviewHint}>变更已撤销</Text>
      ) : null}
    </Pressable>
  );
}
