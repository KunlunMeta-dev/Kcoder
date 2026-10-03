import { type JsonRecord } from "@/gateway/rpc";
import { TaskRuntime } from "./core";
import { text, todosFromInput } from "./normalizers";
import {
  type AgentSummary,
  type ChatMessage,
  type TaskActivityView,
  type TaskSnapshot,
  type ToolCallView,
} from "./types";

export function appendAssistantDelta(
  this: TaskRuntime,
  turnId: string,
  delta: string,
): void {
  const pending = this.pendingAssistantDeltas.get(turnId) ?? [];
  pending.push(delta);
  this.pendingAssistantDeltas.set(turnId, pending);
  this.scheduleDeltaFlush();
}

export function appendThinkingDelta(
  this: TaskRuntime,
  turnId: string,
  delta: string,
): void {
  const pending = this.pendingThinkingDeltas.get(turnId) ?? [];
  pending.push(delta);
  this.pendingThinkingDeltas.set(turnId, pending);
  this.scheduleDeltaFlush();
}

export function scheduleDeltaFlush(this: TaskRuntime): void {
  if (this.deltaFlushTimer || this.disposed) return;
  this.deltaFlushTimer = setTimeout(() => {
    this.deltaFlushTimer = null;
    this.flushPendingDeltas();
  }, 80);
}

export function flushPendingDeltas(this: TaskRuntime): void {
  if (this.deltaFlushTimer) clearTimeout(this.deltaFlushTimer);
  this.deltaFlushTimer = null;
  if (
    this.pendingAssistantDeltas.size === 0 &&
    this.pendingThinkingDeltas.size === 0
  )
    return;
  const messages = [...this.snapshot.messages];
  const turnIds = new Set([
    ...this.pendingAssistantDeltas.keys(),
    ...this.pendingThinkingDeltas.keys(),
  ]);
  for (const turnId of turnIds) {
    const index = this.ensureAssistantMessage(messages, turnId);
    const current = messages[index];
    const contentDelta =
      this.pendingAssistantDeltas.get(turnId)?.join("") ?? "";
    const thinkingDelta =
      this.pendingThinkingDeltas.get(turnId)?.join("") ?? "";
    messages[index] = {
      ...current,
      content: contentDelta ? current.content + contentDelta : current.content,
      thinking: thinkingDelta
        ? `${current.thinking ?? ""}${thinkingDelta}`
        : current.thinking,
    };
  }
  this.pendingAssistantDeltas.clear();
  this.pendingThinkingDeltas.clear();
  this.patch({ messages });
}

export function updateTool(
  this: TaskRuntime,
  turnId: string,
  item: JsonRecord,
  completed: boolean,
): void {
  const messages = [...this.snapshot.messages];
  const index = this.ensureAssistantMessage(messages, turnId);
  const current = messages[index];
  const tools = [...(current.tools ?? [])];
  const id = text(item.id) ?? `tool-${tools.length + 1}`;
  const toolIndex = tools.findIndex((tool) => tool.id === id);
  const existingTool = toolIndex >= 0 ? tools[toolIndex] : undefined;
  const tool: ToolCallView = {
    id,
    name: text(item.name) ?? existingTool?.name ?? "Tool",
    status: completed
      ? item.status === "failed"
        ? "failed"
        : "completed"
      : "running",
    input: item.input ?? existingTool?.input,
    output: item.output ?? existingTool?.output,
  };
  if (toolIndex >= 0) tools[toolIndex] = tool;
  else tools.push(tool);
  messages[index] = { ...current, tools };
  this.patch({ messages });
}

export function ensureAssistantMessage(
  this: TaskRuntime,
  messages: ChatMessage[],
  turnId: string,
): number {
  const attemptId = this.attemptByTurn.get(turnId);
  let index = messages.length - 1;
  while (
    index >= 0 &&
    !(
      messages[index].role === "assistant" &&
      messages[index].turnId === turnId &&
      (!attemptId ||
        (messages[index].attemptId ?? messages[index].turnId) === attemptId)
    )
  )
    index -= 1;
  if (index < 0) {
    messages.push({
      id: `assistant-${attemptId || turnId}`,
      turnId,
      ...(attemptId ? { attemptId } : {}),
      role: "assistant",
      content: "",
      timestampMs: Date.now(),
    });
    index = messages.length - 1;
  }
  return index;
}

