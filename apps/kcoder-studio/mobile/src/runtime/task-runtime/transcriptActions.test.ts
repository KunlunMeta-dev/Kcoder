import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MobileRpcError, type JsonRecord } from "@/gateway/rpc";
import type { ThreadMessage } from "@/gateway/types";
import { installBrowserProfileFixture } from "@/test/browser-profile-fixture";
import { captureWorkspaceProfileIdentity } from "@/storage/workspace-profile-fence";
import { loadWorkspaceState, saveWorkspaceState, workspaceStateAuthorizationScope } from "@/storage/workspace-preferences";
import { TaskRuntime } from "./core";
import { taskRuntimeRegistry } from "./registry";
import { taskRuntimeTestHelpers } from "./connectionFactory";
import { FakeClient, profile as baseProfile, server } from "./fixture.test-support";
import { completedForkMessage, lastEditableMessage } from "./transcriptActions";

const store = vi.hoisted(() => new Map<string, string>());
vi.mock("@react-native-async-storage/async-storage", () => ({ default: {
  getItem: async (key: string) => store.get(key) ?? null,
  setItem: async (key: string, value: string) => { store.set(key, value); },
  removeItem: async (key: string) => { store.delete(key); },
  getAllKeys: async () => [...store.keys()],
} }));
const profile = { ...baseProfile, authorizationGeneration: "transcript-tests", deviceId: "device" };
const scope = workspaceStateAuthorizationScope(profile, server);
const message = (id: string, role: string, content: string, turnId = "turn-1"): ThreadMessage => ({ id, role, content, turnId, status: "completed", timestampMs: 1 });
let history: Array<ThreadMessage & { clientMessageId?: string }>;
let calls: Array<{ method: string; params: JsonRecord }>;
let rollbackFailure: "lost" | "partial" | undefined;
let forkLost: boolean;
let startFailure: "lost" | "rejected" | undefined;
let gate: Promise<void> | undefined;
let receipt: boolean;
let childModel: string | undefined;
let rejectChildModel: boolean;
let client: FakeClient;
const runtimes: TaskRuntime[] = [];
beforeEach(() => {
  childModel = undefined;
  rejectChildModel = false;
  store.clear(); installBrowserProfileFixture([profile]); calls = []; gate = undefined; receipt = false;
  rollbackFailure = undefined; forkLost = false; startFailure = undefined;
  history = [message("old-u", "user", "old", "old-turn"), message("old-a", "assistant", "old answer", "old-turn"),
    message("last-u", "user", "original"), message("last-a", "assistant", "answer")];
  client = new FakeClient([]);
  client.supportsExperimental = capability => ["turnReceiptsV1", "qualifiedModelSelectionV1", "turnPermissions"].includes(capability);
  client.request = async <T>(method: string, params: JsonRecord = {}): Promise<T> => {
    calls.push({ method, params });
    const childRequest = params.threadId === "child-thread";
    const thread = { id: childRequest ? "child-thread" : "thread-1", cwd: "/workspace", title: "Source", status: "idle", model: childRequest ? childModel : "provider::model" };
    if (method === "thread/resume") return { thread } as T;
    if (method === "thread/read") { if (gate) await gate; return { thread, messages: childRequest ? history.slice(0, 2) : [...history], hasMoreBefore: false } as T; }
    if (method === "thread/metadata/update") {
      if (rejectChildModel) throw new MobileRpcError("child model rejected", -32602, "remote");
      childModel = String(params.model); return { thread: { ...thread, model: childModel } } as T;
    }
    if (method === "thread/rollback") {
      history = history.slice(0, -2);
      if (rollbackFailure === "lost") throw new MobileRpcError("lost rewind ACK", -1, "transport", "unknown");
      return { threadId: "thread-1", removedMessages: 2, restoredFiles: 1, deletedFiles: 0, failedFiles: rollbackFailure === "partial" ? 1 : 0 } as T;
    }
    if (method === "thread/fork") {
      if (forkLost) throw new MobileRpcError("lost fork ACK", -1, "transport", "unknown");
      return { thread: { id: "child-thread", cwd: "/workspace" }, ephemeral: false } as T;
    }
    if (method === "turn/start") {
      if (startFailure === "rejected") throw new MobileRpcError("rejected start", -32602, "remote");
      if (startFailure === "lost") throw new MobileRpcError("lost start ACK", -1, "transport", "unknown");
      return { turn: { id: "new-turn", status: "running" } } as T;
    }
    if (method === "turn/receipt/read") {
      if (!receipt) return { receipt: null } as T;
      return { receipt: { threadId: params.threadId, clientMessageId: params.clientMessageId, turnId: "new-turn", status: "running", attemptId: "new-attempt" } } as T;
    }
    return {} as T;
  };
  taskRuntimeTestHelpers.setConnector((async () => client) as never);
});
afterEach(() => { taskRuntimeRegistry.removeProfile(profile.id); taskRuntimeRegistry.removeProfile("gateway-b"); runtimes.splice(0).forEach(task => task.close()); taskRuntimeTestHelpers.resetConnector(); });
async function runtime() {
  const task = await TaskRuntime.resume({ profile, server, threadId: "thread-1", cwd: "/workspace" });
  runtimes.push(task); task.patch({ configurationReady: true, permissionMode: "ask", reasoningEffort: "high" }); return task;
}
const mutations = () => calls.filter(call => ["thread/rollback", "thread/fork", "turn/start"].includes(call.method));

