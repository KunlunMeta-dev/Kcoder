import { expect, it, vi } from "vitest";
import type { SessionTranscriptBackend } from "./session-transcript-backend";
import { createSessionTranscriptStore } from "./session-transcript-store";
import { captureSessionTranscriptScope, sessionTranscriptIdentityDigest as digest, sessionTranscriptWorkspaceScopeKey } from "./session-transcript-scope";
import { projectConfirmedTranscript, TRANSCRIPT_CACHE_MAX_IDLE_MS } from "./session-transcript-projection";
import type { TranscriptCacheChange } from "./session-transcript-backend-contract";
import { markProfileStateRemoval, profileStateRemovalTestHelpers } from "./profile-state-removal";
import { PROFILE_INDEX_KEY, persistProfiles } from "./profile-store";

const profile = { id: "p", baseUrl: "https://gateway.example", label: "", authMode: "device" as const, authorizationGeneration: "g", deviceId: "d", accessToken: "secret", rpcToken: "secret", expiresAt: 1 };
const server = { id: "s", label: "", description: "", runtime: "kcoder" as const, transport: "local" as const, workspacePath: "/workspace" };
const peerProfile = { ...profile, id: "peer-profile", baseUrl: "https://peer.example", deviceId: "peer-device", authorizationGeneration: "peer-generation" };
const scope = (threadId = "t", owner = profile) => captureSessionTranscriptScope(owner, server, "/workspace", threadId);
const record = (threadId = "t", content = "confirmed", owner = profile) => projectConfirmedTranscript(scope(threadId, owner), { messages: [{ id: `m-${threadId}`, role: "assistant", content, timestampMs: 1 }] }, { title: "Title", updatedAt: 1, anchor: { messageId: `m-${threadId}`, offset: 12, followsLatest: false } });
const scopeAt = (threadId = "t", cwd = "/workspace", owner = profile, target = server) => captureSessionTranscriptScope(owner, target, cwd, threadId);
const recordAt = (threadId = "t", cwd = "/workspace", content = "confirmed", owner = profile, target = server) => projectConfirmedTranscript(scopeAt(threadId, cwd, owner, target), { messages: [{ id: `m-${threadId}`, role: "assistant", content, timestampMs: 1 }] }, { title: "Title", updatedAt: 1, anchor: { messageId: `m-${threadId}`, offset: 12, followsLatest: false } });

function memoryBackend() {
  let manifest: string | null = null;
  const entries = new Map<number, { revision: number; raw: string }>();
  let fail = false;
  let failReset = false;
  const backend: SessionTranscriptBackend = {
    async readManifest() { return manifest; },
    async readEntry(slot, revision) { const entry = entries.get(slot); return entry?.revision === revision ? entry.raw : null; },
    async reset(raw, isCurrent) { if (!isCurrent()) throw new Error("disposed"); if (failReset) throw new Error("reset unavailable"); entries.clear(); manifest = raw; },
    async commit(change, isCurrent) {
      if (!isCurrent()) throw new Error("disposed");
      if (fail) throw new Error("quota");
      if (change.put) entries.set(change.put.slot, { revision: change.put.revision, raw: change.put.raw });
      for (const slot of change.removeSlots) entries.delete(slot);
      manifest = change.manifest;
    },
  };
  // Model a shared local storage gate, not a network lock or real IndexedDB/Native host.
  let tail: Promise<unknown> = Promise.resolve();
  const fence = <T>(_identity: unknown, operation: () => Promise<T>): Promise<T> => {
    const result = tail.catch(() => {}).then(() => operation()); tail = result; return result;
  };
  return { backend, entries, fence, manifest: () => manifest, replaceManifest: (raw: string) => { manifest = raw; }, fail: () => { fail = true; }, failReset: (value: boolean) => { failReset = value; } };
}

it("removes expired offline bytes and the last route at 30 idle days without rewriting a warm cache", async () => {
  const now = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
  try {
    const f = memoryBackend(); const store = createSessionTranscriptStore(f.backend, f.fence);
    await store.save(await store.capture(scope(), () => true), record(), true);
    now.mockReturnValue(1_700_000_000_000 + TRANSCRIPT_CACHE_MAX_IDLE_MS - 1);
    expect(await store.loadVersioned(await store.capture(scope(), () => true))).not.toBeNull();
    const warmManifest = f.manifest();
    await store.capture(scope(), () => true);
    expect(f.manifest()).toBe(warmManifest);
    now.mockReturnValue(1_700_000_000_000 + TRANSCRIPT_CACHE_MAX_IDLE_MS);
    expect(await store.last(profile, () => true)).toBeNull();
    expect(f.entries.size).toBe(0);
    expect(await store.load(await store.capture(scope(), () => true))).toBeNull();
  } finally { now.mockRestore(); }
});

it("extends retention only after a real cache visit and keeps peer Gateway reads isolated", async () => {
  const start = 1_700_000_000_000;
  const now = vi.spyOn(Date, "now").mockReturnValue(start);
  try {
    const f = memoryBackend(); const store = createSessionTranscriptStore(f.backend, f.fence);
    await store.save(await store.capture(scope(), () => true), record(), true);
    await store.save(await store.capture(scope("peer", peerProfile), () => true), record("peer", "peer", peerProfile));
    now.mockReturnValue(start + TRANSCRIPT_CACHE_MAX_IDLE_MS - 1);
    expect(await store.load(await store.capture(scope(), () => true))).not.toBeNull();
    now.mockReturnValue(start + TRANSCRIPT_CACHE_MAX_IDLE_MS);
    expect(await store.load(await store.capture(scope("peer", peerProfile), () => true))).toBeNull();
    expect((await store.load(await store.capture(scope(), () => true)))?.record.messages[0].content).toBe("confirmed");
    expect(await store.last(peerProfile, () => true)).toBeNull();
  } finally { now.mockRestore(); }
});