export function updateTodos(
  this: TaskRuntime,
  turnId: string,
  item: JsonRecord,
): void {
  if (text(item.name)?.toLowerCase() !== "todowrite") return;
  const todos = todosFromInput(item.input);
  if (!todos) return;
  const messages = [...this.snapshot.messages];
  const index = this.ensureAssistantMessage(messages, turnId);
  messages[index] = { ...messages[index], todos };
  this.patch({ messages });
}

export function updateSubagentSteer(
  this: TaskRuntime,
  agentId: string,
  steerStatus: string,
  messageId?: string,
  clientMessageId?: string | null,
): void {
  const messages = [...this.snapshot.messages];
  let updated = false;
  for (let index = 0; index < messages.length; index += 1) {
    const activities = messages[index].activities;
    if (!activities?.some((activity) => activity.agentId === agentId)) continue;
    messages[index] = {
      ...messages[index],
      activities: activities.map((activity) =>
        activity.agentId === agentId
          ? {
              ...activity,
              steerStatus,
              steerMessageId: messageId ?? activity.steerMessageId,
              clientMessageId: clientMessageId ?? activity.clientMessageId,
            }
          : activity,
      ),
    };
    updated = true;
  }
  if (!updated) {
    const turnId = this.snapshot.activeTurnId ?? this.snapshot.threadId;
    const index = this.ensureAssistantMessage(messages, turnId);
    messages[index] = {
      ...messages[index],
      activities: [
        ...(messages[index].activities ?? []),
        {
          id: `background-${agentId}`,
          type: "activity",
          label: `子智能体 ${agentId}`,
          status: "running",
          agentId,
          steerStatus,
          steerMessageId: messageId,
          clientMessageId: clientMessageId ?? undefined,
        },
      ],
    };
  }
  this.patch({ messages });
}

export function applySubagentSnapshot(
  this: TaskRuntime,
  agents: AgentSummary[],
): void {
  const accepted = agents.filter((agent) =>
    this.notificationReplayGuard.canSeedBackgroundRun(
      agent.backgroundRun ?? {},
      agent.status,
    ),
  );
  const messages = [...this.snapshot.messages].map((message) => ({
    ...message,
    activities: message.activities?.map((activity) => {
      const agent = accepted.find(
        (agent) => agent.agentId === activity.agentId,
      );
      if (
        !agent ||
        !["completed", "failed", "cancelled", "halted", "paused"].includes(
          agent.status,
        )
      )
        return activity;
      const status: TaskActivityView["status"] =
        agent.status === "paused"
          ? "paused"
          : agent.status === "completed"
            ? "completed"
            : agent.status === "failed"
              ? "failed"
              : "cancelled";
      return { ...activity, status };
    }),
  }));
  const visibleAgents = accepted.filter(
    (agent) =>
      ["pending", "running", "paused"].includes(agent.status) ||
      agent.queueDepth > 0,
  );
  if (visibleAgents.length === 0) {
    this.patch({ messages });
    for (const agent of accepted)
      this.notificationReplayGuard.seedBackgroundRun(
        agent.backgroundRun ?? {},
        agent.status,
      );
    return;
  }
  const index = this.ensureAssistantMessage(messages, this.snapshot.threadId);
  const activities = [...(messages[index].activities ?? [])];
  for (const agent of visibleAgents) {
    if (
      !this.notificationReplayGuard.canSeedBackgroundRun(
        agent.backgroundRun ?? {},
        agent.status,
      )
    )
      continue;
    const id = `background-${agent.agentId}`;
    const steerStatus =
      agent.queueDepth === 0
        ? undefined
        : agent.headStatus === "blocked"
          ? "queued_behind_blocked"
          : agent.status === "paused"
            ? "queued_paused"
            : ["failed", "completed", "cancelled", "halted"].includes(
                  agent.status,
                )
              ? "resuming"
              : "queued_live";
    const activity: TaskActivityView = {
      id,
      type: "activity",
      label: agent.agentName?.trim() || `子智能体 ${agent.agentId}`,
      status: agent.status === "paused" ? "paused" : "running",
      agentId: agent.agentId,
      steerStatus,
      steerMessageId: agent.headMessageId,
    };
    const existing = activities.findIndex((item) => item.id === id);
    if (existing >= 0) activities[existing] = activity;
    else activities.push(activity);
  }
  messages[index] = { ...messages[index], activities };
  this.patch({ messages });
  for (const agent of accepted)
    this.notificationReplayGuard.seedBackgroundRun(
      agent.backgroundRun ?? {},
      agent.status,
    );
}

