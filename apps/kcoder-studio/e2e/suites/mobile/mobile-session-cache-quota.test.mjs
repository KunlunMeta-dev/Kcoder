import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyQuotaObservation, installQuotaProbeInPage, overrideOriginQuota,
  projectPrivateQuotaProbeSnapshot, resetOriginQuota, safeQuotaFailure,
} from "./mobile-session-cache-quota.mjs";

const plan = { databaseName: "kcoder-confirmed-transcripts-v1", targetKey: "target", peerKey: "peer",
  freeSlot: 2, peerSlot: 1, peerRevision: 10, nextRevision: 11,
  expectedScope: { threadId: "target-thread" } };
const manifest = lastKey => JSON.stringify({ revision: 11, lastKey, entries: [
  { key: "target", slot: 2, dataRevision: 11 }, { key: "peer", slot: 1, dataRevision: 10 },
] });

test("CDP quota clamp reads active override and reset omits quotaSize", async () => {
  const calls = [];
  let active = false;
  const cdp = { async send(method, args) {
    calls.push({ method, args });
    if (method === "Storage.getUsageAndQuota") return { usage: 4000, quota: active ? 1 : 5000,
      overrideActive: active };
    assert.equal(method, "Storage.overrideQuotaForOrigin");
    active = Object.hasOwn(args, "quotaSize");
    return {};
  } };
  const origin = "http://127.0.0.1:1234";
  const observed = await overrideOriginQuota(cdp, origin);
  assert.deepEqual(observed.before, { usage: 4000, quota: 5000, overrideActive: false });
  assert.deepEqual(observed.active, { usage: 4000, quota: 1, overrideActive: true });
  assert.equal((await resetOriginQuota(cdp, origin)).overrideActive, false);
  assert.deepEqual(calls.map(row => row.method), [
    "Storage.getUsageAndQuota", "Storage.overrideQuotaForOrigin", "Storage.getUsageAndQuota",
    "Storage.overrideQuotaForOrigin", "Storage.getUsageAndQuota",
  ]);
  assert.equal(Object.hasOwn(calls[3].args, "quotaSize"), false);
  assert.equal(calls.every(row => row.args.origin === origin), true);
});

test("unsupported or ineffective override cannot be reported as quota evidence", async () => {
  let resetOwed = false;
  await assert.rejects(overrideOriginQuota({ send: async () => { throw new Error("unsupported"); } },
    "http://test", () => { resetOwed = true; }));
  assert.equal(resetOwed, false, "unsupported initial read cannot have applied an override");
  const ineffective = { send: async method => method === "Storage.getUsageAndQuota"
    ? { usage: 4000, quota: 5000, overrideActive: false } : {} };
  await assert.rejects(overrideOriginQuota(ineffective, "http://test", () => { resetOwed = true; }));
  assert.equal(resetOwed, true, "a successful send with failed readback must still require reset");
  await assert.rejects(resetOriginQuota({ send: async method => method === "Storage.getUsageAndQuota"
    ? { usage: 4000, quota: 1, overrideActive: true } : {} }, "http://test"));
});

test("classification requires the exact transaction's native QuotaExceededError abort", () => {
  const valid = { matchedEntryPuts: 1, matchedManifestPuts: 1, sameTransactionVerified: true,
    unexpectedWrites: 0, invalidReason: null, transactionAborted: true,
    transactionCompleted: false, transactionErrorName: "QuotaExceededError",
    attempted: { scopeMatched: true, anchor: { messageId: "u", offset: 40, followsLatest: false } } };
  assert.equal(classifyQuotaObservation(valid, true), "VALID_NATIVE_QUOTA_ABORT");
  assert.equal(classifyQuotaObservation(valid, false), "TRIGGER_PRECONDITION");
  for (const changed of [
    { matchedEntryPuts: 0 }, { matchedManifestPuts: 0 }, { sameTransactionVerified: false },
    { unexpectedWrites: 1 }, { transactionAborted: false }, { transactionCompleted: true },
    { transactionErrorName: "ConstraintError" }, { invalidReason: "wrong manifest" },
  ]) assert.equal(classifyQuotaObservation({ ...valid, ...changed }, true), "NATIVE_QUOTA_UNVERIFIED");
  assert.equal(classifyQuotaObservation({ ...valid, attempted: { ...valid.attempted,
    scopeMatched: false } }, true), "POST_ABORT_CANDIDATE_MISMATCH");
});