it("gives legacy offline rows one 30-day grace period rather than using server history timestamps", async () => {
  const start = 1_700_000_000_000;
  const now = vi.spyOn(Date, "now").mockReturnValue(start);
  try {
    const f = memoryBackend(); const store = createSessionTranscriptStore(f.backend, f.fence);
    await store.save(await store.capture(scope(), () => true), record(), true);
    const manifest = JSON.parse(f.manifest()!);
    delete manifest.entries[0].lastAccessedAt;
    f.replaceManifest(JSON.stringify(manifest));
    expect(await store.last(profile, () => true)).not.toBeNull();
    now.mockReturnValue(start + TRANSCRIPT_CACHE_MAX_IDLE_MS - 1);
    expect(await store.last(profile, () => true)).not.toBeNull();
    now.mockReturnValue(start + TRANSCRIPT_CACHE_MAX_IDLE_MS);
    expect(await store.last(profile, () => true)).toBeNull();
  } finally { now.mockRestore(); }
});

it("never displays expired offline data when its cleanup cannot be committed", async () => {
  const start = 1_700_000_000_000;
  const now = vi.spyOn(Date, "now").mockReturnValue(start);
  try {
    const f = memoryBackend(); const store = createSessionTranscriptStore(f.backend, f.fence);
    await store.save(await store.capture(scope(), () => true), record(), true);
    now.mockReturnValue(start + TRANSCRIPT_CACHE_MAX_IDLE_MS); f.fail();
    await expect(store.last(profile, () => true)).rejects.toThrow("quota");
  } finally { now.mockRestore(); }
});

function holdPublishedCommit(f: ReturnType<typeof memoryBackend>, matches: (change: TranscriptCacheChange) => boolean = () => true) {
  let release: (() => void) | undefined;
  let released = false;
  let held = false;
  const original = f.backend.commit;
  f.backend.commit = async (change, isCurrent) => {
    await original(change, isCurrent);
    if (!held && matches(change)) {
      held = true;
      await new Promise<void>(resolve => { release = resolve; if (released) resolve(); });
    }
  };
  return {
    async wait() { await vi.waitFor(() => expect(held).toBe(true), { timeout: 2000 }); },
    release() { released = true; release?.(); },
    restore() { f.backend.commit = original; },
  };
}

it("reopens confirmed transcript, exact last route and stable anchor without network", async () => {
  const f = memoryBackend(); const first = createSessionTranscriptStore(f.backend, f.fence);
  const lease = await first.capture(scope(), () => true);
  await first.save(lease, record(), true);
  const reopened = createSessionTranscriptStore(f.backend, f.fence);
  const nextLease = await reopened.capture(scope(), () => true);
  expect((await reopened.load(nextLease))?.record).toEqual(record());
  expect((await reopened.last(profile, () => true))?.record.scope).toEqual(scope());
  expect((await reopened.last(profile, () => true))?.record.anchor).toMatchObject({ messageId: "m-t", offset: 12, followsLatest: false });
  expect(await reopened.last({ ...profile, deviceId: "other" }, () => true)).toBeNull();
});

it("conditional thread revocation preserves a newer same-scope publication", async () => {
  const f = memoryBackend(); const store = createSessionTranscriptStore(f.backend, f.fence);
  await store.save(await store.capture(scope(), () => true), record(), true);
  const beforeVersionedRead = f.manifest();
  const observed = await store.loadVersioned(await store.capture(scope(), () => true));
  expect(observed?.version).toBeDefined();
  expect(f.manifest()).toBe(beforeVersionedRead);

  await store.save(await store.capture(scope(), () => true), record("t", "new confirmed page"), true);
  const currentLease = await store.capture(scope(), () => true);
  expect(await store.invalidateThreadIfVersion(currentLease, observed!.version)).toBe(false);
  expect((await store.load(currentLease))?.record.messages[0].content).toBe("new confirmed page");
  expect((await store.last(profile, () => true))?.record.messages[0].content).toBe("new confirmed page");
});

it("conditional thread revocation removes only the observed row and its matching last route", async () => {
  const f = memoryBackend(); const store = createSessionTranscriptStore(f.backend, f.fence);
  await store.save(await store.capture(scope("peer"), () => true), record("peer", "peer remains"), true);
  await store.save(await store.capture(scope(), () => true), record(), true);
  const observed = await store.loadVersioned(await store.capture(scope(), () => true));
  expect(await store.invalidateThreadIfVersion(await store.capture(scope(), () => true), observed!.version)).toBe(true);
  expect(await store.load(await store.capture(scope(), () => true))).toBeNull();
  expect((await store.load(await store.capture(scope("peer"), () => true)))?.record.messages[0].content).toBe("peer remains");
  expect(await store.last(profile, () => true)).toBeNull();
});

it("conditional thread revocation fences an epoch reset with a reused entry revision", async () => {
  const f = memoryBackend(); const store = createSessionTranscriptStore(f.backend, f.fence);
  await store.save(await store.capture(scope(), () => true), record(), true);
  const observed = await store.loadVersioned(await store.capture(scope(), () => true));
  expect(observed?.version.dataRevision).toBe(1);

  f.replaceManifest("corrupt");
  const resetLease = await store.capture(scope(), () => true);
  await store.save(resetLease, record("t", "new epoch publication"), true);
  const currentLease = await store.capture(scope(), () => true);
  expect(currentLease.epoch).not.toBe(observed!.version.epoch);
  expect(await store.invalidateThreadIfVersion(currentLease, observed!.version)).toBe(false);
  expect((await store.load(currentLease))?.record.messages[0].content).toBe("new epoch publication");
});

