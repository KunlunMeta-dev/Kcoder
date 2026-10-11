/** Tool-call projection, distinct from turn, task and workflow lifecycles. */
export type KnownToolCallStatus =
  "generating_arguments" | "pending" | "streaming" | "done" | "error";
export type ToolCallStatus =
  { status: KnownToolCallStatus } | { status: "unknown"; rawStatus?: string };

/** Preserve established aliases; a future label never grants execution/completion. */
export function decodeToolCallStatus(raw?: string): ToolCallStatus {
  const normalized = raw
    ?.trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  switch (normalized) {
    case "generating_arguments":
    case "pending":
    case "streaming":
    case "done":
    case "error":
      return { status: normalized };
    case "completed":
    case "complete":
    case "succeeded":
    case "success":
      return { status: "done" };
    case "failed":
    case "failure":
      return { status: "error" };
    case "running":
    case "in_progress":
    case "inprogress":
      return { status: "pending" };
    default:
      return {
        status: "unknown",
        ...(raw !== undefined && { rawStatus: raw }),
      };
  }
}

export function isActiveToolCallStatus(
  status?: ToolCallStatus["status"],
): boolean {
  return (
    status === "pending" ||
    status === "streaming" ||
    status === "generating_arguments"
  );
}

/** Late explicit terminal corrections can supply background output. Activity cannot
 * restart a settled call, and unrecognized evidence cannot be guessed into execution. */
export function canAcceptToolCallUpdate(
  previous: ToolCallStatus["status"],
  next?: ToolCallStatus["status"],
): boolean {
  if (next === undefined) return true;
  if (previous === "unknown") return next === "unknown";
  return !(
    (previous === "done" || previous === "error") &&
    isActiveToolCallStatus(next)
  );
}
