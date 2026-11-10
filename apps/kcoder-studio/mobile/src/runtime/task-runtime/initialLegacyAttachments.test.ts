import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installBrowserProfileFixture } from "@/test/browser-profile-fixture";
import { AttachmentManifestFixture } from "@/test/attachment-manifest-fixture";
import { DraftAttachmentStore } from "@/storage/draft-attachment-store";
import { loadPendingThreadCreation, pendingThreadCreationKey } from "@/storage/pending-thread-creation";
import { MobileRpcError, type JsonRecord } from "@/gateway/rpc";
import { TaskRuntime, taskRuntimeTestHelpers } from "../task-runtime";
import { FakeClient, profile, server } from "./fixture.test-support";
import { prepareInitialLegacyAttachments } from "./initialLegacyAttachments";
import type { TaskCreationInput } from "./types";
const fixture = vi.hoisted(() => ({ backend: null as any }));
vi.mock("@/storage/staged-attachment-bytes", () => ({ createAttachmentBytesBackend: () => fixture.backend }));
vi.mock("@/gateway/http", () => ({ ensureGatewayAuthorization: async () => {}, gatewaySessionExpired: async () => false }));
beforeEach(() => { installBrowserProfileFixture([profile]); fixture.backend = new AttachmentManifestFixture(); });
afterEach(() => { taskRuntimeTestHelpers.resetConnector(); vi.restoreAllMocks(); });
async function setup(size = 3) {
  const store = new DraftAttachmentStore(); const context = { profile, server, workspacePath: "/workspace", isCurrent: () => true };
  const blob = new Blob([new Uint8Array(size).fill(17)]);
  const row = await store.prepare(context, "legacy-draft", "first.png", "image/png", { size: blob.size, blob, async read(offset, length) { return new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer()); } });
  const input: TaskCreationInput = { profile, server, cwd: "/workspace", prompt: "original files", permissionMode: "ask", localAttachmentIds: [row.id], attachmentDraftId: "legacy-draft", attachmentTransport: "legacy" };
  const calls: { client: FakeClient; method: string; params: JsonRecord }[] = [];
  let failure: "upload" | "retain" | "turn" | undefined; let serial = 0;
  const clients: FakeClient[] = [];
  const connect = vi.fn(async () => {
    const client = new FakeClient([]); const base = client.request.bind(client); const index = ++serial;
    client.supportsExperimental = (name: string) => ["threadCreationReceiptsV1", "turnReceiptsV1", "turnPermissions"].includes(name);
    Object.assign(client, { matchesRetainedAttachmentOwner: () => !client.closed });
    client.request = (async (method: string, params: JsonRecord = {}) => {
      calls.push({ client, method, params });
      if (method === "thread/start") return { thread: { id: "thread-1", cwd: "/workspace" } };
      if (method === "thread/creation/read") return { receipt: { status: "ready", threadId: "thread-1", thread: { id: "thread-1", cwd: "/workspace" } } };
      if (method === "attachment/save") { if (failure === "upload") throw new MobileRpcError("lost upload ACK", -1, "transport"); return { path: `/owned/${index}/first.png` }; }
      if (method === "gateway/attachments/retain") return failure === "retain" ? { retained: true, paths: ["/foreign"] } : { retained: true, paths: params.paths };
      if (method === "turn/start") { if (failure === "turn") throw new MobileRpcError("lost turn ACK", -1, "transport"); return { turn: { id: "initial-turn", status: "running" } }; }
      if (method === "turn/receipt/read") { if (failure === "turn") throw new Error("receipt unavailable"); return { receipt: { threadId: "thread-1", turnId: "initial-turn", status: "running" } }; }
      return base(method, params);
    }) as never;
    clients.push(client); return client as never;
  });
  taskRuntimeTestHelpers.setConnector(connect as never);
  const key = pendingThreadCreationKey(profile, server, input.cwd);
  return { store, context, row, input, calls, clients, connect, key, fail: (mode?: typeof failure) => { failure = mode; } };
}
it("uses ordinary legacy upload and exact scoped retain on the one creation client, without V1 admission", async () => {
  const f = await setup(); expect(f.calls).toEqual([]);
  const task = await TaskRuntime.create(f.input);
  expect(f.connect).toHaveBeenCalledOnce();
  expect(f.calls.filter(call => ["thread/start", "attachment/save", "gateway/attachments/retain", "turn/start"].includes(call.method)).map(call => call.method)).toEqual(["thread/start", "attachment/save", "gateway/attachments/retain", "turn/start"]);
  expect(new Set(f.calls.map(call => call.client)).size).toBe(1);
  const turn = f.calls.find(call => call.method === "turn/start")!.params;
  expect((turn.input as any)[0].text).toContain('<kcoder_attachments version="1">');
  expect((turn.input as any)[0].text).toContain('"mimeType":"image/png"'); expect((turn.input as any)[0].text).toContain('"path":"/owned/1/first.png"');
  expect(turn).toMatchObject({ threadId: "thread-1", permissionMode: "ask" }); expect(turn.retention).toBeUndefined();
  expect(task.getSnapshot().messages[0].attachments?.[0].path).toBe("/owned/1/first.png");
  expect(await loadPendingThreadCreation(f.key)).toBeNull(); expect(fixture.backend.bytes.size).toBe(0); task.close();
});
it("preserves an upload-unknown original thread and bytes; only an explicit action prepares again", async () => {
  const f = await setup(); f.fail("upload");
  await expect(TaskRuntime.create(f.input)).rejects.toThrow("lost upload ACK");
  const pending = await loadPendingThreadCreation(f.key); expect(pending).toMatchObject({ threadId: "thread-1", dispatched: true }); expect(pending?.turnDispatched).not.toBe(true);
  expect((await f.store.load(f.context, f.row.id))?.phase).toBe("unknown"); expect(fixture.backend.bytes.size).toBe(1);
  f.fail(); await expect(TaskRuntime.create(f.input)).rejects.toThrow();
  expect(f.calls.filter(call => call.method === "attachment/save")).toHaveLength(1);
  const task = await TaskRuntime.create({ ...f.input, reprepareInitialAttachments: true });
  expect(f.calls.filter(call => call.method === "thread/start")).toHaveLength(1);
  expect(f.calls.filter(call => call.method === "attachment/save")).toHaveLength(2);
  expect(f.calls.find(call => call.method === "turn/start")?.params.clientMessageId).toBe(`${pending?.clientRequestId}-initial-turn`);
  expect(fixture.backend.bytes.size).toBe(0); task.close();
});
it("reads an unknown original turn without uploading, retaining or sending again", async () => {
  const f = await setup(); f.fail("turn"); const first = await TaskRuntime.create(f.input);
  expect(first.getSnapshot().sendAcceptanceUnknown).toBe(true); first.close();
  const pending = await loadPendingThreadCreation(f.key); expect(pending?.turnDispatched).toBe(true); expect(pending?.legacyAttachments).toHaveLength(1);
  expect(fixture.backend.bytes.size).toBe(1); f.fail(); const task = await TaskRuntime.create({ ...f.input, reprepareInitialAttachments: true });
  expect(task.getSnapshot().sendAcceptanceUnknown).toBe(false);
  for (const method of ["thread/start", "attachment/save", "gateway/attachments/retain", "turn/start"]) expect(f.calls.filter(call => call.method === method)).toHaveLength(1);
  expect(f.calls.filter(call => call.method === "turn/receipt/read").at(-1)?.params.clientMessageId).toBe(`${pending?.clientRequestId}-initial-turn`);
  expect(fixture.backend.bytes.size).toBe(0); expect(await loadPendingThreadCreation(f.key)).toBeNull(); task.close();
});
it("refuses a mismatched retain ACK and never hands its unconfirmed old path to another client", async () => {
  const f = await setup(); f.fail("retain"); await expect(TaskRuntime.create(f.input)).rejects.toThrow();
  expect(f.calls.some(call => call.method === "turn/start")).toBe(false);
  f.fail(); await expect(TaskRuntime.create(f.input)).rejects.toThrow();
  expect(f.calls.filter(call => call.method === "attachment/save")).toHaveLength(1);
  expect(f.calls.filter(call => call.method === "gateway/attachments/retain")).toHaveLength(1);
  expect(fixture.backend.bytes.size).toBe(1);
});
it("rejects changed local bytes before any upload or path binding", async () => {
  const f = await setup(); fixture.backend.bytes.set(f.row.id, new Blob([new Uint8Array([9, 9, 9])]));
  await expect(TaskRuntime.create(f.input)).rejects.toThrow();
  expect(f.calls.some(call => call.method.startsWith("attachment/") || call.method === "gateway/attachments/retain" || call.method === "turn/start")).toBe(false);
});
it("checks owner before every chunk and uses only the captured client for exact cancellation", async () => {
  const f = await setup(300 * 1024); let current = true;
  const client = new FakeClient([]); Object.assign(client, { matchesRetainedAttachmentOwner: () => true });
  client.request = vi.fn(async (method: string) => {
    if (method === "attachment/upload/start") return { upload_id: "own-upload" };
    if (method === "attachment/upload/chunk") { current = false; return {}; }
    if (method === "attachment/upload/cancel") return { cancelled: true };
    throw new Error(`Unexpected ${method}`);
  }) as never;
  await expect(prepareInitialLegacyAttachments(client as any, f.input, "thread-1", () => current)).rejects.toThrow();
  expect((client.request as any).mock.calls.map(([method]: any[]) => method)).toEqual(["attachment/upload/start", "attachment/upload/chunk", "attachment/upload/cancel"]);
  expect(fixture.backend.bytes.size).toBe(1);
});
it("clears the exact creation journal and local bytes when the task page later confirms the original receipt", async () => {
  const f = await setup(); f.fail("turn"); const task = await TaskRuntime.create(f.input);
  expect(task.getSnapshot().sendAcceptanceUnknown).toBe(true); expect(fixture.backend.bytes.size).toBe(1);
  f.fail(); await task.reconcileSendAcceptance();
  expect(await loadPendingThreadCreation(f.key)).toBeNull(); expect(fixture.backend.bytes.size).toBe(0);
  expect(f.calls.filter(call => call.method === "attachment/save")).toHaveLength(1); expect(f.calls.filter(call => call.method === "turn/start")).toHaveLength(1); task.close();
});
it.each(["attachment/save", "attachment/upload/start"])("reclaims a stale successful %s handle using its original client", async method => {
  const f = await setup(method === "attachment/save" ? 3 : 300 * 1024); let current = true;
  const client = new FakeClient([]); Object.assign(client, { matchesRetainedAttachmentOwner: () => true });
  client.request = vi.fn(async (request: string) => {
    if (request === method) { current = false; return method === "attachment/save" ? { path: "/own/stale-file" } : { upload_id: "own-stale-upload" }; }
    if (request === "attachment/delete") return { removed: true };
    if (request === "attachment/upload/cancel") return { cancelled: true };
    throw new Error(`Unexpected ${request}`);
  }) as never;
  await expect(prepareInitialLegacyAttachments(client as any, f.input, "thread-1", () => current)).rejects.toThrow();
  expect((client.request as any).mock.calls.map(([name]: any[]) => name)).toEqual([method, method === "attachment/save" ? "attachment/delete" : "attachment/upload/cancel"]);
  expect(fixture.backend.bytes.size).toBe(1);
});
it("persists and reloads a 50000-character original prompt with attachments and exact first-turn IDs", async () => {
  const f = await setup(); f.input.prompt = "文".repeat(50_000); f.fail("turn");
  const first = await TaskRuntime.create(f.input); first.close();
  const pending = await loadPendingThreadCreation(f.key);
  expect(pending?.input?.prompt).toBe(f.input.prompt);
  expect((pending?.initialTurnParams?.input as any)[0].text).toContain(f.input.prompt);
  expect(JSON.stringify(pending).length).toBeGreaterThan(65_536);
  f.fail(); const task = await TaskRuntime.create(f.input);
  expect(f.calls.filter(call => call.method === "turn/start")).toHaveLength(1);
  expect(f.calls.filter(call => call.method === "attachment/save")).toHaveLength(1);
  expect(f.calls.filter(call => call.method === "turn/receipt/read").at(-1)?.params.clientMessageId).toBe(`${pending?.clientRequestId}-initial-turn`);
  expect(await loadPendingThreadCreation(f.key)).toBeNull(); task.close();
});