it("deletion fences a queued late write across store instances and does not touch peer caches", async () => {
  const f = memoryBackend(); const first = createSessionTranscriptStore(f.backend, f.fence);
  const old = await first.capture(scope(), () => true); const peer = await first.capture(scope("peer"), () => true);
  await first.save(old, record(), true); await first.save(peer, record("peer"), false);
  const reopened = createSessionTranscriptStore(f.backend, f.fence);
  await reopened.invalidateThread(old);
  await expect(first.save(old, record(), true)).rejects.toThrow();
  await first.save(peer, record("peer", "peer still writes"), false);
  expect(await reopened.load(await reopened.capture(scope(), () => true))).toBeNull();
  expect((await reopened.load(await reopened.capture(scope("peer"), () => true)))?.record.messages[0].content).toBe("peer still writes");
  expect(await reopened.last(profile, () => true)).toBeNull();
});

it("LRU eviction stays bounded to this cache and failed commit preserves the prior record", async () => {
  const f = memoryBackend(); const store = createSessionTranscriptStore(f.backend, f.fence);
  for (let index = 0; index < 17; index++) {
    const id = `t${index}`; await store.save(await store.capture(scope(id), () => true), record(id), true);
  }
  expect(f.entries.size).toBe(16);
  expect(await store.load(await store.capture(scope("t0"), () => true))).toBeNull();
  const lease = await store.capture(scope("t16"), () => true); const before = f.manifest();
  f.fail(); await expect(store.save(lease, record("t16", "new content"), true)).rejects.toThrow("quota");
  expect(f.manifest()).toBe(before);
  expect((await store.load(lease))?.record.messages[0].content).toBe("confirmed");
});

it("rejects stale owner after held entry read and malformed/oversized manifest before reading entries", async () => {
  const f = memoryBackend(); const store = createSessionTranscriptStore(f.backend, f.fence);
  let current = true;
  const lease = await store.capture(scope(), () => current); await store.save(lease, record(), true);
  const original = f.backend.readEntry; let release!: () => void;
  f.backend.readEntry = async (...args) => { await new Promise<void>(resolve => { release = resolve; }); return original(...args); };
  const pending = store.load(lease); await vi.waitFor(() => expect(release).toBeTypeOf("function")); current = false; release();
  await expect(pending).rejects.toThrow();
  const reads = vi.spyOn(f.backend, "readEntry");
  f.replaceManifest("x".repeat(64 * 1024 + 1)); const fresh = await store.capture(scope(), () => true);
  expect(await store.load(fresh)).toBeNull();
  current = true; await expect(store.save(lease, record())).rejects.toThrow();
  expect(reads).not.toHaveBeenCalled();
});

it("profile invalidation removes only matching profile entries and blocks old leases", async () => {
  const f = memoryBackend(); const store = createSessionTranscriptStore(f.backend, f.fence);
  const old = await store.capture(scope(), () => true); await store.save(old, record(), true);
  const otherScope = captureSessionTranscriptScope({ ...profile, id: "peer-profile" }, server, "/workspace", "t");
  const peer = await store.capture(otherScope, () => true);
  await store.save(peer, { ...record(), scope: otherScope }, false);
  await store.invalidateProfile(profile, () => true);
  await expect(store.save(old, record(), true)).rejects.toThrow();
  expect(await store.last(profile, () => true)).toBeNull();
  expect((await store.load(await store.capture(otherScope, () => true)))?.record.scope.profile.id).toBe("peer-profile");
});


it("thread invalidation preserves a peer lease captured before its first save", async () => {
  const f = memoryBackend(); const store = createSessionTranscriptStore(f.backend, f.fence);
  const removed = await store.capture(scope(), () => true);
  const coldPeer = await store.capture(scope("cold"), () => true);
  await store.invalidateThread(removed);
  await store.save(coldPeer, record("cold"), true);
  expect((await store.last(profile, () => true))?.record.scope.threadId).toBe("cold");
  await expect(store.save(removed, record(), true)).rejects.toThrow();
  const replacement = await store.capture(scope(), () => true); await store.save(replacement, record());
  await expect(store.save(removed, record(), true)).rejects.toThrow();
});

it("post-publication cancellation preserves peers without restoring the prior last route", async () => {
  const f = memoryBackend(); const store = createSessionTranscriptStore(f.backend, f.fence);
  const peerLease = await store.capture(scope("peer"), () => true);
  await store.save(peerLease, record("peer", "peer remains cached"), true);
  let current = true;
  const lease = await store.capture(scope("new-route"), () => current);
  const hold = holdPublishedCommit(f, change => change.put?.raw.includes('"threadId":"new-route"') ?? false);
  const writing = store.save(lease, record("new-route"), true);
  try {
    await hold.wait(); current = false; hold.release();
    await expect(writing).rejects.toThrow();
  } finally {
    hold.release(); await writing.catch(() => {}); hold.restore();
  }
  const reopened = createSessionTranscriptStore(f.backend, f.fence);
  expect((await reopened.load(await reopened.capture(scope("peer"), () => true)))?.record.messages[0].content).toBe("peer remains cached");
  const workspaceKey = digest(sessionTranscriptWorkspaceScopeKey(scope("new-route")));
  const generations = (JSON.parse(f.manifest()!) as { workspaceGenerations: { key: string; generation: number }[] }).workspaceGenerations;
  expect(generations.find(item => item.key === workspaceKey)?.generation).toBe(3);
  // A was the last published route. Removing A must not reinstate B's prior last-route marker.
  expect(await reopened.last(profile, () => true)).toBeNull();
  current = true; await expect(store.save(lease, record())).rejects.toThrow();
});


