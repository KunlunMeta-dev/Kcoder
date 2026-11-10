import { TaskRuntime } from "./core";
import { normalizeMessage, record, text } from "./normalizers";
import type { ThreadMessage } from "@/gateway/types";
import type { ChatMessage, TaskSnapshot } from "./types";
import type { JsonRecord } from "@/gateway/rpc";

export interface AgentConversationSnapshot {
  threadId: string; agentId: string; subscriptionId: string; runId: string;
  sequence: number; active: boolean; status: string; messages: ThreadMessage[];
  activeAssistantItemId?: string | null; pendingEvents?: unknown[]; truncated?: boolean;
}

/** Retained history is readable, but cannot retain execution claims across an observation gap. */
export function settleAgentConversationMessages(messages: ChatMessage[]): ChatMessage[] {
  const settleTool = <T extends { status: string }>(tool: T): T => tool.status === "running" ? { ...tool, status: "unknown" } : tool;
  return messages.map(row => ({ ...row, status: row.status === "streaming" ? "interrupted" : row.status,
    tools: row.tools?.map(settleTool),
    orderedBlocks: row.orderedBlocks?.map(block => block.kind === "tool" ? settleTool(block) : block),
  }));
}

/** The ordinary Mobile normalizer/reducer renders child events without granting parent mutation authority. */
export class AgentConversationProjection {
  readonly runtime: TaskRuntime;
  private assistant = "";
  private toolOwners = new Map<string, string>();
  constructor(parent: TaskSnapshot, agentId: string) {
    this.runtime = TaskRuntime.transcriptProjection({ ...parent, threadId: agentId, messages: [],
      running: false, activeTurnId: null, hasMoreBefore: false, loadingOlder: false,
      error: null, interaction: null, interactionCount: 0, sendAcceptanceUnknown: false });
  }
  reset(raw: AgentConversationSnapshot) {
    this.toolOwners.clear();
    this.assistant = raw.activeAssistantItemId ?? raw.messages.filter(row => row.role === "assistant").at(-1)?.id ?? "";
    const messages = raw.messages.map(row => {
      if (!row.id || !["user", "assistant"].includes(row.role)) throw new Error("Invalid subagent message identity");
      const normalized = normalizeMessage({ ...row, status: raw.active && row.id === this.assistant ? "streaming" : row.status === "done" ? "completed" : row.status ?? "completed" });
      const terminalStatus = !raw.active && row.id === this.assistant
        ? raw.status === "failed" ? "failed" : ["cancelled", "halted", "interrupted"].includes(raw.status) ? "cancelled" : undefined
        : undefined;
      const message: ChatMessage = { ...row, ...normalized, turnId: row.id, attemptId: row.id,
        ...(terminalStatus ? { status: terminalStatus } : {}) };
      if (raw.active && row.id === this.assistant) {
        // Snapshot blocks precede every queued delta. Seed the current producer so
        // a resumed text/thinking run continues in place instead of adding a paragraph.
        message.orderedBlocks = message.orderedBlocks?.map((block, index, blocks) => ({ ...block,
          arrivalOrdinal: index - blocks.length,
          ...((block.kind === "text" || block.kind === "thinking") ? { endArrivalOrdinal: index - blocks.length } : {}),
          ...(block.kind === "text" ? { producerId: row.id } : {}),
        }));
      }
      for (const tool of message.tools ?? []) this.toolOwners.set(tool.id, row.id);
      return message;
    });
    this.runtime.flushPendingDeltas();
    this.runtime.attemptByTurn.clear();
    this.runtime.attemptSequence.clear();
    this.runtime.finishedAttempts.clear();
    this.runtime.transcriptArrivalOrdinal = 0;
    this.runtime.patch({ messages, connected: true, running: raw.active,
      activeTurnId: raw.active ? this.assistant : null, error: null });
    if (!raw.active) this.settle();
  }
  private ensureAssistant(id: string, timestampMs?: number) {
    if (!id) throw new Error("Missing subagent assistant item");
    if (!this.runtime.snapshot.messages.some(row => row.id === id))
      this.runtime.patch({ messages: [...this.runtime.snapshot.messages, { id, role: "assistant", content: "",
        turnId: id, attemptId: id, timestampMs: timestampMs ?? Date.now(), status: "streaming", orderedBlocks: [] }] });
    this.runtime.patch({ activeTurnId: id });
  }
  event(method: string, params: JsonRecord, occurredAtMs?: number) {
    if (!["item/started", "item/completed", "item/delta", "item/event", "turn/completed"].includes(method)) return;
    const item = record(params.item);
    if (method === "item/started" && item.type === "userMessage") {
      const raw = record(item.message);
      const id = text(item.id);
      if (!id) throw new Error("Missing subagent user item");
      if (!this.runtime.snapshot.messages.some(row => row.id === id)) this.runtime.patch({ messages: [
        ...this.runtime.snapshot.messages,
        { ...raw, id, role: "user", content: String(raw.content ?? item.text ?? ""),
          clientMessageId: text(item.clientMessageId), timestampMs: occurredAtMs ?? Date.now() },
      ] });
      return;
    }
    if (item.type === "agentMessage" && text(item.id)) this.assistant = String(item.id);
    if (method === "item/delta" && text(params.itemId)) this.assistant = String(params.itemId);
    const toolId = item.type === "toolCall" ? text(item.id) : undefined;
    const event = record(params.event);
    const owner = toolId ? this.toolOwners.get(toolId) ?? this.assistant
      : method === "item/delta" ? text(params.itemId) ?? this.assistant : this.assistant;
    if (toolId && owner) this.toolOwners.set(toolId, owner);
    if (!owner) return;
    this.ensureAssistant(owner, occurredAtMs);
    if (method === "item/event" && event.type === "tool_output_delta") {
      const id = text(event.id);
      const message = this.runtime.snapshot.messages.find(row => row.id === (this.toolOwners.get(id ?? "") ?? owner));
      const tool = message?.tools?.find(row => row.id === id);
      if (tool) this.runtime.updateTool(message!.id, { ...tool, output: `${tool.output ?? ""}${event.delta ?? event.text ?? ""}` }, false);
      return;
    }
    this.runtime.handleAcceptedRpc({ method, params: { ...params, threadId: this.runtime.snapshot.threadId, turnId: owner } });
    this.runtime.flushPendingDeltas();
    if (method === "item/completed" && item.type === "agentMessage") this.runtime.patch({ messages:
      this.runtime.snapshot.messages.map(row => row.id === owner ? { ...row, status: "completed" } : row) });
    if (method === "turn/completed") this.settle();
    else this.runtime.patch({ activeTurnId: this.assistant });
  }
  /** An observation gap/terminal event must stop live indicators without inventing tool success. */
  settle() {
    this.runtime.flushPendingDeltas();
    this.runtime.patch({ running: false, activeTurnId: null,
      messages: settleAgentConversationMessages(this.runtime.snapshot.messages) });
  }
  close() { this.runtime.close(); }
}
