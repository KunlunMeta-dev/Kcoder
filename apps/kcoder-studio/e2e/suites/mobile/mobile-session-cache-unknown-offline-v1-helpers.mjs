export const COMPATIBILITY_ROOT_UNKNOWN_REASON = "compatibilityRootPresent";
export const THREAD_PRESENCE_READ_METHOD = "thread/presence/read";

/** Match only the typed Rust unknown response for this exact Browser request and thread. */
export function matchesExactCompatibilityRootUnknown(frame, { requestId, threadId } = {}) {
  if (!frame || typeof frame !== "object" || !frame.result || frame.error ||
      typeof requestId !== "string" || !requestId || typeof threadId !== "string" || !threadId) return false;
  const result = frame.result;
  return frame.jsonrpc === "2.0" && String(frame.id) === requestId &&
    result.status === "unknown" && result.reason === COMPATIBILITY_ROOT_UNKNOWN_REASON &&
    result.threadId === threadId;
}

/** Consume one injected response loss, scoped to the exact probe and typed Rust result. */
export function shouldWithholdExactCompatibilityRootUnknown(request, frame, fault) {
  if (!fault || fault.injected !== true || fault.consumed === true ||
      request?.method !== THREAD_PRESENCE_READ_METHOD ||
      typeof request?.id !== "string" || typeof request?.threadId !== "string" ||
      request.threadId !== fault.threadId ||
      !matchesExactCompatibilityRootUnknown(frame, { requestId: request.id, threadId: fault.threadId })) return false;
  fault.consumed = true;
  return true;
}
