import type { ThreadMessage } from "@/gateway/types";
import type { TranscriptReadAnchor } from "@/storage/session-transcript-projection";

type Row = Pick<ThreadMessage, "id" | "role" | "turnId" | "attemptId"> & { clientMessageId?: unknown };
const explicit = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const uniqueId = (rows: readonly Row[], id: string) => {
  const matches = rows.filter(row => row.id === id);
  return matches.length === 1 ? matches[0] : undefined;
};
function compatible(left: Row, right: Row): boolean {
  return left.role === right.role && (["turnId", "attemptId", "clientMessageId"] as const).every(key =>
    !explicit(left[key]) || !explicit(right[key]) || left[key] === right[key]);
}
function sameSource(left: Row, right: Row): boolean {
  if (!compatible(left, right)) return false;
  if (left.role === "assistant") return explicit(left.turnId) && explicit(left.attemptId) &&
    left.turnId === right.turnId && left.attemptId === right.attemptId;
  return left.role === "user" && explicit(left.clientMessageId) && left.clientMessageId === right.clientMessageId;
}
function counterpart(source: Row, sources: readonly Row[], targets: readonly Row[]): Row | undefined {
  const exact = targets.filter(row => row.id === source.id);
  if (exact.length) return exact.length === 1 && compatible(source, exact[0]) ? exact[0] : undefined;
  // A coalesced live row cannot identify one of several history rows. Text is never source proof.
  const candidates = targets.filter(row => sameSource(source, row));
  return sources.filter(row => sameSource(source, row)).length === 1 && candidates.length === 1
    ? candidates[0] : undefined;
}

/** Convert a display marker only against this exact authority page and its retained projection. */
export function confirmedSessionAnchor(marker: TranscriptReadAnchor, display: readonly Row[], authority: readonly Row[], retained: readonly Row[]): TranscriptReadAnchor | undefined {
  const source = uniqueId(display, marker.messageId);
  const raw = source && counterpart(source, display, authority);
  const saved = raw && uniqueId(retained, raw.id);
  return raw && saved && compatible(raw, saved) ? { ...marker, messageId: raw.id } : undefined;
}

/** Canonical IDs must still exist; a different same-turn history row is not their replacement. */
export function displayedSessionAnchor(marker: TranscriptReadAnchor, display: readonly Row[], authority: readonly Row[], retained: readonly Row[]): TranscriptReadAnchor | undefined {
  const saved = uniqueId(retained, marker.messageId);
  const raw = uniqueId(authority, marker.messageId);
  const shown = saved && raw && compatible(saved, raw) && counterpart(raw, authority, display);
  return shown ? { ...marker, messageId: shown.id } : undefined;
}
