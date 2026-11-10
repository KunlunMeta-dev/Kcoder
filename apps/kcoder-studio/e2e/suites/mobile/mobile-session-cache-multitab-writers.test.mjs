import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { assertCanonicalResumeCacheIdentity, assertNativeWriterProbe, assertTwoWriterStorage,
  installMultitabLockHolderInPage, installMultitabWriterProbeInPage,
  projectMultitabPreparationChange, safeMultitabFailure,
} from "./mobile-session-cache-multitab-writers.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");

test("each real resume must bind its marked canonical user to its own native cache record", () => {
  const snapshot = { rows: [
    { raw: JSON.stringify({ scope: { threadId: "target" }, messages: [
      { id: "target-user", role: "user", content: "TARGET_MARKER" },
    ] }) },
    { raw: JSON.stringify({ scope: { threadId: "peer" }, messages: [
      { id: "peer-user", role: "user", content: "PEER_MARKER" },
    ] }) },
  ] };
  assert.equal(assertCanonicalResumeCacheIdentity(snapshot, "target", "TARGET_MARKER",
    { markerMessageId: "target-user" }), hash("target-user"));
  assert.equal(assertCanonicalResumeCacheIdentity(snapshot, "peer", "PEER_MARKER",
    { markerMessageId: "peer-user" }), hash("peer-user"));
  assert.throws(() => assertCanonicalResumeCacheIdentity(snapshot, "target", "TARGET_MARKER",
    { markerMessageId: "peer-user" }), "cross-thread authority must fail");
  assert.throws(() => assertCanonicalResumeCacheIdentity(snapshot, "missing", "TARGET_MARKER",
    { markerMessageId: "target-user" }), "missing native record must fail");
});

test("private assertion operands never enter multitab failure evidence or propagated error", () => {
  const original = new assert.AssertionError({ actual: "PRIVATE_DRAFT_AND_USER_ID",
    expected: "PRIVATE_CANONICAL_ID", operator: "strictEqual" });
  original.stack = "AssertionError: PRIVATE_DRAFT_AND_USER_ID\n at runCacheMultitabWritersSmoke (mobile-session-cache-multitab-writers.mjs:77:9)";
  const safe = safeMultitabFailure(original, "two-independent-real-resumes", "PRECONDITION_OR_ASSERTION_FAILURE");
  const serialized = JSON.stringify({ artifact: safe.evidence, propagated: String(safe.error.stack) });
  assert.equal(serialized.includes("PRIVATE"), false);
  assert.equal(safe.evidence.sourceRef, "mobile-session-cache-multitab-writers.mjs:77:9");
  assert.equal(safe.evidence.name, "AssertionError");
  assert.equal(safe.error.cause, undefined);
  assert.equal(safeMultitabFailure({ name: "PRIVATE_SECRET", stack: "PRIVATE_SECRET" },
    "exact-owner-cleanup", "CLEANUP_FAILURE").evidence.name, "Error");
});

test("preparation drift reports only bounded categories and numeric revisions", () => {
  const before = { manifestRaw: JSON.stringify({ revision: 4, id: "PRIVATE_MANIFEST_ID" }),
    rows: [{ slot: 1, revision: 4, type: "text", raw: "PRIVATE_CANONICAL_USER_ID" }],
    workspaceStates: [{ key: "PRIVATE_DRAFT_KEY", raw: "PRIVATE_DRAFT_BODY" }],
    profiles: [{ id: "PRIVATE_PROFILE_ID" }], activeId: "PRIVATE_PROFILE_ID" };
  const after = { manifestRaw: JSON.stringify({ revision: 5, id: "PRIVATE_MANIFEST_ID" }),
    rows: [{ slot: 1, revision: 5, type: "text", raw: "PRIVATE_CHANGED_USER_ID" }],
    workspaceStates: [{ key: "PRIVATE_DRAFT_KEY", raw: "PRIVATE_CHANGED_DRAFT" }],
    profiles: before.profiles, activeId: before.activeId };
  const result = projectMultitabPreparationChange(before, after, 701.6);
  assert.deepEqual(result, { elapsedMs: 702, manifestRevisionBefore: 4, manifestRevisionAfter: 5,
    manifestChanged: true, changedRowCount: 1, workspaceStatesChanged: true,
    profilesChanged: false, activeIdChanged: false });
  assert.equal(JSON.stringify(result).includes("PRIVATE"), false);
  assert.equal(projectMultitabPreparationChange(before, before, 0).changedRowCount, 0);
});

