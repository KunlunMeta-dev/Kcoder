import type { ThreadMessage } from "@/gateway/types";
import { normalizeHistoryPage } from "@/runtime/task-runtime/history";
import { attachmentFromValue, attachmentsFromContent } from "@/runtime/task-runtime/normalizers";
import { visibleUserContent } from "@/protocol/normalizers";
import type { ThreadReadPage } from "@/runtime/task-runtime/types";
import { decodeTurnMessageStatus } from "../../../shared/turnMessageStatus";
import { decodeToolCallStatus } from "../../../shared/toolCallStatus";
import { decodeSessionTranscriptScope, sessionTranscriptScopeKey, type SessionTranscriptScope } from "./session-transcript-scope";

export const TRANSCRIPT_CACHE_LIMITS = Object.freeze({ entries: 16, totalBytes: 8 * 1024 * 1024, entryBytes: 512 * 1024, rows: 200, manifestBytes: 64 * 1024 });
export const TRANSCRIPT_CACHE_MAX_IDLE_MS = 30 * 24 * 60 * 60 * 1000;
export interface TranscriptReadAnchor { messageId: string; offset: number; followsLatest: boolean }
export interface ConfirmedTranscript {
  schemaVersion: 1;
  scope: SessionTranscriptScope;
  title: string;
  updatedAt: number;
  messages: ThreadMessage[];
  /** Source coverage only: filtered/cropped rows never constitute a continuous replay page. */
  coverage: { rangeStart?: number; rangeEnd?: number; hasMoreBefore: boolean; complete: false; sparse: true };
  anchor?: TranscriptReadAnchor;
}
export interface ConfirmedTranscriptOptions {
  title: string;
  updatedAt: number;
  activeTurnId?: string | null;
  unconfirmedMessageIds?: readonly string[];
  anchor?: TranscriptReadAnchor;
}

/** Hermes-safe UTF8 sizing, including replacement of isolated UTF16 surrogates. */
export function transcriptUtf8Size(value: string): number {
  let bytes = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length && value.charCodeAt(i + 1) >= 0xdc00 && value.charCodeAt(i + 1) <= 0xdfff) { bytes += 4; i++; }
    else bytes += 3;
  }
  return bytes;
}
const identity = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 4096 && !/\p{Cc}/u.test(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

function displayBlocks(value: unknown): unknown[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 1024) throw new Error("Invalid transcript blocks");
  return value.flatMap(block => {
    if (!block || typeof block !== "object" || Array.isArray(block)) return [];
    const raw = block as Record<string, unknown>;
    if ((raw.type === "text" || raw.type === "thinking") && typeof raw.content === "string") {
      return [{ type: raw.type, ...(identity(raw.id) ? { id: raw.id } : {}), content: raw.content }];
    }
    if (raw.type === "tool") {
      const status = decodeToolCallStatus(typeof raw.status === "string" ? raw.status : undefined).status;
      if (status !== "done" && status !== "error") return [];
      // Inputs/output remain conversation display data, not an executable tool call.
      const result: Record<string, unknown> = { type: "tool" };
      for (const key of ["id", "tool_use_id", "tool_name", "name", "status", "tool_input", "tool_output", "input", "output", "webSources"]) {
        if (Object.prototype.hasOwnProperty.call(raw, key)) result[key] = raw[key];
      }
      return [result];
    }
    if (raw.type === "attachment") {
      const attachment = attachmentFromValue(raw.attachment ?? raw);
      return attachment && finite(attachment.fileSize) ? [{ type: "attachment", ...attachment }] : [];
    }
    return [];
  });
}

/** Bound traversal and copying before calling the existing, richer history normalizer. */
function boundedDisplayJson(value: unknown): unknown {
  let remaining = TRANSCRIPT_CACHE_LIMITS.entryBytes;
  let nodes = 4096;
  const copy = (item: unknown, depth: number): unknown => {
    if (--nodes < 0 || depth > 12) throw new Error("Transcript display value is too complex");
    if (typeof item === "string") {
      if (item.length > remaining) throw new Error("Transcript display value exceeds budget");
      remaining -= transcriptUtf8Size(JSON.stringify(item));
      if (remaining < 0) throw new Error("Transcript display value exceeds budget");
      return item;
    }
    if (item === null || typeof item === "boolean" || finite(item)) {
      remaining -= String(item).length;
      return item;
    }
    if (!item || typeof item !== "object") throw new Error("Transcript display value is not JSON");
    if (Array.isArray(item)) {
      if (item.length > nodes) throw new Error("Transcript display array is too large");
      remaining -= item.length + 2;
      return item.map(child => copy(child, depth + 1));
    }
    const result: Record<string, unknown> = {};
    for (const key in item) {
      if (!Object.prototype.hasOwnProperty.call(item, key)) continue;
      remaining -= transcriptUtf8Size(JSON.stringify(key)) + 2;
      if (remaining < 0) throw new Error("Transcript display object exceeds budget");
      Object.defineProperty(result, key, { value: copy((item as Record<string, unknown>)[key], depth + 1), enumerable: true });
    }
    remaining -= 2;
    return result;
  };
  const result = copy(value, 0);
  if (remaining < 0) throw new Error("Transcript display value exceeds budget");
  return result;
}