it("a cancelled published LRU touch keeps both cache entries", async () => {
  const f = memoryBackend(); const store = createSessionTranscriptStore(f.backend, f.fence);
  await store.save(await store.capture(scope("peer"), () => true), record("peer", "peer cached"), true);
  let current = true;
  const lease = await store.capture(scope("read"), () => current);
  await store.save(lease, record("read", "read cached"), true);
  const hold = holdPublishedCommit(f, change => change.put === undefined);
  const reading = store.load(lease);
  try {
    await hold.wait(); current = false; hold.release();
    await expect(reading).rejects.toThrow();
  } finally {
    hold.release(); await reading.catch(() => {}); hold.restore();
  }
  const reopened = createSessionTranscriptStore(f.backend, f.fence);
  expect((await reopened.load(await reopened.capture(scope("peer"), () => true)))?.record.messages[0].content).toBe("peer cached");
  expect((await reopened.load(await reopened.capture(scope("read"), () => true)))?.record.messages[0].content).toBe("read cached");
});

it("a cancelled published thread invalidation keeps the exact deletion and peer route", async () => {
  const f = memoryBackend(); const store = createSessionTranscriptStore(f.backend, f.fence);
  await store.save(await store.capture(scope("peer"), () => true), record("peer", "peer remains"), true);
  let current = true;
  const lease = await store.capture(scope("removed"), () => current);
  await store.save(lease, record("removed", "removed"), true);
  const hold = holdPublishedCommit(f);
  const invalidating = store.invalidateThread(lease);
  try {
    await hold.wait(); current = false; hold.release();
    await expect(invalidating).rejects.toThrow();
  } finally {
    hold.release(); await invalidating.catch(() => {}); hold.restore();
  }
  const reopened = createSessionTranscriptStore(f.backend, f.fence);
  expect(await reopened.load(await reopened.capture(scope("removed"), () => true))).toBeNull();
  expect((await reopened.load(await reopened.capture(scope("peer"), () => true)))?.record.messages[0].content).toBe("peer remains");
  expect(await reopened.last(profile, () => true)).toBeNull();
});

it("a cancelled published profile invalidation keeps the exact deletion and peer cache", async () => {
  const f = memoryBackend(); const store = createSessionTranscriptStore(f.backend, f.fence);
  await store.save(await store.capture(scope("peer", peerProfile), () => true), record("peer", "peer profile remains", peerProfile), true);
  await store.save(await store.capture(scope("removed"), () => true), record("removed", "removed profile"), true);
  let current = true;
  const hold = holdPublishedCommit(f);
  const invalidating = store.invalidateProfile(profile, () => current);
  try {
    await hold.wait(); current = false; hold.release();
    await expect(invalidating).rejects.toThrow();
  } finally {
    hold.release(); await invalidating.catch(() => {}); hold.restore();
  }
  const reopened = createSessionTranscriptStore(f.backend, f.fence);
  expect(await reopened.load(await reopened.capture(scope("removed"), () => true))).toBeNull();
  expect((await reopened.load(await reopened.capture(scope("peer", peerProfile), () => true)))?.record.messages[0].content).toBe("peer profile remains");
  expect(await reopened.last(profile, () => true)).toBeNull();
  expect(await reopened.last(peerProfile, () => true)).toBeNull();
});

it("a superseded published profile-removal cleanup keeps its delete and peer entry", async () => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem(key: string) { return values.get(key) ?? null; },
    setItem(key: string, value: string) { values.set(key, value); },
    removeItem(key: string) { values.delete(key); },
  });
  let invalidation: ReturnType<typeof holdPublishedCommit> | undefined;
  let cleanup: Promise<void> | undefined;
  try {
    await persistProfiles([profile, peerProfile], profile.id);
    const f = memoryBackend(); const store = createSessionTranscriptStore(f.backend, f.fence);
    await store.save(await store.capture(scope("peer", peerProfile), () => true), record("peer", "peer survives profile removal", peerProfile), true);
    await store.save(await store.capture(scope("removed"), () => true), record("removed", "removed profile"), true);
    await persistProfiles([peerProfile], peerProfile.id);
    const generation = markProfileStateRemoval(profile.id)!;
    invalidation = holdPublishedCommit(f);
    cleanup = store.clearRemovedProfile(profile, generation, () => true);
    await invalidation.wait();
    markProfileStateRemoval(profile.id, generation + 1);
    invalidation.release();
    await expect(cleanup).rejects.toThrow();
    const reopened = createSessionTranscriptStore(f.backend, f.fence);
    expect(await reopened.load(await reopened.capture(scope("removed"), () => true))).toBeNull();
    expect((await reopened.load(await reopened.capture(scope("peer", peerProfile), () => true)))?.record.messages[0].content).toBe("peer survives profile removal");
    expect(await reopened.last(profile, () => true)).toBeNull();
    expect(await reopened.last(peerProfile, () => true)).toBeNull();
  } finally {
    invalidation?.release(); await cleanup?.catch(() => {}); invalidation?.restore();
    profileStateRemovalTestHelpers.reset();
    vi.unstubAllGlobals();
  }
});

