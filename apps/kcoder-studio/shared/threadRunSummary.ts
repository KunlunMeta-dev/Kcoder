/**
 * Authoritative run facts published by an app-server that negotiated
 * `threadRunSummaryV1`.
 *
 * This module is the single client-side derivation: both Gateway adapters use
 * it so a thread cannot look "running" in one surface and "idle" in another,
 * and a pending approval, background work or pending delivery is never reduced
 * back to a plain boolean.
 */

export interface ThreadRecentError {
  turnId: string;
  attemptId?: string;
  kind: "failed" | "interrupted";
  source: "provider" | "execution";
  category:
    | "authentication"
    | "rate_limit"
    | "network"
    | "provider"
    | "execution"
    | "unknown";
  atMs: number;
}

export interface ThreadRunSummary {
  /** Absent is unknown; null is a confirmed absence of failures. */
  recentError?: ThreadRecentError | null;
  mainTurn: "idle" | "running" | "unknown";
  pendingApprovals: number | null;
  pendingQuestions: number | null;
  activeJobs: number | null;
  tasksPending: number | null;
  tasksRunning: number | null;
  pendingFollowups: number | null;
  pendingGoals: number | null;
}

/** What the session list should show for one thread. */
export type ThreadRunActivity =
  | "idle"
  | "running"
  | "waiting_approval"
  | "waiting_answer"
  | "background"
  | "aggregating"
  | "failed"
  | "unknown";

const COUNT_KEYS = [
  "pendingApprovals",
  "pendingQuestions",
  "activeJobs",
  "tasksPending",
  "tasksRunning",
  "pendingFollowups",
  "pendingGoals",
] as const;

function count(value: unknown): number | null | undefined {
  if (value === null) return null;
  if (typeof value === "number" && Number.isFinite(value) && value >= 0)
    return Math.floor(value);
  return undefined;
}

/**
 * Parses the `runSummary` field. An incomplete or malformed summary is dropped
 * as a whole: a partial object must never be read as "no approval pending".
 */
export function parseThreadRunSummary(
  value: unknown,
): ThreadRunSummary | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const mainTurn = record.mainTurn;
  if (mainTurn !== "idle" && mainTurn !== "running" && mainTurn !== "unknown")
    return undefined;
  const summary = { mainTurn } as ThreadRunSummary;
  if (record.recentError === null) summary.recentError = null;
  else {
    const recent = parseThreadRecentError(record.recentError);
    if (recent) summary.recentError = recent;
  }
  for (const key of COUNT_KEYS) {
    const parsed = count(record[key]);
    if (parsed === undefined) return undefined;
    summary[key] = parsed;
  }
  return summary;
}

/** True while the server reports outstanding work for the thread. */
export function threadRunSummaryIsActive(activity: ThreadRunActivity): boolean {
  return (
    activity === "running" ||
    activity === "waiting_approval" ||
    activity === "waiting_answer" ||
    activity === "background" ||
    activity === "aggregating"
  );
}

/**
 * Maps the authoritative facts to the single activity a surface should show.
 *
 * Order mirrors the server rule (`ThreadRunFacts::state`): a pending user
 * interaction is more actionable than a running turn, background work outlives
 * the main turn, and delivery is the last thing outstanding. Unreadable facts
 * are reported as `unknown`, never as idle.
 */
export function threadRunActivity(
  status: unknown,
  summary: ThreadRunSummary | undefined,
): ThreadRunActivity {
  if (!summary) return coarseActivity(status);
  // Persisted, non-resident threads carry an error-only summary: none of
  // their live counters is observable. This is not an in-progress sync.
  // Keep the server's coarse status; partially unreadable live facts below
  // must still remain unknown.
  if (summary.mainTurn === "unknown" && COUNT_KEYS.every(key => summary[key] === null))
    return coarseActivity(status);
  if (summary.pendingApprovals !== null && summary.pendingApprovals > 0)
    return "waiting_approval";
  if (summary.pendingQuestions !== null && summary.pendingQuestions > 0)
    return "waiting_answer";
  if (summary.mainTurn === "running") return "running";
  if (
    (summary.activeJobs !== null && summary.activeJobs > 0) ||
    (summary.tasksRunning !== null && summary.tasksRunning > 0) ||
    (summary.tasksPending !== null && summary.tasksPending > 0) ||
    (summary.pendingGoals !== null && summary.pendingGoals > 0)
  ) {
    return "background";
  }
  if (summary.pendingFollowups !== null && summary.pendingFollowups > 0)
    return "aggregating";
  const unreadable =
    summary.mainTurn === "unknown" ||
    COUNT_KEYS.some((key) => summary[key] === null);
  return unreadable ? "unknown" : "idle";
}

/** Older servers only publish the coarse status; keep their existing meaning. */
function coarseActivity(status: unknown): ThreadRunActivity {
  switch (status) {
    case "running":
      return "running";
    case "waiting_for_approval":
      return "waiting_approval";
    case "waiting_for_answer":
      return "waiting_answer";
    case "background":
      return "background";
    case "aggregating":
      return "aggregating";
    case "failed":
      return "failed";
    case "idle":
      return "idle";
    default:
      return "unknown";
  }
}

/** A transcript's current thread snapshot outranks an older list/cache entry. */
export function transcriptSnapshotRunning(
  snapshot: unknown,
  legacyRunning: boolean | undefined,
): boolean | undefined {
  if (!snapshot || typeof snapshot !== "object") return legacyRunning;
  const thread = snapshot as Record<string, unknown>;
  if (typeof thread.status !== "string" && thread.runSummary === undefined)
    return legacyRunning;
  const activity = threadRunActivity(
    thread.status,
    parseThreadRunSummary(thread.runSummary),
  );
  return activity === "unknown"
    ? undefined
    : threadRunSummaryIsActive(activity);
}

export function parseThreadRecentError(
  value: unknown,
): ThreadRecentError | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (
    typeof record.turnId !== "string" ||
    !/^turn-[1-9][0-9]*$/.test(record.turnId) ||
    !["failed", "interrupted"].includes(String(record.kind)) ||
    !["provider", "execution"].includes(String(record.source)) ||
    ![
      "authentication",
      "rate_limit",
      "network",
      "provider",
      "execution",
      "unknown",
    ].includes(String(record.category)) ||
    typeof record.atMs !== "number" ||
    !Number.isSafeInteger(record.atMs) ||
    record.atMs < 0 ||
    (record.attemptId !== undefined &&
      (typeof record.attemptId !== "string" || record.attemptId.length > 256))
  )
    return undefined;
  return {
    turnId: record.turnId,
    ...(typeof record.attemptId === "string"
      ? { attemptId: record.attemptId }
      : {}),
    kind: record.kind as ThreadRecentError["kind"],
    source: record.source as ThreadRecentError["source"],
    category: record.category as ThreadRecentError["category"],
    atMs: record.atMs,
  };
}