async function withBrowserGlobals(lockRequest, run) {
  const oldNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const oldStore = Object.getOwnPropertyDescriptor(globalThis, "IDBObjectStore");
  class Store {
    put() {} add() {} delete() {} clear() {}
  }
  Object.defineProperty(globalThis, "navigator", { configurable: true,
    value: { locks: { request: lockRequest } } });
  Object.defineProperty(globalThis, "IDBObjectStore", { configurable: true, value: Store });
  try { return await run(); }
  finally {
    if (oldNavigator) Object.defineProperty(globalThis, "navigator", oldNavigator);
    else delete globalThis.navigator;
    if (oldStore) Object.defineProperty(globalThis, "IDBObjectStore", oldStore);
    else delete globalThis.IDBObjectStore;
  }
}

test("writer probe forwards the original lock call, callback result and throw once", async () => {
  const calls = [];
  const nativeResult = Promise.resolve("native-result");
  const nativeRequest = function(...args) { calls.push({ owner: this, args }); return nativeResult; };
  await withBrowserGlobals(nativeRequest, async () => {
    assert.equal(installMultitabWriterProbeInPage({ databaseName: "db" }), true);
    const state = globalThis.__mobileCacheMultitabWriterProbeV1;
    try {
      assert.equal(state.arm(), true);
      const lock = { name: "kcoder-mobile:gateway-profile-index", mode: "exclusive" };
      const callbackThis = { callback: true };
      const callbackArgument = { id: "argument" };
      const callbackResult = Promise.resolve("original-callback-result");
      const originalCallback = function(...args) {
        assert.equal(this, callbackThis);
        assert.deepEqual(args, [lock, callbackArgument]);
        return callbackResult;
      };
      const options = { mode: "exclusive" };
      const lockResult = navigator.locks.request(lock.name, options, originalCallback);
      assert.equal(lockResult, nativeResult);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].owner, navigator.locks);
      assert.equal(calls[0].args[0], lock.name);
      assert.equal(calls[0].args[1], options);
      assert.equal(Reflect.apply(calls[0].args[2], callbackThis, [lock, callbackArgument]), callbackResult);
      await callbackResult;
      await lockResult;
      assert.equal(state.snapshot().requestSettled, 1);
      assert.equal(state.snapshot().callbackSettled, 1);

      const thrown = new Error("original callback throw");
      navigator.locks.request(lock.name, options, () => { throw thrown; });
      assert.throws(() => calls[1].args[2](lock), error => error === thrown);
      await Promise.resolve();
      assert.equal(state.snapshot().requestSettled, 2);
      assert.equal(state.snapshot().callbackSettled, 2);
      assert.equal(state.snapshot().lockRequests, 2);
    } finally { assert.equal(state.restore(), true); }
    assert.equal(navigator.locks.request, nativeRequest);
  });
});

test("holder H2 queued behind H1 can be released before entry during cleanup", async () => {
  let held = false;
  const queue = [];
  const entered = [];
  const pump = () => {
    if (held || queue.length === 0) return;
    held = true;
    const next = queue.shift();
    entered.push(next.ordinal);
    Promise.resolve().then(() => next.callback({ name: next.name, mode: next.options.mode }))
      .then(next.resolve, next.reject).finally(() => { held = false; pump(); });
  };
  const nativeRequest = (name, options, callback) => new Promise((resolve, reject) => {
    queue.push({ name, options, callback, resolve, reject, ordinal: entered.length + queue.length + 1 });
    pump();
  });
  await withBrowserGlobals(nativeRequest, async () => {
    assert.equal(installMultitabLockHolderInPage(), true);
    const state = globalThis.__mobileCacheMultitabLockHolderV1;
    try {
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(state.snapshot().firstEntered, true);
      assert.equal(state.queueSecond(), true);
      assert.equal(state.snapshot().secondQueued, true);
      assert.equal(state.snapshot().secondEntered, false);
      assert.equal(state.releaseSecond(), true);
      assert.equal(state.releaseFirst(), true);
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(entered, [1, 2]);
      assert.equal(state.snapshot().firstReleased, true);
      assert.equal(state.snapshot().secondReleased, true);
      assert.equal(state.snapshot().failed, false);
      assert.equal(state.restore(), true);
    } finally {
      if (globalThis.__mobileCacheMultitabLockHolderV1) {
        state.releaseFirst(); state.releaseSecond();
        await new Promise(resolve => setImmediate(resolve));
        state.restore();
      }
    }
  });
});