it("rewinds exactly once, sends captured configuration, preserves the ordinary draft, and discards removed rows", async () => {
  const task = await runtime();
  await saveWorkspaceState(profile.id, server.id, "thread-1", { composerDraft: "unsent draft" }, scope, captureWorkspaceProfileIdentity(profile));
  await task.editLastMessage("last-u", "corrected question");
  expect(mutations().map(call => call.method)).toEqual(["thread/rollback", "turn/start"]);
  expect(mutations()[1].params).toMatchObject({ threadId: "thread-1", model: "provider::model", reasoningEffort: "high", permissionMode: "ask", input: [{ type: "text", text: "corrected question" }] });
  expect(task.snapshot.messages.map(row => row.id)).not.toContain("last-a");
  expect(task.snapshot.messages.at(-1)?.content).toBe("corrected question");
  expect((await loadWorkspaceState(profile.id, server.id, "thread-1", scope)).composerDraft).toBe("unsent draft");
  expect(await task.pendingTranscriptAction()).toBeUndefined();
});

it("does not rewind a stale last message or a running/interacting conversation", async () => {
  const task = await runtime();
  history.push(message("new-user", "user", "another question", "other-turn"));
  await expect(task.editLastMessage("last-u", "edited")).rejects.toThrow();
  expect(mutations()).toHaveLength(0);
  task.patch({ running: true });
  expect(lastEditableMessage(task.snapshot)).toBeUndefined();
  await expect(task.forkCompletedTurn("last-a")).rejects.toThrow();
});

it("matches an optimistic last-user row to persisted history by its stable send identity", async () => {
  history[2] = { ...history[2], clientMessageId: "stable-original-send" };
  const task = await runtime();
  task.patch({ messages: task.snapshot.messages.map(row => row.id === "last-u" ? { ...row, id: "local-user-original" } : row) });
  await task.editLastMessage("local-user-original", "edited");
  expect(mutations().map(call => call.method)).toEqual(["thread/rollback", "turn/start"]);
});

it("stops before resending on a partial rewind and retains the edited text across runtime recreation", async () => {
  const task = await runtime(); rollbackFailure = "partial";
  await expect(task.editLastMessage("last-u", "keep this correction")).rejects.toThrow();
  expect(mutations().map(call => call.method)).toEqual(["thread/rollback"]);
  const restored = await runtime();
  expect(await restored.pendingTranscriptAction()).toMatchObject({ phase: "blocked", text: "keep this correction" });
  await expect(restored.recoverTranscriptAction()).rejects.toThrow();
  await expect(restored.send("new question")).rejects.toThrow();
  expect(mutations()).toHaveLength(1);
});

it("never repeats a rewind after a lost acknowledgement or a repeated click", async () => {
  const task = await runtime(); rollbackFailure = "lost";
  const first = task.editLastMessage("last-u", "edited");
  await expect(task.editLastMessage("last-u", "duplicate")).rejects.toThrow();
  await expect(first).rejects.toThrow();
  expect(await task.pendingTranscriptAction()).toMatchObject({ phase: "rollbackSent", text: "edited" });
  const restored = await runtime();
  await expect(restored.recoverTranscriptAction()).rejects.toThrow();
  expect(mutations().map(call => call.method)).toEqual(["thread/rollback"]);
});

