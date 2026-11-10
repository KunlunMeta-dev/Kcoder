import { useEffect, useRef, useState } from "react";
import { Platform } from "react-native";
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import { File } from "expo-file-system";
import type { GatewayProfile, KCoderServer } from "@/gateway/types";
import type { GatewayRpcClient } from "@/gateway/rpc";
import { catalogReadScopeKey } from "@/runtime/task-runtime/new-catalog-read-source";
import type { AttachmentStoreContext } from "@/storage/staged-attachment-store";
import { DraftAttachmentStore, type DraftAttachmentRecord } from "@/storage/draft-attachment-store";
import { MAX_ATTACHMENT_BYTES } from "@/protocol/attachment-limits";
import { MAX_ATTACHMENTS_PER_TURN } from "@/components/attachment-selection";
import { t } from "@/i18n";
import { loadPendingThreadCreation, pendingThreadCreationKey } from "@/storage/pending-thread-creation";
import { compressWebImage, previewableRasterMimeType, webBase64Blob } from "./attachmentPreparation";
import type { AttachmentAsset } from "./types";

export interface DraftLocalAttachment { id: string; filename: string; mimeType: string; fileSize: number; previewUri?: string }
type DraftSession = { key: string; draftId: string; rows: DraftAttachmentRecord[]; items: DraftLocalAttachment[]; locked: boolean; context?: AttachmentStoreContext };

