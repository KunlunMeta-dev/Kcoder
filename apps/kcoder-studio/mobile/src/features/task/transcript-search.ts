import type { ChatMessage } from "@/runtime/task-runtime";
import { visibleAssistantText } from "./transcript-body";

export interface TranscriptMatch {
  key: string;
  messageId: string;
  start: number;
  end: number;
  excerpt: string;
}

/** Search loaded, visible body only. Never initiate history paging or inspect tool inputs. */
export function searchLoadedTranscript(messages: readonly ChatMessage[], query: string): { matches: TranscriptMatch[]; total: number } {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return { matches: [], total: 0 };
  const matches: TranscriptMatch[] = [];
  let total = 0;
  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    const text = message.role === "user" ? message.content : visibleAssistantText(message) ?? "";
    const haystack = text.toLocaleLowerCase();
    let from = 0;
    while (from <= haystack.length) {
      const start = haystack.indexOf(needle, from);
      if (start < 0) break;
      const end = start + needle.length;
      total++;
      // Bound retained excerpts while still counting every loaded occurrence.
      if (matches.length < 1000) matches.push({ key: `${message.id}:${start}`, messageId: message.id, start, end,
        excerpt: `${start > 36 ? "…" : ""}${text.slice(Math.max(0, start - 36), end + 64)}${end + 64 < text.length ? "…" : ""}` });
      from = end;
    }
  }
  return { matches, total };
}
