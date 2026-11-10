import { beforeEach, expect, it, vi } from "vitest";
import { installBrowserProfileFixture } from "@/test/browser-profile-fixture";
import { AttachmentManifestFixture } from "@/test/attachment-manifest-fixture";
import { StagedAttachmentStore } from "@/storage/staged-attachment-store";
import { profile, server } from "./fixture.test-support";
import { prepareInitialTurn } from "./initialTurn";
import type { TaskCreationInput } from "./types";
const fixture = vi.hoisted(() => ({ backend: null as any }));
vi.mock("@/storage/staged-attachment-bytes", () => ({ createAttachmentBytesBackend: () => fixture.backend }));
const admission = { version: 1 as const, rootNamespace: "initial_turn", admissionEpoch: 1 };
const scopeId = "a".repeat(64);
beforeEach(() => { installBrowserProfileFixture([profile]); fixture.backend = new AttachmentManifestFixture(); });
async function setup() {
  const store = new StagedAttachmentStore(); const context = { profile, server, workspacePath: "/workspace", isCurrent: () => true };
  const blob = new Blob([new Uint8Array([1, 2, 3])]);
  const row = await store.prepare(context, admission, "first.png", { blob, size: blob.size, async read(offset, length) { return new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer()); } }, undefined, { draftId: "original-draft", mimeType: "image/png" });
  let reserve: any; let lost = false;
  const request = vi.fn(async (method: string, params: any) => {
    if (method.startsWith("attachment/retention/upload/")) {
      return { clientOwnerRequestId: row.ownerRequest.clientOwnerRequestId, clientUploadId: row.clientUploadId, scopeId,
        lookup: { outcome: "present", filename: row.filename, size: row.size, contentSha256: row.contentSha256,
          recovery: { rootNamespace: admission.rootNamespace, epoch: 1, state: "sealed", confirmedBytes: row.size,
            stageRef: { rootNamespace: admission.rootNamespace, epoch: 1, ownerId: "owner", entryId: "first-image", revision: 1 } } } };
    }
    if (method === "attachment/retention/reserve") {
      reserve = { scopeId, result: { receipt: { clientRequestId: params.clientRequestId, retentionId: `r1.initial_turn.1.${"b".repeat(32)}`, threadId: params.threadId, revision: 1, state: "ready", entries: params.stageRefs.map((stageRef: any) => ({ stageRef, state: "ready" })) } } };
      if (lost) throw new Error("lost reserve ACK");
      return reserve;
    }
    if (method === "attachment/retention/read") return reserve;
    throw new Error(`Unexpected RPC ${method}`);
  });
  const client = { request, supportsExperimental: () => true, getAttachmentUploadAdmission: () => admission, matchesRetainedAttachmentOwner: () => true };
  const input: TaskCreationInput = { profile, server, cwd: "/workspace", prompt: "first image", permissionMode: "ask", reasoningEffort: "high", localAttachmentIds: [row.id], attachmentDraftId: "original-draft" };
  return { store, context, row, input, client, request, loseReserve: () => { lost = true; } };
}
it("prepares initial retained attachments with real local bytes and exact thread/message/permission descriptors", async () => {
  const f = await setup();
  expect(f.request).not.toHaveBeenCalled();
  const params = await prepareInitialTurn(f.client as any, f.input, "real-thread", "create-original-initial-turn", "provider::chosen", () => true);
  expect(params).toMatchObject({ threadId: "real-thread", clientMessageId: "create-original-initial-turn", permissionMode: "ask", reasoningEffort: "high", model: "provider::chosen",
    retention: { references: [{ entryIds: ["first-image"] }], attachments: [{ entryId: "first-image", filename: "first.png", mimeType: "image/png" }] } });
  expect(f.request.mock.calls.map(([method]) => method)).toEqual(["attachment/retention/upload/save", "attachment/retention/reserve"]);
  const row = await f.store.load(f.context, f.row.id); expect(row?.consumerBatch?.threadId).toBe("real-thread"); expect(row?.consumerBatch?.draftId).toBe("original-draft"); expect(row?.phase).toBe("sourceRemoved");
  expect(fixture.backend.bytes.size).toBe(0);
});
it("reads the same reserve after a lost ACK, preserves original IDs and never allocates another upload or reserve", async () => {
  const f = await setup(); f.loseReserve();
  await expect(prepareInitialTurn(f.client as any, f.input, "real-thread", "original-message", undefined, () => true)).rejects.toThrow();
  const before = await f.store.load(f.context, f.row.id);
  expect(before?.consumerBatch?.phase).toBe("reserveSent"); expect(fixture.backend.bytes.size).toBe(1);
  const params = await prepareInitialTurn(f.client as any, f.input, "real-thread", "original-message", undefined, () => true);
  expect(params.clientMessageId).toBe("original-message");
  expect(f.request.mock.calls.map(([method]) => method)).toEqual(["attachment/retention/upload/save", "attachment/retention/reserve", "attachment/retention/read"]);
  const after = await f.store.load(f.context, f.row.id); expect(after?.clientUploadId).toBe(before?.clientUploadId); expect(after?.consumerBatch?.reserveId).toBe(before?.consumerBatch?.reserveId);
});
it("rejects another draft or stale owner before uploading any bytes", async () => {
  const f = await setup();
  await expect(prepareInitialTurn(f.client as any, { ...f.input, attachmentDraftId: "another-draft" }, "thread", "message", undefined, () => true)).rejects.toThrow();
  await expect(prepareInitialTurn(f.client as any, f.input, "thread", "message", undefined, () => false)).rejects.toThrow();
  expect(f.request).not.toHaveBeenCalled(); expect(fixture.backend.bytes.size).toBe(1);
});