/** Local bytes have a draft identity and exact target owner, never a pretend remote path. */
export function useNewTaskDraftAttachments(profile: GatewayProfile | null, server: KCoderServer | undefined, cwd: string,
  client: GatewayRpcClient | null, draftOwner: object, enabled: boolean) {
  const key = profile && server && cwd ? JSON.stringify([catalogReadScopeKey(profile, server), server.observationTargetIdentity, cwd]) : "";
  const sessions = useRef<{ owner: object; entries: Map<string, DraftSession> }>({ owner: draftOwner, entries: new Map() });
  const retired = useRef<DraftSession[]>([]);
  if (sessions.current.owner !== draftOwner) { retired.current.push(...sessions.current.entries.values()); sessions.current = { owner: draftOwner, entries: new Map() }; }
  if (key && !sessions.current.entries.has(key)) sessions.current.entries.set(key, {
    key, draftId: `mobile-draft-${Date.now()}-${Math.random().toString(36).slice(2)}`, rows: [], items: [], locked: false,
  });
  const session = sessions.current.entries.get(key);
  const latest = useRef({ key, client, enabled, draftOwner });
  latest.current = { key, client, enabled, draftOwner };
  const mounted = useRef(false);
  const batch = useRef<object | null>(null);
  const [, redraw] = useState(0);
  const [sheet, setSheet] = useState<{ key: string; open: boolean }>({ key, open: false });
  const [failure, setFailure] = useState<{ key: string; error: string } | null>(null);
  const store = useRef(new DraftAttachmentStore()).current;
  const available = Boolean(enabled && profile && server && session && client?.supportsExperimental("turnReceiptsV1") && client.supportsExperimental("threadCreationReceiptsV1") && client.matchesRetainedAttachmentOwner(profile, server, cwd));
  const releaseLocalSession = (entry: DraftSession) => {
    for (const item of entry.items) if (item.previewUri?.startsWith("blob:")) URL.revokeObjectURL(item.previewUri);
    if (entry.locked || !entry.context) return;
    const context = { ...entry.context, isCurrent: () => true };
    // Cleanup owns only IDs copied by this hook. Profile fences still apply.
    void Promise.all(entry.rows.map(async selected => {
      const row = await store.load(context, selected.id);
      if (row?.draftId === entry.draftId && ["copying", "prepared"].includes(row.phase)) await store.discardSource(context, row);
    })).catch(() => {});
  };
  useEffect(() => { for (const entry of retired.current.splice(0)) releaseLocalSession(entry); }, [draftOwner]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; for (const entry of [...retired.current.splice(0), ...sessions.current.entries.values()]) releaseLocalSession(entry); };
  }, []);
  useEffect(() => { setSheet({ key, open: false }); batch.current = null; redraw(value => value + 1); }, [key, enabled, client]);
  const capture = () => {
    if (!available || !profile || !server || !client || !session || session.locked) return null;
    const connection = client;
    const isCurrent = () => mounted.current && latest.current.key === key && latest.current.client === connection && latest.current.enabled && latest.current.draftOwner === draftOwner;
    const context: AttachmentStoreContext = { profile: { ...profile }, server: { ...server }, workspacePath: cwd, isCurrent };
    session.context = context;
    return { connection, isCurrent, context, session };
  };
  const select = async (kind: "file" | "image" | "camera") => {
    const owner = capture();
    if (!owner || batch.current) return;
    const token = {}; batch.current = token; redraw(value => value + 1); setFailure(null);
    try {
      const slots = MAX_ATTACHMENTS_PER_TURN - owner.session.items.length;
      if (slots <= 0) throw new Error(t("task.a_turn_can_have_at_most_attachments", { p0: MAX_ATTACHMENTS_PER_TURN }));
      let assets: AttachmentAsset[];
      if (kind === "file") {
        const result = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, multiple: true });
        assets = (result.assets ?? []).slice(0, slots).map(asset => ({ uri: asset.uri, name: asset.name, mimeType: asset.mimeType, size: asset.size, blob: asset.file }));
      } else {
        if (kind === "camera" && !(await ImagePicker.requestCameraPermissionsAsync()).granted) throw new Error(t("task.camera_permission_is_required_to_take_photos_you"));
        const result = kind === "camera" ? await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], quality: 0.85, base64: Platform.OS === "web" })
          : await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], quality: 0.9, base64: Platform.OS === "web", allowsMultipleSelection: true, selectionLimit: slots });
        assets = (result.assets ?? []).slice(0, slots).map((asset, index) => ({ uri: asset.uri, name: asset.fileName ?? `image-${Date.now()}-${index}.jpg`, mimeType: asset.mimeType, size: asset.fileSize, base64: asset.base64 }));
      }
      for (const asset of assets) {
        if (!owner.isCurrent() || batch.current !== token) return;
        let mimeType = asset.mimeType || "application/octet-stream";
        let filename = asset.name.replace(/[\\/\u0000-\u001f\u007f]/g, "_").slice(0, 255) || "attachment";
        let blob = Platform.OS === "web" ? asset.blob ?? (asset.base64 ? webBase64Blob(asset.base64, mimeType) : await (await fetch(asset.uri)).blob()) : undefined;
        if (blob && previewableRasterMimeType(mimeType) && mimeType !== "image/gif" && blob.size > 256 * 1024) {
          const compressed = await compressWebImage(blob);
          if (compressed !== blob) { blob = compressed; mimeType = "image/jpeg"; filename = `${filename.replace(/\.[^.]+$/, "")}.jpg`; }
        }
        const file = Platform.OS !== "web" ? new File(asset.uri) : null;
        const size = blob?.size ?? file?.size ?? asset.size ?? 0;
        if (!Number.isSafeInteger(size) || size < 0 || size > MAX_ATTACHMENT_BYTES) throw new Error(t("task.an_attachment_cannot_exceed_50_mib"));
        if (!owner.isCurrent() || batch.current !== token) return;
        const row = await store.prepare(owner.context, owner.session.draftId, filename, mimeType,
          { size, blob, async read(offset, length) {
            if (!owner.isCurrent()) throw new Error("Draft attachment owner changed");
            if (blob) return new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer());
            const handle = file!.open(); try { handle.offset = offset; return handle.readBytesSync(length); } finally { handle.close(); }
          } });
        owner.session.rows.push(row);
        if (!owner.isCurrent() || batch.current !== token) {
          // Reclaim only this newly copied, never uploaded local source.
          await store.discardSource({ ...owner.context, isCurrent: () => true }, row).catch(() => {});
          return;
        }
        const previewUri = previewableRasterMimeType(mimeType) ? blob ? URL.createObjectURL(blob) : asset.uri : undefined;
        owner.session.items.push({ id: row.id, filename, mimeType, fileSize: size, previewUri });
        redraw(value => value + 1);
      }
      if (owner.isCurrent()) setSheet({ key, open: false });
    } catch (error) {
      if (owner.isCurrent()) setFailure({ key, error: error instanceof Error ? error.message : String(error) });
    } finally { if (batch.current === token) { batch.current = null; redraw(value => value + 1); } }
  };
  const remove = async (id: string) => {
    const owner = capture();
    if (!owner || batch.current) return;
    const token = {}; batch.current = token; redraw(value => value + 1);
    try {
      const row = await store.load(owner.context, id);
      if (!row || row.draftId !== owner.session.draftId || row.phase !== "prepared") throw new Error("Draft attachment is already bound to a submission");
      await store.discardSource(owner.context, row);
      if (!owner.isCurrent()) return;
      const item = owner.session.items.find(value => value.id === id);
      if (item?.previewUri?.startsWith("blob:")) URL.revokeObjectURL(item.previewUri);
      owner.session.items = owner.session.items.filter(value => value.id !== id);
      owner.session.rows = owner.session.rows.filter(value => value.id !== id);
      redraw(value => value + 1);
    } catch (error) { if (owner.isCurrent()) setFailure({ key, error: error instanceof Error ? error.message : String(error) }); }
    finally { if (batch.current === token) { batch.current = null; redraw(value => value + 1); } }
  };
  const unlockUnsent = async () => {
    if (!profile || !server || !session) return;
    const captured = session;
    const context = { profile, server, workspacePath: cwd, isCurrent: () => mounted.current && latest.current.key === key && latest.current.draftOwner === draftOwner };
    const rows = await Promise.all(captured.items.map(item => store.load(context, item.id)));
    if (rows.some(row => !row || row.phase !== "prepared")) return;
    if (!context.isCurrent()) return;
    captured.locked = false; redraw(value => value + 1);
  };
  const releaseUnclaimed = async () => {
    if (!profile || !server || !session?.locked) return;
    const pending = await loadPendingThreadCreation(pendingThreadCreationKey(profile, server, cwd));
    const input = pending?.linked?.input ?? pending?.input;
    if (input?.attachmentDraftId === session.draftId) return;
    const context = { profile, server, workspacePath: cwd, isCurrent: () => true };
    const rows = await Promise.all(session.items.map(item => store.load(context, item.id)));
    if (rows.some(row => !row || row.draftId !== session.draftId || row.phase !== "prepared")) return;
    session.locked = false;
    if (!mounted.current || latest.current.key !== key || latest.current.draftOwner !== draftOwner) releaseLocalSession(session);
    else redraw(value => value + 1);
  };
  const freeze = () => {
    if (!session?.items.length) return {};
    if (!available || batch.current) throw new Error("Draft attachments are not ready");
    session.locked = true;
    redraw(value => value + 1);
    return { localAttachmentIds: session.items.map(item => item.id), attachmentDraftId: session.draftId, attachmentTransport: "legacy" as const };
  };
  return { items: session?.items ?? [], available, busy: Boolean(batch.current), locked: session?.locked ?? false,
    error: failure?.key === key ? failure.error : null, sheetOpen: enabled && sheet.key === key && sheet.open,
    open: () => { if (available && !session?.locked) setSheet({ key, open: true }); }, close: () => setSheet({ key, open: false }), select, remove, freeze, unlockUnsent, releaseUnclaimed };
}
export type NewTaskDraftAttachments = ReturnType<typeof useNewTaskDraftAttachments>;
