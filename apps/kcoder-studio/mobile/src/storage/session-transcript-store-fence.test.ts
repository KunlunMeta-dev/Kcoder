import { afterEach, expect, it, vi } from "vitest";
const values = vi.hoisted(() => new Map<string, string>());
vi.mock("react-native", () => ({ Platform: { OS: "android" } }));
vi.mock("./secure", () => ({
  getSecureValue: vi.fn(async (key: string) => values.get(key) ?? null),
  setSecureValue: vi.fn(async (key: string, value: string) => { values.set(key, value); }),
  deleteSecureValue: vi.fn(async (key: string) => { values.delete(key); }),
}));
import { persistProfiles } from "./profile-store";
import { markProfileStateRemoval, profileStateRemovalTestHelpers } from "./profile-state-removal";
import { createSessionTranscriptStore } from "./session-transcript-store";
import type { SessionTranscriptBackend } from "./session-transcript-backend-contract";
import { captureSessionTranscriptScope } from "./session-transcript-scope";
import { projectConfirmedTranscript } from "./session-transcript-projection";
const profile = { id: "p", label: "", baseUrl: "https://gateway.example", authMode: "device" as const, deviceId: "d", authorizationGeneration: "g", accessToken: "secret", rpcToken: "secret", expiresAt: 1 };
const server = { id: "s", label: "", description: "", runtime: "kcoder" as const, transport: "local" as const, workspacePath: "/workspace" };
function fixture() {
  let manifest: string | null = null;
  const entries = new Map<number, { revision: number; raw: string }>();
  const backend: SessionTranscriptBackend = {
    async readManifest() { return manifest; },
    async readEntry(slot, revision) { const entry = entries.get(slot); return entry?.revision === revision ? entry.raw : null; },
    async reset(raw, guard) { if (!guard()) throw new Error("disposed"); entries.clear(); manifest = raw; },
    async commit(change, guard) { if (!guard()) throw new Error("disposed"); if (change.put) entries.set(change.put.slot, change.put); for (const slot of change.removeSlots) entries.delete(slot); manifest = change.manifest; },
  };
  return { store: createSessionTranscriptStore(backend), backend };
}
const scope = (p = profile) => captureSessionTranscriptScope(p, server, "/workspace", "t");
const record = (p = profile) => projectConfirmedTranscript(scope(p), { messages: [{ id: "m", role: "assistant", content: "confirmed", timestampMs: 1 }] }, { title: "T", updatedAt: 1 });
afterEach(() => { values.clear(); profileStateRemovalTestHelpers.reset(); });
it("uses real profile fence and cleans old identity after committed removal/pending mark", async () => {
  await persistProfiles([profile], profile.id);
  const { store } = fixture(); const lease = await store.capture(scope(), () => true); await store.save(lease, record(), true);
  await persistProfiles([], null); const generation = markProfileStateRemoval(profile.id)!;
  await expect(store.save(lease, record())).rejects.toThrow(); await expect(store.invalidateProfile(profile, () => true)).rejects.toThrow();
  await store.clearRemovedProfile(profile, generation, () => true);
  await persistProfiles([profile], profile.id); profileStateRemovalTestHelpers.reset();
  expect(await store.last(profile, () => true)).toBeNull(); await expect(store.save(lease, record())).rejects.toThrow();
});
it("late removal cleans exact old authorization only; superseded ticket cannot clean", async () => {
  await persistProfiles([profile], profile.id);
  const { store } = fixture(); await store.save(await store.capture(scope(), () => true), record(), true);
  await persistProfiles([], null); const oldTicket = markProfileStateRemoval(profile.id)!; profileStateRemovalTestHelpers.reset();
  const next = { ...profile, authorizationGeneration: "new-g", deviceId: "new-d" };
  await persistProfiles([next], next.id); await store.save(await store.capture(scope(next), () => true), record(next), true);
  const currentTicket = markProfileStateRemoval(profile.id, oldTicket + 1)!;
  await expect(store.clearRemovedProfile(profile, oldTicket, () => true)).rejects.toThrow();
  await store.clearRemovedProfile(profile, currentTicket, () => true); profileStateRemovalTestHelpers.reset();
  expect((await store.last(next, () => true))?.record.scope.profile.deviceId).toBe("new-d");
});
it.each(["deviceId", "authorizationGeneration", "baseUrl", "authMode"] as const)("rejects changed persisted %s before touching cache", async field => {
  await persistProfiles([profile], profile.id); const { store, backend } = fixture();
  const lease = await store.capture(scope(), () => true); const write = vi.spyOn(backend, "commit");
  await persistProfiles([{ ...profile, [field]: field === "authMode" ? "legacy" : field === "baseUrl" ? "https://other.example" : "replacement" }], profile.id);
  await expect(store.save(lease, record(), true)).rejects.toThrow(); expect(write).not.toHaveBeenCalled();
});

it("superseded removal during held manifest read cannot publish old cleanup or erase new identity", async () => {
  await persistProfiles([profile], profile.id); const { store, backend } = fixture();
  await store.save(await store.capture(scope(), () => true), record(), true);
  await persistProfiles([], null);
  const next = { ...profile, authorizationGeneration: "new-g", deviceId: "new-d" };
  await persistProfiles([next], next.id); await store.save(await store.capture(scope(next), () => true), record(next), true);
  const ticket = markProfileStateRemoval(profile.id)!;
  const original = backend.readManifest; let release!: () => void;
  vi.spyOn(backend, "readManifest").mockImplementationOnce(async () => {
    const raw = await original(); await new Promise<void>(resolve => { release = resolve; }); return raw;
  });
  const writes = vi.spyOn(backend, "commit"); const pending = store.clearRemovedProfile(profile, ticket, () => true);
  await vi.waitFor(() => expect(release).toBeTypeOf("function")); markProfileStateRemoval(profile.id, ticket + 1); release();
  await expect(pending).rejects.toThrow(); expect(writes).not.toHaveBeenCalled();
  profileStateRemovalTestHelpers.reset();
  expect((await store.last(next, () => true))?.record.scope.profile.deviceId).toBe("new-d");
});