it("fails closed only when exact save compensation fails", async () => {
  const f = memoryBackend(); const store = createSessionTranscriptStore(f.backend, f.fence);
  await store.save(await store.capture(scope("peer"), () => true), record("peer", "peer before failed compensation"), true);
  let current = true;
  const lease = await store.capture(scope("new-route"), () => current);
  const hold = holdPublishedCommit(f, change => change.put?.raw.includes('"threadId":"new-route"') ?? false);
  const writing = store.save(lease, record("new-route"), true);
  const reopened = createSessionTranscriptStore(f.backend, f.fence);
  try {
    await hold.wait(); current = false; f.fail(); f.failReset(true); hold.release();
    await expect(writing).rejects.toThrow("reset unavailable");
    await expect(reopened.last(profile, () => true)).rejects.toThrow("reset unavailable");
    f.failReset(false);
    expect(await reopened.last(profile, () => true)).toBeNull();
    expect(await reopened.load(await reopened.capture(scope("peer"), () => true))).toBeNull();
  } finally {
    f.failReset(false); hold.release(); await writing.catch(() => {}); hold.restore();
    await reopened.last(profile, () => true).catch(() => {});
  }
});

it("bounds invalidation metadata and epoch rollover never revives old leases", async () => {
  const f = memoryBackend(); const store = createSessionTranscriptStore(f.backend, f.fence);
  const peer = await store.capture(scope("peer"), () => true); await store.save(peer, record("peer"));
  for (let index = 0; index < 33; index++) await store.invalidateThread(await store.capture(scope(`deleted-${index}`), () => true));
  expect(JSON.parse(f.manifest()!).invalidations.length).toBeLessThanOrEqual(32);
  await expect(store.save(peer, record("peer"))).rejects.toThrow();
  const renewed = await store.capture(scope("peer"), () => true); await store.save(renewed, record("peer", "renewed"));
  expect((await store.load(renewed))?.record.messages[0].content).toBe("renewed");
});

it("conditionally invalidates one exact workspace prefix across stores while preserving peers", async () => {
  const f = memoryBackend(); const first = createSessionTranscriptStore(f.backend, f.fence);
  const workspaceA = await first.capture(scopeAt("a"), () => true);
  const workspaceB = await first.capture(scopeAt("b"), () => true);
  const otherCwd = await first.capture(scopeAt("other-cwd", "/workspace/sub"), () => true);
  const otherTargetServer = { ...server, id: "other-target" };
  const otherTarget = await first.capture(scopeAt("other-target", "/workspace", profile, otherTargetServer), () => true);
  const otherProfile = await first.capture(scopeAt("other-profile", "/workspace", peerProfile), () => true);
  await first.save(workspaceA, recordAt("a"));
  await first.save(workspaceB, recordAt("b"), true);
  await first.save(otherCwd, recordAt("other-cwd", "/workspace/sub"));
  await first.save(otherTarget, recordAt("other-target", "/workspace", "other target survives", profile, otherTargetServer));
  await first.save(otherProfile, recordAt("other-profile", "/workspace", "other profile survives", peerProfile));

  const observed = await first.captureWorkspaceWitness(scopeAt("probe"), () => true);
  const peerUpdate = await first.capture(scopeAt("other-cwd", "/workspace/sub"), () => true);
  await first.save(peerUpdate, recordAt("other-cwd", "/workspace/sub", "peer workspace updated"));
  const reopened = createSessionTranscriptStore(f.backend, f.fence);
  expect(await reopened.invalidateWorkspaceIfVersion(observed.lease, observed.version)).toBe(true);

  await expect(first.load(workspaceA)).rejects.toThrow();
  await expect(first.load(workspaceB)).rejects.toThrow();
  await expect(first.save(workspaceA, recordAt("a"))).rejects.toThrow();
  expect(await reopened.load(await reopened.capture(scopeAt("a"), () => true))).toBeNull();
  expect(await reopened.load(await reopened.capture(scopeAt("b"), () => true))).toBeNull();
  expect((await reopened.load(await reopened.capture(scopeAt("other-cwd", "/workspace/sub"), () => true)))?.record.messages[0].content).toBe("peer workspace updated");
  expect((await reopened.load(await reopened.capture(scopeAt("other-target", "/workspace", profile, otherTargetServer), () => true)))?.record.messages[0].content).toBe("other target survives");
  expect((await reopened.load(await reopened.capture(scopeAt("other-profile", "/workspace", peerProfile), () => true)))?.record.messages[0].content).toBe("other profile survives");
  expect(await reopened.last(profile, () => true)).toBeNull();
  const manifest = JSON.parse(f.manifest()!) as { invalidations: { key: string }[] };
  expect(manifest.invalidations.some(item => item.key.startsWith("w:") && item.key.length === 66)).toBe(true);
});

it("preserves an unrelated last route when its prefix is changed after the witness", async () => {
  const f = memoryBackend(); const store = createSessionTranscriptStore(f.backend, f.fence);
  await store.save(await store.capture(scopeAt("workspace"), () => true), recordAt("workspace"), true);
  const observed = await store.captureWorkspaceWitness(scopeAt("probe"), () => true);
  const other = await store.capture(scopeAt("other", "/elsewhere"), () => true);
  await store.save(other, recordAt("other", "/elsewhere", "unrelated last route"), true);

  expect(await store.invalidateWorkspaceIfVersion(observed.lease, observed.version)).toBe(true);
  expect((await store.last(profile, () => true))?.record.messages[0].content).toBe("unrelated last route");
});

