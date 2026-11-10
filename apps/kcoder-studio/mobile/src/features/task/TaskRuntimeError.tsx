import { t } from "@/i18n";
import type { TaskSnapshot } from "@/runtime/task-runtime";
import { RuntimeErrorBanner } from "./RuntimeErrorBanner";

export function TaskRuntimeError({ snapshot, task, readOnly = false, connectionNoticeOwned = false }: {
  snapshot: Pick<TaskSnapshot, "messages" | "error" | "connected" | "sendAcceptanceUnknown">;
  task?: {
    reconnectNow(): Promise<void>;
    reconcileSendAcceptance(): Promise<void>;
  };
  readOnly?: boolean;
  connectionNoticeOwned?: boolean;
}) {
  const connectionOwned = connectionNoticeOwned && !snapshot.connected;
  const error = connectionOwned ? null : snapshot.error;
  if (!snapshot.sendAcceptanceUnknown && (!error || snapshot.messages.some(message =>
    message.role === "assistant" && message.status === "failed" && message.error === error &&
    message === snapshot.messages.at(-1)))) return null;
  return <RuntimeErrorBanner key={error}
    error={error ?? t("task.send_acceptance_is_still_unknown_check_execution_status")}
    onReconnect={!readOnly && task && !snapshot.connected && !connectionNoticeOwned ? () => task.reconnectNow() : undefined}
    onReconcile={!readOnly && task && snapshot.sendAcceptanceUnknown ? async () => { await task.reconcileSendAcceptance(); } : undefined} />;
}
