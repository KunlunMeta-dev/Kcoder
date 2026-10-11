import {
  GatewayRpcClient,
  MobileRpcError,
  type JsonRecord,
} from "@/gateway/rpc";
import { negotiateModelSelector } from "../../../../shared/modelSelection";
import {
  readTurnReceipt,
  startTurnWithReceipt,
  type TurnStartResult,
} from "../../../../shared/turnReceipt";
import {
  nextOutgoingMessageSequence,
  outgoingMessageNamespace,
} from "./connectionFactory";
import { TaskRuntime } from "./core";
import { mergeReconciledMessages, readHistoryPage } from "./history";
import {
  type AgentSteerResult,
  type ChatMessage,
  type StagedAttachment,
  type TaskSendOptions,
} from "./types";

export function continuationState(
  this: TaskRuntime,
  messageId: string,
): { allowed: boolean; reason?: string; unknown: boolean } {
  const unknown = this.snapshot.continuationUnknown === messageId;
  const index = this.snapshot.messages.findIndex(
    (message) => message.id === messageId,
  );
  const message = this.snapshot.messages[index];
  if (
    !message ||
    message.status !== "failed" ||
    !message.turnId ||
    message.continuedByAttemptId
  )
    return {
      allowed: false,
      unknown,
      reason: "此记录已处理或没有可用恢复点。",
    };
  if (
    this.snapshot.messages
      .slice(index + 1)
      .some(
        (item) =>
          item.role === "user" ||
          (item.role === "assistant" && item.turnId !== message.turnId),
      )
  )
    return {
      allowed: false,
      unknown,
      reason: "后续会话已经发生变化，不能自动继续这条旧记录。",
    };
  if (this.snapshot.archivedAt)
    return { allowed: false, unknown, reason: "请先恢复已归档的任务。" };
  if (
    !this.client ||
    !this.client.supportsExperimental?.("failedTurnContinuationV1") ||
    !this.client.supportsExperimental?.("turnRetryOperationV1") ||
    !this.client.supportsExperimental?.("turnAttemptRetryV1")
  )
    return {
      allowed: false,
      unknown,
      reason: "目标不支持从失败处继续，请升级 KCoder；不会重新提交原消息。",
    };
  if (
    !this.snapshot.connected ||
    this.snapshot.running ||
    this.snapshot.continuationPending
  )
    return { allowed: false, unknown, reason: "请等待当前任务或连接恢复。" };
  return { allowed: true, unknown };
}

export function supportsCurrentConfigurationContinuation(
  this: TaskRuntime,
): boolean {
  return (
    this.client?.supportsExperimental?.("retryModelConfigurationV1") === true
  );
}

