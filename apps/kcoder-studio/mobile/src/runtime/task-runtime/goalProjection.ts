import type { TaskRuntime } from "./core";
import type { ThreadGoal } from "./types";

/** Matches the target's GoalStatus::is_unfinished edit contract. */
export function goalCanEdit(goal: Pick<ThreadGoal, "status"> | null | undefined): boolean {
  return goal?.status === "active" || goal?.status === "paused" || goal?.status === "blocked";
}

/** Capture both transport ownership and the published Goal revision before a read. */
export function captureGoalProjection(runtime: TaskRuntime) {
  const client = runtime.client;
  const generation = runtime.clientGeneration;
  const threadId = runtime.snapshot.threadId;
  const version = runtime.goalProjectionVersion;
  return {
    version,
    current: () => !runtime.disposed && runtime.client === client &&
      runtime.clientGeneration === generation && runtime.snapshot.threadId === threadId,
  };
}

export function publishGoal(runtime: TaskRuntime, goal: ThreadGoal | null,
  expectedVersion?: number): boolean {
  if (runtime.disposed || (goal && goal.threadId !== runtime.snapshot.threadId)) return false;
  const previous = runtime.snapshot.goal;
  if (expectedVersion !== undefined && runtime.goalProjectionVersion !== expectedVersion) return false;
  if (goal && previous?.goalId === goal.goalId && previous.revision > goal.revision) return false;
  runtime.goalProjectionVersion++;
  runtime.patch({ goal, goalError: runtime.snapshot.goalMutationUnknown ? runtime.snapshot.goalError : null,
    ...(goal?.status === "active" ? {} : { goalContinuation: null }) });
  return true;
}
