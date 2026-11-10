import { afterEach, expect, it, vi } from "vitest";
import { createSessionTranscriptBackend } from "./session-transcript-backend.web";
import { createSessionTranscriptStore } from "./session-transcript-store";
import { captureSessionTranscriptScope } from "./session-transcript-scope";
import { projectConfirmedTranscript } from "./session-transcript-projection";

// Event-order fixture for our IDB adapter, not a browser/IndexedDB durability implementation.
function idbEvents() {
  let data = new Map<string, unknown>();
  const state = { blocked: false, throwTransaction: false, failReset: false, beforeSuccess: null as (() => void) | null,
    failNextTransaction: false, holdPublication: false, release: null as (() => void) | null, aborts: 0, close: vi.fn() };
  const db = { close: state.close, transaction: (_names: unknown, mode: string) => {
    if (state.throwTransaction) throw new Error("transaction unavailable");
    if (state.failNextTransaction && mode === "readwrite") { state.failNextTransaction = false; throw new Error("transaction unavailable"); }
    const pendingData = new Map(data); let requests = 0; let aborted = false;
    const transaction: any = { oncomplete: null, onabort: null, onerror: null, abort() {
      if (aborted) return; aborted = true; state.aborts++; queueMicrotask(() => transaction.onabort?.());
    }, objectStore(name: string) {
      const request = (operation: () => unknown) => {
        const result: any = { onsuccess: null, result: undefined }; requests++;
        queueMicrotask(() => {
          if (aborted) return;
          result.result = operation(); const before = state.beforeSuccess; state.beforeSuccess = null; before?.(); result.onsuccess?.();
          if (--requests === 0 && !aborted) {
            if (mode === "readwrite") data = pendingData;
            const complete = () => transaction.oncomplete?.();
            if (mode === "readwrite" && state.holdPublication) { state.holdPublication = false; state.release = complete; }
            else queueMicrotask(complete);
          }
        }); return result;
      };
      return { get: (key: unknown) => request(() => pendingData.get(`${name}:${key}`)),
        put: (value: unknown, key: unknown) => request(() => pendingData.set(`${name}:${key}`, value)),
        delete: (key: unknown) => request(() => pendingData.delete(`${name}:${key}`)),
        clear: () => { if (state.failReset) throw new Error("reset unavailable"); return request(() => { for (const key of pendingData.keys()) if (key.startsWith(`${name}:`)) pendingData.delete(key); }); },
      };
    } }; return transaction;
  } };
  vi.stubGlobal("indexedDB", { open() {
    const request: any = { result: db, onsuccess: null, onblocked: null };
    queueMicrotask(() => state.blocked ? request.onblocked?.() : request.onsuccess?.()); return request;
  } });
  return state;
}
const profile = { id: "p", label: "", baseUrl: "https://gateway.example", authMode: "device" as const, authorizationGeneration: "g", deviceId: "d", accessToken: "secret", rpcToken: "secret", expiresAt: 1 };
const server = { id: "s", label: "", description: "", runtime: "kcoder" as const, transport: "local" as const };
const scopeFor = (threadId: string) => captureSessionTranscriptScope(profile, server, "/workspace", threadId);
const scope = scopeFor("t");
const recordFor = (targetScope: typeof scope, content: string) => projectConfirmedTranscript(targetScope, { messages: [{ id: `m-${targetScope.threadId}`, role: "assistant", content, timestampMs: 1 }] }, { title: "T", updatedAt: 1 });
const record = recordFor(scope, "confirmed");
const fence = <T>(_profile: unknown, operation: () => Promise<T>) => operation();
afterEach(() => vi.unstubAllGlobals());
it("aborts queued publication when owner invalidates before request success", async () => {
  const state = idbEvents(); const store = createSessionTranscriptStore(createSessionTranscriptBackend(), fence); let current = true;
  const lease = await store.capture(scope, () => current);
  state.beforeSuccess = () => { current = false; };
  // readManifest observes cancellation before the commit is opened.
  await expect(store.save(lease, record, true)).rejects.toThrow();
  expect(await store.last(profile, () => true)).toBeNull();
  const backend = createSessionTranscriptBackend(); current = true;
  state.beforeSuccess = () => { current = false; };
  await expect(backend.commit({ manifest: "{}", removeSlots: [] }, () => current)).rejects.toThrow();
  expect(state.aborts).toBe(1);
});
it("compensates an already published IDB transaction before rejecting late owner", async () => {
  const state = idbEvents(); const store = createSessionTranscriptStore(createSessionTranscriptBackend(), fence); let current = true;
  const lease = await store.capture(scope, () => current); state.holdPublication = true;
  const pending = store.save(lease, record, true);
  await vi.waitFor(() => expect(state.release).toBeTypeOf("function")); current = false; state.release!();
  await expect(pending).rejects.toThrow();
  const reopened = createSessionTranscriptStore(createSessionTranscriptBackend(), fence);
  expect(await reopened.last(profile, () => true)).toBeNull(); current = true;
  await expect(store.save(lease, record)).rejects.toThrow();
});

it("compensates a cancelled save without resetting a peer IDB entry", async () => {
  const state = idbEvents(); const store = createSessionTranscriptStore(createSessionTranscriptBackend(), fence); let current = true;
  const peerScope = scopeFor("peer");
  await store.save(await store.capture(peerScope, () => true), recordFor(peerScope, "peer remains cached"), true);
  const lease = await store.capture(scope, () => current); state.holdPublication = true;
  const pending = store.save(lease, record, true);
  await vi.waitFor(() => expect(state.release).toBeTypeOf("function"));
  current = false; state.failReset = true; state.release!();
  await expect(pending).rejects.toThrow();
  const reopened = createSessionTranscriptStore(createSessionTranscriptBackend(), fence);
  expect(await reopened.last(profile, () => true)).toBeNull();
  expect((await reopened.load(await reopened.capture(peerScope, () => true)))?.record.messages[0].content).toBe("peer remains cached");
  state.failReset = false;
  current = true; await expect(store.save(lease, record)).rejects.toThrow();
});
it("blocked open fails promptly and transaction-construction failure closes the connection", async () => {
  const state = idbEvents(); state.blocked = true;
  await expect(createSessionTranscriptBackend().readManifest()).rejects.toThrow("open failed");
  state.blocked = false; state.throwTransaction = true;
  await expect(createSessionTranscriptBackend().readManifest()).rejects.toThrow("transaction unavailable"); expect(state.close).toHaveBeenCalledOnce();
});

it("failed exact save compensation keeps same-realm reads fail-closed until reset succeeds", async () => {
  // The module-local reset flag is shared by stores in this realm; this fixture does not model other tabs.
  const state = idbEvents(); const store = createSessionTranscriptStore(createSessionTranscriptBackend(), fence); let current = true;
  const lease = await store.capture(scope, () => current); state.holdPublication = true;
  const pending = store.save(lease, record, true);
  await vi.waitFor(() => expect(state.release).toBeTypeOf("function"));
  current = false; state.failNextTransaction = true; state.failReset = true; state.release!();
  await expect(pending).rejects.toThrow("reset unavailable");
  const reopened = createSessionTranscriptStore(createSessionTranscriptBackend(), fence);
  await expect(reopened.last(profile, () => true)).rejects.toThrow("reset unavailable");
  state.failReset = false; expect(await reopened.last(profile, () => true)).toBeNull();
  current = true; await expect(store.save(lease, record)).rejects.toThrow();
});
