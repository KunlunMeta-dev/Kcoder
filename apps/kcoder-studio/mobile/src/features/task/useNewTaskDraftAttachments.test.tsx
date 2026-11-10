import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { useNewTaskDraftAttachments } from "./useNewTaskDraftAttachments";
import { installBrowserProfileFixture } from "@/test/browser-profile-fixture";
import { AttachmentManifestFixture } from "@/test/attachment-manifest-fixture";
import { profile, server } from "@/runtime/task-runtime/fixture.test-support";
const fixture = vi.hoisted(() => ({ backend: null as any, picker: vi.fn(), preview: vi.fn(() => "blob:owned-preview"), revoke: vi.fn() }));
vi.mock("@/storage/staged-attachment-bytes", () => ({ createAttachmentBytesBackend: () => fixture.backend }));
vi.mock("react-native", () => ({ Platform: { OS: "web" } }));
vi.mock("expo-document-picker", () => ({ getDocumentAsync: (...args: unknown[]) => fixture.picker(...args) }));
vi.mock("expo-image-picker", () => ({}));
vi.mock("expo-file-system", () => ({ File: class {} }));
vi.mock("./attachmentPreparation", () => ({ previewableRasterMimeType: (mime: string) => mime.startsWith("image/") ? mime : null, compressWebImage: async (blob: Blob) => blob }));
vi.mock("@/i18n", () => ({ t: (key: string) => key }));
vi.mock("@/runtime/task-runtime/new-catalog-read-source", () => ({ catalogReadScopeKey: (profile: any, server: any) => JSON.stringify([profile.id, profile.authorizationGeneration, server.id]) }));
let result!: ReturnType<typeof useNewTaskDraftAttachments>; let renderer: ReactTestRenderer | undefined;
const owner = {};
const client = { supportsExperimental: vi.fn(() => true), getAttachmentUploadAdmission: () => ({ version: 1, rootNamespace: "draft_fixture", admissionEpoch: 1 }), matchesRetainedAttachmentOwner: () => true, request: vi.fn() };
function Probe({ cwd = "/workspace", selected = profile }: { cwd?: string; selected?: typeof profile }) { result = useNewTaskDraftAttachments(selected, server, cwd, client as any, owner, true); return null; }
beforeEach(() => {
  installBrowserProfileFixture([profile]); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fixture.backend = new AttachmentManifestFixture(); fixture.picker.mockReset(); fixture.revoke.mockClear(); client.request.mockClear(); client.supportsExperimental.mockImplementation(() => true);
  vi.spyOn(URL, "createObjectURL").mockImplementation(fixture.preview); vi.spyOn(URL, "revokeObjectURL").mockImplementation(fixture.revoke);
});
afterEach(async () => { await act(async () => renderer?.unmount()); renderer = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function selection() { return { assets: [{ uri: "blob:picked", name: "sample.png", mimeType: "image/png", file: new Blob([new Uint8Array([1, 2])], { type: "image/png" }) }] }; }
it("copies bytes locally, previews and deletes before sending without any target RPC", async () => {
  fixture.picker.mockResolvedValue(selection());
  await act(async () => { renderer = create(<Probe />); });
  await act(async () => { await result.select("file"); });
  expect(result.items).toHaveLength(1); expect(result.items[0].previewUri).toBe("blob:owned-preview");
  expect(fixture.backend.bytes.size).toBe(1); expect(client.request).not.toHaveBeenCalled();
  const id = result.items[0].id;
  await act(async () => { await result.remove(id); });
  expect(result.items).toEqual([]); expect(fixture.backend.bytes.size).toBe(0); expect(fixture.revoke).toHaveBeenCalledWith("blob:owned-preview");
});
it("freezes exact draft IDs and unlocks only an entirely local, definitely-unsent selection", async () => {
  fixture.picker.mockResolvedValue(selection()); await act(async () => { renderer = create(<Probe />); });
  await act(async () => { await result.select("file"); });
  let frozen: any; await act(async () => { frozen = result.freeze(); });
  const row = [...fixture.backend.rows.values()][0] as any;
  expect(frozen).toEqual({ localAttachmentIds: [row.id], attachmentDraftId: row.draftId, attachmentTransport: "legacy" }); expect(row.threadId).toBeUndefined(); expect(result.locked).toBe(true);
  await act(async () => { await result.unlockUnsent(); }); expect(result.locked).toBe(false);
  await act(async () => { result.freeze(); }); row.phase = "unknown"; fixture.backend.rows.set(row.id, row);
  await act(async () => { await result.unlockUnsent().catch(() => {}); }); expect(result.locked).toBe(true);
});
it.each(["cwd", "profile"])("drops a late picker result after %s changes", async change => {
  let finish!: (value: unknown) => void; fixture.picker.mockReturnValue(new Promise(done => { finish = done; }));
  await act(async () => { renderer = create(<Probe />); }); let pending!: Promise<void>;
  await act(async () => { pending = result.select("file"); });
  await act(async () => { renderer!.update(<Probe cwd={change === "cwd" ? "/other" : "/workspace"} selected={change === "profile" ? { ...profile, id: "other" } : profile} />); });
  await act(async () => { finish(selection()); await pending; });
  expect(result.items).toEqual([]); expect(fixture.backend.bytes.size).toBe(0); expect(client.request).not.toHaveBeenCalled();
});
it("requires both receipt capabilities before enabling initial attachments", async () => {
  client.supportsExperimental.mockImplementation((name?: string) => name !== "turnReceiptsV1");
  await act(async () => { renderer = create(<Probe />); }); expect(result.available).toBe(false);
  await act(async () => { await result.select("file"); }); expect(fixture.picker).not.toHaveBeenCalled();
});

it("cleans only this hook's unfrozen local bytes on unmount and preserves frozen recovery bytes", async () => {
  fixture.picker.mockResolvedValue(selection());
  await act(async () => { renderer = create(<Probe />); });
  await act(async () => { await result.select("file"); });
  await act(async () => { renderer!.unmount(); }); renderer = undefined;
  await vi.waitFor(() => expect(fixture.backend.bytes.size).toBe(0));
  await act(async () => { renderer = create(<Probe />); });
  await act(async () => { await result.select("file"); result.freeze(); });
  await act(async () => { renderer!.unmount(); }); renderer = undefined;
  expect(fixture.backend.bytes.size).toBe(1);
});
it("reclaims a cancelled freeze before the creation journal exists, even after the route unmounts", async () => {
  fixture.picker.mockResolvedValue(selection());
  await act(async () => { renderer = create(<Probe />); });
  await act(async () => { await result.select("file"); result.freeze(); });
  const captured = result;
  await act(async () => { renderer!.unmount(); }); renderer = undefined;
  expect(fixture.backend.bytes.size).toBe(1);
  await captured.releaseUnclaimed();
  await vi.waitFor(() => expect(fixture.backend.bytes.size).toBe(0));
  expect(client.request).not.toHaveBeenCalled();
});
