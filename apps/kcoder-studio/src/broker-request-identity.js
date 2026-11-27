import { agentMessageMethod } from '../shared/agentMessageMethods.mjs';

// Pure JSON-RPC identity extraction shared by the workspace broker and its
// extracted mechanisms. These helpers never consult or mutate broker state.

export const TASK_COMPARISON_METHODS = new Set([
  "runtime.worktrees.comparison.bind", "runtime.worktrees.comparison.read", "runtime.worktrees.comparison.select",
]);

export function threadIdFrom(message) {
  const params = message?.params ?? message;
  if (!params || typeof params !== "object") return null;
  if (agentMessageMethod(message?.method)) return typeof params.sourceThreadId === 'string' ? params.sourceThreadId : null;
  if (TASK_COMPARISON_METHODS.has(message?.method)) {
    // Comparison threadId identifies candidate B; only ownerThreadId names the requesting runtime A.
    const owner = params.ownerThreadId;
    return typeof owner === "string" && owner.length > 0 && owner.length <= 512 && !/[\x00-\x1f\x7f]/.test(owner)
      ? owner : null;
  }
  return typeof params.threadId === "string"
    ? params.threadId
    : typeof params.thread_id === "string"
      ? params.thread_id
      : typeof params.thread?.threadId === "string"
        ? params.thread.threadId
        : typeof params.thread?.id === "string"
          ? params.thread.id
          : typeof params.widget?.threadId === "string"
            ? params.widget.threadId
          : null;
}

export function turnIdFrom(message) {
  const params = message?.params ?? message;
  if (!params || typeof params !== "object") return null;
  return typeof params.turnId === "string"
    ? params.turnId
    : typeof params.turn_id === "string"
      ? params.turn_id
      : typeof params.turn?.turnId === "string"
        ? params.turn.turnId
        : typeof params.turn?.id === "string"
          ? params.turn.id
          : null;
}

export function cloneWithId(message, id) {
  return { ...message, id };
}

export function terminalSessionIdFrom(message) {
  const params = message?.params ?? message;
  if (!params || typeof params !== "object") return null;
  const sessionId =
    params.session_id ?? params.terminalId ?? params.terminal?.id;
  return typeof sessionId === "string" ? sessionId : null;
}

export const THREAD_RESUME_CLAIM = Symbol("thread-resume-claim");

export function threadClaimOwner(claim) {
  return claim?.[THREAD_RESUME_CLAIM] === true ? claim.client : claim;
}