export async function continueFailed(
  this: TaskRuntime,
  messageId: string,
  useSelectedModel?: boolean,
): Promise<void> {
  if (useSelectedModel === undefined) useSelectedModel = false;
  const state = this.continuationState(messageId);
  if (!state.allowed) throw new Error(state.reason);
  if (
    useSelectedModel &&
    !state.unknown &&
    !this.supportsCurrentConfigurationContinuation()
  )
    throw new Error("目标不支持使用当前配置继续，请升级 KCoder。");
  const message = this.snapshot.messages.find((item) => item.id === messageId)!;
  if (
    useSelectedModel &&
    !state.unknown &&
    (!message.attemptId || !this.snapshot.model)
  )
    throw new Error("此记录缺少恢复身份或尚未选择模型，请刷新任务并选择模型。");
  const client = this.client!;
  const params: JsonRecord = {
    threadId: this.snapshot.threadId,
    input: [],
    retryFromTurnId: message.turnId,
    retryFromAttemptId: message.attemptId ?? message.turnId,
    retryOperationId: `retry:${this.snapshot.threadId}:${message.attemptId || message.turnId}`,
  };
  this.patch({ continuationPending: messageId, error: null });
  try {
    if (useSelectedModel && !state.unknown) {
      params.retryModelConfiguration = "current";
      const model = await negotiateModelSelector(client, this.snapshot.model);
      if (!model) throw new Error("请选择可用模型后再使用当前配置继续。");
      params.model = model;
      if (this.snapshot.reasoningEffort)
        params.reasoningEffort = this.snapshot.reasoningEffort;
    }
    const recoverClient = async () => {
      if (this.disposed) throw new Error("会话已关闭");
      if (this.client && this.snapshot.connected) return this.client;
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      await this.reconnect();
      if (!this.client || !this.snapshot.connected)
        throw new Error("连接尚未恢复");
      return this.client;
    };
    const submitted = state.unknown
      ? {
          client,
          result: await readTurnReceipt(client, params),
          recovered: true,
        }
      : await startTurnWithReceipt(client, params, recoverClient, {
          invalidReply: () =>
            new MobileRpcError("无效的执行接受回包", -1, "protocol"),
          ambiguous: (error) =>
            error instanceof MobileRpcError &&
            error.code === -1 &&
            error.reason !== "remote" &&
            error.delivery !== "not-sent",
          unknownOutcome: (cause) =>
            Object.assign(
              new Error("执行是否已接受仍未知。请核对状态，不要重复执行。", {
                cause,
              }),
              { acceptanceUnknown: true },
            ),
        });
    if (this.disposed) return;
    const turn = submitted.result.turn!;
    const attemptId =
      turn.attemptId ?? this.attemptByTurn.get(turn.id!) ?? turn.id!;
    this.attemptByTurn.set(turn.id!, attemptId);
    const finished =
      this.finishedAttempts.has(attemptId) ||
      (turn.status !== undefined && turn.status !== "running");
    this.patch({
      continuationUnknown: null,
      running: !finished,
      activeTurnId: finished ? null : turn.id!,
      messages: this.snapshot.messages.map((item) =>
        item.id === messageId
          ? { ...item, continuedByAttemptId: attemptId }
          : item,
      ),
    });
    // Recovered terminal replies have no live events to project. Read the real
    // attempts instead of synthesizing success or copying the user's input.
    if (submitted.recovered && finished) {
      const generation = this.clientGeneration;
      const history = await readHistoryPage(
        submitted.client,
        this.snapshot.threadId,
      );
      if (
        !this.disposed &&
        this.clientGeneration === generation &&
        !this.snapshot.running
      )
        this.patch({
          messages: mergeReconciledMessages(
            history.messages,
            this.snapshot.messages,
          ),
          hasMoreBefore: history.hasMoreBefore,
          beforeCursor: history.beforeCursor,
        });
    }
  } catch (error) {
    if (!this.disposed)
      this.patch({
        ...(state.unknown ||
        (typeof error === "object" && error && "acceptanceUnknown" in error)
          ? { continuationUnknown: messageId }
          : {}),
        error: error instanceof Error ? error.message : String(error),
      });
    throw error;
  } finally {
    if (!this.disposed) this.patch({ continuationPending: null });
  }
}

export async function acceptanceClient(
  this: TaskRuntime,
): Promise<GatewayRpcClient> {
  if (this.disposed) throw new Error("会话已关闭");
  if (this.client && this.snapshot.connected) return this.client;
  if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
  this.reconnectTimer = null;
  await this.reconnect();
  if (!this.client || !this.snapshot.connected) throw new Error("连接尚未恢复");
  return this.client;
}

