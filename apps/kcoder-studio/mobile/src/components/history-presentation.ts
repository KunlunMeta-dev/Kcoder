import { timestampMs } from "@/protocol/normalizers";

export type HistoryDateGroup = "today" | "yesterday" | "earlier_week" | "older" | "unknown_date";

/** Calendar boundaries use the client's local day, including DST transitions. */
export function historyDateGroup(value: string | number, now = Date.now()): HistoryDateGroup {
  const ms = timestampMs(value);
  if (!Number.isFinite(ms) || ms <= 0) return "unknown_date";
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
  const week = new Date(today); week.setDate(week.getDate() - (week.getDay() + 6) % 7);
  if (ms >= today.getTime()) return "today";
  if (ms >= yesterday.getTime()) return "yesterday";
  return ms >= week.getTime() ? "earlier_week" : "older";
}

export function historyTime(value: string | number, locale: string, now = Date.now()): string {
  const ms = timestampMs(value);
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const date = new Date(ms);
  return historyDateGroup(value, now) === "today"
    ? date.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString(locale, { month: "short", day: "numeric" });
}

/** The same directory on separate targets is always a different filter. */
export function historyProjectKey(serverId: string, path: string): string {
  return JSON.stringify([serverId, path]);
}
