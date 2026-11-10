import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { Check, ChevronDown, ChevronRight, ListTodo } from "lucide-react-native";
import { t } from "@/i18n";
import { useLocale } from "@/i18n/use-locale";
import type { ChatMessage } from "@/runtime/task-runtime";
import { useTaskAppearance } from "./taskStyles";
import { taskPlanProgress } from "./task-plan";

export function TaskPlanItems({ todos }: { todos: NonNullable<ChatMessage["todos"]> }) {
  const { styles, colors } = useTaskAppearance();
  return <View style={styles.todoList}>{todos.map((todo, index) => (
    <View key={`${todo.content}-${index}`} style={styles.todoRow}>
      <View style={[styles.todoDot, todo.status === "completed" && styles.todoDotDone,
        todo.status === "in_progress" && { borderColor: colors.blue }]}>
        {todo.status === "completed" ? <Check size={11} color={colors.background} /> : null}
        {todo.status === "cancelled" ? <Text style={styles.timelineDetail}>−</Text> : null}
      </View>
      <View style={styles.toolCopy}>
        <Text style={[styles.todoText, (todo.status === "completed" || todo.status === "cancelled") && styles.todoTextDone]}>
          {todo.content}
        </Text>
        <Text style={styles.timelineDetail}>{t(`task.plan_${todo.status}`)}</Text>
      </View>
    </View>
  ))}</View>;
}

/** Historical and legacy placements share checklist content and progress semantics. */
export function TodoCard({ todos, current = false }: {
  todos: NonNullable<ChatMessage["todos"]>;
  current?: boolean;
}) {
  useLocale();
  const { styles, colors } = useTaskAppearance();
  const [expanded, setExpanded] = useState(false);
  const { completed, total, next } = taskPlanProgress(todos);
  const items = <TaskPlanItems todos={todos} />;
  return <View testID={current ? "task-plan-card" : "todo-card"} style={styles.timelineCard}>
    <Pressable testID={current ? "task-plan-summary" : "todo-card-toggle"} accessibilityRole="button"
      aria-expanded={expanded} accessibilityState={{ expanded }}
      onPress={() => setExpanded(value => !value)} style={styles.timelineHeader}>
      <ListTodo size={15} color={colors.blue} />
      <View style={styles.toolCopy}>
        <Text style={styles.timelineTitle}>{t(current ? "task.plan_progress" : "task.checklist_progress", { done: completed, total })}</Text>
        {!expanded && next ? <Text numberOfLines={1} style={styles.timelineDetail}>
          {t(`task.plan_${next.status}`)} · {next.content}
        </Text> : null}
      </View>
      {expanded ? <ChevronDown size={15} color={colors.textDim} /> : <ChevronRight size={15} color={colors.textDim} />}
    </Pressable>
    {expanded ? current
      ? <ScrollView testID="task-plan-items" nestedScrollEnabled style={{ maxHeight: 144 }}>{items}</ScrollView>
      : <View testID="todo-card-items">{items}</View>
      : null}
  </View>;
}