test("native writer acceptance requires both settled locks and a completed same-tx save", () => {
  const base = { preArmLockRequests: 0, preArmWrites: 0, lockRequests: 2, requestSettled: 2,
    callbackEntered: 2, callbackSettled: 2, callbacksHaveExclusiveLock: true,
    entryPutCallbackIndex: 2, manifestPutCallbackIndex: 2, entryPuts: 1, manifestPuts: 1,
    unexpectedWrites: 0, sameTransaction: true, entrySucceeded: true,
    manifestSucceeded: true, transactionCompleted: true, transactionAborted: false,
    transactionErrorName: null, invalidReason: null,
    manifest: { revision: 2, lastKeyMatched: true, epochMatched: true,
      entries: [{ keyMatched: true, dataRevision: 2 }, { keyMatched: false, dataRevision: 1 }] },
    attempted: { revision: 2, scopeMatched: true, bodySha256: "body",
      anchor: { messageId: "canonical", followsLatest: false, offset: 42 } } };
  const expected = { baselineRevision: 1, expectedBodySha256: "body",
    expectedUserId: "canonical", wheel: { offset: 42 } };
  assert.doesNotThrow(() => assertNativeWriterProbe(base, expected));
  for (const invalid of [
    { requestSettled: 1 }, { callbackSettled: 1 }, { entryPutCallbackIndex: 1 },
    { sameTransaction: false }, { transactionCompleted: false, transactionAborted: true },
  ]) assert.throws(() => assertNativeWriterProbe({ ...base, ...invalid }, expected));
});

test("two-writer storage requires both anchors, unchanged bodies and drafts, and exact physical slots", () => {
  const workspaceKey = "a".repeat(64);
  const makeRecord = (threadId, marker, offset) => ({
    scope: { threadId }, messages: [{ id: `${threadId}-user`, role: "user", content: marker }],
    anchor: { messageId: `${threadId}-user`, followsLatest: false, offset },
  });
  const makeSnapshot = (revision, offsets) => {
    const records = [makeRecord("target", "TARGET", offsets[0]), makeRecord("peer", "PEER", offsets[1])];
    const dataRevisions = revision === 1 ? [1, 1] : [2, 3];
    const rows = records.map((record, index) => ({ slot: index + 1,
      revision: dataRevisions[index], raw: JSON.stringify(record) }));
    const entries = rows.map((row, index) => ({ slot: row.slot, dataRevision: row.revision,
      key: hash(JSON.stringify(records[index].scope)), workspaceKey, profileKey: "profile",
      bytes: Buffer.byteLength(row.raw) }));
    return { rows, manifestRaw: JSON.stringify({ schemaVersion: 1, revision, clock: revision,
      epoch: 1, invalidations: [], workspaceGenerations: [{ key: workspaceKey, generation: revision }],
      entries, lastKey: entries[revision === 1 ? 0 : 1].key }),
    workspaceStates: [{ draft: "PRIVATE_DRAFT" }], profiles: [{ id: "profile" }], activeId: "profile" };
  };
  const baseline = makeSnapshot(1, [0, 0]);
  const final = makeSnapshot(3, [42, 56]);
  const args = { baseline, final, targetThreadId: "target", peerThreadId: "peer",
    targetMarker: "TARGET", peerMarker: "PEER", targetWheel: { offset: 42 },
    peerWheel: { offset: 56 }, targetProbe: { manifest: { revision: 2 },
      attempted: { anchor: { messageId: "target-user", offset: 42 } } },
    peerProbe: { manifest: { revision: 3 },
      attempted: { anchor: { messageId: "peer-user", offset: 56 } } } };
  assert.equal(assertTwoWriterStorage(args).committedRevision, 3);
  assert.throws(() => assertTwoWriterStorage({ ...args, final: { ...final,
    workspaceStates: [{ draft: "lost" }] } }));
  assert.throws(() => assertTwoWriterStorage({ ...args, final: { ...final,
    rows: final.rows.slice(0, 1) } }));
});
