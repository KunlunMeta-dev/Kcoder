import { isPermissionMode, type PermissionMode } from "@/protocol/task-permission-mode";

export interface TranscriptActionRecord {
  id: string;
  kind: "edit" | "fork";
  phase: "prepared" | "rollbackSent" | "rolledBack" | "sendSent" | "sendRejected" | "forkSent" | "forked" | "forkReady" | "blocked";
  sourceMessageId: string;
  cwd?: string;
  turnId?: string;
  text: string;
  wireText?: string;
  model?: string;
  reasoningEffort?: string;
  permissionMode?: PermissionMode;
  childThreadId?: string;
}

const phases = new Set(["prepared", "rollbackSent", "rolledBack", "sendSent", "sendRejected", "forkSent", "forked", "forkReady", "blocked"]);
export function normalizeTranscriptAction(value: unknown): TranscriptActionRecord | undefined {
  if (value === undefined || value === null) return undefined;
  const invalid = (): TranscriptActionRecord => ({ id: "mobile-transcript-unreadable", kind: "edit", phase: "blocked",
    sourceMessageId: "unknown", text: typeof (value as Record<string, unknown>)?.text === "string"
      ? String((value as Record<string, unknown>).text).slice(0, 50_000) : "" });
  if (typeof value !== "object") return invalid();
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== "string" || !raw.id.startsWith("mobile-transcript-") || raw.id.length > 200 ||
      (raw.kind !== "edit" && raw.kind !== "fork") || !phases.has(String(raw.phase)) ||
      typeof raw.sourceMessageId !== "string" || raw.sourceMessageId.length > 1000 ||
      typeof raw.text !== "string" || raw.text.length > 50_000) return invalid();
  const optional = (key: string, max = 1000) => typeof raw[key] === "string" && (raw[key] as string).length <= max ? raw[key] as string : undefined;
  return { id: raw.id, kind: raw.kind, phase: raw.phase as TranscriptActionRecord["phase"],
    sourceMessageId: raw.sourceMessageId, text: raw.text, turnId: optional("turnId"),
    cwd: optional("cwd", 4096),
    wireText: optional("wireText", 100_000), model: optional("model", 256),
    reasoningEffort: optional("reasoningEffort", 40),
    permissionMode: isPermissionMode(raw.permissionMode) ? raw.permissionMode : undefined,
    childThreadId: optional("childThreadId") };
}
