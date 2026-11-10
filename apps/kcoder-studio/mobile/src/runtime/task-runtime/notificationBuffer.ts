import { GatewayRpcClient, type RpcMessage } from "@/gateway/rpc";
import { type BufferedSubscription } from "./types";
import { hasConflictingTurnIdentity } from "../../../../shared/turnNotificationIdentity";

function notificationReplayKey(message: RpcMessage): string {
  // JSON object members are unordered. Keep arrays and every scalar unchanged,
  // including selection order and answer whitespace in the durable payload.
  return JSON.stringify(message, (_key, value) =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]]))
      : value);
}

export function bufferNotifications(
  client: GatewayRpcClient,
): BufferedSubscription {
  const messages: RpcMessage[] = [];
  const replayKeys = new Set<string>();
  let target: ((message: RpcMessage) => void) | null = null;
  let cancelled = false;
  let overflowed = false;
  let bufferedBytes = 0;
  const unsubscribe = client.subscribe((message) => {
    if (cancelled) return;
    if (hasConflictingTurnIdentity(message)) return;
    // Invalid envelopes and foreign producers cannot reserve recovery capacity
    // before the runtime gets a chance to reject their input/terminal binding.
    if (["asyncQuestion/changed", "question/resolved", "approval/resolved", "turn/started", "turn/completed"].includes(message.method ?? "") &&
        (message.id !== undefined || (message.params?.serverId !== undefined &&
          message.params.serverId !== client.getAppServerId()))) return;
    if (target) target(message);
    else if (!overflowed) {
      // Equivalent question snapshots and terminal receipts keep their first position.
      // Distinct snapshots and all other events still use the original limits.
      let replayKey: string | undefined;
      if (message.id == null && ["asyncQuestion/changed", "question/resolved", "approval/resolved"].includes(message.method ?? "")) {
        // Canonicalize only the incoming frame. Reserializing every retained
        // prompt for each replay stalls the JS thread during task recovery.
        replayKey = notificationReplayKey(message);
        if (replayKeys.has(replayKey)) return;
      }
      const serialized = JSON.stringify(message);
      const bytes = serialized.length * 2;
      if (messages.length >= 512 || bufferedBytes + bytes > 2 * 1024 * 1024) {
        overflowed = true;
        messages.length = 0;
        replayKeys.clear();
        bufferedBytes = 0;
      } else {
        messages.push(message);
        if (replayKey !== undefined) replayKeys.add(replayKey);
        bufferedBytes += bytes;
      }
    }
  });
  return {
    hasOverflowed: () => overflowed,
    activate(listener) {
      if (overflowed) {
        cancelled = true;
        unsubscribe();
        throw new Error("会话更新超过缓存上限，请重新连接以读取完整记录。");
      }
      target = listener;
      replayKeys.clear();
      // Replay is synchronous, so new notifications cannot overtake cached notifications.
      for (const message of messages.splice(0)) listener(message);
      bufferedBytes = 0;
      return unsubscribe;
    },
    cancel() {
      cancelled = true;
      messages.length = 0;
      replayKeys.clear();
      unsubscribe();
    },
  };
}
