import { expect, it } from "vitest";
import { historyWorkerMessage, historyWorkerObservation, canRecoverUntrackedHistory } from "./migration-history-worker";
import { historicalControls } from "./migration-history-controls";
it("negotiated missing, null and contradictory ownership remains unknown instead of granting execution", () => {
  for (const value of [{ workerRunning: false }, { workerRunning: true }, { workerRunning: false, workerState: null }, { workerRunning: false, workerState: "unknown" }, { workerRunning: true, workerState: "stopped" }, { workerRunning: false, workerState: "running" }] as const) {
    const state = historyWorkerObservation(value, true);
    expect(state).toBe("unknown"); expect(historyWorkerMessage(state)).toBe("migration_history.worker_unknown");
    for (const stage of ["planned", "failed", "cancelled"]) expect(historicalControls("history", stage, false, value.workerRunning, null, state)).toMatchObject({ run: false, resume: false });
  }
});
it("only the exact Native legacy-untracked cancellation classification admits explicit recovery", () => {
  const value = { workerRunning: false, workerState: "unknown" as const, workerError: "history_job_execution_untracked", job: { cancelRequested: true } };
  expect(canRecoverUntrackedHistory(value)).toBe(true);
  expect(historicalControls("history", "normalizing", true, false, null, "unknown", true)).toMatchObject({ run: false, resume: true, cancel: false });
  for (const stage of ["normalized", "failed", "cancelled"]) {
    expect(canRecoverUntrackedHistory({ ...value, job: { stage, cancelRequested: false } })).toBe(true);
    expect(historicalControls("history", stage, false, false, null, "unknown", true)).toMatchObject({ run: false, resume: true, cancel: false });
  }
  for (const candidate of [{ ...value, workerState: undefined }, { ...value, workerState: null }, { ...value, workerRunning: true }, { ...value, job: { cancelRequested: false } }, { ...value, workerError: "history_job_execution_unknown" }]) expect(canRecoverUntrackedHistory(candidate)).toBe(false);
});
it("legacy lack of ownership is distinct from explicit stopped while proven running remains blocked", () => {
  expect(historyWorkerObservation({ workerRunning: false }, false)).toBe("legacy");
  expect(historyWorkerObservation({ workerRunning: false, workerState: null }, false)).toBe("legacy");
  expect(historyWorkerObservation({ workerRunning: true }, false)).toBe("running");
  expect(historyWorkerObservation({ workerRunning: false, workerState: "stopped" }, true)).toBe("stopped");
  expect(historyWorkerObservation({ workerRunning: true, workerState: "running" }, true)).toBe("running");
  expect(historyWorkerObservation({ workerRunning: false, workerState: "unknown" }, false)).toBe("unknown");
  expect(historicalControls("history", "planned", false, false, null, "stopped").run).toBe(true);
  expect(historicalControls("history", "failed", false, false, null, "legacy").resume).toBe(true);
  expect(historicalControls("history", "failed", false, false, null, "running").resume).toBe(false);
});
