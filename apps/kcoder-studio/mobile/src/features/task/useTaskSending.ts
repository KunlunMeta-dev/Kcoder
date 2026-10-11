import { t } from "@/i18n";
import { profileAuthorizationScopeKey } from "@/state/profile-coordinator";
import { threadListScopeKey } from "@/runtime/thread-list-projection";
import { RETAIN_TASK_ATTACHMENTS } from "../../../../shared/attachmentRetention";
import {
  MAX_QUEUED_TASK_MESSAGES,
  MAX_TASK_MESSAGE_CHARACTERS,
} from "@/protocol/task-message-limits";
import { MobileRpcError } from "@/gateway/rpc";
import { readTurnReceipt } from "../../../../shared/turnReceipt";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  releaseLocalAttachmentPreview,
  wireAttachment,
} from "./attachmentPreparation";
import {
  failedTaskSubmissionsFor,
  type FailedTaskSubmission,
} from "./failedTaskSubmissions";
import type { ComposerStagedAttachment } from "./types";
import type { useTaskCommands } from "./useTaskCommands";
import type { WorkspaceFailedSubmission } from "@/storage/workspace-preferences";

function newComposerMessageId(): string {
  return `composer-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function releasePreviewAttachments(
  attachments: readonly ComposerStagedAttachment[],
): void {
  attachments.forEach(releaseLocalAttachmentPreview);
}

function persistedFailedSubmissions(
  items: readonly FailedTaskSubmission[],
): WorkspaceFailedSubmission[] | undefined {
  if (items.length === 0) return undefined;
  return items.map((item) => ({
    id: item.id,
    content: item.content,
    attachments: item.attachments.map(wireAttachment),
    createdAt: item.createdAt,
    outcome: item.outcome,
    ...(item.error ? { error: item.error } : {}),
  }));
}

export function useTaskSending(context: ReturnType<typeof useTaskCommands>) {
  const {
    task,
    demo,
    onDraftChange,
    snapshot,
    messageQueue,
    queuedMessages,
    initialFailedSubmissions,
    onFailedSubmissionsChange,
    onQueueCommit,
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
  // Keep upstream's synchronous revision admission while retaining durable
  // queue/receipt recovery. Authority includes the full captured owner scope.
  const scope = JSON.stringify([
    context.profile ? profileAuthorizationScopeKey(context.profile) : null,
    context.profile && context.server ? threadListScopeKey(context.profile, context.server) : null,
    snapshot.threadId,
  ]);
  const lifecycleRef = useRef({ task, scope, generation: 0 });
  if (lifecycleRef.current.task !== task || lifecycleRef.current.scope !== scope) {
    lifecycleRef.current = { task, scope, generation: lifecycleRef.current.generation + 1 };
  }
  const renderGeneration = lifecycleRef.current.generation;
  const ownerCurrent = () => mountedRef.current && !task.isDisposed() &&
    lifecycleRef.current.task === task && lifecycleRef.current.generation === renderGeneration;
  const requireOwner = () => {
    if (!ownerCurrent()) throw new MobileRpcError("Composer owner changed before dispatch", -1, "transport", "not-sent");
  };
  const pending = useRef(new Set<string>());
  const [, refreshPending] = useState(0);
  const draftKey = JSON.stringify([
    lifecycleRef.current.generation,
    context.inputIntentRef.current.revision,
    input,
    attachments.map((item) => item.path),
  ]);
  const failedSubmissionStore = failedTaskSubmissionsFor(task);
  failedSubmissionStore.hydrateOnce(initialFailedSubmissions ?? []);
  const failedSubmissionItems = useSyncExternalStore(
    failedSubmissionStore.subscribe,
    failedSubmissionStore.getSnapshot,
    failedSubmissionStore.getSnapshot,
  );
  const pendingQueueFailureSlots = useRef(0);
  const blocksSubmission = (item: FailedTaskSubmission) => item.outcome === "unknown" ||
    (item.retrying && !((snapshot.running || snapshot.interaction) && messageQueue.getSnapshot().some((queued) => queued.id === item.id && queued.staging)));
  const persistFailedSubmissions = async () => {
    // Evaluate the recovery projection at transaction execution, not enqueue.
    // A later preparing write must not restore a record removed by queue commit.
    await messageQueue.persistProjection(async () => {
      await onFailedSubmissionsChange?.(
        persistedFailedSubmissions(failedSubmissionStore.getSnapshot()),
      );
    });
  };

  useEffect(
    () => () => {
      for (const item of failedSubmissionStore.getSnapshot()) {
        releasePreviewAttachments(item.attachments);
        failedSubmissionStore.update(item.id, (current) => ({
          ...current,
          attachments: current.attachments.map(wireAttachment),
        }));
      }
    },
    [failedSubmissionStore],
  );

  const removeFailedSubmission = async (
    id: string,
    deleteRemoteAttachments: boolean,
  ) => {
    if (!ownerCurrent()) return;
    const removed = failedSubmissionStore.remove(id);
    if (!removed) return;
    try {
      await persistFailedSubmissions();
    } catch {
      failedSubmissionStore.add({
        ...removed,
        outcome: "unknown",
        retrying: false,
        error: t("task.send_state_changed_recovery_not_saved"),
      });
      try {
        await persistFailedSubmissions();
      } catch {
        // Keep the conservative in-memory state if local persistence is unavailable.
      }
      return;
    }
    releasePreviewAttachments(removed.attachments);
    if (!ownerCurrent() || !deleteRemoteAttachments || demo) return;
    for (const attachment of removed.attachments) {
      void task
        .request("attachment/delete", { path: attachment.path })
        .catch(() => {});
    }
  };

  const submit = async () => {
    const value = input.trim();
    if (
      (!value && attachments.length === 0) ||
      !snapshot.connected ||
      pending.current.has(draftKey) ||
      snapshot.configurationReady === false ||
      snapshot.sendAcceptanceUnknown ||
      failedSubmissionStore
        .getSnapshot()
        .some(blocksSubmission)
    )
      return;
    const generation = lifecycleRef.current.generation;
    const submittedRevision = context.inputIntentRef.current.revision;
    const outgoing = [...attachments];
    const wireOutgoing = outgoing.map(wireAttachment);
    const isCurrent = () => mountedRef.current && !task.isDisposed() &&
      lifecycleRef.current.task === task && lifecycleRef.current.generation === generation;
    const assertCurrent = () => {
      if (!isCurrent()) throw new MobileRpcError("Composer owner changed before dispatch", -1, "transport", "not-sent");
    };
    const clearSubmitted = () => {
      if (context.inputIntentRef.current.revision === submittedRevision) setInput("");
      const paths = new Set(outgoing.map((item) => item.path));
      setAttachments((current) => current.filter((item) => !paths.has(item.path)));
    };
    pending.current.add(draftKey);
    for (const attachment of outgoing) {
      const counts = context.pendingAttachmentSubmissions.current;
      counts.set(attachment.path, (counts.get(attachment.path) ?? 0) + 1);
    }
    refreshPending((current) => current + 1);
    try {
      if (await executeSlashCommand(value)) return;
      if (!isCurrent()) return;
    goalEditExpectationRef.current = null;
    if (value.length > MAX_TASK_MESSAGE_CHARACTERS) {
      setQueueError(
        t("task.a_message_cannot_exceed_characters", { p0: MAX_TASK_MESSAGE_CHARACTERS.toLocaleString() }),
      );
      return;
    }
    if (
      failedSubmissionStore.getSnapshot().length +
        pendingQueueFailureSlots.current >=
      MAX_QUEUED_TASK_MESSAGES
    ) {
      setQueueError(
        t("task.too_many_failed_drafts", {
          p0: MAX_QUEUED_TASK_MESSAGES,
        }),
      );
      return;
    }
    if (
      (snapshot.running || snapshot.interaction) &&
      queuedMessages.length >= MAX_QUEUED_TASK_MESSAGES
    ) {
      setQueueError(
        t("task.you_can_queue_at_most_messages_remove_one", { p0: MAX_QUEUED_TASK_MESSAGES }),
      );
      return;
    }
    if (snapshot.running || snapshot.interaction) {
      pendingQueueFailureSlots.current += 1;
      let failureSlotReserved = true;
      const releaseFailureSlot = () => {
        if (!failureSlotReserved) return;
        pendingQueueFailureSlots.current -= 1;
        failureSlotReserved = false;
      };
      const queuedId = `queued-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const createdAt = Date.now();
      clearSubmitted();
      messageQueue.enqueue({ id: queuedId, content: value, attachments: wireOutgoing, createdAt, staging: true });
      failedSubmissionStore.add({ id: queuedId, content: value, attachments: outgoing, createdAt, outcome: "failed", retrying: true, phase: "preparing" });
      try {
        await persistFailedSubmissions();
        assertCurrent();
        if (context.inputIntentRef.current.value === "") await onDraftChange?.(undefined);
        assertCurrent();
        if (!demo && wireOutgoing.length > 0) {
          await task.request(RETAIN_TASK_ATTACHMENTS, {
            paths: wireOutgoing.map((attachment) => attachment.path),
            threadId: snapshot.threadId,
          });
        }
        assertCurrent();
        if (!demo && !onQueueCommit)
          throw new Error(t("task.queued_message_save_unavailable"));
        await messageQueue.commitReady(queuedId, async (messages) => {
          assertCurrent();
          await onQueueCommit?.({ queuedMessages: messages, failedSubmissions: persistedFailedSubmissions(failedSubmissionStore.getSnapshot().filter((item) => item.id !== queuedId)) });
          assertCurrent();
          failedSubmissionStore.remove(queuedId);
        });
        releaseFailureSlot();
      } catch (error) {
        messageQueue.remove(queuedId);
        releaseFailureSlot();
        failedSubmissionStore.add({
          id: queuedId,
          content: value,
          attachments: outgoing.filter((attachment) => !context.removedPendingAttachments.current.has(attachment.path)),
          createdAt,
          outcome: "failed",
          retrying: false,
          error: error instanceof Error ? error.message : String(error),
        });
        try {
          await persistFailedSubmissions();
        } catch {
          // The prior persisted projection may still own removed paths. Keep
          // those references conservatively until a local save can confirm removal.
          failedSubmissionStore.update(queuedId, (item) => ({ ...item, attachments: outgoing, outcome: "unknown" }));
        }
        if (isCurrent()) setQueueError(
          t("task.could_not_save_the_queued_message", { p0: error instanceof Error ? error.message : String(error) }),
        );
        return;
      }
      outgoing.forEach(releaseLocalAttachmentPreview);
      if (isCurrent()) setQueueError(null);
      return;
    }
    clearSubmitted();
    const clientMessageId = newComposerMessageId();
    const createdAt = Date.now();
    failedSubmissionStore.add({
      id: clientMessageId,
      content: value,
      attachments: outgoing,
      createdAt,
      outcome: "failed",
      retrying: true,
      phase: "preparing",
    });
    let turnDispatched = false;
    try {
      await Promise.all([
        context.inputIntentRef.current.value === "" ? onDraftChange?.(undefined) : undefined,
        persistFailedSubmissions(),
      ]);
      assertCurrent();
      failedSubmissionStore.update(clientMessageId, (item) => ({ ...item, phase: "retaining" }));
      if (!demo && wireOutgoing.length > 0) {
        await task.request(RETAIN_TASK_ATTACHMENTS, {
          paths: wireOutgoing.map((attachment) => attachment.path),
          threadId: snapshot.threadId,
        });
      }
      assertCurrent();
      failedSubmissionStore.update(clientMessageId, (item) => ({
        ...item,
        outcome: "unknown",
        retrying: true,
        error: undefined,
      }));
      await persistFailedSubmissions();
      assertCurrent();
      failedSubmissionStore.update(clientMessageId, (item) => ({ ...item, phase: "sending" }));
      turnDispatched = true;
      await task.send(value, wireOutgoing, undefined, { clientMessageId });
      if (task.getSnapshot().sendAcceptanceUnknown) {
        failedSubmissionStore.update(clientMessageId, (item) => ({
          ...item,
          retrying: false,
          error: task.getSnapshot().error ?? undefined,
        }));
        await persistFailedSubmissions();
        return;
      }
      await removeFailedSubmission(clientMessageId, false);
    } catch (error) {
      const unknownAcceptance = task.getSnapshot().sendAcceptanceUnknown;
      const definitelyNotSent =
        error instanceof MobileRpcError && error.delivery === "not-sent";
      const unknown = turnDispatched &&
        (unknownAcceptance || (task.isDisposed() && !definitelyNotSent));
      failedSubmissionStore.update(clientMessageId, (item) => ({
        ...item,
        outcome: unknown ? "unknown" : "failed",
        retrying: false,
        error: !turnDispatched && outgoing.length > 0
          ? attachmentPreparationError(error)
          : error instanceof Error ? error.message : String(error),
      }));
      try {
        await persistFailedSubmissions();
      } catch {
        // The in-memory card remains available for recovery in this runtime.
      }
    }
    } finally {
      pending.current.delete(draftKey);
      for (const attachment of outgoing) {
        const counts = context.pendingAttachmentSubmissions.current;
        const remaining = (counts.get(attachment.path) ?? 1) - 1;
        if (remaining > 0) { counts.set(attachment.path, remaining); continue; }
        counts.delete(attachment.path);
        const removed = context.removedPendingAttachments.current.delete(attachment.path);
        const retained = messageQueue.getSnapshot().some((item) => item.attachments.some((ref) => ref.path === attachment.path)) ||
          failedSubmissionStore.getSnapshot().some((item) => item.attachments.some((ref) => ref.path === attachment.path));
        if (retained || (!removed && isCurrent())) continue;
        releaseLocalAttachmentPreview(attachment);
        if (!demo && !task.isDisposed()) void task.request("attachment/delete", { path: attachment.path }).catch(() => {});
      }
      if (isCurrent()) refreshPending((current) => current + 1);
    }

  };

  const canSend =
    snapshot.connected &&
    !pending.current.has(draftKey) &&
    snapshot.configurationReady !== false &&
    !snapshot.sendAcceptanceUnknown &&
    !failedSubmissionItems.some(blocksSubmission) &&
    (Boolean(input.trim()) || attachments.length > 0);

  const assertDispatchReady = () => {
    requireOwner();
    const live = task.getSnapshot();
    if (live.sendAcceptanceUnknown || live.configurationReady === false ||
        live.connected === false || live.running || live.interaction || live.archivedAt)
      throw new MobileRpcError(
        t("task.task_state_changed_message_not_dispatched"),
        -1,
        "transport",
        "not-sent",
      );
  };
  const retainForDispatch = async (items: readonly ComposerStagedAttachment[]) => {
    assertDispatchReady();
    if (!demo && items.length > 0) {
      await task.request(RETAIN_TASK_ATTACHMENTS, {
        threadId: snapshot.threadId,
        paths: items.map((item) => item.path),
      });
      assertDispatchReady();
    }
  };
  const attachmentPreparationError = (error: unknown): string =>
    error instanceof MobileRpcError && error.reason === "remote" && error.code === -32048
      ? t("task.attachment_invalid_retry_manually")
      : t("task.attachment_preparation_unconfirmed");

  const retryFailedSubmission = async (id: string) => {
    const failed = failedSubmissionStore.find(id);
    if (
      !ownerCurrent() ||
      !failed ||
      failed.retrying ||
      failed.outcome === "unknown" ||
      !snapshot.connected ||
      snapshot.configurationReady === false ||
      snapshot.running ||
      snapshot.interaction ||
      snapshot.archivedAt ||
      snapshot.sendAcceptanceUnknown
    )
      return;
    failedSubmissionStore.update(id, (item) => ({
      ...item,
      outcome: "failed",
      retrying: true,
      phase: "retaining",
      error: undefined,
    }));
    let dispatched = false;
    try {
      await persistFailedSubmissions();
      assertDispatchReady();
      const wireAttachments = failed.attachments.map(wireAttachment);
      await retainForDispatch(wireAttachments);
      assertDispatchReady();
      failedSubmissionStore.update(id, (item) => ({ ...item, outcome: "unknown", phase: "sending" }));
      await persistFailedSubmissions();
      assertDispatchReady();
      dispatched = true;
      await task.send(failed.content, wireAttachments, undefined, {
        clientMessageId: failed.id,
      });
      if (task.getSnapshot().sendAcceptanceUnknown) {
        failedSubmissionStore.update(id, (item) => ({
          ...item,
          outcome: "unknown",
          retrying: false,
          error: task.getSnapshot().error ?? undefined,
        }));
        await persistFailedSubmissions();
        return;
      }
      await removeFailedSubmission(id, false);
    } catch (error) {
      const unknownAcceptance = task.getSnapshot().sendAcceptanceUnknown;
      const definitelyNotSent =
        error instanceof MobileRpcError && error.delivery === "not-sent";
      const unknown = dispatched &&
        (unknownAcceptance || (task.isDisposed() && !definitelyNotSent));
      failedSubmissionStore.update(id, (item) => ({
        ...item,
        outcome: unknown ? "unknown" : "failed",
        retrying: false,
        phase: dispatched ? "sending" : "retaining",
        error: !dispatched && failed.attachments.length > 0
          ? attachmentPreparationError(error)
          : error instanceof Error ? error.message : String(error),
      }));
      try {
        await persistFailedSubmissions();
      } catch {
        // Keep the visible item if workspace storage is unavailable.
      }
    }
  };

  const checkFailedSubmission = async (id: string) => {
    const failed = failedSubmissionStore.find(id);
    if (!ownerCurrent() || !failed || failed.outcome !== "unknown" || failed.retrying) return;
    failedSubmissionStore.update(id, (item) => ({ ...item, retrying: true }));
    try {
      const client = await task.acceptanceClient();
      requireOwner();
      await readTurnReceipt(client, {
        threadId: snapshot.threadId,
        clientMessageId: failed.id,
      });
      requireOwner();
      if (
        task.getSnapshot().sendAcceptanceUnknown &&
        task.uncertainSend?.clientMessageId === failed.id
      ) {
        await task.reconcileSendAcceptance();
      }
      await removeFailedSubmission(id, false);
    } catch (error) {
      failedSubmissionStore.update(id, (item) => ({
        ...item,
        outcome: "unknown",
        retrying: false,
        error:
          error instanceof Error
            ? error.message
            : t("task.execution_receipt_not_confirmed"),
      }));
      try {
        await persistFailedSubmissions();
      } catch {
        // The uncertain record remains visible in memory.
      }
    }
  };

  const dismissFailedSubmission = (id: string) => {
    const failed = failedSubmissionStore.find(id);
    if (!ownerCurrent() || !failed || failed.retrying) return;
    void removeFailedSubmission(id, failed.outcome === "failed");
  };

  const removeFailedSubmissionAttachment = (id: string, path: string) => {
    const failed = failedSubmissionStore.find(id);
    if (!ownerCurrent() || !failed || failed.outcome === "unknown" || failed.retrying) return;
    const removed = failed.attachments.find((item) => item.path === path);
    if (!removed) return;
    const remainingAttachments = failed.attachments.filter(
      (attachment) => attachment.path !== path,
    );
    if (!failed.content.trim() && remainingAttachments.length === 0) {
      failedSubmissionStore.remove(id);
    } else {
      failedSubmissionStore.update(id, (item) => ({
        ...item,
        attachments: remainingAttachments,
      }));
    }
    releaseLocalAttachmentPreview(removed);
    void persistFailedSubmissions()
      .then(() => {
        if (ownerCurrent() && !demo)
          void task.request("attachment/delete", { path }).catch(() => {});
      })
      .catch(() => {});
  };

  useEffect(() => {
    if (
      !snapshot.connected ||
      snapshot.configurationReady === false ||
      snapshot.running ||
      snapshot.interaction ||
      snapshot.sendAcceptanceUnknown ||
      failedSubmissionItems.some(
        (item) => item.outcome === "unknown" || item.retrying,
      ) ||
      snapshot.archivedAt ||
      sendingQueued.current ||
      queuedMessages.length === 0
    )
      return;
    const next = messageQueue.first();
    if (!next) return;
    sendingQueued.current = true;
    setQueueError(null);
    let dispatched = false;
    const queuedCurrent = () => messageQueue.getSnapshot().some((item) => item.id === next.id && !item.staging);
    void (async () => {
      if (!queuedCurrent()) return;
      await retainForDispatch(next.attachments);
      if (!queuedCurrent()) return;
      assertDispatchReady();
      dispatched = true;
      await task.send(next.content, next.attachments, undefined, { clientMessageId: next.id });
      if (!ownerCurrent() || task.getSnapshot().sendAcceptanceUnknown) return;
      messageQueue.remove(next.id);
    })()
      .catch((value) => {
        if (!ownerCurrent() || !queuedCurrent()) return;
        setQueueError(!dispatched && next.attachments.length > 0
          ? attachmentPreparationError(value)
          : t("task.could_not_send_the_queued_message", { p0: value instanceof Error ? value.message : String(value) }));
      })
      .finally(() => {
        sendingQueued.current = false;
      });
  }, [
    messageQueue,
    queuedMessages,
    snapshot.archivedAt,
    snapshot.connected,
    snapshot.configurationReady,
    snapshot.interaction,
    snapshot.running,
    snapshot.sendAcceptanceUnknown,
    failedSubmissionItems,
    task,
  ]);

  const removeQueuedMessage = (id: string) => {
    if (!ownerCurrent()) return;
    if (messageQueue.getSnapshot().find((item) => item.id === id)?.staging) return;
    const removed = messageQueue.remove(id);
    if (!removed || demo) return;
    for (const attachment of removed.attachments) {
      void task
        .request("attachment/delete", { path: attachment.path })
        .catch(() => {});
    }
  };
  return {
    ...context,
    submit,
    canSend,
    removeQueuedMessage,
    failedSubmissions: failedSubmissionItems.filter((item) => !queuedMessages.some((queued) => queued.id === item.id && queued.staging)),
    retryFailedSubmission,
    checkFailedSubmission,
    dismissFailedSubmission,
    removeFailedSubmissionAttachment,
  };
}
