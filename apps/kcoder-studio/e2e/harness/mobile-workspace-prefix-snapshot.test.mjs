import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { Blob } from "node:buffer";
import { TextEncoder } from "node:util";
import { runInNewContext } from "node:vm";
import test from "node:test";
import {
  assertMobileWorkspacePrefixInvalidated,
  captureMobileWorkspacePrefixSnapshot,
  mobileWorkspaceProfileKey,
} from "./mobile-workspace-prefix-snapshot.mjs";

const epoch = "e".repeat(64);
const targetWorkspaceKey = "a".repeat(64);
const peerWorkspaceKey = "b".repeat(64);
const parentCwd = "/run/workspace";
const targetCwd = `${parentCwd}/target-leaf`;

function row(key, slot, dataRevision, workspaceKey, cwd, threadId) {
  return { key, slot, dataRevision, workspaceKey, cwd, threadId };
}

function snapshot({ revision, entries, lastKey, invalidations = [], generations = [] }) {
  return { ready: true, manifest: { schemaVersion: 1, epoch, revision, lastKey,
    invalidations, workspaceGenerations: generations, entries: entries.map(({ key, slot, dataRevision, workspaceKey }) =>
      ({ key, slot, dataRevision, workspaceKey })) }, entries };
}

function fixture() {
  const peer = row("1".repeat(64), 0, 1, peerWorkspaceKey, parentCwd, "peer-thread");
  const targetA = row("2".repeat(64), 1, 2, targetWorkspaceKey, targetCwd, "target-thread-a");
  const targetB = row("3".repeat(64), 2, 3, targetWorkspaceKey, targetCwd, "target-thread-b");
  const before = snapshot({ revision: 5, entries: [targetA, peer, targetB], lastKey: targetB.key,
    generations: [{ key: peerWorkspaceKey, generation: 1 }, { key: targetWorkspaceKey, generation: 2 }] });
  const after = snapshot({ revision: 7, entries: [peer], lastKey: null,
    invalidations: [{ key: `w:${targetWorkspaceKey}`, revision: 7 }],
    generations: [{ key: peerWorkspaceKey, generation: 1 }, { key: targetWorkspaceKey, generation: 3 }] });
  return { before, after, peer, targetA, targetB };
}

test("profile key uses the cache's non-secret identity tuple", () => {
  const identity = { profileId: "profile-a", baseUrl: "http://127.0.0.1:4173", authMode: "device",
    authorizationGeneration: "family-a", deviceId: "device-a" };
  assert.equal(mobileWorkspaceProfileKey(identity), mobileWorkspaceProfileKey({ ...identity }));
  assert.notEqual(mobileWorkspaceProfileKey(identity), mobileWorkspaceProfileKey({ ...identity, deviceId: "device-b" }));
  assert.throws(() => mobileWorkspaceProfileKey({ ...identity, authMode: "legacy" }), /device-auth profile/);
});

test("in-memory IndexedDB adapter contract reads only active-profile slots without writes or body exposure", async () => {
  // This adapter-level contract test is not Browser evidence; the E2E suite reads the real origin database.
  const identity = { profileId: "profile-readonly", baseUrl: "http://127.0.0.1:4173", authMode: "device",
    authorizationGeneration: "family-readonly", deviceId: "device-readonly" };
  const key = mobileWorkspaceProfileKey(identity);
  const scope = { version: 1, profile: { id: identity.profileId, baseUrl: identity.baseUrl,
      authorizationGeneration: identity.authorizationGeneration, deviceId: identity.deviceId, authMode: "device" },
    target: { id: "local", transport: "local", connectionFingerprint: "c".repeat(64),
      principalId: null, role: null, workspacePath: "/run/workspace" },
    cwd: "/run/workspace/child", threadId: "thread-readonly" };
  const manifest = JSON.stringify({ schemaVersion: 1, revision: 1, epoch, clock: 1,
    invalidations: [], workspaceGenerations: [], lastKey: "4".repeat(64),
    entries: [
      { key: "4".repeat(64), profileId: identity.profileId, profileKey: key, slot: 0,
        dataRevision: 1, bytes: 100, used: 1 },
      { key: "5".repeat(64), profileId: "other-profile", profileKey: "d".repeat(64), slot: 1,
        dataRevision: 1, bytes: 100, used: 1 },
    ] });
  const slots = new Map([[0, { revision: 1,
    blob: new Blob([JSON.stringify({ schemaVersion: 1, scope, messages: [{ content: "PRIVATE_TRANSCRIPT_BODY" }] })]) }]]);
  const reads = [];
  const modes = [];
  let writes = 0;
  const db = {
    close() {},
    transaction(_stores, mode) {
      modes.push(mode);
      assert.equal(mode, "readonly");
      let pending = 0;
      const transaction = {
        objectStore(name) {
          return { get(slot) {
            reads.push({ store: name, slot });
            const request = {};
            pending += 1;
            queueMicrotask(() => {
              request.result = name === "manifest" ? manifest : slots.get(slot);
              request.onsuccess?.();
              pending -= 1;
              queueMicrotask(() => { if (pending === 0) transaction.oncomplete?.(); });
            });
            return request;
          }, put() { writes += 1; throw new Error("readonly snapshot attempted put"); },
          delete() { writes += 1; throw new Error("readonly snapshot attempted delete"); },
          clear() { writes += 1; throw new Error("readonly snapshot attempted clear"); } };
        },
      };
      return transaction;
    },
  };
  const originalIndexedDb = globalThis.indexedDB;
  globalThis.indexedDB = {
    async databases() { return [{ name: "kcoder-confirmed-transcripts-v1", version: 1 }]; },
    open() {
      const request = {};
      queueMicrotask(() => { request.result = db; request.onsuccess?.(); });
      return request;
    },
  };
  try {
    const page = { evaluate: (operation, args) => {
      // Playwright serializes evaluate callbacks; invoke the same source in a separate realm
      // so an accidental host-module closure reference fails this adapter contract test.
      const browserOperation = runInNewContext(`(${operation.toString()})`, {
        indexedDB: globalThis.indexedDB,
        Blob,
        TextEncoder,
        crypto: webcrypto,
      });
      return browserOperation(args);
    } };
    const result = await captureMobileWorkspacePrefixSnapshot(page, {
      identity, expectedServerId: "local", expectedTargetWorkspacePath: "/run/workspace",
    });
    assert.equal(result.ready, true);
    assert.equal(result.entries.length, 1);
    assert.equal(result.entries[0].threadId, "thread-readonly");
    assert.equal(JSON.stringify(result).includes("PRIVATE_TRANSCRIPT_BODY"), false);
    assert.deepEqual(reads, [{ store: "manifest", slot: "current" }, { store: "entries", slot: 0 }]);
    assert.deepEqual(modes, ["readonly"]);
    assert.equal(writes, 0);
  } finally {
    if (originalIndexedDb === undefined) delete globalThis.indexedDB;
    else globalThis.indexedDB = originalIndexedDb;
  }
});