it("rejects a workspace prefix witness if a same-profile entry is added or replaced", async () => {
  const f = memoryBackend(); const store = createSessionTranscriptStore(f.backend, f.fence);
  await store.save(await store.capture(scopeAt("existing"), () => true), recordAt("existing"));
  const beforeReplacement = await store.captureWorkspaceWitness(scopeAt("probe"), () => true);
  await store.save(await store.capture(scopeAt("existing"), () => true), recordAt("existing", "/workspace", "replacement during stat"));
  expect(await store.invalidateWorkspaceIfVersion(beforeReplacement.lease, beforeReplacement.version)).toBe(false);

  const observed = await store.captureWorkspaceWitness(scopeAt("probe"), () => true);
  await store.save(await store.capture(scopeAt("added"), () => true), recordAt("added", "/workspace", "arrived during stat"));
  const before = f.manifest();

  expect(await store.invalidateWorkspaceIfVersion(observed.lease, observed.version)).toBe(false);
  expect(f.manifest()).toBe(before);
  expect((await store.load(await store.capture(scopeAt("existing"), () => true)))?.record.messages[0].content).toBe("replacement during stat");
  expect((await store.load(await store.capture(scopeAt("added"), () => true)))?.record.messages[0].content).toBe("arrived during stat");
});

it("fails the whole workspace invalidation when any matching-profile cache row is corrupt", async () => {
  const f = memoryBackend(); const store = createSessionTranscriptStore(f.backend, f.fence);
  await store.save(await store.capture(scopeAt("peer", "/elsewhere"), () => true), recordAt("peer", "/elsewhere"));
  await store.save(await store.capture(scopeAt("target"), () => true), recordAt("target"));
  const observed = await store.captureWorkspaceWitness(scopeAt("probe"), () => true);
  const manifestBefore = JSON.parse(f.manifest()!) as { entries: { key: string; slot: number; dataRevision: number; profileKey: string }[] };
  const corrupt = manifestBefore.entries.find(entry => entry.key !== manifestBefore.entries[0].key)!;
  f.entries.set(corrupt.slot, { revision: corrupt.dataRevision, raw: "{" });
  const manifestRaw = f.manifest();

  await expect(store.invalidateWorkspaceIfVersion(observed.lease, observed.version)).rejects.toThrow();
  expect(f.manifest()).toBe(manifestRaw);
  expect(JSON.parse(f.manifest()!).entries).toHaveLength(2);
});

it("filters other profiles before reading their possibly corrupt cache rows", async () => {
  const f = memoryBackend(); const store = createSessionTranscriptStore(f.backend, f.fence);
  await store.save(await store.capture(scopeAt("target"), () => true), recordAt("target"));
  await store.save(await store.capture(scopeAt("peer", "/workspace", peerProfile), () => true), recordAt("peer", "/workspace", "peer profile survives", peerProfile));
  const observed = await store.captureWorkspaceWitness(scopeAt("probe"), () => true);
  const manifest = JSON.parse(f.manifest()!) as { entries: { key: string; slot: number; dataRevision: number; profileKey: string }[] };
  const peerEntry = manifest.entries[0];
  f.entries.set(peerEntry.slot, { revision: peerEntry.dataRevision, raw: "{" });

  expect(await store.invalidateWorkspaceIfVersion(observed.lease, observed.version)).toBe(true);
  const after = JSON.parse(f.manifest()!) as { entries: { key: string; slot: number }[] };
  expect(after.entries).toHaveLength(1);
  expect(after.entries[0].key).toBe(peerEntry.key);
  expect(f.entries.has(peerEntry.slot)).toBe(true);
});

it("catches an add-delete ABA within one workspace prefix", async () => {
  const f = memoryBackend(); const store = createSessionTranscriptStore(f.backend, f.fence);
  const observed = await store.captureWorkspaceWitness(scopeAt("probe"), () => true);
  const transient = await store.capture(scopeAt("transient"), () => true);
  await store.save(transient, recordAt("transient"));
  await store.invalidateThread(transient);
  expect(JSON.parse(f.manifest()!).entries).toHaveLength(0);

  expect(await store.invalidateWorkspaceIfVersion(observed.lease, observed.version)).toBe(false);
});

it("does not invalidate a workspace witness for a load-only LRU recency touch", async () => {
  const f = memoryBackend(); const store = createSessionTranscriptStore(f.backend, f.fence);
  await store.save(await store.capture(scopeAt("cached"), () => true), recordAt("cached"));
  const observed = await store.captureWorkspaceWitness(scopeAt("probe"), () => true);
  await store.load(await store.capture(scopeAt("cached"), () => true));

  expect(await store.invalidateWorkspaceIfVersion(observed.lease, observed.version)).toBe(true);
});

it("catches a workspace entry that was added and then LRU-evicted", async () => {
  const f = memoryBackend(); const store = createSessionTranscriptStore(f.backend, f.fence);
  const observed = await store.captureWorkspaceWitness(scopeAt("probe"), () => true);
  await store.save(await store.capture(scopeAt("transient"), () => true), recordAt("transient"));
  for (let index = 0; index < 16; index++) {
    const cwd = `/peer-workspace-${index}`; const threadId = `peer-${index}`;
    await store.save(await store.capture(scopeAt(threadId, cwd), () => true), recordAt(threadId, cwd));
  }

  const workspaceKey = digest(sessionTranscriptWorkspaceScopeKey(scopeAt("probe")));
  const manifest = JSON.parse(f.manifest()!) as { entries: { workspaceKey?: string }[]; workspaceGenerations: { key: string; generation: number }[] };
  expect(manifest.entries).toHaveLength(16);
  expect(manifest.entries.some(entry => entry.workspaceKey === workspaceKey)).toBe(false);
  expect(manifest.workspaceGenerations.find(item => item.key === workspaceKey)?.generation).toBe(2);
  expect(await store.invalidateWorkspaceIfVersion(observed.lease, observed.version)).toBe(false);
});

