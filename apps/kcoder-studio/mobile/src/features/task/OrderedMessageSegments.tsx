import { providerRetryProgress } from "@/components/provider-retry-presentation";
import { ProviderRetryNotice } from "@/components/provider-retry-notice";
import type {
  AssistantTranscriptBlock,
  TaskRuntime,
} from "@/runtime/task-runtime";
import { Clock, Lightbulb, Wrench } from "lucide-react-native";
import { memo, useState, useSyncExternalStore, type ReactNode } from "react";
import { Text, View } from "react-native";
import { t } from "@/i18n";
import { useLocale } from "@/i18n/use-locale";
import {
  ActivityCard,
  InteractionSummaryCard,
  ToolCallCard,
} from "./MessageCards";
import {
  THINKING_CONTENT_CHUNK_SIZE,
  ThinkingContent,
} from "./ThinkingDisclosure";
import { useTaskAppearance } from "./taskStyles";
import {
  ProcessingStep,
  TranscriptDisclosureHeader,
} from "./TranscriptDisclosure";
import { resolveDisclosureExpanded, toggleDisclosureChoice } from "./disclosure-state";
import { getAppPreferencesSnapshot, subscribeAppPreferences } from "@/storage/app-preferences";
import { useInterfaceVersion } from "@/storage/interface-version";
import { v3ConversationPalette } from "@/features/interface/v3-styles";

export function OrderedMessageSegments({
  textOverride,
  orderedBlocks,
  task,
  messageStatus,
  renderText,
  renderThinkingText,
  readOnly = false,
  handledFailureDetail,
  failureHandled = handledFailureDetail !== undefined,
}: {
  textOverride?: { id: string; content: string };
  readOnly?: boolean;
  handledFailureDetail?: string;
  failureHandled?: boolean;
  orderedBlocks: readonly AssistantTranscriptBlock[];
  task?: TaskRuntime;
  messageStatus?: string;
  renderText(content: string, blockId: string): ReactNode;
  renderThinkingText?(content: string, blockId: string): ReactNode;
}) {
  const { styles } = useTaskAppearance();
  const [thinkingLimits, setThinkingLimits] = useState<Record<string, number>>({});
  const retryBlocks = orderedBlocks.filter(block => block.kind === "activity" && providerRetryProgress(block.activity));
  const lastRetry = retryBlocks.at(-1);
  const retryActivities = retryBlocks.flatMap(block => block.kind === "activity" ? [block.activity] : []);
  const segments = groupOrderedBlocks(orderedBlocks.filter(block => {
    if (block.kind !== "activity") return true;
    if (providerRetryProgress(block.activity)) return !failureHandled && block === lastRetry;
    return !(handledFailureDetail && block.activity.status === "failed" && block.activity.detail === handledFailureDetail);
  }));
  // Activity notices do not finish the preceding reasoning or tool segment.
  let statusSegment: OrderedSegment | undefined;
  for (const segment of segments) {
    if (segment.kind === "processing" || segment.block.kind === "text") statusSegment = segment;
  }
  return (
    <View
      testID="assistant-ordered-segments"
      style={styles.orderedMessageSegments}
    >
      {segments.map((segment) =>
        segment.kind === "processing" ? (
          <ProcessingGroup
            key={segment.key}
            testID={segment.testID}
            blocks={segment.blocks}
            renderText={renderThinkingText ?? renderText}
            thinkingLimits={thinkingLimits}
            onMoreThinking={(blockId) => setThinkingLimits((current) => ({
              ...current,
              [blockId]: (current[blockId] ?? THINKING_CONTENT_CHUNK_SIZE) + THINKING_CONTENT_CHUNK_SIZE,
            }))}
            messageStatus={
              segment === statusSegment ? messageStatus : undefined
            }
          />
        ) : (
          <OrderedMessageSegment
            key={segment.block.kind === "activity" && providerRetryProgress(segment.block.activity) ? `provider-retry:${retryActivities[0]?.id}` : `${segment.block.kind}:${segment.block.id}`}
            block={segment.block}
            textContent={
              segment.block.kind === "text" ? textOverride?.id === segment.block.id ? textOverride.content : segment.block.content : undefined
            }
            retryActivities={retryActivities}
            retrying={messageStatus === "streaming" && orderedBlocks.at(-1) === lastRetry}
            task={task}
            renderText={renderText}
            readOnly={readOnly}
            handledFailureDetail={handledFailureDetail}
          />
        ),
      )}
    </View>
  );
}

