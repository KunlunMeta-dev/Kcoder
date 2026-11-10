import type { TaskRuntime } from "@/runtime/task-runtime";
import type { TaskSnapshot } from "@/runtime/task-runtime/types";

export function canChangePermission(task: TaskRuntime, snapshot: TaskSnapshot): boolean {
  return (
    !task.isDisposed() &&
    snapshot.connected &&
    !snapshot.running &&
    snapshot.activeTurnId == null &&
    !snapshot.continuationPending &&
    !snapshot.continuationUnknown &&
    !snapshot.sendAcceptanceUnknown &&
    !snapshot.interaction &&
    !snapshot.archivedAt &&
    snapshot.configurationReady !== false
  );
}