test("passive Page hook returns both original requests, queues no synthetic request, and observes tx quota abort", async () => {
  const original = globalThis.IDBObjectStore;
  class Request extends EventTarget { result = undefined; error = null; }
  class Store {
    constructor(name, transaction) { this.name = name; this.transaction = transaction; this.calls = []; }
    put(value, key) { const request = new Request(); request.transaction = this.transaction;
      this.calls.push({ method: "put", value, key, request, arity: arguments.length }); return request; }
    add(value, key) { const request = new Request(); request.transaction = this.transaction;
      this.calls.push({ method: "add", value, key, request }); return request; }
    delete(key) { const request = new Request(); request.transaction = this.transaction;
      this.calls.push({ method: "delete", key, request }); return request; }
    clear() { const request = new Request(); request.transaction = this.transaction;
      this.calls.push({ method: "clear", request }); return request; }
  }
  globalThis.IDBObjectStore = Store;
  try {
    const transaction = new EventTarget();
    transaction.db = { name: plan.databaseName };
    transaction.mode = "readwrite";
    transaction.objectStoreNames = ["entries", "manifest"];
    const entries = new Store("entries", transaction);
    const manifestStore = new Store("manifest", transaction);
    let now = 0;
    assert.equal(installQuotaProbeInPage(plan, () => now), true);
    const state = globalThis.__mobileCacheQuotaProbeV1;
    now = 31_999;
    assert.equal(state.arm(), false, "the original transaction must not run before the quiet window");
    now = 32_000;
    assert.equal(state.arm(), true);
    assert.equal(state.snapshot().armedAfterQuietMs, 32_000);
    const blob = new Blob([JSON.stringify({ scope: plan.expectedScope,
      anchor: { messageId: "PRIVATE_USER_ID", offset: 42, followsLatest: false } })]);
    const entryRequest = entries.put({ revision: 11, blob }, 2);
    const manifestRequest = manifestStore.put(manifest("target"), "current");
    assert.equal(entries.calls[0].request, entryRequest);
    assert.equal(manifestStore.calls[0].request, manifestRequest);
    assert.equal(entries.calls.length, 1);
    assert.equal(manifestStore.calls.length, 1);
    entryRequest.dispatchEvent(new Event("success"));
    manifestRequest.dispatchEvent(new Event("success"));
    transaction.error = { name: "QuotaExceededError" };
    transaction.dispatchEvent(new Event("abort"));
    const snapshot = await state.inspectAttempt();
    assert.equal(snapshot.targetPutSucceeded, true);
    assert.equal(snapshot.manifestPutSucceeded, true);
    assert.equal(snapshot.sameTransactionVerified, true);
    assert.equal(snapshot.transactionErrorName, "QuotaExceededError");
    assert.equal(classifyQuotaObservation(snapshot, true), "VALID_NATIVE_QUOTA_ABORT");
    assert.equal(entries.calls.some(call => call.method === "add"), false);
    assert.equal(entries.calls.some(call => call.method === "delete"), false);
    const otherTransaction = { db: { name: "unrelated-db" }, mode: "readwrite",
      objectStoreNames: ["entries"] };
    const unrelated = new Store("entries", otherTransaction);
    unrelated.put({ unrelated: true });
    assert.equal(unrelated.calls[0].arity, 1,
      "a Page-wide passive wrapper must preserve an unrelated put(value) call exactly");
    assert.equal(state.restore(), true);
    assert.equal(globalThis.__mobileCacheQuotaProbeV1, undefined);
    assert.equal(Store.prototype.put.name, "put");
  } finally { globalThis.IDBObjectStore = original; }
});