export type OrderedSegment =
  | {
      kind: "block";
      block: AssistantTranscriptBlock;
    }
  | {
      kind: "processing";
      key: string;
      testID: string;
      blocks: readonly Extract<
        AssistantTranscriptBlock,
        { kind: "tool" | "thinking" }
      >[];
    };

export function groupOrderedBlocks(
  blocks: readonly AssistantTranscriptBlock[],
): OrderedSegment[] {
  const grouped: OrderedSegment[] = [];
  for (let index = 0; index < blocks.length;) {
    const block = blocks[index];
    if (
      (block.kind === "thinking" && block.content.length === 0) ||
      (block.kind === "text" && block.content.length === 0)
    ) {
      // Empty placeholders do not create visible or semantic transcript rows.
      index++;
      continue;
    }
    if (block.kind !== "tool" && block.kind !== "thinking") {
      grouped.push({ kind: "block", block });
      index++;
      continue;
    }

    const run: Array<
      Extract<AssistantTranscriptBlock, { kind: "tool" | "thinking" }>
    > = [];
    while (index < blocks.length) {
      const candidate = blocks[index];
      if (
        (candidate.kind === "thinking" && candidate.content.length === 0) ||
        (candidate.kind === "text" && candidate.content.length === 0)
      ) {
        index++;
        continue;
      }
      if (candidate.kind !== "tool" && candidate.kind !== "thinking") break;
      run.push(candidate);
      index++;
    }
    const first = run[0];
    if (!first) continue;
    const firstKey = `${first.kind}:${first.id}`;
    grouped.push({
      kind: "processing",
      // The first block identity stays fixed as later streamed blocks append.
      key: `processing:${firstKey}`,
      testID: `ordered-message-processing-${encodeURIComponent(first.id)}`,
      blocks: run,
    });
  }
  return grouped;
}

const OrderedMessageSegment = memo(function OrderedMessageSegment({
  block,
  textContent,
  task,
  renderText,
  readOnly,
  handledFailureDetail,
  retryActivities,
  retrying,
}: {
  retryActivities: import("@/runtime/task-runtime/types").TaskActivityView[];
  retrying: boolean;
  readOnly: boolean;
  handledFailureDetail?: string;
  block: AssistantTranscriptBlock;
  textContent?: string;
  task?: TaskRuntime;
  renderText(content: string, blockId: string): ReactNode;
}) {
  const { styles } = useTaskAppearance();
  switch (block.kind) {
    case "text":
      return (
        <View
          testID={segmentTestId(block.kind, block.id)}
          style={styles.orderedMessageText}
        >
          {renderText(textContent ?? block.content, block.id)}
        </View>
      );
    case "thinking":
      return null;
    case "tool":
      return (
        <View
          testID={segmentTestId(block.kind, block.id)}
          style={styles.orderedMessageTool}
        >
          <ToolCallCard tool={block} />
          {block.interactionSummaries?.map((summary) => (
            <InteractionSummaryCard key={summary.id} summary={summary} />
          ))}
        </View>
      );
    case "activity":
      if (providerRetryProgress(block.activity)) return <ProviderRetryNotice activities={retryActivities} running={retrying} />;
      return (
        <View
          testID={segmentTestId(block.kind, block.id)}
          style={styles.orderedMessageActivity}
        >
          <ActivityCard
            activity={block.activity}
            handledFailureDetail={handledFailureDetail}
            onSteer={
              !readOnly && task && block.activity.agentId
                ? async (message) =>
                    (await task.steerSubagent(block.activity.agentId!, message))
                      .queued
                : undefined
            }
          />
        </View>
      );
  }
});

