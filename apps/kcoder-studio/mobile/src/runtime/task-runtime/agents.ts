/** Uses negotiated target capabilities and existing TaskRuntime ownership; no secondary executor. */
import type { JsonRecord } from "@/gateway/rpc";
import type { TaskRuntime } from "./core";
import type { AgentListResult, AgentSummary } from "./types";

export interface AgentPage {
  threadId: string;
  agentId: string;
  content: string;
  revision?: string | number | null;
  offset?: number;
  nextOffset?: number;
  truncated?: boolean;
  unchanged?: boolean;
  active?: boolean;
}
export interface AgentCommandReceipt {
  clientMessageId: string;
  messageId: string;
  status: string;
  acceptedAtMs: number;
  appliedAtMs?: number;
}
export interface AgentCommands {
  threadId: string;
  agentId: string;
  receiptEpoch: number;
  receipts: AgentCommandReceipt[];
  retainedCount: number;
  retainedLimit: number;
}
export interface AgentCommandLookup {
  threadId: string;
  agentId: string;
  clientMessageId: string;
  receiptEpoch: number;
  receipt?: AgentCommandReceipt | null;
}

export function agentCapabilities(this: TaskRuntime) {
  const has = (name: string) =>
    this.client?.supportsExperimental(name) === true;
  return {
    discover: has("agentArtifactsV1") || has("agentArtifactPagesV1"),
    live: has("agentLiveViewV1"),
    pages: has("agentArtifactPagesV1"),
    commands: has("agentCommandReceiptsV1") && has("agentSteering"),
    stop: has("agentStopV1"),
  };
}

async function scoped<T extends { threadId: string; agentId?: string }>(
  task: TaskRuntime,
  method: string,
  params: JsonRecord,
): Promise<T> {
  const client = task.client,
    generation = task.clientGeneration,
    threadId = task.snapshot.threadId;
  if (!client || !task.snapshot.connected || task.disposed)
    throw new Error("会话尚未连接");
  const result = await task.request<T>(method, { ...params, threadId });
  if (
    task.client !== client ||
    task.clientGeneration !== generation ||
    task.disposed ||
    result.threadId !== threadId ||
    (params.agentId && result.agentId !== params.agentId)
  )
    throw new Error("代理数据已失效，请刷新");
  return result;
}

export function listSubagents(this: TaskRuntime): Promise<AgentListResult> {
  if (!this.agentCapabilities().discover)
    return Promise.reject(new Error("此目标暂不支持查看子代理"));
  return scoped(this, "agent/list", {});
}

export function readSubagent(
  this: TaskRuntime,
  agent: AgentSummary,
  options?: { history?: boolean; offset?: number; revision?: string },
): Promise<AgentPage> {
  if (options === undefined) options = {};
  const capabilities = this.agentCapabilities();
  if (!capabilities.discover)
    return Promise.reject(new Error("此目标暂不支持代理记录"));
  if (!options.history && agent.status === "running" && capabilities.live)
    return scoped(this, "agent/live/read", { agentId: agent.agentId });
  const modern = capabilities.pages;
  return scoped(this, "agent/artifact/read", {
    agentId: agent.agentId,
    kind: modern ? "transcript" : "output",
    ...(modern
      ? {
          limit: 32768,
          ...(options.history
            ? {
                offset: options.offset ?? 0,
                ...(options.revision ? { revision: options.revision } : {}),
              }
            : { tail: true }),
        }
      : {}),
  });
}

export function readSubagentCommands(
  this: TaskRuntime,
  agentId: string,
): Promise<AgentCommands> {
  if (!this.agentCapabilities().commands)
    return Promise.reject(new Error("此目标不支持可靠指令回执"));
  return scoped(this, "agent/messages/list", { agentId, offset: 0, limit: 32 });
}

export function readSubagentCommand(
  this: TaskRuntime,
  agentId: string,
  clientMessageId: string,
): Promise<AgentCommandLookup> {
  if (!this.agentCapabilities().commands)
    return Promise.reject(new Error("此目标不支持查询指令状态"));
  return scoped<AgentCommandLookup>(this, "agent/message/read", {
    agentId,
    clientMessageId,
  }).then((result) => {
    if (result.clientMessageId !== clientMessageId)
      throw new Error("指令回执身份不匹配");
    return result;
  });
}

export function stopSubagent(
  this: TaskRuntime,
  agent: AgentSummary,
): Promise<{
  threadId: string;
  agentId: string;
  stopped: boolean;
  status: string;
}> {
  if (
    !this.agentCapabilities().stop ||
    agent.presentation?.canStop !== true ||
    !agent.backgroundRun
  )
    return Promise.reject(new Error("此代理不支持独立停止"));
  return scoped(this, "agent/stop", {
    agentId: agent.agentId,
    expectedBackgroundRun: agent.backgroundRun,
  });
}