test("wrong target publication and malformed scope fail closed", async () => {
  const original = globalThis.IDBObjectStore;
  class Store {
    constructor(name, transaction) { this.name = name; this.transaction = transaction; }
    put() { const request = new EventTarget(); request.transaction = this.transaction; return request; }
    add() { throw new Error("passive probe must not add"); }
  }
  globalThis.IDBObjectStore = Store;
  try {
    const transaction = new EventTarget();
    transaction.db = { name: plan.databaseName };
    transaction.mode = "readwrite";
    transaction.objectStoreNames = ["entries", "manifest"];
    const entries = new Store("entries", transaction);
    const manifestStore = new Store("manifest", transaction);
    let now = 0;
    installQuotaProbeInPage(plan, () => now);
    const state = globalThis.__mobileCacheQuotaProbeV1;
    now = 32_000;
    assert.equal(state.arm(), true);
    entries.put({ revision: 11, blob: new Blob([JSON.stringify({ scope: { threadId: "WRONG" },
      anchor: { messageId: "PRIVATE", offset: 42, followsLatest: false } })]) }, 2);
    manifestStore.put(manifest("peer"), "current");
    assert.equal(state.snapshot().matchedManifestPuts, 0);
    assert.equal(state.snapshot().unexpectedWrites, 1);
    assert.equal(classifyQuotaObservation(state.snapshot(), true), "NATIVE_QUOTA_UNVERIFIED");
    assert.equal((await state.inspectAttempt()).attempted.scopeMatched, false);
    state.restore();
  } finally { globalThis.IDBObjectStore = original; }
});

test("a native writer during the quiet window prevents arming even after 32 seconds", () => {
  const original = globalThis.IDBObjectStore;
  class Store {
    constructor(name, transaction) { this.name = name; this.transaction = transaction; }
    put() { return new EventTarget(); }
    add() { return new EventTarget(); }
  }
  globalThis.IDBObjectStore = Store;
  try {
    const transaction = { db: { name: plan.databaseName }, mode: "readwrite",
      objectStoreNames: ["entries", "manifest"] };
    let now = 0;
    installQuotaProbeInPage(plan, () => now);
    const state = globalThis.__mobileCacheQuotaProbeV1;
    now = 10_000;
    new Store("entries", transaction).put({ revision: 1 }, 0);
    now = 50_000;
    assert.equal(state.snapshot().preArmEntryWrites, 1);
    assert.equal(state.arm(), false, "a writer must fail this attempt instead of restarting the clock");
    assert.equal(state.restore(), true);
  } finally { globalThis.IDBObjectStore = original; }
});

test("failure artifact and propagated error keep private IDs and assertion operands out", () => {
  const snapshot = { phase: "triggered", attempted: { blobSha256: "a".repeat(64),
    scopeMatched: true, anchor: { messageId: "PRIVATE_USER_ID", offset: 42, followsLatest: false } } };
  const projected = projectPrivateQuotaProbeSnapshot(snapshot);
  const original = new assert.AssertionError({ actual: "PRIVATE_PROMPT_DRAFT",
    expected: "PRIVATE_TOKEN", operator: "strictEqual" });
  original.stack = "AssertionError: PRIVATE_PROMPT_DRAFT\n at runCacheQuotaSmoke (mobile-session-cache-quota.mjs:301:7)";
  const safe = safeQuotaFailure(original, "atomic-rollback-readback", "PRECONDITION_OR_ASSERTION_FAILURE");
  const serialized = JSON.stringify({ projected, error: safe.evidence, propagated: String(safe.error.stack) });
  assert.equal(serialized.includes("PRIVATE"), false);
  assert.equal(safe.evidence.sourceRef, "mobile-session-cache-quota.mjs:301:7");
});
