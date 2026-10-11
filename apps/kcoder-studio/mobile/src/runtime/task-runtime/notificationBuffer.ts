import { GatewayRpcClient, type RpcMessage } from "@/gateway/rpc";
import { type BufferedSubscription } from "./types";

export function bufferNotifications(
  client: GatewayRpcClient,
): BufferedSubscription {
  const messages: RpcMessage[] = [];
  let target: ((message: RpcMessage) => void) | null = null;
  let cancelled = false;
  let overflowed = false;
  let bufferedBytes = 0;
  const unsubscribe = client.subscribe((message) => {
    if (cancelled) return;
    if (target) target(message);
    else if (!overflowed) {
      const bytes = JSON.stringify(message).length * 2;
      if (messages.length >= 512 || bufferedBytes + bytes > 2 * 1024 * 1024) {
        overflowed = true;
        messages.length = 0;
        bufferedBytes = 0;
      } else {
        messages.push(message);
        bufferedBytes += bytes;
      }
    }
  });
  return {
    activate(listener) {
      if (overflowed) {
        cancelled = true;
        unsubscribe();
        throw new Error("会话更新超过缓存上限，请重新连接以读取完整记录。");
      }
      target = listener;
      // Replay is synchronous, so new notifications cannot overtake cached notifications.
      for (const message of messages.splice(0)) listener(message);
      bufferedBytes = 0;
      return unsubscribe;
    },
    cancel() {
      cancelled = true;
      messages.length = 0;
      unsubscribe();
    },
  };
}
