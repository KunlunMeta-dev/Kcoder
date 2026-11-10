import { NativeWebSources } from "./NativeWebSources";
import { t } from "@/i18n";
import { useLocale } from "@/i18n/use-locale";
import { BoundedOutput } from "@/components/output-disclosure";
import { runtimeErrorSummary } from "@/components/runtime-error";
import { type ChatMessage, type FileChangesView } from "@/runtime/task-runtime";
import {
  ArrowUp,
  ChevronRight,
  GitCompareArrows,
  ShieldCheck,
  Wrench,
} from "lucide-react-native";
import { useState, useSyncExternalStore } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { useTaskAppearance } from "./taskStyles";
import { TranscriptDisclosureHeader } from "./TranscriptDisclosure";
import { resolveDisclosureExpanded, toggleDisclosureChoice } from "./disclosure-state";
import { getAppPreferencesSnapshot, subscribeAppPreferences } from "@/storage/app-preferences";
import { useInterfaceVersion } from "@/storage/interface-version";

export { TodoCard } from "./TaskPlanCard";

export function InteractionSummaryCard({
  summary,
  compact = false,
}: {
  summary: NonNullable<ChatMessage["interactionSummaries"]>[number];
  compact?: boolean;
}) {
  const { styles, colors } = useTaskAppearance();
  const v3 = useInterfaceVersion() === "v3";
  const [promptExpanded, setPromptExpanded] = useState(false);
  const collapsiblePrompt = v3 && compact && Boolean(summary.prompt && summary.prompt.length > 160);
  return (
    <View
      testID={`interaction-summary-${summary.id}`}
      style={compact ? styles.processingSummary : styles.timelineCard}
    >
      <View
        style={compact ? styles.processingSummaryHeader : styles.timelineHeader}
      >
        <ShieldCheck size={15} color={colors.green} />
        <View style={styles.toolCopy}>
          <Text style={styles.timelineTitle}>{summary.header}</Text>
          {summary.prompt ? (
            <Text testID={`interaction-summary-prompt-${summary.id}`} selectable
              numberOfLines={collapsiblePrompt && !promptExpanded ? 2 : undefined}
              accessibilityRole={collapsiblePrompt ? "button" : undefined}
              accessibilityState={collapsiblePrompt ? { expanded: promptExpanded } : undefined}
              accessibilityHint={collapsiblePrompt ? t(promptExpanded ? "task.hide_technical_details" : "task.view_technical_details") : undefined}
              onPress={collapsiblePrompt ? () => setPromptExpanded(value => !value) : undefined}
              style={styles.timelineDetail}>
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

export function ActivityCard({
  activity,
  onSteer,
  handledFailureDetail,
}: {
  activity: NonNullable<ChatMessage["activities"]>[number];
  onSteer?: (message: string) => Promise<boolean>;
  handledFailureDetail?: string;
}) {
  useLocale();
  const { styles, colors } = useTaskAppearance();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorDetailsVisible, setErrorDetailsVisible] = useState(false);
  const detail = activity.status === "failed" && activity.detail ? runtimeErrorSummary(activity.detail) : activity.detail;
  const detailHandled = activity.status === "failed" && activity.detail === handledFailureDetail;
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
      ? t("task.adjustment_applied")
      : activity.steerStatus?.startsWith("queued")
        ? t("task.adjustment_queued")
        : activity.steerStatus === "resuming"
          ? t("task.recovering")
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
          {activity.detail && !detailHandled ? (
            <Text selectable style={styles.timelineDetail}>
              {errorDetailsVisible ? activity.detail : detail}
            </Text>
          ) : null}
          {activity.detail && !detailHandled && detail !== activity.detail ? <Pressable accessibilityRole="button"
            accessibilityState={{ expanded: errorDetailsVisible }} onPress={() => setErrorDetailsVisible(value => !value)} style={styles.errorDetailsButton}>
            <Text style={styles.errorDetailsText}>{t(errorDetailsVisible ? "task.hide_technical_details" : "task.view_technical_details")}</Text>
          </Pressable> : null}
          {steerLabel ? (
            <Text testID="subagent-steer-status" style={styles.timelineDetail}>
              {steerLabel}
            </Text>
          ) : null}
        </View>
        <Text style={[styles.activityStatus, { color: tone }]}>
          {activity.status === "running"
            ? t("task.in_progress")
            : activity.status === "paused"
              ? t("task.paused")
              : activity.status === "failed"
                ? t("task.failed")
                : activity.status === "cancelled"
                  ? t("task.cancelled")
                  : t("task.completed")}
        </Text>
        {onSteer && activity.status === "running" ? (
          <Pressable
            testID="subagent-steer-open"
            accessibilityRole="button"
            accessibilityLabel={t("task.adjust_with_value", {
              p0: activity.label,
            })}
            onPress={() => {
              setEditing((value) => !value);
              setError(null);
            }}
            style={styles.activitySteerButton}
          >
            <Text style={styles.activitySteerButtonText}>
              {t("task.adjust")}
            </Text>
          </Pressable>
        ) : null}
      </View>
      {editing && onSteer ? (
        <View style={styles.activitySteerForm}>
          <TextInput
            testID="subagent-steer-input"
            accessibilityLabel={t("task.new_subagent_instruction")}
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
              <Text style={styles.activitySteerCancelText}>
                {t("task.cancel")}
              </Text>
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
                    } else
                      setError(t("task.the_instruction_could_not_be_queued"));
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
                {pending ? t("task.sending") : t("task.send")}
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
  useLocale();
  const v3 = useInterfaceVersion() === "v3";
  const { styles, colors } = useTaskAppearance();
  const preferences = useSyncExternalStore(
    subscribeAppPreferences,
    getAppPreferencesSnapshot,
    getAppPreferencesSnapshot,
  );
  const [defaultExpanded] = useState(() => !preferences.toolsCollapsedByDefault);
  const [userExpanded, setUserExpanded] = useState<boolean | null>(null);
  const expanded = resolveDisclosureExpanded(userExpanded, defaultExpanded);
  const hasDetails = tool.input !== undefined || tool.output !== undefined;
  const toolLabel = /^web_?search$/i.test(tool.name) ? t("web_sources.search") : /^web_?fetch$/i.test(tool.name) ? t("web_sources.fetch") : tool.name;
  const cancelled =
    tool.status === "unknown" &&
    /^(?:cancelled|canceled)$/i.test(tool.rawStatus?.trim() ?? "");
  const statusLabel = tool.status === "running"
    ? t("task.running")
    : tool.status === "failed"
      ? t("task.failed")
      : cancelled
        ? t("task.cancelled")
        : tool.status === "unknown"
          ? t("task.unknown")
          : t("task.completed");
  const statusTone = tool.status === "failed" ? colors.red : tool.status === "running" || tool.status === "unknown" && !cancelled
    ? colors.yellow : cancelled ? colors.textDim : colors.green;
  return (
    <View
      testID={`tool-call-${encodeURIComponent(tool.id)}`}
      style={styles.tool}
    >
      <TranscriptDisclosureHeader
        testID={`tool-call-toggle-${encodeURIComponent(tool.id)}`}
        label={`${toolLabel}. ${statusLabel}`}
        disabled={!hasDetails}
        expanded={expanded}
        onPress={() => setUserExpanded((value) => toggleDisclosureChoice(value, defaultExpanded))}
        icon={
          v3 ? <View testID={`tool-status-${encodeURIComponent(tool.id)}`} style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: statusTone }} /> : <Wrench
            size={20}
            color={
              tool.status === "failed"
                ? colors.red
                : tool.status === "running"
                  ? colors.yellow
                  : colors.textMuted
            }
          />
        }
      >
        <View style={styles.toolCopy}>
          <Text style={styles.toolName}>{toolLabel}</Text>
        </View>
        <Text
          style={[
            styles.toolStatus,
            tool.status === "running" && styles.toolRunning,
            tool.status === "failed" && styles.toolFailed,
            v3 && { color: statusTone },
          ]}
        >
          {statusLabel}
        </Text>
      </TranscriptDisclosureHeader>
      {expanded ? (
        <View style={styles.toolDetails}>
          {tool.input !== undefined ? (
            <View>
              <Text style={styles.toolDetailLabel}>{t("task.input")}</Text>
              <BoundedOutput value={tool.input} />
            </View>
          ) : null}
          {tool.output !== undefined ? (
            <View>
              <Text style={styles.toolDetailLabel}>{t("task.output")}</Text>
              <BoundedOutput value={tool.output} />
            </View>
          ) : null}
        </View>
      ) : null}
      {tool.webSources ? <NativeWebSources receipt={tool.webSources} /> : null}
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
  useLocale();
  const { styles, colors } = useTaskAppearance();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t("task.review_changes_in_files", {
        p0: changes.fileCount,
      })}
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
            {`${t("task.file_changes")} ${changes.fileCount}`}
          </Text>
        </View>
        <View style={styles.changeSummary}>
          <Text style={styles.changeAdditions}>+{changes.additions}</Text>
          <Text style={styles.changeDeletions}>-{changes.deletions}</Text>
          <ChevronRight size={16} color={colors.textDim} />
        </View>
      </View>
      {changes.status === "reverted" ? (
        <Text style={styles.reviewHint}>{t("task.changes_reverted")}</Text>
      ) : null}
    </Pressable>
  );
}