it("reads an old manifest and decodes a legacy LRU victim before advancing its workspace generation", async () => {
  const f = memoryBackend(); const first = createSessionTranscriptStore(f.backend, f.fence);
  await first.save(await first.capture(scopeAt("legacy", "/legacy"), () => true), recordAt("legacy", "/legacy"));
  for (let index = 0; index < 15; index++) {
    const cwd = `/legacy-peer-${index}`; const threadId = `legacy-peer-${index}`;
    await first.save(await first.capture(scopeAt(threadId, cwd), () => true), recordAt(threadId, cwd));
  }
  const legacy = JSON.parse(f.manifest()!) as { workspaceGenerations?: unknown; entries: Record<string, unknown>[] };
  delete legacy.workspaceGenerations;
  for (const entry of legacy.entries) delete entry.workspaceKey;
  f.replaceManifest(JSON.stringify(legacy));

  const reopened = createSessionTranscriptStore(f.backend, f.fence);
  const observed = await reopened.captureWorkspaceWitness(scopeAt("probe", "/legacy"), () => true);
  await reopened.save(await reopened.capture(scopeAt("overflow", "/overflow"), () => true), recordAt("overflow", "/overflow"));

  const workspaceKey = digest(sessionTranscriptWorkspaceScopeKey(scopeAt("probe", "/legacy")));
  const after = JSON.parse(f.manifest()!) as { entries: { key: string }[]; workspaceGenerations: { key: string; generation: number }[] };
  expect(after.entries).toHaveLength(16);
  expect(after.workspaceGenerations.find(item => item.key === workspaceKey)?.generation).toBe(1);
  expect(await reopened.invalidateWorkspaceIfVersion(observed.lease, observed.version)).toBe(false);
});

it("epoch-fences legacy peer eviction without reading its transcript payload", async () => {
  const f = memoryBackend(); const first = createSessionTranscriptStore(f.backend, f.fence);
  const peerScope = scopeAt("legacy-peer", "/peer-workspace", peerProfile);
  await first.save(await first.capture(peerScope, () => true), recordAt("legacy-peer", "/peer-workspace", "peer", peerProfile));
  for (let index = 0; index < 15; index++) {
    const threadId = `current-${index}`;
    await first.save(await first.capture(scopeAt(threadId), () => true), recordAt(threadId));
  }
  const legacy = JSON.parse(f.manifest()!) as { epoch: string; workspaceGenerations?: unknown; entries: Record<string, unknown>[] };
  delete legacy.workspaceGenerations;
  for (const entry of legacy.entries) delete entry.workspaceKey;
  f.replaceManifest(JSON.stringify(legacy));

  const reopened = createSessionTranscriptStore(f.backend, f.fence);
  const observed = await reopened.captureWorkspaceWitness(scopeAt("probe", "/peer-workspace", peerProfile), () => true);
  const peerEntry = (JSON.parse(f.manifest()!) as { entries: { profileId: string; slot: number; dataRevision: number }[] }).entries
    .find(entry => entry.profileId === peerProfile.id);
  expect(peerEntry).toBeDefined();
  const reads = vi.spyOn(f.backend, "readEntry");

  await reopened.save(await reopened.capture(scopeAt("overflow"), () => true), recordAt("overflow"));

  expect(reads).not.toHaveBeenCalledWith(peerEntry!.slot, peerEntry!.dataRevision);
  const after = JSON.parse(f.manifest()!) as { epoch: string; entries: { profileId: string }[]; workspaceGenerations: { key: string; generation: number }[] };
  expect(after.epoch).not.toBe(legacy.epoch);
  expect(after.entries).toHaveLength(16);
  expect(after.entries.some(entry => entry.profileId === peerProfile.id)).toBe(false);
  const currentWorkspaceKey = digest(sessionTranscriptWorkspaceScopeKey(scopeAt("overflow")));
  expect(after.workspaceGenerations.find(item => item.key === currentWorkspaceKey)?.generation).toBe(1);
  await expect(reopened.invalidateWorkspaceIfVersion(observed.lease, observed.version)).rejects.toThrow();
});

it("keeps the workspace tombstone and lease fence when invalidation metadata compacts", async () => {
  const f = memoryBackend(); const store = createSessionTranscriptStore(f.backend, f.fence);
  const oldLease = await store.capture(scopeAt("old"), () => true);
  for (let index = 0; index < 32; index++) await store.invalidateThread(await store.capture(scopeAt(`deleted-${index}`), () => true));
  expect(JSON.parse(f.manifest()!).invalidations).toHaveLength(32);
  const observed = await store.captureWorkspaceWitness(scopeAt("probe"), () => true);

  expect(await store.invalidateWorkspaceIfVersion(observed.lease, observed.version)).toBe(true);
  await expect(store.load(oldLease)).rejects.toThrow();
  const manifest = JSON.parse(f.manifest()!) as { epoch: string; invalidations: { key: string }[]; workspaceGenerations: { key: string; generation: number }[] };
  const workspaceKey = digest(sessionTranscriptWorkspaceScopeKey(scopeAt("probe")));
  expect(manifest.invalidations.some(item => item.key === `w:${workspaceKey}`)).toBe(true);
  expect(manifest.workspaceGenerations.find(item => item.key === workspaceKey)?.generation).toBe(1);
});

it("compacts the bounded workspace generation table and fences older leases", async () => {
  const f = memoryBackend(); const store = createSessionTranscriptStore(f.backend, f.fence);
  const oldLease = await store.capture(scopeAt("old", "/generation-0"), () => true);
  for (let index = 0; index < 33; index++) {
    const cwd = `/generation-${index}`; const threadId = `generation-${index}`;
    await store.save(await store.capture(scopeAt(threadId, cwd), () => true), recordAt(threadId, cwd));
  }

  await expect(store.load(oldLease)).rejects.toThrow();
  const manifest = JSON.parse(f.manifest()!) as { workspaceGenerations: { key: string; generation: number }[] };
  expect(manifest.workspaceGenerations.length).toBeLessThanOrEqual(32);
});