it("retries a definitely rejected send without another rewind", async () => {
  const task = await runtime(); startFailure = "rejected";
  await expect(task.editLastMessage("last-u", "edited")).rejects.toThrow();
  expect(await task.pendingTranscriptAction()).toMatchObject({ phase: "sendRejected" });
  startFailure = undefined;
  await task.recoverTranscriptAction();
  expect(mutations().map(call => call.method)).toEqual(["thread/rollback", "turn/start", "turn/start"]);
  expect(mutations()[1].params.clientMessageId).toBe(mutations()[2].params.clientMessageId);
});

it("reconciles an uncertain resend by receipt after reload, without sending or rewinding twice", async () => {
  const task = await runtime(); startFailure = "lost";
  await task.editLastMessage("last-u", "edited");
  expect(await task.pendingTranscriptAction()).toMatchObject({ phase: "sendSent" });
  const restored = await runtime();
  await expect(restored.recoverTranscriptAction()).rejects.toThrow();
  expect(mutations().map(call => call.method)).toEqual(["thread/rollback", "turn/start"]);
  receipt = true;
  await restored.recoverTranscriptAction();
  expect(await restored.pendingTranscriptAction()).toBeUndefined();
  expect(mutations().map(call => call.method)).toEqual(["thread/rollback", "turn/start"]);
});

it("isolates pending operations between Gateways and targets with identical workspace paths", async () => {
  const task = await runtime(); forkLost = true;
  await expect(task.forkCompletedTurn("last-a")).rejects.toThrow();
  const otherProfile = { ...profile, id: "gateway-b", baseUrl: "https://another.invalid" };
  installBrowserProfileFixture([profile, otherProfile]);
  const other = await TaskRuntime.resume({ profile: otherProfile, server, threadId: "thread-1", cwd: "/workspace" });
  runtimes.push(other);
  expect(await other.pendingTranscriptAction()).toBeUndefined();
  const otherTarget = await TaskRuntime.resume({ profile, server: { ...server, id: "target-b" }, threadId: "thread-1", cwd: "/workspace" });
  runtimes.push(otherTarget);
  expect(await otherTarget.pendingTranscriptAction()).toBeUndefined();
  expect(await task.pendingTranscriptAction()).toMatchObject({ phase: "forkSent" });
});

it("rejects an old cache read that finishes after rewind, including legacy histories without snapshot IDs", async () => {
  const task = await runtime();
  const oldPage = { thread: { id: "thread-1", cwd: "/workspace", title: "Source", status: "idle" }, messages: [...history] };
  const request = client.request.bind(client);
  let release!: () => void;
  let held = false;
  client.request = async <T>(method: string, params: JsonRecord = {}): Promise<T> => {
    if (method === "thread/read" && !held) {
      held = true;
      await new Promise<void>(resolve => { release = resolve; });
      return oldPage as T;
    }
    return request<T>(method, params);
  };
  const pendingRead = task.readConfirmedTranscriptPage(() => true);
  await task.editLastMessage("last-u", "edited");
  release();
  expect(await pendingRead).toBeNull();
  expect(task.snapshot.messages.map(row => row.id)).not.toContain("last-a");
  expect(task.confirmedTranscriptPage?.page.messages?.map(row => row.id)).not.toContain("last-a");
});

it("claims one rewind across concurrent same-scope runtimes", async () => {
  const first = await runtime(); const second = await runtime();
  const outcomes = await Promise.allSettled([first.editLastMessage("last-u", "edited"), second.editLastMessage("last-u", "duplicate")]);
  expect(outcomes.filter(outcome => outcome.status === "fulfilled")).toHaveLength(1);
  expect(mutations().map(call => call.method)).toEqual(["thread/rollback", "turn/start"]);
});

it("retains existing attachments before rewind and includes them exactly once in the edited request", async () => {
  const attachment = { filename: "note.txt", path: "/workspace/.kcoder/attachments/note.txt", mimeType: "text/plain", fileSize: 12 };
  history[2] = { ...history[2], content: `original\n\n<kcoder_attachments version="1">\n${JSON.stringify(attachment)}\n</kcoder_attachments>` };
  const task = await runtime();
  await task.editLastMessage("last-u", "edited");
  const retain = calls.findIndex(call => call.method === "gateway/attachments/retain");
  const rewind = calls.findIndex(call => call.method === "thread/rollback");
  expect(retain).toBeGreaterThanOrEqual(0); expect(retain).toBeLessThan(rewind);
  const wire = String((mutations()[1].params.input as Array<{ text: string }>)[0].text);
  expect(wire.match(/<kcoder_attachments/g)).toHaveLength(1);
  expect(wire).toContain(attachment.path);
  expect(task.snapshot.messages.at(-1)?.attachments).toEqual([attachment]);
});

