import { useEffect, useMemo, useRef, useState } from "react";
import { Platform } from "react-native";
import { RETENTION_CAPABILITY } from "@/protocol/attachment-retention";
import { captureWorkspaceProfileIdentity } from "@/storage/workspace-profile-fence";
import { StagedAttachmentStore, AttachmentStoreConflict, type AttachmentStoreContext, type StagedAttachmentRecord } from "@/storage/staged-attachment-store";
import { RetainedAttachmentUploader } from "@/storage/retained-attachment-upload";
import { StagedAttachmentConsumers } from "@/storage/staged-attachment-consumers";
import type { useTaskHistory } from "./useTaskHistory";

/** Captured before the asynchronous picker opens. It cannot switch to another owner/flow. */
export interface RetainedAttachmentSelection {
  isCurrent(): boolean;
  stage(filename: string, mimeType: string, blob: Blob): Promise<void>;
}

/** A UI projection of the existing bounded byte store, never a second upload journal. */
export function useRetainedAttachmentOutbox(context: ReturnType<typeof useTaskHistory>) {
  const { task, profile, server, snapshot, mountedRef, demo } = context;
  const client = task.client;
  const owner = profile && server ? JSON.stringify([
    captureWorkspaceProfileIdentity(profile), server,
    [snapshot.cwd === undefined ? "absent" : "value", snapshot.cwd ?? ""], snapshot.threadId,
  ]) : null;
  const latest = useRef({ owner, task, client });
  latest.current = { owner, task, client };
  const pickerOwner = useMemo(() => ({}), [owner, task, client]);
  const latestPickerOwner = useRef(pickerOwner);
  latestPickerOwner.current = pickerOwner;
  const isPickerOwnerCurrent = () => latestPickerOwner.current === pickerOwner && mountedRef.current;
  const store = useMemo(() => new StagedAttachmentStore(), []);
  const session = useMemo(() => {
    if (demo || Platform.OS !== "web" || !profile || !server || !client || !owner || !snapshot.threadId) return null;
    const capturedProfile = { ...profile };
    const capturedServer = { ...server, ...(server.accountIdentity ? { accountIdentity: { ...server.accountIdentity } } : {}) };
    const threadId = snapshot.threadId;
    const lifetime = { abort: new AbortController() };
    const isCurrent = () => !lifetime.abort.signal.aborted && mountedRef.current && !task.isDisposed() &&
      latest.current.owner === owner && latest.current.task === task && latest.current.client === client;
    const scope: AttachmentStoreContext = { profile: capturedProfile, server: capturedServer, workspacePath: snapshot.cwd, isCurrent };
    const available = () => isCurrent() && client.supportsExperimental(RETENTION_CAPABILITY) &&
      client.matchesRetainedAttachmentOwner(capturedProfile, capturedServer, snapshot.cwd) && Boolean(client.getAttachmentUploadAdmission());
    return { owner, client, threadId, scope, isCurrent, available, busy: new Set<string>(),
      get abort() { return lifetime.abort; },
      activate() { if (lifetime.abort.signal.aborted) lifetime.abort = new AbortController(); },
      get uploader() { return new RetainedAttachmentUploader(scope, client, store, lifetime.abort.signal); },
      get consumers() { return new StagedAttachmentConsumers(scope, client, store, lifetime.abort.signal); } };
  }, [owner, task, client, demo, store, mountedRef]);
  const [projection, setProjection] = useState<{ session: typeof session; rows: StagedAttachmentRecord[]; error: string | null; busy: string[] }>({ session: null, rows: [], error: null, busy: [] });
  const publish = (rows: StagedAttachmentRecord[], error: string | null = null) => {
    if (!session?.isCurrent()) return;
    setProjection(previous => session.isCurrent() ? { session, rows, error, busy: [...session.busy] } : previous);
  };
  const reload = async () => {
    if (!session?.isCurrent()) return;
    const rows = await store.listUnresolved(session.scope);
    // Old records without a composer association are not guessed into this thread.
    publish(rows.filter(row => row.composer?.threadId === session.threadId || row.consumerBatch?.threadId === session.threadId));
  };
  useEffect(() => {
    if (!session) return;
    session.activate();
    void reload().catch(() => publish([], "本机附件记录暂时无法核对，原文件未删除。"));
    return () => { session.abort.abort(); };
  }, [session]);
  const perform = async (id: string, operation: () => Promise<unknown>) => {
    if (!session?.isCurrent() || session.busy.has(id)) throw new AttachmentStoreConflict();
    session.busy.add(id);
    setProjection(previous => session.isCurrent() && previous.session === session ? { ...previous, busy: [...session.busy], error: null } : previous);
    let error: unknown;
    try { await operation(); }
    catch (value) { error = value; }
    finally {
      session.busy.delete(id);
      try { await reload(); } catch (value) { error ??= value; }
      if (error && session.isCurrent()) setProjection(previous => previous.session === session && session.isCurrent() ? { ...previous, busy: [...session.busy], error: "附件尚未完成，原文件和恢复记录已保留。" } : previous);
    }
    if (error) throw error;
  };
  const captureSelection = (): RetainedAttachmentSelection | null => {
    // Negotiation, not a local flag, selects the retained producer. Legacy stays unchanged.
    if (!session || !session.client.supportsExperimental(RETENTION_CAPABILITY)) return null;
    if (!session.available()) throw new AttachmentStoreConflict();
    return {
      isCurrent: session.available,
      async stage(filename, mimeType, blob) {
        if (!session.available()) throw new AttachmentStoreConflict();
        await perform("prepare", async () => {
          const row = await session.uploader.prepare(filename, {
            size: blob.size, blob,
            async read(offset, length) { return new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer()); },
          }, { threadId: session.threadId, mimeType });
          if (!session.available()) throw new AttachmentStoreConflict();
          await session.uploader.resume(row.id);
        });
      },
    };
  };
  const resume = (id: string) => perform(id, async () => {
    if (!session?.available()) throw new AttachmentStoreConflict();
    const row = await store.load(session.scope, id);
    if (!row || row.composer?.threadId !== session.threadId || row.consumers.length) throw new AttachmentStoreConflict();
    if (row.phase === "copying") await session.uploader.recoverCopy(id);
    await session.uploader.resume(id);
  });
  const discard = (id: string) => perform(id, async () => {
    if (!session) throw new AttachmentStoreConflict();
    const row = await store.load(session.scope, id);
    if (!row || row.composer?.threadId !== session.threadId || row.consumers.length) throw new AttachmentStoreConflict();
    if (!row.wire && !row.scopeId && ["copying", "prepared"].includes(row.phase)) await store.discardSource(session.scope, row);
    else {
      if (!session.available()) throw new AttachmentStoreConflict();
      await session.uploader.cancel(id);
    }
  });
  const checkConsumer = (id: string) => perform(id, async () => {
    if (!session?.available()) throw new AttachmentStoreConflict();
    const row = await store.load(session.scope, id);
    const leader = row?.consumers[0]?.leaderId;
    const batch = leader ? (await store.load(session.scope, leader))?.consumerBatch : undefined;
    // This recovery action cannot create a reserve, send a turn, or clean up bytes.
    if (!batch || batch.threadId !== session.threadId || batch.phase === "prepared") throw new AttachmentStoreConflict();
    await session.consumers.reserveOrRead(batch);
  });
  const visible = session?.isCurrent() && projection.session === session ? projection : { rows: [] as StagedAttachmentRecord[], error: null, busy: [] as string[] };
  return { rows: visible.rows, error: visible.error, busy: visible.busy, available: session?.available() ?? false,
    pickerOwner, isPickerOwnerCurrent, captureSelection, resume, discard, checkConsumer };
}