it("rejects a publisher fence after cross-store workspace invalidation and allows a fresh fence", async () => {
  const f = memoryBackend(); const first = createSessionTranscriptStore(f.backend, f.fence);
  const second = createSessionTranscriptStore(f.backend, f.fence);
  const target = scopeAt("publisher");
  const fixed = await first.captureWorkspacePublisherFence(target, () => true);
  const witness = await second.captureWorkspaceWitness(scopeAt("probe"), () => true);
  expect(await second.invalidateWorkspaceIfVersion(witness.lease, witness.version)).toBe(true);

  await expect(first.capturePublisherLease(target, fixed, () => true)).rejects.toThrow();
  const renewed = await first.captureWorkspacePublisherFence(target, () => true);
  const lease = await first.capturePublisherLease(target, renewed, () => true);
  await first.save(lease, recordAt("publisher", "/workspace", "fresh publisher"), true);
  expect((await first.load(await first.capture(target, () => true)))?.record.messages[0].content).toBe("fresh publisher");
});

it("keeps publisher fences scoped to the exact thread tombstone and peer workspace", async () => {
  const f = memoryBackend(); const store = createSessionTranscriptStore(f.backend, f.fence);
  const target = scopeAt("deleted-thread"); const peerThread = scopeAt("peer-thread");
  const targetFence = await store.captureWorkspacePublisherFence(target, () => true);
  const peerThreadFence = await store.captureWorkspacePublisherFence(peerThread, () => true);
  await store.invalidateThread(await store.capture(target, () => true));

  await expect(store.capturePublisherLease(target, targetFence, () => true)).rejects.toThrow();
  const peerThreadLease = await store.capturePublisherLease(peerThread, peerThreadFence, () => true);
  await store.save(peerThreadLease, recordAt("peer-thread"), true);
  expect((await store.load(await store.capture(peerThread, () => true)))?.record.scope.threadId).toBe("peer-thread");

  const otherWorkspace = scopeAt("other-workspace", "/elsewhere");
  const otherWorkspaceFence = await store.captureWorkspacePublisherFence(otherWorkspace, () => true);
  const peerWorkspace = scopeAt("same-workspace-peer", "/workspace/sub");
  const peerWorkspaceFence = await store.captureWorkspacePublisherFence(peerWorkspace, () => true);
  const otherWitness = await store.captureWorkspaceWitness(otherWorkspace, () => true);
  expect(await store.invalidateWorkspaceIfVersion(otherWitness.lease, otherWitness.version)).toBe(true);
  const peerWorkspaceLease = await store.capturePublisherLease(peerWorkspace, peerWorkspaceFence, () => true);
  await store.save(peerWorkspaceLease, recordAt("same-workspace-peer", "/workspace/sub"), true);
  expect((await store.load(await store.capture(peerWorkspace, () => true)))?.record.scope.cwd).toBe("/workspace/sub");
  await expect(store.capturePublisherLease(otherWorkspace, otherWorkspaceFence, () => true)).rejects.toThrow();
});

it("keeps a publisher fence valid across its own consecutive saves", async () => {
  const f = memoryBackend(); const store = createSessionTranscriptStore(f.backend, f.fence);
  const target = scopeAt("publisher");
  const fixed = await store.captureWorkspacePublisherFence(target, () => true);

  const firstLease = await store.capturePublisherLease(target, fixed, () => true);
  await store.save(firstLease, recordAt("publisher", "/workspace", "first page"));
  const secondLease = await store.capturePublisherLease(target, fixed, () => true);
  await store.save(secondLease, recordAt("publisher", "/workspace", "second page"));

  expect((await store.load(await store.capture(target, () => true)))?.record.messages[0].content).toBe("second page");
});

it("captures publisher fences without transcript scans and rejects mismatched or future fences", async () => {
  const f = memoryBackend(); const store = createSessionTranscriptStore(f.backend, f.fence);
  const target = scopeAt("publisher");
  await store.save(await store.capture(target, () => true), recordAt("publisher"));
  const reads = vi.spyOn(f.backend, "readEntry");
  const fixed = await store.captureWorkspacePublisherFence(target, () => true);
  expect(reads).not.toHaveBeenCalled();

  await expect(store.capturePublisherLease(scopeAt("other", "/elsewhere"), fixed, () => true)).rejects.toThrow();
  await expect(store.capturePublisherLease(target, { ...fixed, revision: fixed.revision + 1 }, () => true)).rejects.toThrow();
  expect(reads).not.toHaveBeenCalled();
});

it("rejects publisher fences after profile invalidation and epoch compaction", async () => {
  const f = memoryBackend(); const store = createSessionTranscriptStore(f.backend, f.fence);
  const second = createSessionTranscriptStore(f.backend, f.fence);
  const target = scopeAt("publisher");
  const profileFence = await store.captureWorkspacePublisherFence(target, () => true);
  await second.invalidateProfile(profile, () => true);
  await expect(store.capturePublisherLease(target, profileFence, () => true)).rejects.toThrow();

  const beforeCompaction = await store.captureWorkspacePublisherFence(target, () => true);
  for (let index = 0; index < 33; index++) await second.invalidateThread(await second.capture(scopeAt(`deleted-${index}`), () => true));
  await expect(store.capturePublisherLease(target, beforeCompaction, () => true)).rejects.toThrow();
});
