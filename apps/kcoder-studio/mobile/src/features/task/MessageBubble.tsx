import { messageProviderRetries, providerRetryProgress } from "@/components/provider-retry-presentation";
import { ProviderRetryNotice } from "@/components/provider-retry-notice";
import { createConversationMarkdownRules } from "@/features/conversation/markdown-presentation";
import { useInterfaceVersion } from "@/storage/interface-version";
import { t } from "@/i18n";
import { useLocale } from "@/i18n/use-locale";
import { FailureContinuation } from "@/components/failure-continuation";
import {
  CodeDisclosure,
  ProcessingDisclosure,
} from "@/components/output-disclosure";
import { workspaceFilePathFromInlineCode } from "@/components/workspace-file-links";
import { TaskRuntime, type ChatMessage } from "@/runtime/task-runtime";
import { memo, useCallback, useMemo, useState } from "react";
import { rowActions } from "@/components/row-actions";
import { Linking, Pressable, Text, View } from "react-native";
import Markdown, { type RenderRules } from "react-native-markdown-display";
import {
  ActivityCard,
  FileChangesCard,
  InteractionSummaryCard,
  TodoCard,
  ToolCallCard,
} from "./MessageCards";
import { inlineWidgetFallback } from "./inline-widget-fallback";
import { OrderedMessageSegments } from "./OrderedMessageSegments";
import { MessageAttachment } from "./TaskAttachments";
import { previewableRasterMimeType } from "./attachmentPreparation";
import { TaskMenuSheet } from "./TaskMenu";
import { TranscriptActions } from "./TranscriptActions";
import { visibleAssistantText } from "./transcript-actions";
import { usePacedStreamingText } from "./usePacedStreamingText";
import { ThinkingDisclosure } from "./ThinkingDisclosure";
import { ProcessingStep } from "./TranscriptDisclosure";
import { useTaskAppearance, useTaskMarkdownStyles } from "./taskStyles";