const ProcessingGroup = memo(function ProcessingGroup({
  testID,
  blocks,
  renderText,
  thinkingLimits,
  onMoreThinking,
  messageStatus,
}: {
  testID: string;
  blocks: readonly Extract<
    AssistantTranscriptBlock,
    { kind: "tool" | "thinking" }
  >[];
  renderText(content: string, blockId: string): ReactNode;
  thinkingLimits: Readonly<Record<string, number>>;
  onMoreThinking(blockId: string): void;
  messageStatus?: string;
}) {
  useLocale();
  const { styles, colors } = useTaskAppearance();
  const v3 = useInterfaceVersion() === "v3";
  const tools = blocks.filter(
    (block): block is Extract<AssistantTranscriptBlock, { kind: "tool" }> =>
      block.kind === "tool",
  );
  const thinkingBlocks = blocks.filter(
    (block): block is Extract<AssistantTranscriptBlock, { kind: "thinking" }> =>
      block.kind === "thinking" && block.content.length > 0,
  );
  const hasThinking = thinkingBlocks.length > 0;
  const hasTools = tools.length > 0;
  const preferences = useSyncExternalStore(
    subscribeAppPreferences,
    getAppPreferencesSnapshot,
    getAppPreferencesSnapshot,
  );
  const [defaultExpanded] = useState(() => (
    hasThinking && !preferences.thinkingCollapsedByDefault
  ) || (hasTools && !preferences.toolsCollapsedByDefault));
  const [userExpanded, setUserExpanded] = useState<boolean | null>(null);
  const expanded = resolveDisclosureExpanded(userExpanded, defaultExpanded);
  const running = tools.filter((tool) => tool.status === "running");
  const failed = tools.filter((tool) => tool.status === "failed");
  const cancelled = tools.filter(isCancelledTool);
  const unknown = tools.filter(
    (tool) => tool.status === "unknown" && !isCancelledTool(tool),
  );
  const live =
    running.length > 0 || (messageStatus === "streaming" && hasThinking);
  const title =
    hasThinking && hasTools
      ? t("output.thinking_and_tools", { count: tools.length })
      : hasThinking
        ? t("output.process")
        : t("output.tools", { count: tools.length });
  const failureStatus = failed.length
    ? t("output.failed", { count: failed.length })
    : messageStatus === "failed"
      ? t("task.failed")
      : null;
  const unknownStatus = unknown.length
    ? t("output.unknown", { count: unknown.length })
    : messageStatus === "unknown"
      ? t("task.unknown")
      : null;
  const cancelledStatus = cancelled.length
    ? t("output.cancelled", { count: cancelled.length })
    : messageStatus === "cancelled"
      ? t("task.stopped")
      : null;
  const runningStatus = live
    ? `${t("output.running")}${running.length ? ` · ${toolNames(running)}` : ""}`
    : null;
  const statusLines = [
    failureStatus
      ? { key: "failed", text: failureStatus, color: colors.red }
      : null,
    unknownStatus
      ? { key: "unknown", text: unknownStatus, color: colors.yellow }
      : null,
    cancelledStatus
      ? { key: "cancelled", text: cancelledStatus, color: colors.textDim }
      : null,
    runningStatus
      ? { key: "running", text: runningStatus, color: colors.yellow }
      : null,
  ].filter((status): status is NonNullable<typeof status> => Boolean(status));
  const summary = statusLines.length
    ? statusLines.map((status) => status.text).join(". ")
    : t("output.complete");
  const statusColor =
    failed.length > 0 || messageStatus === "failed"
      ? colors.red
      : cancelled.length > 0 || messageStatus === "cancelled"
        ? colors.textDim
        : unknown.length > 0 || messageStatus === "unknown"
          ? colors.yellow
          : live
            ? colors.yellow
            : colors.textDim;

  return (
    <View testID={testID} style={styles.orderedProcessingGroup}>
      <TranscriptDisclosureHeader
        testID={`${testID}-toggle`}
        label={`${title}. ${summary}`}
        expanded={expanded}
        onPress={() => setUserExpanded((value) => toggleDisclosureChoice(value, defaultExpanded))}
        icon={
          live ? (
            <Clock size={20} color={statusColor} />
          ) : hasThinking ? (
            <Lightbulb size={20} color={v3 ? v3ConversationPalette(colors).thinkingIcon : colors.textMuted} />
          ) : (
            <Wrench size={20} color={colors.textMuted} />
          )
        }
      >
        <View style={styles.toolCopy}>
          <Text style={styles.orderedProcessingTitle}>{title}</Text>
          {statusLines.length ? (
            statusLines.map((status) => (
              <Text
                key={status.key}
                numberOfLines={status.key === "running" ? 1 : undefined}
                style={[
                  styles.orderedProcessingStatus,
                  status.key === "failed" && styles.orderedProcessingFailure,
                  { color: status.color },
                ]}
              >
                {status.text}
              </Text>
            ))
          ) : !v3 || !expanded ? (
            <Text style={styles.orderedProcessingStatus}>
              {t("output.complete")}
            </Text>
          ) : null}
        </View>
      </TranscriptDisclosureHeader>
      {expanded ? (
        <View
          testID={`${testID}-details`}
          style={styles.orderedProcessingDetails}
        >
          {blocks.map((block, index) => {
            const content = block.kind === "thinking" ? (
                <ThinkingDetail
                  key={`thinking:${block.id}`}
                  block={block}
                  renderText={renderText}
                  limit={thinkingLimits[block.id] ?? THINKING_CONTENT_CHUNK_SIZE}
                  onMore={() => onMoreThinking(block.id)}
                />
              ) : (
                <View
                  key={`tool:${block.id}`}
                  testID={segmentTestId(block.kind, block.id)}
                  style={styles.orderedMessageTool}
                >
                  <ToolCallCard tool={block} />
                  {block.interactionSummaries?.map((summary) => (
                    <InteractionSummaryCard
                      key={summary.id}
                      summary={summary}
                      compact
                    />
                  ))}
                </View>
              );
            if (v3 && block.kind === "thinking") return content;
            return <ProcessingStep
              key={`${block.kind}:${block.id}`}
              testID={`processing-step-${encodeURIComponent(block.id)}`}
              first={index === 0 || v3 && blocks[index - 1].kind === "thinking"}
              last={index === blocks.length - 1 || v3 && blocks[index + 1].kind === "thinking"}
            >
              {content}
            </ProcessingStep>
          })}
        </View>
      ) : null}
    </View>
  );
});

const ThinkingDetail = memo(function ThinkingDetail({
  block,
  renderText,
  limit,
  onMore,
}: {
  block: Extract<AssistantTranscriptBlock, { kind: "thinking" }>;
  renderText(content: string, blockId: string): ReactNode;
  limit: number;
  onMore(): void;
}) {
  const { styles } = useTaskAppearance();
  const testID = segmentTestId(block.kind, block.id);
  return (
    <View testID={testID} style={styles.orderedMessageThinking}>
      <ThinkingContent
        testID={testID}
        content={block.content}
        renderContent={(content) => renderText(content, block.id)}
        limit={limit}
        onMore={onMore}
      />
    </View>
  );
});

function isCancelledTool(
  tool: Extract<AssistantTranscriptBlock, { kind: "tool" }>,
) {
  return (
    tool.status === "unknown" &&
    /^(?:cancelled|canceled)$/i.test(tool.rawStatus?.trim() ?? "")
  );
}

function toolNames(tools: readonly { name: string }[]) {
  return tools.map((tool) => tool.name).join(", ");
}

function segmentTestId(kind: AssistantTranscriptBlock["kind"], id: string) {
  return `ordered-message-segment-${kind}-${encodeURIComponent(id)}`;
}
