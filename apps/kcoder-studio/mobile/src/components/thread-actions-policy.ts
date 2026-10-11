import type { ThreadSummary } from "@/gateway/types";

export function threadCanBeArchivedOrDeleted(status: ThreadSummary["status"]): boolean {
  return status === "idle" || status === "failed";
}

export function matchesLiveTaskTarget(
  targetServerId: string,
  targetThreadId: string,
  liveServerId: string | undefined,
  liveThreadId: string | undefined,
): boolean {
  return targetServerId === liveServerId && targetThreadId === liveThreadId;
}
