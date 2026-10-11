import { isTurnAttemptStatus, knownValues } from "./generated/contracts";
/** Visible message projection, not permission to resume a TurnAttempt. */
export type TurnMessageStatus =
  | { status: "pending" | "streaming" | "done" | "failed" | "cancelled" }
  | { status: "unknown"; rawStatus: string };

export function decodeTurnMessageStatus(
  raw?: string | null,
): TurnMessageStatus {
  // Older committed history omitted per-message status. Keep that storage contract.
  if (raw === undefined || raw === null) return { status: "done" };
  if (
    isTurnAttemptStatus(raw) &&
    (knownValues.TurnAttemptStatus as readonly string[]).includes(raw)
  ) {
    switch (raw) {
      case "accepted":
        return { status: "pending" };
      case "completed":
        return { status: "done" };
      case "failed":
        return { status: "failed" };
      case "interrupted":
        return { status: "cancelled" };
      default:
        return { status: "unknown", rawStatus: raw };
    }
  }
  switch (raw) {
    case "failed":
      return { status: "failed" };
    case "cancelled":
    case "interrupted":
      return { status: "cancelled" };
    case "streaming":
    case "running":
    case "inprogress":
    case "in_progress":
    case "busy":
    case "pending":
      return { status: "streaming" };
    case "done":
    case "completed":
    case "complete":
    case "succeeded":
    case "success":
    // Legacy conversation activity metadata is not proof that a message is streaming.
    case "active":
    case "idle":
      return { status: "done" };
    default:
      return { status: "unknown", rawStatus: raw };
  }
}