test("exact child prefix CAS retains the parent peer and same cache epoch", () => {
  const { before, after } = fixture();
  assert.deepEqual(assertMobileWorkspacePrefixInvalidated(before, after, {
    workspaceKey: targetWorkspaceKey, targetCwd, peerCwd: parentCwd,
  }), {
    workspaceKey: targetWorkspaceKey, invalidationRevision: 7, beforeRevision: 5, afterRevision: 7,
    targetEntryCountBefore: 2, targetEntryCountAfter: 0, peerRetained: true, epochStable: true,
  });
});

test("rejects a partial cleanup that removes only one target thread", () => {
  const { before, after, targetA } = fixture();
  after.entries.push(targetA);
  after.manifest.entries.push({ key: targetA.key, slot: targetA.slot, dataRevision: targetA.dataRevision,
    workspaceKey: targetWorkspaceKey });
  assert.throws(() => assertMobileWorkspacePrefixInvalidated(before, after, {
    workspaceKey: targetWorkspaceKey, targetCwd, peerCwd: parentCwd,
  }), /exact child workspace prefix/);
});

test("rejects a missing exact workspace tombstone or stale generation", () => {
  const first = fixture();
  first.after.manifest.invalidations = [];
  assert.throws(() => assertMobileWorkspacePrefixInvalidated(first.before, first.after, {
    workspaceKey: targetWorkspaceKey, targetCwd, peerCwd: parentCwd,
  }), /exact workspace invalidation tombstone/);

  const second = fixture();
  second.after.manifest.workspaceGenerations.find(item => item.key === targetWorkspaceKey).generation = 2;
  assert.throws(() => assertMobileWorkspacePrefixInvalidated(second.before, second.after, {
    workspaceKey: targetWorkspaceKey, targetCwd, peerCwd: parentCwd,
  }), /generation must advance/);
});

test("rejects epoch rollover, peer mutation, or a removed parent peer", () => {
  const rolled = fixture();
  rolled.after.manifest.epoch = "f".repeat(64);
  assert.throws(() => assertMobileWorkspacePrefixInvalidated(rolled.before, rolled.after, {
    workspaceKey: targetWorkspaceKey, targetCwd, peerCwd: parentCwd,
  }), /must not roll the cache epoch/);

  const mutatedPeer = fixture();
  mutatedPeer.after.entries[0] = { ...mutatedPeer.after.entries[0], dataRevision: 4 };
  assert.throws(() => assertMobileWorkspacePrefixInvalidated(mutatedPeer.before, mutatedPeer.after, {
    workspaceKey: targetWorkspaceKey, targetCwd, peerCwd: parentCwd,
  }), /keep its identity and stored slot/);

  const removedPeer = fixture();
  removedPeer.after.entries = [];
  removedPeer.after.manifest.entries = [];
  assert.throws(() => assertMobileWorkspacePrefixInvalidated(removedPeer.before, removedPeer.after, {
    workspaceKey: targetWorkspaceKey, targetCwd, peerCwd: parentCwd,
  }), /unrelated peer workspace entry must remain readable/);
});

test("requires the invalidated prefix to own the old last route and clear it", () => {
  const oldRouteFromPeer = fixture();
  oldRouteFromPeer.before.manifest.lastKey = oldRouteFromPeer.peer.key;
  assert.throws(() => assertMobileWorkspacePrefixInvalidated(oldRouteFromPeer.before, oldRouteFromPeer.after, {
    workspaceKey: targetWorkspaceKey, targetCwd, peerCwd: parentCwd,
  }), /pre-cleanup last-route marker/);

  const staleRoute = fixture();
  staleRoute.after.manifest.lastKey = staleRoute.peer.key;
  assert.throws(() => assertMobileWorkspacePrefixInvalidated(staleRoute.before, staleRoute.after, {
    workspaceKey: targetWorkspaceKey, targetCwd, peerCwd: parentCwd,
  }), /must clear that route marker/);
});

test("rejects generation changes in an unrelated peer prefix", () => {
  const { before, after } = fixture();
  after.manifest.workspaceGenerations.find(item => item.key === peerWorkspaceKey).generation = 2;
  assert.throws(() => assertMobileWorkspacePrefixInvalidated(before, after, {
    workspaceKey: targetWorkspaceKey, targetCwd, peerCwd: parentCwd,
  }), /peer workspace generation must remain unchanged/);
});