export function updateActivity(
  this: TaskRuntime,
  turnId: string,
  event: JsonRecord,
): void {
  const eventType = text(event.type);
  if (!eventType) return;
  const messages = [...this.snapshot.messages];
  const currentIndex = messages.findIndex(
    (message) => message.role === "assistant" && message.turnId === turnId,
  );
  const activities =
    currentIndex >= 0 ? [...(messages[currentIndex].activities ?? [])] : [];
  let activity: TaskActivityView | undefined;
  if (eventType.startsWith("background_job_")) {
    const jobId = text(event.id) ?? "unknown";
    const id = `background-${jobId}`;
    const existing = activities.find((item) => item.id === id);
    const current = Number(event.current);
    const total = Number(event.total);
    const progress =
      Number.isFinite(current) && Number.isFinite(total) && total > 0
        ? `${current} / ${total}`
        : undefined;
    if (eventType === "background_job_started")
      activity = {
        id,
        type: "activity",
        label: text(event.description) ?? "后台任务已启动",
        status: "running",
        agentId: jobId,
      };
    else if (eventType === "background_job_progress")
      activity = {
        id,
        type: "activity",
        label: text(event.message) ?? existing?.label ?? "后台任务运行中",
        detail: text(event.detail) ?? progress,
        status: "running",
        agentId: jobId,
      };
    else if (eventType === "background_job_paused")
      activity = {
        id,
        type: "activity",
        label: existing?.label ?? "后台任务已暂停",
        detail: text(event.reason),
        status: "paused",
        agentId: jobId,
      };
    else if (eventType === "background_job_completed")
      activity = {
        id,
        type: "activity",
        label: existing?.label ?? "后台任务已完成",
        detail: text(event.text),
        status: event.is_error === true ? "failed" : "completed",
        agentId: jobId,
      };
    else if (eventType === "background_job_failed")
      activity = {
        id,
        type: "activity",
        label: existing?.label ?? "后台任务失败",
        detail: text(event.error),
        status: "failed",
        agentId: jobId,
      };
    else if (
      eventType === "background_job_cancelled" ||
      eventType === "background_job_halted"
    )
      activity = {
        id,
        type: "cancelled",
        label: existing?.label ?? "后台任务已取消",
        detail: text(event.reason),
        status: "cancelled",
        agentId: jobId,
      };
  } else if (eventType === "system_notice") {
    const notice = text(event.text);
    if (notice && /compact/i.test(notice))
      activity = {
        id: `compaction-${activities.length}`,
        type: "compaction",
        label: "上下文已压缩",
        detail: notice,
        status: "completed",
      };
    else if (notice)
      activity = {
        id: `notice-${activities.length}`,
        type: "notice",
        label: notice,
        status: "completed",
      };
  } else if (eventType === "compaction_failed") {
    activity = {
      id: `compaction-${activities.length}`,
      type: "compaction",
      label: "上下文压缩失败",
      detail: text(event.error),
      status: "failed",
    };
  } else if (eventType === "stream_aborted") {
    const reason = text(event.reason) ?? "任务流已中止";
    const cancelled = /cancel/i.test(reason);
    activity = {
      id: `aborted-${activities.length}`,
      type: cancelled ? "cancelled" : "activity",
      label: cancelled ? "本轮已取消" : "任务流已中止",
      detail: reason,
      status: cancelled ? "cancelled" : "failed",
    };
  } else if (eventType === "error") {
    activity = {
      id: `error-${activities.length}`,
      type: "activity",
      label: "运行失败",
      detail: text(event.error),
      status: "failed",
    };
  } else if (eventType === "hook_message") {
    activity = {
      id: `hook-${activities.length}`,
      type: "activity",
      label: text(event.text) ?? "Hook 消息",
      status: event.is_error === true ? "failed" : "completed",
    };
  }
  if (!activity) return;
  const activityId = activity.id;
  const previousActivity = activities.find((item) => item.id === activityId);
  if (previousActivity) {
    activity = {
      ...activity,
      steerStatus: previousActivity.steerStatus,
      steerMessageId: previousActivity.steerMessageId,
      clientMessageId: previousActivity.clientMessageId,
    };
  }
  const index =
    currentIndex >= 0
      ? currentIndex
      : this.ensureAssistantMessage(messages, turnId);
  const existingIndex = activities.findIndex((item) => item.id === activityId);
  if (existingIndex >= 0) activities[existingIndex] = activity;
  else activities.push(activity);
  messages[index] = { ...messages[index], activities };
  this.patch({ messages });
}

export function patch(this: TaskRuntime, update: Partial<TaskSnapshot>): void {
  this.snapshot = { ...this.snapshot, ...update };
  for (const listener of this.listeners) listener();
}
