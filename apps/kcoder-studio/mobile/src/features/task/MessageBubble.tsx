import { t } from "@/i18n";
import { useLocale } from "@/i18n/use-locale";
import { FailureContinuation } from "@/components/failure-continuation";
import {
  BoundedOutput,
  CodeDisclosure,
  ProcessingDisclosure,
} from "@/components/output-disclosure";
import { workspaceFilePathFromInlineCode } from "@/components/workspace-file-links";
import { TaskRuntime, type ChatMessage } from "@/runtime/task-runtime";
import { Bot } from "lucide-react-native";
import { memo, useCallback, useMemo } from "react";
import { Linking, Text, View } from "react-native";
import Markdown, { type RenderRules } from "react-native-markdown-display";
import {
  ActivityCard,
  FileChangesCard,
  InteractionSummaryCard,
  TodoCard,
  ToolCallCard,
} from "./MessageCards";
import { OrderedMessageSegments } from "./OrderedMessageSegments";
import { MessageAttachment } from "./TaskAttachments";
import {
  useTaskAppearance,
  useTaskMarkdownStyles,
} from "./taskStyles";

export const MessageBubble = memo(function MessageBubble({
  message,
  task,
  continuationBusy,
  connected,
  onOpenFile,
  onOpenChanges,
}: {
  message: ChatMessage;
  task: TaskRuntime;
  continuationBusy: boolean;
  connected: boolean;
  onOpenFile(link: string): boolean;
  onOpenChanges(): void;
}) {
  const locale = useLocale();
  const { styles, colors } = useTaskAppearance();
  const markdownStyles = useTaskMarkdownStyles();
  const user = message.role === "user";
  const orderedTranscript = !user && message.orderedBlocks !== undefined;
  const workspaceRoot = task.getSnapshot().cwd;
  const openLink = useCallback(
    (url: string) => {
      if (onOpenFile(url)) return;
      if (/^(?:https?:|mailto:)/i.test(url))
        void Linking.openURL(url).catch(() => {});
    },
    [onOpenFile],
  );
  const rules = useMemo<RenderRules>(
    () => ({
      link: (node, children, _parents, markdownRuleStyles) => (
        <Text
          key={node.key}
          accessibilityRole="link"
          accessibilityHint={t("task.open_link")}
          onPress={() => openLink(String(node.attributes.href ?? ""))}
          style={markdownRuleStyles.link}
        >
          {children}
        </Text>
      ),
      fence: (node) => (
        <CodeDisclosure
          key={node.key}
          content={String(node.content ?? "")}
          language={String(
            ("sourceInfo" in node ? node.sourceInfo : "") ?? "",
          )}
        />
      ),
      code_block: (node) => (
        <CodeDisclosure key={node.key} content={String(node.content ?? "")} />
      ),
      code_inline: (
        node,
        _children,
        _parents,
        markdownRuleStyles,
        inheritedStyles,
      ) => {
        const isWorkspaceFile = Boolean(
          workspaceFilePathFromInlineCode(node.content, workspaceRoot),
        );
        return (
          <Text
            key={node.key}
            accessibilityRole={isWorkspaceFile ? "link" : undefined}
            accessibilityHint={
              isWorkspaceFile ? t("task.open_in_files") : undefined
            }
            onPress={isWorkspaceFile ? () => onOpenFile(node.content) : undefined}
            style={[
              inheritedStyles,
              markdownRuleStyles.code_inline,
              isWorkspaceFile && markdownStyles.fileCodeLink,
            ]}
          >
            {node.content}
          </Text>
        );
      },
    }),
    [onOpenFile, openLink, workspaceRoot, locale, markdownStyles],
  );
  const renderOrderedText = useCallback(
    (content: string) => (
      <Markdown rules={rules} style={markdownStyles}>
        {content}
      </Markdown>
    ),
    [rules],
  );
  return (
    <View
      testID={user ? "message-user" : "message-assistant"}
      style={[styles.messageRow, user && styles.userMessageRow]}
    >
      <View
        style={[
          styles.messageBubble,
          user ? styles.userBubble : styles.assistantBubble,
        ]}
      >
        {!user ? (
          <View style={styles.assistantLabel}>
            <Bot size={16} color={colors.textMuted} />
            <Text style={styles.assistantLabelText}>KCoder</Text>
          </View>
        ) : null}
        {orderedTranscript ? (
          <OrderedMessageSegments
            orderedBlocks={message.orderedBlocks ?? []}
            task={task}
            renderText={renderOrderedText}
          />
        ) : (
          <>
            {message.thinking ||
            message.tools?.length ||
            message.activities?.length ||
            message.interactionSummaries?.length ? (
              <ProcessingDisclosure
                count={message.tools?.length ?? 0}
                running={
                  message.status === "streaming" ||
                  Boolean(
                    message.tools?.some((tool) => tool.status === "running") ||
                    message.activities?.some(
                      (activity) => activity.status === "running",
                    ),
                  )
                }
                failed={
                  (message.tools?.filter((tool) => tool.status === "failed")
                    .length ?? 0) +
                  (message.activities?.filter(
                    (activity) => activity.status === "failed",
                  ).length ?? 0)
                }
              >
                {message.thinking ? (
                  <BoundedOutput value={message.thinking} />
                ) : null}
                {message.activities?.map((activity) => (
                  <ActivityCard
                    key={activity.id}
                    activity={activity}
                    onSteer={
                      activity.agentId
                        ? async (value) =>
                            (await task.steerSubagent(activity.agentId!, value))
                              .queued
                        : undefined
                    }
                  />
                ))}
                {message.interactionSummaries?.map((summary) => (
                  <InteractionSummaryCard key={summary.id} summary={summary} />
                ))}
                {message.tools?.map((tool) => (
                  <ToolCallCard key={tool.id} tool={tool} />
                ))}
              </ProcessingDisclosure>
            ) : null}
            {message.content ? (
              user ? (
                <Text selectable style={styles.userText}>
                  {message.content}
                </Text>
              ) : (
                <Markdown rules={rules} style={markdownStyles}>
                  {message.content}
                </Markdown>
              )
            ) : null}
          </>
        )}
        {!user && message.status === "unknown" ? (
          <Text
            accessibilityRole="text"
            testID="message-attempt-unknown"
            style={styles.cancelledMessage}
          >
            {t("task.unknown")}
          </Text>
        ) : null}
        {!user && message.status === "failed" ? (
          <View accessibilityRole="alert" testID="message-attempt-failure">
            <FailureContinuation
              task={task}
              message={message}
              busy={continuationBusy}
              connected={connected}
            />
          </View>
        ) : null}
        {!user && message.status === "cancelled" ? (
          <Text accessibilityRole="text" style={styles.cancelledMessage}>
            {t("task.stopped")}
          </Text>
        ) : null}
        {message.attachments?.map((attachment) => (
          <MessageAttachment
            key={attachment.path}
            attachment={attachment}
            task={task}
          />
        ))}
        {message.todos ? <TodoCard todos={message.todos} /> : null}
        {message.fileChanges ? (
          <FileChangesCard
            changes={message.fileChanges}
            onOpenChanges={onOpenChanges}
          />
        ) : null}
      </View>
    </View>
  );
});
