import type { TaskRuntime } from "./core";
import type { ChatMessage, TaskSnapshot } from "./types";
import { record } from "./normalizers";
import { AgentConversationProjection, settleAgentConversationMessages, type AgentConversationSnapshot } from "./agent-conversation-projection";

export interface AgentConversationView { snapshot: TaskSnapshot; loading: boolean; error?: string; truncated?: boolean }

/** Connection-owned observation only. Closing never interrupts either Agent or replays a command. */
export function observeAgentConversation(task: TaskRuntime, agentId: string, publish: (view: AgentConversationView) => void,
  options: { isCurrent(): boolean; runId?: string; retainedMessages?: ChatMessage[] }) {
  const client = task.client;
  if (!client || !task.agentCapabilities().conversation) throw new Error("Subagent conversation stream unavailable");
  const threadId = task.snapshot.threadId, generation = task.clientGeneration;
  const projection = new AgentConversationProjection(task.snapshot, agentId);
  if (options.retainedMessages) projection.runtime.patch({ messages: settleAgentConversationMessages(options.retainedMessages) });
  let disposed = false, attempt = 0, failures = 0;
  let truncated = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let release: (() => void) | undefined;
  const current = () => !disposed && task.client === client && task.clientGeneration === generation &&
    task.snapshot.threadId === threadId && !task.isDisposed() && options.isCurrent();
  const emit = (loading: boolean, error?: string) => { if (current()) publish({ snapshot: projection.runtime.snapshot, loading, error, truncated }); };
  const restart = (error: string, immediate = false) => {
    if (!current()) return;
    attempt++;
    release?.(); release = undefined;
    projection.settle();
    emit(true, error);
    clearTimeout(timer);
    timer = setTimeout(subscribe, immediate ? 0 : Math.min(1000 * 2 ** failures++, 10000));
  };
  const subscribe = async () => {
    if (!current()) return;
    const request = ++attempt;
    const subscriptionId = `mobile-agent-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let ready = false, sequence = -1, floor = -1, runId = "", queuedBytes = 0;
    const queued: Array<{ method: string; params: Record<string, unknown> }> = [];
    const fingerprints = new Set<string>();
    const valid = (raw: Record<string, unknown>) => raw.threadId === threadId && raw.agentId === agentId && raw.subscriptionId === subscriptionId;
    const reset = (raw: Record<string, unknown>) => {
      if (!valid(raw) || !Number.isSafeInteger(raw.sequence) || Number(raw.sequence) < 0 ||
          typeof raw.runId !== "string" || !raw.runId || !Array.isArray(raw.messages)) throw new Error("Invalid subagent stream snapshot");
      if (raw.runId === runId && Number(raw.sequence) < sequence) return;
      if (options.runId && raw.runId !== options.runId) throw new Error("Subagent run changed");
      if (raw.messages.length > 1024 || JSON.stringify(raw.messages).length > 1024 * 1024) throw new Error("Subagent snapshot exceeds the observation window");
      projection.reset(raw as unknown as AgentConversationSnapshot);
      truncated = raw.truncated === true;
      sequence = Number(raw.sequence); floor = sequence; runId = raw.runId; fingerprints.clear();
    };
    const deliver = (method: string, raw: Record<string, unknown>) => {
      if (!current() || request !== attempt) return;
      try {
        if (method === "agent/stream/reset") { reset(raw); emit(false); return; }
        if (!Number.isSafeInteger(raw.sequence)) throw new Error("Invalid subagent stream cursor");
        if (raw.runId !== runId || Number(raw.sequence) > sequence + 1) { restart("Subagent stream sequence changed", true); return; }
        if (Number(raw.sequence) <= floor || Number(raw.sequence) < sequence) return;
        const key = JSON.stringify([raw.sequence, raw.method, raw.params]);
        if (fingerprints.has(key)) return;
        if (Number(raw.sequence) > sequence) fingerprints.clear();
        // One Engine event can project several distinct item notifications at the same cursor.
        if (fingerprints.size >= 2048 || key.length > 1024 * 1024) throw new Error("Subagent frame budget exceeded");
        fingerprints.add(key); sequence = Number(raw.sequence);
        projection.event(String(raw.method), record(raw.params), typeof raw.occurredAtMs === "number" ? raw.occurredAtMs : undefined);
        if (projection.runtime.snapshot.messages.length > 1024 || JSON.stringify(projection.runtime.snapshot.messages).length > 1024 * 1024) {
          restart("Subagent transcript window refreshed", true); return;
        }
        emit(false);
      } catch (error) { restart(error instanceof Error ? error.message : String(error)); }
    };
    const unlisten = client.subscribe(message => {
      if (!current() || request !== attempt) return;
      if (message.method === "connection/closed") { restart("Subagent connection closed"); return; }
      if (message.method !== "agent/stream/event" && message.method !== "agent/stream/reset") return;
      const raw = record(message.params);
      if (!valid(raw)) return;
      if (ready) deliver(message.method, raw);
      else {
        queuedBytes += JSON.stringify(raw).length;
        if (queued.length >= 2048 || queuedBytes > 1024 * 1024) restart("Subagent stream buffer exceeded", true);
        else queued.push({ method: message.method, params: raw });
      }
    });
    let released = false;
    const unsubscribe = () => { void client.request("agent/stream/unsubscribe", { subscriptionId }).catch(() => {}); };
    release = () => { if (!released) { released = true; unlisten(); queued.length = 0; unsubscribe(); } };
    emit(true);
    try {
      const raw = await client.request<Record<string, unknown>>("agent/stream/subscribe", { threadId, agentId, subscriptionId });
      if (!current() || request !== attempt) { unsubscribe(); return; }
      reset(raw); ready = true; failures = 0; emit(false);
      for (const frame of queued.splice(0)) deliver(frame.method, frame.params);
    } catch (error) {
      if (current() && request === attempt) restart(error instanceof Error ? error.message : String(error));
    }
  };
  timer = setTimeout(subscribe, 0);
  return () => { disposed = true; attempt++; clearTimeout(timer); release?.(); projection.close(); };
}
