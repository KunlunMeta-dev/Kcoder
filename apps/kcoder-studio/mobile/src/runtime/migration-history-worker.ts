export const HISTORY_WORKER_STATE_CAPABILITY = "migrationHistoryWorkerStateV1";
export type HistoryWorkerObservation = "running" | "stopped" | "unknown" | "legacy";
/** A missing negotiated observation cannot grant execution or establish that a peer stopped. */
export function historyWorkerObservation(value: { workerRunning: boolean; workerState?: "running" | "stopped" | "unknown" | null } | null | undefined, negotiated: boolean): HistoryWorkerObservation {
  if (!value) return "unknown";
  if (value.workerState != null) {
    if (value.workerState === "running" && value.workerRunning) return "running";
    if (value.workerState === "stopped" && !value.workerRunning) return "stopped";
    return "unknown";
  }
  if (negotiated) return "unknown";
  return value.workerRunning ? "running" : "legacy";
}
export function historyWorkerMessage(observation: HistoryWorkerObservation): string {
  return observation === "running" ? "migration_results.worker_running" : `migration_history.worker_${observation}`;
}
type HistoryOwnershipSnapshot = { workerRunning: boolean; workerState?: "running" | "stopped" | "unknown" | null; workerError?: string | null; job: { cancelRequested?: boolean; stage?: string } };
export function isUntrackedHistory(value: HistoryOwnershipSnapshot | null | undefined): boolean {
  return value?.workerState === "unknown" && value.workerRunning === false && value.workerError === "history_job_execution_untracked";
}
/** Only Native's explicit legacy classification admits an ownership-only compatibility check. */
export function canRecoverUntrackedHistory(value: HistoryOwnershipSnapshot | null | undefined): boolean {
  return isUntrackedHistory(value) && (value?.job.cancelRequested === true || ["normalized", "failed", "cancelled"].includes(value?.job.stage ?? ""));
}
