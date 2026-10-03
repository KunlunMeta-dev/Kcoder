import {
  MAX_QUEUED_TASK_MESSAGES,
  MAX_TASK_MESSAGE_CHARACTERS,
} from "@/protocol/task-message-limits";
import { useEffect } from "react";
import {
  releaseLocalAttachmentPreview,
  wireAttachment,
} from "./attachmentPreparation";
import type { useTaskCommands } from "./useTaskCommands";

export function useTaskSending(context: ReturnType<typeof useTaskCommands>) {
  const {
    task,
    demo,
    onDraftChange,
    snapshot,
    messageQueue,
    queuedMessages,
    input,
    setInput,
    goalEditExpectationRef,
    attachments,
    setAttachments,
    mountedRef,
    setQueueError,
    sendingQueued,
    executeSlashCommand,
  } = context;
  const submit = async () => {
    const value = input.trim();
    if ((!value && attachments.length === 0) || !snapshot.connected) return;
    if (await executeSlashCommand(value)) return;
    goalEditExpectationRef.current = null;
    if (value.length > MAX_TASK_MESSAGE_CHARACTERS) {
      setQueueError(
        `消息不能超过 ${MAX_TASK_MESSAGE_CHARACTERS.toLocaleString()} 个字符`,
      );
      return;
    }
    if (
      (snapshot.running || snapshot.interaction) &&
      queuedMessages.length >= MAX_QUEUED_TASK_MESSAGES
    ) {
      setQueueError(
        `最多排队 ${MAX_QUEUED_TASK_MESSAGES} 条消息，请先移除一条或等待发送`,
      );
      return;
    }
    const outgoing = attachments;
    const wireOutgoing = outgoing.map(wireAttachment);
    if (snapshot.running || snapshot.interaction) {
      try {
        if (!demo && wireOutgoing.length > 0) {
          await task.request("gateway/attachments/retain", {
            paths: wireOutgoing.map((attachment) => attachment.path),
          });
        }
        messageQueue.enqueue({
          id: `queued-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          content: value,
          attachments: wireOutgoing,
          createdAt: Date.now(),
        });
      } catch (error) {
        setQueueError(
          `排队消息保存失败：${error instanceof Error ? error.message : String(error)}`,
        );
        return;
      }
      setInput("");
      setAttachments([]);
      outgoing.forEach(releaseLocalAttachmentPreview);
      setQueueError(null);
      onDraftChange?.(undefined);
      return;
    }
    setInput("");
    setAttachments([]);
    try {
      await task.send(value, wireOutgoing);
      outgoing.forEach(releaseLocalAttachmentPreview);
      onDraftChange?.(undefined);
    } catch {
      if (!mountedRef.current) {
        outgoing.forEach(releaseLocalAttachmentPreview);
        if (!demo) {
          for (const attachment of wireOutgoing) {
            void task
              .request("attachment/delete", { path: attachment.path })
              .catch(() => {});
          }
        }
        return;
      }
      setInput((current) => current || value);
      setAttachments((current) => [
        ...outgoing.filter(
          (item) => !current.some((existing) => existing.path === item.path),
        ),
        ...current,
      ]);
    }
  };

  const canSend =
    snapshot.connected && (Boolean(input.trim()) || attachments.length > 0);

  useEffect(() => {
    if (
      !snapshot.connected ||
      snapshot.running ||
      snapshot.interaction ||
      snapshot.archivedAt ||
      sendingQueued.current ||
      queuedMessages.length === 0
    )
      return;
    const next = messageQueue.first();
    if (!next) return;
    sendingQueued.current = true;
    setQueueError(null);
    void task
      .send(next.content, next.attachments)
      .then(() => {
        messageQueue.remove(next.id);
      })
      .catch((value) => {
        setQueueError(
          `排队消息发送失败：${value instanceof Error ? value.message : String(value)}`,
        );
      })
      .finally(() => {
        sendingQueued.current = false;
      });
  }, [
    messageQueue,
    queuedMessages,
    snapshot.archivedAt,
    snapshot.connected,
    snapshot.interaction,
    snapshot.running,
    task,
  ]);

  const removeQueuedMessage = (id: string) => {
    const removed = messageQueue.remove(id);
    if (!removed || demo) return;
    for (const attachment of removed.attachments) {
      void task
        .request("attachment/delete", { path: attachment.path })
        .catch(() => {});
    }
  };
  return { ...context, submit, canSend, removeQueuedMessage };
}