export const MessageBubble = memo(function MessageBubble({
  message,
  task,
  continuationBusy,
  connected,
  onOpenFile,
  onOpenChanges,
  readOnly: requestedReadOnly = false,
  cwd,
  onEdit,
  onFork,
  animateText = false,
  turnRunning = false,
  showTodos = true,
}: {
  onEdit?(): void;
  onFork?(): void;
  animateText?: boolean;
  turnRunning?: boolean;
  showTodos?: boolean;
  readOnly?: boolean;
  message: ChatMessage;
  task?: TaskRuntime;
  cwd?: string;
  continuationBusy: boolean;
  connected: boolean;
  onOpenFile(link: string): boolean;
  onOpenChanges(): void;
}) {
  const locale = useLocale();
  const interfaceVersion = useInterfaceVersion();
  const v3 = interfaceVersion === "v3";
  const { styles, colors } = useTaskAppearance();
  const markdownStyles = useTaskMarkdownStyles();
  const thinkingMarkdownStyles = useMemo(() => v3 ? { ...markdownStyles,
    body: { ...markdownStyles.body, color: colors.textMuted }, paragraph: { ...markdownStyles.paragraph, color: colors.textMuted },
  } : markdownStyles, [v3, markdownStyles, colors.textMuted]);
  const user = message.role === "user";
  const [actionsOpen, setActionsOpen] = useState(false);
  const attachments = message.attachments ?? [];
  const imageAttachments = user
    ? attachments.filter((attachment) =>
        Boolean(previewableRasterMimeType(attachment.mimeType)),
      )
    : [];
  const trailingAttachments = user
    ? attachments.filter(
        (attachment) => !previewableRasterMimeType(attachment.mimeType),
      )
    : attachments;
  const orderedTranscript = !user && message.orderedBlocks !== undefined;
  const assistantText = user ? null : visibleAssistantText(message);
  const retryActivities = messageProviderRetries(message);
  const legacyActivities = (message.activities ?? []).filter(activity => !providerRetryProgress(activity) &&
    !(message.status === "failed" && message.error && activity.status === "failed" && activity.detail === message.error));
  const legacyToolsCount = message.tools?.length ?? 0;
  const legacyHasThinking = Boolean(message.thinking);
  const legacyProcessingTitle =
    legacyHasThinking && legacyToolsCount > 0
      ? t("output.thinking_and_tools", { count: legacyToolsCount })
      : legacyHasThinking
        ? t("output.process")
        : legacyToolsCount > 0
          ? t("output.tools", { count: legacyToolsCount })
          : t("output.activity");
  const readOnly = requestedReadOnly || !task;
  // Live deltas may precede a message status. The active turn owns that interim state.
  const messageStatus = message.status ?? (turnRunning && !readOnly && !user ? "streaming" : undefined);
  const tail = message.orderedBlocks?.at(-1);
  const tailText = orderedTranscript ? tail?.kind === "text" ? tail.content : "" : message.content;
  const fragmentId = orderedTranscript ? tail?.kind === "text" ? tail.id : "" : "legacy";
  const terminalMessage = ["completed", "failed", "cancelled", "interrupted", "stopped"].includes(message.status ?? "");
  const displayedText = usePacedStreamingText(tailText, animateText && connected && !readOnly && !user && !terminalMessage,
    task, message.id, fragmentId);
  const editable = user && !readOnly && Boolean(onEdit);
  const BubbleContainer = editable ? Pressable : View;
  const workspaceRoot = cwd ?? task?.getSnapshot().cwd ?? "";
  const openLink = useCallback(
    (url: string) => {
      if (!readOnly && onOpenFile(url)) return;
      if (/^(?:https?:|mailto:)/i.test(url))
        void Linking.openURL(url).catch(() => {});
    },
    [onOpenFile, readOnly],
  );
  const rules = useMemo<RenderRules>(
    () => createConversationMarkdownRules(interfaceVersion, {
      ...(!task ? { image: (node: { key: string; attributes: { alt?: string } }) => <Text key={node.key}>{node.attributes.alt ?? ""}</Text> } : {}),
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
          language={String(("sourceInfo" in node ? node.sourceInfo : "") ?? "")}
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
        const isWorkspaceFile = !readOnly && Boolean(
          workspaceFilePathFromInlineCode(node.content, workspaceRoot),
        );
        return (
          <Text
            key={node.key}
            testID="conversation-markdown-inline-code"
            accessibilityRole={isWorkspaceFile ? "link" : undefined}
            accessibilityHint={
              isWorkspaceFile ? t("task.open_in_files") : undefined
            }
            onPress={
              isWorkspaceFile ? () => onOpenFile(node.content) : undefined
            }
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
    [onOpenFile, openLink, workspaceRoot, locale, markdownStyles, readOnly, task, interfaceVersion],
  );
  const renderOrderedText = useCallback(
    (content: string) => (
      <Markdown rules={rules} style={markdownStyles}>
        {inlineWidgetFallback(content, t("task.visualization_studio_hint"))}
      </Markdown>
    ),
    [rules, markdownStyles, locale],
  );
  const renderThinkingText = useCallback((content: string) => (
    <Markdown rules={rules} style={thinkingMarkdownStyles}>{inlineWidgetFallback(content, t("task.visualization_studio_hint"))}</Markdown>
  ), [rules, thinkingMarkdownStyles, locale]);
  return (
    <View
      testID={user ? "message-user" : "message-assistant"}
      style={[styles.messageRow, user && styles.userMessageRow]}
    >
      <BubbleContainer
        testID={editable ? "message-user-actions-trigger" : undefined}
        {...(editable ? rowActions(t("task.edit_last_message"), () => setActionsOpen(true)) : {})}
        style={[
          styles.messageBubble,
          user ? styles.userBubble : styles.assistantBubble,
        ]}
      >
        {imageAttachments.map((attachment) => (
          readOnly || !task ? <Text key={attachment.path} style={styles.cancelledMessage}>{attachment.filename}</Text> : <MessageAttachment
            key={`${task.getSnapshot().threadId}:${attachment.path}`}
            attachment={attachment}
            task={task}
            inlineImage
          />
        ))}
        {orderedTranscript ? (
          <OrderedMessageSegments
            orderedBlocks={message.orderedBlocks ?? []}
            task={task}
            readOnly={readOnly}
            handledFailureDetail={message.status === "failed" ? message.error : undefined}
            failureHandled={message.status === "failed"}
            messageStatus={messageStatus}
            renderText={renderOrderedText}
            renderThinkingText={renderThinkingText}
            textOverride={fragmentId ? { id: fragmentId, content: displayedText } : undefined}
          />
        ) : (
          <View testID="assistant-legacy-segments" style={styles.legacyMessageSegments}>
            {retryActivities.length > 0 && message.status !== "failed" ? <ProviderRetryNotice activities={retryActivities} /> : null}
            {message.thinking ||
            message.tools?.length ||
            legacyActivities.length ||
            message.interactionSummaries?.length ? (
              <ProcessingDisclosure
                count={legacyToolsCount}
                title={legacyProcessingTitle}
                hasThinking={Boolean(message.thinking)}
                running={
                  messageStatus === "streaming" ||
                  Boolean(
                    message.tools?.some((tool) => tool.status === "running") ||
                    legacyActivities.some(
                      (activity) => activity.status === "running",
                    ),
                  )
                }
                failed={
                  (message.tools?.filter((tool) => tool.status === "failed")
                    .length ?? 0) +
                  (legacyActivities.filter(
                    (activity) => activity.status === "failed",
                  ).length ?? 0)
                }
                unknown={
                  message.tools?.filter(
                    (tool) =>
                      tool.status === "unknown" &&
                      !isCancelledToolStatus(tool.rawStatus),
                  ).length ?? 0
                }
                cancelled={
                  (message.tools?.filter(
                    (tool) =>
                      tool.status === "unknown" &&
                      isCancelledToolStatus(tool.rawStatus),
                  ).length ?? 0) +
                  (legacyActivities.filter(
                    (activity) => activity.status === "cancelled",
                  ).length ?? 0)
                }
              >
                {message.thinking ? (
                  <ProcessingStep
                    testID="legacy-processing-thinking"
                    first
                    last={
                      !legacyToolsCount ||
                      Boolean(
                        legacyActivities.length ||
                        message.interactionSummaries?.length,
                      )
                    }
                  >
                    <ThinkingDisclosure
                      content={message.thinking}
                      renderContent={renderThinkingText}
                      testID="legacy-thinking"
                    />
                  </ProcessingStep>
                ) : null}
                {legacyActivities.map((activity) => (
                  <ActivityCard
                    key={activity.id}
                    activity={activity}
                    handledFailureDetail={message.status === "failed" && !readOnly ? message.error : undefined}
                    onSteer={
                      !readOnly && task && activity.agentId
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
                {message.tools?.map((tool, index) => (
                  <ProcessingStep
                    key={tool.id}
                    testID={`legacy-processing-tool-${encodeURIComponent(tool.id)}`}
                    first={
                      index === 0 &&
                      (!legacyHasThinking ||
                        Boolean(
                          legacyActivities.length ||
                          message.interactionSummaries?.length,
                        ))
                    }
                    last={index === legacyToolsCount - 1}
                  >
                    <ToolCallCard tool={tool} />
                  </ProcessingStep>
                ))}
              </ProcessingDisclosure>
            ) : null}
            {message.content ? (
              user ? (
                <Text selectable style={[styles.userText, markdownStyles.body, v3 && { color: styles.userText.color }]}>
                  {message.content}
                </Text>
              ) : (
                <Markdown rules={rules} style={markdownStyles}>
                  {inlineWidgetFallback(displayedText, t("task.visualization_studio_hint"))}
                </Markdown>
              )
            ) : null}
          </View>
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
          <View accessibilityRole={message.continuedByAttemptId ? undefined : "alert"} testID="message-attempt-failure">
            <FailureContinuation task={task} readOnly={readOnly} message={message} busy={continuationBusy} connected={connected} />
          </View>
        ) : null}
        {!user && message.status === "cancelled" ? (
          <Text accessibilityRole="text" style={styles.cancelledMessage}>
            {t("task.stopped")}
          </Text>
        ) : null}
        {trailingAttachments.map((attachment) => (
          readOnly || !task ? <Text key={attachment.path} style={styles.cancelledMessage}>{attachment.filename}</Text> : <MessageAttachment
            key={attachment.path}
            attachment={attachment}
            task={task}
          />
        ))}
        {showTodos && message.todos ? <TodoCard todos={message.todos} /> : null}
        {message.fileChanges && !readOnly ? (
          <FileChangesCard
            changes={message.fileChanges}
            onOpenChanges={onOpenChanges}
          />
        ) : null}
        {!user && assistantText ? (
          <TranscriptActions onFork={!readOnly ? onFork : undefined} text={assistantText} />
        ) : null}
        {!readOnly && !user && !assistantText && onFork ? <TranscriptActions text="" onFork={onFork} /> : null}
      </BubbleContainer>
      {editable && actionsOpen ? <TaskMenuSheet visible title={t("task.response_actions")} testID="user-message-menu" onClose={() => setActionsOpen(false)}>
        <Pressable testID="message-edit-last" accessibilityRole="button" style={styles.taskMenuRow}
          onPress={() => { setActionsOpen(false); onEdit?.(); }}><Text style={styles.taskMenuText}>{t("task.edit_last_message")}</Text></Pressable>
      </TaskMenuSheet> : null}
    </View>
  );
});

function isCancelledToolStatus(rawStatus?: string) {
  return /^(?:cancelled|canceled)$/i.test(rawStatus?.trim() ?? "");
}