export async function acceptOrdinaryResult(
  this: TaskRuntime,
  result: TurnStartResult,
  client: GatewayRpcClient,
  recovered: boolean,
  optimisticMessageId?: string,
): Promise<void> {
  if (this.disposed) return;
  const turn = result.turn!;
  const finished =
    this.finishedAttempts.has(turn.attemptId ?? turn.id!) ||
    (turn.status !== undefined && turn.status !== "running");
  this.uncertainSend = null;
  const messages = optimisticMessageId
    ? this.snapshot.messages.map((message) =>
        message.id === optimisticMessageId &&
        message.role === "user" &&
        (!message.turnId || message.turnId === turn.id)
          ? { ...message, turnId: turn.id! }
          : message,
      )
    : this.snapshot.messages;
  this.patch({
    messages,
    sendAcceptanceUnknown: false,
    error: null,
    activeTurnId: finished ? null : turn.id!,
    running: !finished,
  });
  if (recovered && finished) {
    const generation = this.clientGeneration;
    try {
      const history = await readHistoryPage(client, this.snapshot.threadId);
      if (
        !this.disposed &&
        this.clientGeneration === generation &&
        !this.snapshot.running
      )
        this.patch({
          messages: mergeReconciledMessages(
            history.messages,
            this.snapshot.messages,
          ),
          hasMoreBefore: history.hasMoreBefore,
          beforeCursor: history.beforeCursor,
        });
    } catch {
      if (!this.disposed && this.clientGeneration === generation)
        this.patch({
          error: "执行已确认，但完整记录读取失败，请重新连接以刷新记录。",
        });
    }
  }
}

function preflightNotSentError(error: unknown): MobileRpcError {
  if (error instanceof MobileRpcError)
    return new MobileRpcError(
      error.message,
      error.code,
      error.reason,
      "not-sent",
    );
  return new MobileRpcError(
    error instanceof Error ? error.message : String(error),
    -1,
    "transport",
    "not-sent",
  );
}