function projectRow(value: unknown, options: ConfirmedTranscriptOptions): ThreadMessage | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (!identity(raw.id) || raw.id.startsWith("local-") || !["user", "assistant", "system"].includes(String(raw.role)) ||
      typeof raw.content !== "string" || !finite(raw.timestampMs) || options.unconfirmedMessageIds?.includes(raw.id) ||
      (options.activeTurnId && raw.turnId === options.activeTurnId)) return null;
  if (raw.status !== undefined && typeof raw.status !== "string") return null;
  const status = decodeTurnMessageStatus(raw.status as string | undefined).status;
  if (!["done", "failed", "cancelled"].includes(status)) return null;
  if (raw.content.length > TRANSCRIPT_CACHE_LIMITS.entryBytes || transcriptUtf8Size(raw.content) > TRANSCRIPT_CACHE_LIMITS.entryBytes) return null;
  const row: ThreadMessage = { id: raw.id, role: String(raw.role), content: raw.role === "user" ? visibleUserContent(raw.content) : raw.content, timestampMs: raw.timestampMs };
  for (const key of ["turnId", "attemptId", "continuedByAttemptId", "error", "errorType", "status"] as const) {
    if (raw[key] !== undefined) {
      if (typeof raw[key] !== "string") return null;
      row[key] = raw[key];
    }
  }
  try {
    let blocks = displayBlocks(raw.blocks);
    if (raw.role === "user") {
      blocks = blocks?.filter(block => (block as { type: string }).type === "attachment");
      const descriptors = attachmentsFromContent(raw.content);
      if (descriptors?.length) blocks = [...(blocks ?? []), ...descriptors.map(attachment => ({ type: "attachment", ...attachment }))];
    }
    if (blocks !== undefined) row.blocks = blocks;
    const bounded = boundedDisplayJson(row) as ThreadMessage;
    return normalizeHistoryPage({ messages: [bounded] }).messages.length === 1 ? bounded : null;
  } catch { return null; }
}

export function projectConfirmedTranscript(scope: SessionTranscriptScope, page: ThreadReadPage, options: ConfirmedTranscriptOptions): ConfirmedTranscript {
  if (!decodeSessionTranscriptScope(scope) || typeof options.title !== "string" || options.title.length > 4096 || !finite(options.updatedAt)) throw new Error("Invalid transcript projection metadata");
  const coverage: ConfirmedTranscript["coverage"] = { hasMoreBefore: page.hasMoreBefore === true, complete: false, sparse: true };
  if (Number.isSafeInteger(page.rangeStart) && page.rangeStart! >= 0) coverage.rangeStart = page.rangeStart;
  if (Number.isSafeInteger(page.rangeEnd) && page.rangeEnd! >= (coverage.rangeStart ?? 0)) coverage.rangeEnd = page.rangeEnd;
  const result: ConfirmedTranscript = { schemaVersion: 1, scope, title: options.title, updatedAt: options.updatedAt, messages: [], coverage };
  if (options.anchor && identity(options.anchor.messageId) && finite(options.anchor.offset) && Math.abs(options.anchor.offset) <= 100_000 &&
      typeof options.anchor.followsLatest === "boolean") result.anchor = { messageId: options.anchor.messageId, offset: options.anchor.offset, followsLatest: options.anchor.followsLatest };
  let available = TRANSCRIPT_CACHE_LIMITS.entryBytes - transcriptUtf8Size(JSON.stringify(result));
  if (available < 0) throw new Error("Transcript envelope exceeds budget");
  const seen = new Set<string>();
  const messages = page.messages ?? [];
  // Select newest whole rows with one per-row size calculation, never repeatedly stringify the growing page.
  for (let index = messages.length - 1; index >= Math.max(0, messages.length - TRANSCRIPT_CACHE_LIMITS.rows); index--) {
    const raw = messages[index];
    const row = projectRow(raw, options);
    if (!row || seen.has(row.id)) continue;
    const bytes = transcriptUtf8Size(JSON.stringify(row)) + (result.messages.length ? 1 : 0);
    if (bytes > available) {
      if (result.messages.length) break;
      continue;
    }
    available -= bytes; seen.add(row.id); result.messages.push(row);
  }
  result.messages.reverse();
  if (result.anchor && !result.messages.some(row => row.id === result.anchor!.messageId)) delete result.anchor;
  if (transcriptUtf8Size(JSON.stringify(result)) > TRANSCRIPT_CACHE_LIMITS.entryBytes) throw new Error("Transcript projection exceeds budget");
  return result;
}

export function decodeConfirmedTranscript(raw: string, scope: SessionTranscriptScope): { record: ConfirmedTranscript; view: ReturnType<typeof normalizeHistoryPage> } | null {
  if (raw.length > TRANSCRIPT_CACHE_LIMITS.entryBytes || transcriptUtf8Size(raw) > TRANSCRIPT_CACHE_LIMITS.entryBytes) return null;
  try {
    const value = JSON.parse(raw) as ConfirmedTranscript;
    if (!value || value.schemaVersion !== 1 || !decodeSessionTranscriptScope(value.scope) || sessionTranscriptScopeKey(value.scope) !== sessionTranscriptScopeKey(scope) ||
        !Array.isArray(value.messages) || value.messages.length > TRANSCRIPT_CACHE_LIMITS.rows || !value.coverage || value.coverage.complete !== false || value.coverage.sparse !== true) return null;
    const rebuilt = projectConfirmedTranscript(scope, { messages: value.messages, ...value.coverage }, { title: value.title, updatedAt: value.updatedAt, anchor: value.anchor });
    if (JSON.stringify(rebuilt) !== JSON.stringify(value)) return null;
    return { record: rebuilt, view: normalizeHistoryPage({ messages: rebuilt.messages }) };
  } catch { return null; }
}
