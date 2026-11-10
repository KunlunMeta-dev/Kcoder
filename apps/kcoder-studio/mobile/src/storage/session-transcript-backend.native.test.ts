import { afterEach, expect, it, vi } from "vitest";
const fs = vi.hoisted(() => ({ files: new Map<string, string>(), failMove: "", holdMove: "", release: null as (() => void) | null, oversized: "" }));
vi.mock("expo-file-system/legacy", () => ({
  documentDirectory: "file:///owned/", EncodingType: { UTF8: "utf8" }, makeDirectoryAsync: vi.fn(async () => {}),
  getInfoAsync: vi.fn(async (path: string) => ({ exists: fs.files.has(path), isDirectory: false, size: path === fs.oversized ? 2 ** 30 : Buffer.byteLength(fs.files.get(path) ?? "") })),
  readAsStringAsync: vi.fn(async (path: string) => fs.files.get(path)!),
  writeAsStringAsync: vi.fn(async (path: string, raw: string) => { fs.files.set(path, raw); }),
  deleteAsync: vi.fn(async (path: string) => { fs.files.delete(path); }),
  moveAsync: vi.fn(async ({ from, to }: { from: string; to: string }) => {
    if (to === fs.failMove) throw new Error("simulated interruption"); if (fs.files.has(to)) throw new Error("destination exists");
    fs.files.set(to, fs.files.get(from)!); fs.files.delete(from);
    if (to === fs.holdMove) await new Promise<void>(resolve => { fs.release = resolve; });
  }),
}));
import { readAsStringAsync } from "expo-file-system/legacy";
import { createSessionTranscriptBackend } from "./session-transcript-backend.native";
import { createSessionTranscriptStore } from "./session-transcript-store";
import { captureSessionTranscriptScope } from "./session-transcript-scope";
import { projectConfirmedTranscript } from "./session-transcript-projection";
const profile = { id: "p", label: "", baseUrl: "https://gateway.example", authMode: "device" as const, authorizationGeneration: "g", deviceId: "d", accessToken: "secret", rpcToken: "secret", expiresAt: 1 };
const scope = captureSessionTranscriptScope(profile, { id: "s", label: "", description: "", runtime: "kcoder", transport: "local" }, "/workspace", "t");
const record = (content: string) => projectConfirmedTranscript(scope, { messages: [{ id: "m", role: "assistant", content, timestampMs: 1 }] }, { title: "T", updatedAt: 1 });
const path = (name: string) => `file:///owned/kcoder-confirmed-transcripts-v1/${name}`;
const fence = <T>(_profile: unknown, operation: () => Promise<T>) => operation();
afterEach(() => { fs.files.clear(); fs.failMove = ""; fs.holdMove = ""; fs.release = null; fs.oversized = ""; vi.clearAllMocks(); });
it("retains old checkpoint when manifest publication fails; reopen sees exact old data", async () => {
  const store = createSessionTranscriptStore(createSessionTranscriptBackend(), fence);
  const lease = await store.capture(scope, () => true); await store.save(lease, record("old"), true);
  fs.failMove = path("manifest-0"); await expect(store.save(lease, record("new"), true)).rejects.toThrow("interruption"); fs.failMove = "";
  const reopened = createSessionTranscriptStore(createSessionTranscriptBackend(), fence);
  expect((await reopened.last(profile, () => true))?.record.messages[0].content).toBe("old"); expect(fs.files.size).toBeLessThanOrEqual(35);
});
it("late cancellation after manifest rename removes published last route and fences old lease", async () => {
  const store = createSessionTranscriptStore(createSessionTranscriptBackend(), fence); let current = true;
  const lease = await store.capture(scope, () => current); fs.holdMove = path("manifest-1");
  const pending = store.save(lease, record("cancelled"), true);
  await vi.waitFor(() => expect(fs.release).toBeTypeOf("function")); current = false; fs.holdMove = ""; fs.release!();
  await expect(pending).rejects.toThrow(); const reopened = createSessionTranscriptStore(createSessionTranscriptBackend(), fence);
  expect(await reopened.last(profile, () => true)).toBeNull(); current = true; await expect(store.save(lease, record("late"))).rejects.toThrow();
});
it("interrupted reset never resurrects old checkpoint; new capture recovers", async () => {
  const backend = createSessionTranscriptBackend(); const store = createSessionTranscriptStore(backend, fence);
  const lease = await store.capture(scope, () => true); await store.save(lease, record("old"), true);
  fs.files.set(path("reset.pending"), "reset"); await expect(backend.readManifest()).rejects.toThrow("Interrupted");
  const fresh = await store.capture(scope, () => true); expect(await store.load(fresh)).toBeNull(); await expect(store.save(lease, record("late"))).rejects.toThrow();
  await store.save(fresh, record("recovered"), true); expect((await store.last(profile, () => true))?.record.messages[0].content).toBe("recovered");
});
it("bounds native manifest before read/parse and rejects data revision mismatch", async () => {
  const backend = createSessionTranscriptBackend(); fs.files.set(path("manifest-0"), "{}"); fs.oversized = path("manifest-0");
  await expect(backend.readManifest()).rejects.toThrow("size"); expect(readAsStringAsync).not.toHaveBeenCalled();
  fs.files.set(path("data-0"), "2\n{}"); await expect(backend.readEntry(0, 3)).rejects.toThrow("revision");
});