export async function startOrdinaryTurn(
  this: TaskRuntime,
  params: JsonRecord,
  optimisticMessageId?: string,
): Promise<TurnStartResult> {
  const clientMessageId =
    typeof params.clientMessageId === "string" &&
    params.clientMessageId.trim().length > 0
      ? params.clientMessageId
      : `mobile-${outgoingMessageNamespace}-${Date.now().toString(36)}-${nextOutgoingMessageSequence()}`;
  const request = {
    ...params,
    clientMessageId,
  };
  if (optimisticMessageId) {
    this.patch({
      messages: this.snapshot.messages.map((message) =>
        message.id === optimisticMessageId && message.role === "user"
          ? { ...message, clientMessageId }
          : message,
      ),
    });
  }
  try {
    let submitted: {
      client: GatewayRpcClient;
      result: TurnStartResult;
      recovered: boolean;
    };
    try {
      submitted = await startTurnWithReceipt(
        this.client!,
        request,
        () => this.acceptanceClient(),
        {
          invalidReply: () =>
            new MobileRpcError("无效的执行接受回包", -1, "protocol"),
          ambiguous: (error) =>
            error instanceof MobileRpcError &&
            error.reason !== "remote" &&
            error.delivery !== "not-sent",
          unknownOutcome: (cause) =>
            Object.assign(
              new Error(
                "发送是否已接受仍未知，请核对执行状态；不会重复提交消息。",
                { cause },
              ),
              { acceptanceUnknown: true },
            ),
        },
      );
    } catch (error) {
      const duplicateClientMessage =
        error instanceof MobileRpcError &&
        error.reason === "remote" &&
        error.code === -32047 &&
        typeof request.clientMessageId === "string" &&
        this.client?.supportsExperimental?.("turnReceiptsV1") === true;
      if (!duplicateClientMessage) throw error;
      try {
        const client = await this.acceptanceClient();
        submitted = {
          client,
          result: await readTurnReceipt(client, request),
          recovered: true,
        };
      } catch (cause) {
        throw Object.assign(
          new Error(
            "相同的发送身份已提交，但执行回执暂未确认；请核对状态，不会重复提交消息。",
            { cause },
          ),
          { acceptanceUnknown: true },
        );
      }
    }
    await this.acceptOrdinaryResult(
      submitted.result,
      submitted.client,
      submitted.recovered,
      optimisticMessageId,
    );
    return submitted.result;
  } catch (error) {
    if (
      typeof error === "object" &&
      error &&
      "acceptanceUnknown" in error &&
      !this.disposed
    ) {
      this.uncertainSend = request;
      this.patch({
        sendAcceptanceUnknown: true,
        running: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    throw error;
  }
}

export async function reconcileSendAcceptance(
  this: TaskRuntime,
): Promise<void> {
  if (!this.uncertainSend || this.snapshot.acceptanceChecking) return;
  const uncertainSend = this.uncertainSend;
  const clientMessageId = uncertainSend.clientMessageId;
  const optimisticMessageId =
    typeof clientMessageId === "string"
      ? this.snapshot.messages.find(
          (message) =>
            message.role === "user" &&
            messageClientMessageId(message) === clientMessageId,
        )?.id
      : undefined;
  this.patch({ acceptanceChecking: true });
  try {
    const client = await this.acceptanceClient();
    const result = await readTurnReceipt(client, uncertainSend);
    await this.acceptOrdinaryResult(
      result,
      client,
      true,
      optimisticMessageId,
    );
  } catch (error) {
    if (!this.disposed)
      this.patch({
        error: "执行状态尚未确认，请稍后再次核对；不会重复提交消息。",
      });
    throw error;
  } finally {
    if (!this.disposed) this.patch({ acceptanceChecking: false });
  }
}

function messageClientMessageId(message: ChatMessage): string | undefined {
  const value = (message as ChatMessage & { clientMessageId?: unknown })
    .clientMessageId;
  return typeof value === "string" && value.trim() ? value : undefined;
}

export async function send(
  this: TaskRuntime,
  content: string,
  attachments?: StagedAttachment[],
  turnMode?: "standard" | "moa" | "moa-plan",
  options?: TaskSendOptions,
): Promise<void> {
  if (attachments === undefined) attachments = [];
  if (options === undefined) options = {};
  const command = /^\/(moa-plan|moa)\s+([\s\S]+)$/.exec(content.trim());
  if (command) {
    turnMode = command[1] as "moa" | "moa-plan";
    content = command[2];
  }
  if (
    turnMode &&
    turnMode !== "standard" &&
    !this.client?.supportsExperimental?.("sessionModes")
  ) {
    throw new Error("目标 KCoder 不支持特殊执行模式，请升级后重试");
  }
  if (turnMode === "moa-plan" && attachments.length)
    throw new Error("MoA-plan 仅支持文字规划需求");
  const prompt =
    content.trim() || (attachments.length > 0 ? "请查看并分析附件。" : "");
  if (!prompt) return;
  if (this.snapshot.configurationReady === false) throw new Error("正在校验任务配置，请稍后发送");
  if (this.snapshot.sendAcceptanceUnknown)
    throw new Error("上次发送的执行状态尚未确认，请先核对执行状态。");
  if (this.snapshot.continuationUnknown)
    throw new Error("上次继续请求的执行状态尚未确认，请先核对执行状态。");
  if (this.disposed)
    throw new MobileRpcError(
      "会话已关闭，消息未发送",
      -1,
      "transport",
      "not-sent",
    );
  if (this.snapshot.running || this.snapshot.continuationPending)
    throw new Error("当前回合仍在运行，请将消息加入发送队列");
  if (this.snapshot.archivedAt)
    throw new Error("任务已归档，请先恢复后再发送消息");
  if (!this.client) {
    const user: ChatMessage = {
      id: `demo-user-${Date.now()}`,
      role: "user",
      content: prompt,
      timestampMs: Date.now(),
      attachments,
    };
    this.patch({
      messages: [...this.snapshot.messages, user],
      running: true,
    });
    setTimeout(() => {
      const assistant: ChatMessage = {
        id: `demo-assistant-${Date.now()}`,
        role: "assistant",
        content:
          "这是 Web 演示模式的模拟回复。连接真实 Gateway 后，这里会显示 KCoder app-server 的流式响应。",
        timestampMs: Date.now(),
      };
      this.patch({
        messages: [...this.snapshot.messages, assistant],
        running: false,
      });
    }, 650);
    return;
  }
  const user: ChatMessage = {
    id: `local-user-${Date.now()}`,
    role: "user",
    content: prompt,
    timestampMs: Date.now(),
    attachments,
  };
  this.pendingInteractions = [];
  this.patch({
    messages: [...this.snapshot.messages, user],
    running: true,
    interaction: null,
    error: null,
  });
  let enteredTurnStart = false;
  try {
    const wirePrompt =
      attachments.length > 0
        ? `${prompt}\n\n<kcoder_attachments version="1">\n${attachments
            .map((attachment) => JSON.stringify(attachment))
            .join("\n")}\n</kcoder_attachments>`
        : prompt;
    const wireModel = await negotiateModelSelector(
      this.client,
      this.snapshot.model,
    );
    if (this.disposed)
      throw new MobileRpcError(
        "会话已关闭，消息未发送",
        -1,
        "transport",
        "not-sent",
      );
    enteredTurnStart = true;
    await this.startOrdinaryTurn(
      {
        threadId: this.snapshot.threadId,
        input: [{ type: "text", text: wirePrompt }],
        ...(turnMode ? { turnMode } : {}),
        ...(wireModel ? { model: wireModel } : {}),
        ...(this.snapshot.reasoningEffort
          ? { reasoningEffort: this.snapshot.reasoningEffort }
          : {}),
        ...(options.clientMessageId
          ? { clientMessageId: options.clientMessageId }
          : {}),
      },
      user.id,
    );
  } catch (error) {
    if (this.snapshot.sendAcceptanceUnknown) return;
    const surfacedError =
      this.disposed && !enteredTurnStart
        ? preflightNotSentError(error)
        : error;
    this.patch({
      messages: this.snapshot.messages.filter(
        (message) => message.id !== user.id,
      ),
      running: false,
      error:
        surfacedError instanceof Error
          ? surfacedError.message
          : String(surfacedError),
    });
    throw surfacedError;
  }
}

export async function interrupt(this: TaskRuntime): Promise<void> {
  if (!this.client || !this.snapshot.activeTurnId) return;
  const turnId = this.snapshot.activeTurnId;
  if (this.snapshot.stopRequestedTurnId === turnId) return;
  this.patch({ stopRequestedTurnId: turnId, stopAcceptanceUnknown: false });
  try {
    await this.client.request("turn/interrupt", { threadId: this.snapshot.threadId, turnId });
  } catch (error) {
    if (this.snapshot.activeTurnId === turnId || this.snapshot.stopRequestedTurnId === turnId) {
      const definite = error instanceof MobileRpcError && (error.reason === "remote" || error.delivery === "not-sent");
      this.patch({ stopRequestedTurnId: definite ? undefined : turnId, stopAcceptanceUnknown: !definite });
    }
    throw error;
  }
}

export async function steerSubagent(
  this: TaskRuntime,
  agentId: string,
  message: string,
  clientMessageId?: string,
): Promise<AgentSteerResult> {
  if (clientMessageId === undefined)
    clientMessageId = `mobile-steer-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const normalizedAgentId = agentId.trim();
  const normalizedMessage = message.trim();
  if (!normalizedAgentId || !normalizedMessage)
    throw new Error("子智能体地址或调整消息不完整");
  if (new TextEncoder().encode(normalizedMessage).byteLength > 64 * 1024)
    throw new Error("子智能体调整消息超过 64 KiB 限制");
  if (!this.client || !this.snapshot.connected)
    throw new Error("KCoder app-server 尚未连接");
  if (!this.client.supportsExperimental("agentSteering"))
    throw new Error("当前 KCoder app-server 不支持定向调整子智能体");
  const client = this.client;
  const generation = this.clientGeneration;
  const threadId = this.snapshot.threadId;
  const result = await this.request<AgentSteerResult>("agent/steer", {
    threadId,
    agentId: normalizedAgentId,
    message: normalizedMessage,
    clientMessageId,
  });
  if (
    this.client !== client ||
    this.clientGeneration !== generation ||
    this.disposed ||
    this.snapshot.threadId !== threadId ||
    result.agentId !== normalizedAgentId ||
    result.clientMessageId !== clientMessageId ||
    typeof result.status !== "string"
  )
    throw new Error("指令回执身份不匹配或连接已失效，请查询原指令");
  this.updateSubagentSteer(
    normalizedAgentId,
    result.status,
    result.messageId,
    result.clientMessageId ?? clientMessageId,
  );
  return result;
}
