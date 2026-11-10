import { timestampMs } from "@/protocol/normalizers";

export function v3HistoryMonth(value: string | number, locale: string): { key: string; label: string } | null {
  const ms = timestampMs(value);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const date = new Date(ms);
  return { key: `${date.getFullYear()}-${date.getMonth() + 1}`, label: date.toLocaleDateString(locale, { year: "numeric", month: "long" }) };
}

export function v3HistoryTime(value: string | number, locale: string): string {
  const ms = timestampMs(value);
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }) : "";
}
