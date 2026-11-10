import type { AgentSteerResult, AgentSummary } from "@/runtime/task-runtime/types";

/** A closed live queue does not prevent the server from validating a continuation. */
export function subagentMessageAction(agent: Pick<AgentSummary, "status" | "acceptingMessages">): "send" | "continue" | null {
  if (agent.status === "completed" || agent.status === "failed") return "continue";
  if (["pending", "running", "paused"].includes(agent.status) && agent.acceptingMessages) return "send";
  return null;
}

/** Only an authoritative acceptance clears the draft; unfamiliar results remain reconcilable. */
export function subagentMessageDisposition(result: Pick<AgentSteerResult, "status" | "queued">): "accepted" | "rejected" | "unknown" {
  if (result.status === "applied" || (result.queued &&
      ["queued_live", "queued_paused", "queued_behind_blocked", "resuming"].includes(result.status))) return "accepted";
  if (["finishing", "cancelled", "closed", "rejected"].includes(result.status)) return "rejected";
  return "unknown";
}
