import { BoundedOutput } from "@/components/output-disclosure";
import type {
  AssistantTranscriptBlock,
  TaskRuntime,
} from "@/runtime/task-runtime";
import { ChevronDown, ChevronRight } from "lucide-react-native";
import { memo, useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { t } from "@/i18n";
import { useLocale } from "@/i18n/use-locale";
import {
  ActivityCard,
  InteractionSummaryCard,
  ToolCallCard,
} from "./MessageCards";
import { useTaskAppearance } from "./taskStyles";

export function OrderedMessageSegments({
  orderedBlocks,
  task,
  renderText,
}: {
  orderedBlocks: readonly AssistantTranscriptBlock[];
  task: TaskRuntime;
  renderText(content: string, blockId: string): ReactNode;
}) {
  const { styles } = useTaskAppearance();
  return (
    <View testID="assistant-ordered-segments" style={styles.orderedMessageSegments}>
      {orderedBlocks.map((block) => (
        <OrderedMessageSegment
          key={`${block.kind}:${block.id}`}
          block={block}
          textContent={block.kind === "text" ? block.content : undefined}
          task={task}
          renderText={renderText}
        />
      ))}
    </View>
  );
}

const OrderedMessageSegment = memo(function OrderedMessageSegment({
  block,
  textContent,
  task,
  renderText,
}: {
  block: AssistantTranscriptBlock;
  textContent?: string;
  task: TaskRuntime;
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
      return <ThinkingSegment block={block} />;
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
      return (
        <View
          testID={segmentTestId(block.kind, block.id)}
          style={styles.orderedMessageActivity}
        >
          <ActivityCard
            activity={block.activity}
            onSteer={
              block.activity.agentId
                ? async (message) =>
                    (
                      await task.steerSubagent(
                        block.activity.agentId!,
                        message,
                      )
                    ).queued
                : undefined
            }
          />
        </View>
      );
  }
});

const ThinkingSegment = memo(function ThinkingSegment({
  block,
}: {
  block: Extract<AssistantTranscriptBlock, { kind: "thinking" }>;
}) {
  useLocale();
  const { styles, colors } = useTaskAppearance();
  const [expanded, setExpanded] = useState(false);
  return (
    <View
      testID={segmentTestId(block.kind, block.id)}
      style={styles.orderedMessageThinking}
    >
      <Pressable
        testID={`thinking-segment-toggle-${encodeURIComponent(block.id)}`}
        accessibilityRole="button"
        accessibilityLabel={t("output.process")}
        accessibilityState={{ expanded }}
        aria-expanded={expanded}
        onPress={() => setExpanded((value) => !value)}
        style={styles.orderedThinkingHeader}
      >
        {expanded ? (
          <ChevronDown size={15} color={colors.textMuted} />
        ) : (
          <ChevronRight size={15} color={colors.textMuted} />
        )}
        <Text style={styles.thinkingTitle}>{t("output.process")}</Text>
      </Pressable>
      {expanded ? <BoundedOutput value={block.content} /> : null}
    </View>
  );
});

function segmentTestId(kind: AssistantTranscriptBlock["kind"], id: string) {
  return `ordered-message-segment-${kind}-${encodeURIComponent(id)}`;
}
