import { createAttachmentBytesBackend, type AttachmentBytesBackend, type DurableByteSource } from "./staged-attachment-bytes";
import { captureWorkspaceProfileIdentity, withWorkspaceProfileWrite } from "./workspace-profile-fence";
import { catalogReadScopeKey } from "@/runtime/task-runtime/new-catalog-read-source";
import type { AttachmentStoreContext } from "./staged-attachment-store";
import { hashBoundedSource } from "@/protocol/sha256-stream";
import { MAX_ATTACHMENT_BYTES } from "@/protocol/attachment-limits";

export interface DraftAttachmentRecord {
  version: 1; id: string; revision: number; scope: string; draftId: string;
  filename: string; mimeType: string; size: number; contentSha256?: string;
  phase: "copying" | "prepared" | "uploading" | "uploaded" | "retained" | "unknown" | "removed";
  uploadOwner?: string; path?: string; threadId?: string;
}
const namespace = "kcoder-new-draft-attachments-v1";
const scope = (context: AttachmentStoreContext) => JSON.stringify([captureWorkspaceProfileIdentity(context.profile), catalogReadScopeKey(context.profile, context.server), context.server.observationTargetIdentity, context.workspacePath]);
function current(context: AttachmentStoreContext) { if (!context.isCurrent()) throw new Error("Draft attachment owner changed"); }
function rows(values: readonly unknown[]): DraftAttachmentRecord[] {
  if (values.length > 128) throw new Error("Draft attachment capacity exceeded");
  const result = values as DraftAttachmentRecord[];
  for (const row of result) {
    if (!row || Object.keys(row).some(key => !["version","id","revision","scope","draftId","filename","mimeType","size","contentSha256","phase","uploadOwner","path","threadId"].includes(key)) || row.version !== 1 || !/^[0-9a-f]{32}$/.test(row.id) || !Number.isSafeInteger(row.revision) || row.revision < 1 || typeof row.scope !== "string" || row.scope.length > 16384 || typeof row.draftId !== "string" || !row.draftId || row.draftId.length > 256 || typeof row.filename !== "string" || !row.filename || row.filename.length > 255 || /[\u0000-\u001f\u007f/\\]/.test(row.filename) || typeof row.mimeType !== "string" || !/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(row.mimeType) || !Number.isSafeInteger(row.size) || row.size < 0 || row.size > MAX_ATTACHMENT_BYTES || !["copying", "prepared", "uploading", "uploaded", "retained", "unknown", "removed"].includes(row.phase)) throw new Error("Invalid local draft attachment");
    if (row.path !== undefined && (typeof row.path !== "string" || !row.path || row.path.length > 4096 || /[\u0000-\u001f\u007f]/.test(row.path)) || row.uploadOwner !== undefined && !/^[a-f0-9]{32}$/.test(row.uploadOwner) || row.threadId !== undefined && (typeof row.threadId !== "string" || !row.threadId || row.threadId.length > 256)) throw new Error("Invalid draft preparation identity");
    if (row.phase !== "copying" && row.phase !== "removed" && !/^[a-f0-9]{64}$/.test(row.contentSha256 ?? "")) throw new Error("Invalid local draft attachment hash");
    if (["uploaded", "retained"].includes(row.phase) && (typeof row.path !== "string" || !row.path || typeof row.uploadOwner !== "string" || !row.uploadOwner)) throw new Error("Invalid draft upload ownership");
    if (row.phase === "retained" && (typeof row.threadId !== "string" || !row.threadId)) throw new Error("Invalid draft retained thread");
  }
  if (new Set(result.map(row => row.id)).size !== result.length || result.reduce((sum, row) => sum + (row.phase === "removed" ? 0 : row.size), 0) > 100 * 1024 * 1024) throw new Error("Draft attachment quota exceeded");
  return JSON.parse(JSON.stringify(result)) as DraftAttachmentRecord[];
}
function id() { if (!globalThis.crypto?.getRandomValues) throw new Error("Secure local attachment identity is unavailable"); return [...crypto.getRandomValues(new Uint8Array(16))].map(value => value.toString(16).padStart(2, "0")).join(""); }
/** Purely local bytes and preparation journal. No retained-service admission or remote identity. */
export class DraftAttachmentStore {
  constructor(private readonly backend: AttachmentBytesBackend = createAttachmentBytesBackend(namespace)) {}
  async load(context: AttachmentStoreContext, attachmentId: string): Promise<DraftAttachmentRecord | undefined> {
    current(context);
    return this.backend.transaction(values => {
      current(context); const row = rows(values).find(row => row.id === attachmentId);
      if (row && row.scope !== scope(context)) throw new Error("Draft attachment scope changed");
      return { value: row };
    });
  }
  async prepare(context: AttachmentStoreContext, draftId: string, filename: string, mimeType: string, source: DurableByteSource): Promise<DraftAttachmentRecord> {
    current(context);
    let row: DraftAttachmentRecord = { version: 1, id: id(), revision: 1, scope: scope(context), draftId, filename, mimeType, size: source.size, phase: this.backend.kind === "web" ? "prepared" : "copying" };
    if (this.backend.kind === "web") {
      if (!source.blob || source.blob.size !== source.size) throw new Error("Local file bytes are unavailable");
      row.contentSha256 = await hashBoundedSource(source, () => { current(context); return true; });
    }
    await withWorkspaceProfileWrite(captureWorkspaceProfileIdentity(context.profile), () => this.backend.transaction(values => {
      current(context); const all = rows(values); rows([...all, row]);
      return { value: undefined, putRow: { id: row.id, value: row }, ...(this.backend.kind === "web" ? { putBytes: { id: row.id, blob: source.blob! } } : {}) };
    }));
    if (this.backend.kind === "native") {
      try {
        const hash = await this.backend.copySource!(row.id, source, context.isCurrent, undefined, write => withWorkspaceProfileWrite(captureWorkspaceProfileIdentity(context.profile), async () => { current(context); write(); }));
        row = await this.update(context, row, { phase: "prepared", contentSha256: hash });
      } catch (error) {
        await this.discardSource({ ...context, isCurrent: () => true }, row).catch(() => {}); throw error;
      }
    }
    return row;
  }
  async update(context: AttachmentStoreContext, expected: DraftAttachmentRecord, change: Partial<Pick<DraftAttachmentRecord, "phase" | "uploadOwner" | "path" | "threadId" | "contentSha256">>, reprepareForThread?: string): Promise<DraftAttachmentRecord> {
    return withWorkspaceProfileWrite(captureWorkspaceProfileIdentity(context.profile), () => this.backend.transaction(values => {
      current(context); const all = rows(values); const old = all.find(row => row.id === expected.id);
      if (!old || old.scope !== scope(context) || old.revision !== expected.revision || JSON.stringify(old) !== JSON.stringify(expected)) throw new Error("Draft attachment preparation changed");
      if (change.phase === "prepared" && ["unknown", "uploaded"].includes(old.phase) && (!reprepareForThread || old.threadId !== reprepareForThread)) throw new Error("Explicit original-thread preparation is required");
      if (change.threadId && old.threadId && change.threadId !== old.threadId) throw new Error("Original attachment thread changed");
      const next = { ...old, ...change, revision: old.revision + 1 }; rows(all.map(row => row.id === next.id ? next : row));
      return { value: next, putRow: { id: next.id, value: next } };
    }));
  }
  async source(context: AttachmentStoreContext, row: DraftAttachmentRecord) {
    const loaded = await this.load(context, row.id);
    if (!loaded || loaded.revision !== row.revision || loaded.draftId !== row.draftId || loaded.contentSha256 !== row.contentSha256 || loaded.phase !== "prepared") throw new Error("Original local file is unavailable");
    return this.backend.source(row.id, row.size);
  }
  async discardSource(context: AttachmentStoreContext, expected: DraftAttachmentRecord, accepted = false): Promise<void> {
    if (!accepted && !["copying", "prepared"].includes(expected.phase)) throw new Error("Draft upload must be reconciled before removal");
    if (this.backend.kind === "web") {
      await withWorkspaceProfileWrite(captureWorkspaceProfileIdentity(context.profile), () => this.backend.transaction(values => {
        current(context); const old = rows(values).find(row => row.id === expected.id);
        if (!old || old.scope !== scope(context) || old.revision !== expected.revision) throw new Error("Draft attachment changed");
        return { value: undefined, deleteRow: old.id, deleteBytes: old.id };
      }));
    } else {
      const marked = await this.update(context, expected, { phase: "removed" });
      await withWorkspaceProfileWrite(captureWorkspaceProfileIdentity(context.profile), async () => { current(context); await this.backend.removeSource!(marked.id); });
      await withWorkspaceProfileWrite(captureWorkspaceProfileIdentity(context.profile), () => this.backend.transaction(values => {
        current(context); const old = rows(values).find(row => row.id === marked.id);
        if (!old || old.revision !== marked.revision || old.scope !== scope(context)) throw new Error("Draft attachment cleanup changed");
        return { value: undefined, deleteRow: old.id };
      }));
    }
  }
}
