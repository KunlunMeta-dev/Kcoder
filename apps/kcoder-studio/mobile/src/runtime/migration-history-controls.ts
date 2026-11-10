import type { HistoryWorkerObservation } from "./migration-history-worker";
type Family = "history" | "branch" | "tools" | "attachment" | "continuation";
/** Availability mirrors Native run/resume semantics; a cancel flag is not a terminal stage. */
export function historicalControls(family: Family, stage: string | undefined, cancelRequested = false, workerRunning = false, failureCode?: string | null, workerState?: HistoryWorkerObservation, untrackedExecution = false) {
  const terminal = family === "history" ? stage === "normalized" : family === "continuation" ? stage === "imported" : stage === "ready" || family === "attachment" && ["catalogued", "unavailable"].includes(stage ?? "");
  const recovery = family === "history" && stage === "normalized" && failureCode === "history_projection_recovery_required";
  const requiresResume = family === "continuation" ? stage !== undefined && stage !== "planned" && stage !== "imported" : stage === "cancelled" || stage === "failed";
  const legacyRecovery = family === "history" && workerState === "unknown" && untrackedExecution;
  const historyStoppedStage = family === "history" && ["normalized", "failed", "cancelled"].includes(stage ?? "");
  return {
    run: !workerRunning && workerState !== "running" && workerState !== "unknown" && !cancelRequested && (!terminal || recovery) && !requiresResume,
    resume: !workerRunning && workerState !== "running" && (legacyRecovery && (cancelRequested || historyStoppedStage) || workerState !== "unknown" && !terminal && requiresResume),
    cancel: stage !== undefined && !terminal && !historyStoppedStage && !cancelRequested,
  };
}