it("rejects a request that local storage cannot preserve exactly before any destructive RPC", async () => {
  const task = await runtime();
  task.patch({ model: "x".repeat(257) });
  await expect(task.editLastMessage("last-u", "edited")).rejects.toThrow();
  expect(mutations()).toEqual([]);
  expect(await task.pendingTranscriptAction()).toBeUndefined();
});

it("keeps malformed persisted operations blocked rather than silently treating them as absent", async () => {
  const task = await runtime();
  await saveWorkspaceState(profile.id, server.id, "thread-1", { transcriptAction: { phase: "future-format" } as never }, scope, captureWorkspaceProfileIdentity(profile));
  expect(await task.pendingTranscriptAction()).toMatchObject({ phase: "blocked" });
  await expect(task.send("another question")).rejects.toThrow();
  expect(mutations()).toEqual([]);
});

it("does not resume a pending operation under a different working directory", async () => {
  const task = await runtime(); startFailure = "rejected";
  await expect(task.editLastMessage("last-u", "edited")).rejects.toThrow();
  task.patch({ cwd: "/another-workspace" });
  await expect(task.recoverTranscriptAction()).rejects.toThrow();
  expect(mutations().map(call => call.method)).toEqual(["thread/rollback", "turn/start"]);
});

it("forks a completed turn in the exact same workspace without rewriting source history", async () => {
  const task = await runtime(); const before = [...history];
  await expect(task.forkCompletedTurn("old-a")).resolves.toBe("child-thread");
  expect(mutations()).toEqual([{ method: "thread/fork", params: { threadId: "thread-1", lastTurnId: "old-turn", cwd: "/workspace", ephemeral: false, excludeTurns: true } }]);
  expect(history).toEqual(before);
  expect(taskRuntimeRegistry.get(profile.id, server.id, "child-thread")?.getSnapshot()).toMatchObject({ model: "provider::model", reasoningEffort: "high" });
  expect((await loadWorkspaceState(profile.id, server.id, "child-thread", scope)).reasoningEffort).toBe("high");
  expect(await task.recoverTranscriptAction()).toBe("child-thread");
  expect(mutations()).toHaveLength(1);
  await task.dismissTranscriptAction(); expect(task.snapshot.transcriptActionPending).toBe(false);
});

it("does not replay an unconfirmed fork after reloading", async () => {
  const task = await runtime(); forkLost = true;
  await expect(task.forkCompletedTurn("last-a")).rejects.toThrow();
  const restored = await runtime();
  await expect(restored.recoverTranscriptAction()).rejects.toThrow();
  expect(mutations().map(call => call.method)).toEqual(["thread/fork"]);
  expect(completedForkMessage({ ...task.snapshot.messages.at(-1)!, status: "streaming" })).toBe(false);
  expect(completedForkMessage({ ...task.snapshot.messages.at(-1)!, status: "completed" })).toBe(true);
  expect(completedForkMessage({ ...task.snapshot.messages.at(-1)!, status: "unknown" })).toBe(false);
});

it("recovers configuration of a known fork without creating another conversation", async () => {
  const task = await runtime(); rejectChildModel = true;
  await expect(task.forkCompletedTurn("last-a")).rejects.toThrow();
  expect(await task.pendingTranscriptAction()).toMatchObject({ phase: "forked", childThreadId: "child-thread" });
  rejectChildModel = false;
  expect(await task.recoverTranscriptAction()).toBe("child-thread");
  expect(calls.filter(call => call.method === "thread/fork")).toHaveLength(1);
  expect(await task.pendingTranscriptAction()).toMatchObject({ phase: "forkReady" });
});

it("fences a disposed owner before dispatch after an asynchronous history read", async () => {
  const task = await runtime(); let release!: () => void;
  gate = new Promise(resolve => { release = resolve; });
  const edit = task.editLastMessage("last-u", "edited");
  await Promise.resolve(); task.close(); release();
  await expect(edit).rejects.toThrow();
  expect(mutations()).toHaveLength(0);
});
