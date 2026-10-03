import { type RpcMessage } from "@/gateway/rpc";
import { decodeProviderFailure } from "../../../../shared/providerFailure";
import { TaskRuntime } from "./core";
import { fileChangesFromValue, record, text, turnIdFrom } from "./normalizers";

export function handleRpc(this: TaskRuntime, message: RpcMessage): void {
  const params = record(message.params);
  if (
    message.id == null &&
    !this.notificationReplayGuard.accept(message.method ?? "", params)
  )
    return;
  try {
    this.handleAcceptedRpc(message);
  } catch (error) {
    this.notificationReplayGuard.release(message.method ?? "", params);
    throw error;
  }
}

export function handleAcceptedRpc(
  this: TaskRuntime,
  message: RpcMessage,
): void {
  const params = record(message.params);
  for (const listener of this.protocolListeners) listener(message);
  if (message.method === "connection/closed") {
    this.scheduleReconnect(text(params.reason) ?? "连接已断开");
    return;
  }
  if (typeof message.id === "number" && message.method === "approval/request") {
    this.enqueueInteraction({
      kind: "approval",
      requestId: message.id,
      approvalId: text(params.approvalId) ?? String(message.id),
      reason: text(params.reason) ?? "KCoder 请求执行此操作",
      action: record(params.action),
      availableDecisions: Array.isArray(params.availableDecisions)
        ? params.availableDecisions.filter(
            (
              value,
            ): value is
              "accept" | "accept_for_session" | "decline" | "cancel" =>
              value === "accept" ||
              value === "accept_for_session" ||
              value === "decline" ||
              value === "cancel",
          )
        : undefined,
    });
    return;
  }
  if (typeof message.id === "number" && message.method === "question/request") {
    const questions = Array.isArray(params.questions) ? params.questions : [];
    this.enqueueInteraction({
      kind: "question",
      requestId: message.id,
      questionId: text(params.questionId) ?? String(message.id),
      questions: questions.map((value, index) => {
        const question = record(value);
        return {
          id: text(question.id) ?? `question-${index + 1}`,
          header: text(question.header) ?? "问题",
          prompt: text(question.prompt) ?? "请选择",
          options: (Array.isArray(question.options)
            ? question.options
            : []
          ).map((option) => {
            const item = record(option);
            return {
              label: text(item.label) ?? text(item.value) ?? "选项",
              value: text(item.value) ?? text(item.label) ?? "",
              description: text(item.description),
            };
          }),
          allowsFreeform: question.allowsFreeform !== false,
          multiSelect: question.multiSelect === true,
        };
      }),
    });
    return;
  }
  if (
    message.method === "approval/resolved" ||
    message.method === "question/resolved"
  ) {
    this.resolveInteraction(
      message.method === "approval/resolved" ? "approval" : "question",
      params,
    );
    return;
  }
  if (message.method === "thread/goal/continuation" && text(params.reason)) {
    this.patch({ error: text(params.reason) });
    return;
  }
  if (message.method === "turn/started") {
    this.flushPendingDeltas();
    const turnId = turnIdFrom(message);
    const attemptId =
      text(params.attemptId) ?? text(record(params.turn).attemptId) ?? turnId;
    this.attemptByTurn.set(turnId, attemptId);
    if (Number.isSafeInteger(params.sequence))
      this.attemptSequence.set(turnId, Number(params.sequence));
    if (this.attemptByTurn.size > 256) {
      const first = this.attemptByTurn.keys().next().value!;
      this.attemptByTurn.delete(first);
      this.attemptSequence.delete(first);
    }
    const messages = this.snapshot.messages.map((item) =>
      item.role === "assistant" &&
      item.turnId === turnId &&
      item.status === "failed" &&
      !item.continuedByAttemptId &&
      (item.attemptId ?? turnId) !== attemptId
        ? { ...item, continuedByAttemptId: attemptId }
        : item,
    );
    this.patch({
      running: true,
      activeTurnId: turnId,
      messages,
      error: null,
      continuationUnknown: null,
    });
    return;
  }
  const eventTurn = turnIdFrom(message);
  const floor = this.attemptSequence.get(eventTurn);
  if (
    floor !== undefined &&
    Number.isSafeInteger(params.sequence) &&
    Number(params.sequence) < floor
  )
    return;
  if (message.method === "item/delta") {
    const delta = text(record(params.delta).text);
    if (!delta) return;
    this.appendAssistantDelta(turnIdFrom(message), delta);
    return;
  }
  if (message.method === "agent/steer/applied") {
    const agentId = text(params.agentId);
    const messageId = text(params.messageId);
    if (agentId && messageId) {
      this.updateSubagentSteer(
        agentId,
        "applied",
        messageId,
        text(params.clientMessageId),
      );
    }
    return;
  }
  if (message.method === "item/event") {
    const event = record(params.event);
    if (event.type === "assistant_thinking_delta") {
      const delta = text(event.text);
      if (delta) this.appendThinkingDelta(turnIdFrom(message), delta);
      return;
    }
    this.updateActivity(turnIdFrom(message), event);
    return;
  }
  if (message.method === "item/started") {
    this.flushPendingDeltas();
    const item = record(params.item);
    if (item.type === "toolCall") {
      if (text(item.name)?.toLowerCase() === "todowrite")
        this.updateTodos(turnIdFrom(message), item);
      else this.updateTool(turnIdFrom(message), item, false);
    }
    return;
  }
  if (message.method === "item/completed") {
    this.flushPendingDeltas();
    const item = record(params.item);
    if (
      item.type === "toolCall" &&
      text(item.name)?.toLowerCase() !== "todowrite"
    )
      this.updateTool(turnIdFrom(message), item, true);
    return;
  }
  if (message.method === "turn/completed") {
    const turnId = turnIdFrom(message);
    const turn = record(params.turn);
    const attemptId =
      text(turn.attemptId) ?? this.attemptByTurn.get(turnId) ?? turnId;
    if (
      this.attemptByTurn.has(turnId) &&
      this.attemptByTurn.get(turnId) !== attemptId
    )
      return;
    this.flushPendingDeltas();
    this.attemptByTurn.set(turnId, attemptId);
    this.finishedAttempts.add(attemptId);
    if (this.finishedAttempts.size > 256)
      this.finishedAttempts.delete(
        this.finishedAttempts.values().next().value!,
      );
    const error = text(record(params.error).message);
    const providerFailure = decodeProviderFailure(record(params.error).details);
    const messages = [...this.snapshot.messages];
    const index = this.ensureAssistantMessage(messages, turnId);
    const status =
      ["interrupted", "cancelled"].includes(String(turn.status))
        ? "cancelled"
        : turn.status === "failed" || error
          ? "failed"
          : "completed";
    const fileChanges = fileChangesFromValue(
      params.fileChanges ?? params.file_changes,
    );
    messages[index] = {
      ...messages[index],
      status,
      attemptId,
      ...(status === "cancelled"
        ? { error: undefined, providerFailure: undefined }
        : { ...(providerFailure ? { providerFailure } : {}), ...(error ? { error } : {}) }),
      ...(fileChanges ? { fileChanges } : {}),
    };
    if (this.snapshot.activeTurnId && this.snapshot.activeTurnId !== turnId) {
      this.patch({ messages });
      return;
    }
    this.pendingInteractions = [];
    this.patch({
      messages,
      running: false,
      activeTurnId: null,
      interaction: null,
      interactionCount: 0,
      error: status === "cancelled" ? null : error ?? null,
    });
  }
}
