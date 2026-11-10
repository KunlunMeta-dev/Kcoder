import assert from "node:assert/strict";
import test from "node:test";
import {
  deriveNativeAbortPlan,
  projectPrivateStorageSnapshot,
  projectPrivateNativeProbeSnapshot,
  classifyNativeAbortObservation,
  safeNativeAbortFailure,
  projectTrustedWheelFailure,
  installNativeAbortProbeInPage,
} from "./mobile-session-cache-transaction-abort.mjs";

const fixture = () => ({
  manifest: { revision: 10, lastKey: "target", entries: [
    { key: "target", slot: 0, dataRevision: 9 }, { key: "peer", slot: 1, dataRevision: 10 },
  ] },
  target: { entry: { key: "target", slot: 0, dataRevision: 9 }, record: { scope: { threadId: "target-thread" } } },
  peer: { entry: { key: "peer", slot: 1, dataRevision: 10, bytes: 4 } },
  snapshot: { rows: [{ slot: 0 }, { slot: 1 }] },
});

test("abort plan selects the actual first free slot and rejects orphan or occupied peers", () => {
  const selected = deriveNativeAbortPlan(fixture());
  assert.equal(selected.freeSlot, 2);
  assert.equal(selected.peerSlot, 1);
  assert.equal(selected.nextRevision, 11);
  const orphan = fixture(); orphan.snapshot.rows.push({ slot: 2 });
  assert.throws(() => deriveNativeAbortPlan(orphan), /physical entries/);
  const missingPeer = fixture(); missingPeer.manifest.entries.pop();
  assert.throws(() => deriveNativeAbortPlan(missingPeer));
});

test("storage projection exposes digests rather than raw Blob or draft text", () => {
  const snapshot = { manifestRaw: '{"secret":"manifest"}', rows: [
    { slot: 0, revision: 3, type: "application/json", raw: "SECRET_BLOB" },
  ], workspaceStates: [{ key: "draft-key", raw: "SECRET_DRAFT" }],
  profiles: [{ id: "profile", baseUrl: "http://127.0.0.1" }], activeId: "profile" };
  const projected = projectPrivateStorageSnapshot(snapshot);
  assert.equal(projected.rows[0].slot, 0);
  assert.match(projected.rows[0].sha256, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(projected).includes("SECRET"), false);
  assert.equal(JSON.stringify(projected).includes("draft-key"), false);
});

test("failed native probe artifacts retain only a digest of the canonical row identity", () => {
  const snapshot = { phase: "triggered", nativeRequestErrorName: "ConstraintError",
    attempted: { blobSha256: "a".repeat(64), bodySha256: "b".repeat(64),
      anchor: { messageId: "PRIVATE_CANONICAL_ROW", offset: 24, followsLatest: false } } };
  const projected = projectPrivateNativeProbeSnapshot(snapshot);
  assert.match(projected.attempted.anchor.messageIdSha256, /^[a-f0-9]{64}$/);
  assert.equal(projected.attempted.anchor.offset, 24);
  assert.equal(JSON.stringify(projected).includes("PRIVATE_CANONICAL_ROW"), false);
  assert.equal(snapshot.attempted.anchor.messageId, "PRIVATE_CANONICAL_ROW");
});

test("canceled error, missing abort and mismatched target scope cannot classify as a valid native fault", () => {
  const valid = { sameTransactionVerified: true, injectionCount: 1,
    nativeRequestErrorName: "ConstraintError", requestErrorBubbles: true,
    requestErrorCancelable: true, requestErrorDefaultPrevented: false,
    transactionErrorName: "ConstraintError", transactionAborted: true,
    transactionCompleted: false, attempted: { scopeMatched: true,
      anchor: { messageId: "u", offset: 24, followsLatest: false } } };
  assert.equal(classifyNativeAbortObservation(valid, true), "VALID_NATIVE_TARGET_ABORT");
  assert.equal(classifyNativeAbortObservation({ ...valid, requestErrorDefaultPrevented: true }, true),
    "INJECTION_INEFFECTIVE");
  assert.equal(classifyNativeAbortObservation({ ...valid, transactionAborted: false }, true),
    "INJECTION_INEFFECTIVE");
  assert.equal(classifyNativeAbortObservation({ ...valid, transactionErrorName: "AbortError" }, true),
    "INJECTION_INEFFECTIVE");
  assert.equal(classifyNativeAbortObservation({ ...valid,
    attempted: { ...valid.attempted, scopeMatched: false } }, true), "POST_ABORT_CANDIDATE_MISMATCH");
  assert.equal(classifyNativeAbortObservation(valid, false), "TRIGGER_PRECONDITION");
});

test("failure artifact and propagated error omit private AssertionError operands", () => {
  const original = new assert.AssertionError({ actual: "SECRET_PROMPT_AND_DRAFT",
    expected: "SECRET_TOKEN", operator: "strictEqual" });
  original.stack = `AssertionError: SECRET_PROMPT_AND_DRAFT\n    at runCacheTransactionAbortSmoke (mobile-session-cache-transaction-abort.mjs:301:7)`;
  const safe = safeNativeAbortFailure(original, "atomic-rollback-readback", "PRECONDITION_OR_ASSERTION_FAILURE");
  assert.equal(safe.evidence.sourceRef, "mobile-session-cache-transaction-abort.mjs:301:7");
  assert.equal(safe.evidence.name, "AssertionError");
  assert.equal(JSON.stringify(safe.evidence).includes("SECRET"), false);
  assert.equal(String(safe.error.stack).includes("SECRET"), false);
  assert.equal(safe.error.cause, undefined);
});

test("trusted wheel failure projection preserves trigger facts without marker text", () => {
  const marker = "PRIVATE_TRANSCRIPT_MARKER";
  const diagnostics = { wheelSequence: { initialGeometry: { host: {
    scrollTop: 100, scrollHeight: 400, clientHeight: 200 }, row: { offsetFromHost: 42 } } },
    finalWheel: { phase: "post-dispatch-audit", deltaY: -16,
      targetPreflight: { targetInsideList: true, targetIsHost: false, pathReachesHost: true,
        targetPath: [{ testId: marker }] } } };
  const audit = { events: [{ isTrusted: true, cancelable: true, deltaY: -16,
    targetInsideList: true, defaultPreventedAfterDispatch: false, targetPath: [marker],
    hostScrollTopAtCapture: 100, hostScrollTopAfterFrame: 116 }] };
  const error = new Error(`trusted finalWheel must reach the RNW inverted-list wheel handler ${marker}`);
  const projected = projectTrustedWheelFailure(error, diagnostics, audit);
  assert.equal(projected.failureCode, "RNW_HANDLER_NOT_REACHED");
  assert.equal(projected.events[0].defaultPreventedAfterDispatch, false);
  assert.equal(projectTrustedWheelFailure(error, diagnostics, { events: [{
    ...audit.events[0], defaultPreventedAfterDispatch: null,
  }] }).events[0].defaultPreventedAfterDispatch, null);
  assert.equal(projected.start.hostScrollTop, 100);
  assert.equal(JSON.stringify(projected).includes(marker), false);
  assert.equal(projectTrustedWheelFailure(new ReferenceError(`SECRET ${marker}`), {}, null).failureCode,
    "HARNESS_REFERENCE_ERROR");
});

test("native hook keeps product requests intact and injects once only after matching manifest publication", async () => {
  const original = globalThis.IDBObjectStore;
  class Request extends EventTarget { result = undefined; error = null; }
  class Store {
    constructor(name, transaction) { this.name = name; this.transaction = transaction; this.calls = []; }
    put(value, key) { const request = new Request(); request.transaction = this.transaction; this.calls.push({ method: "put", value, key, request }); return request; }
    get(key) { const request = new Request(); request.transaction = this.transaction; this.calls.push({ method: "get", key, request }); return request; }
    add(value, key) { const request = new Request(); request.transaction = this.transaction; this.calls.push({ method: "add", value, key, request }); return request; }
  }
  globalThis.IDBObjectStore = Store;
  try {
    const transaction = new EventTarget();
    transaction.db = { name: "kcoder-confirmed-transcripts-v1" };
    transaction.mode = "readwrite";
    transaction.objectStoreNames = ["manifest", "entries"];
    const entries = new Store("entries", transaction);
    const manifest = new Store("manifest", transaction);
    const plan = { databaseName: transaction.db.name,
      targetKey: "target", peerKey: "peer", freeSlot: 2, peerSlot: 1, peerRevision: 10, peerBytes: 4,
      nextRevision: 11, baselineRevision: 10, expectedScope: { threadId: "target-thread" } };
    assert.equal(installNativeAbortProbeInPage(plan), true);
    const state = globalThis.__mobileCacheTransactionAbortProbeV1;
    const blob = new Blob([JSON.stringify({ scope: { threadId: "target-thread" }, anchor: { messageId: "u", offset: 24, followsLatest: false } })]);
    assert.equal(state.arm(), true);
    const wrong = manifest.put(JSON.stringify({ revision: 11, lastKey: "peer", entries: [
      { key: "target", slot: 2, dataRevision: 11 }, { key: "peer", slot: 1, dataRevision: 10 },
    ] }), "current");
    assert.equal(manifest.calls[0].request, wrong);
    assert.equal(entries.calls.filter(call => call.method === "get").length, 0);
    const productEntry = entries.put({ revision: 11, blob }, 2);
    assert.equal(entries.calls[0].request, productEntry);
    manifest.put(JSON.stringify({ revision: 11, lastKey: "peer", entries: [
      { key: "target", slot: 2, dataRevision: 11 }, { key: "peer", slot: 1, dataRevision: 10 },
    ] }), "current");
    assert.equal(entries.calls.filter(call => call.method === "get").length, 0,
      "wrong lastKey must not cause a native peer read or duplicate add");
    const productManifest = manifest.put(JSON.stringify({ revision: 11, lastKey: "target", entries: [
      { key: "target", slot: 2, dataRevision: 11 }, { key: "peer", slot: 1, dataRevision: 10 },
    ] }), "current");
    assert.equal(manifest.calls.at(-1).request, productManifest);
    productEntry.dispatchEvent(new Event("success"));
    productManifest.dispatchEvent(new Event("success"));
    const peerRead = entries.calls.find(call => call.method === "get");
    assert.equal(peerRead.key, 1);
    peerRead.request.result = { revision: 10, blob: new Blob(["peer"], { type: "application/json" }) };
    peerRead.request.dispatchEvent(new Event("success"));
    const injected = entries.calls.find(call => call.method === "add");
    assert.equal(injected.key, 1);
    injected.request.error = { name: "ConstraintError" };
    const nativeError = new Event("error", { bubbles: true, cancelable: true });
    injected.request.dispatchEvent(nativeError);
    assert.equal(nativeError.defaultPrevented, false);
    transaction.error = { name: "ConstraintError" };
    transaction.dispatchEvent(new Event("abort"));
    for (let index = 0; index < 20 && !state.snapshot().attempted; index++) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(state.snapshot().nativeRequestErrorName, "ConstraintError");
    assert.equal(state.snapshot().transactionAborted, true);
    assert.equal(state.snapshot().transactionCompleted, false);
    assert.equal(state.snapshot().injectionCount, 1);
    assert.equal(state.snapshot().sameTransactionVerified, true);
    manifest.put(JSON.stringify({ revision: 11, lastKey: "target", entries: [
      { key: "target", slot: 2, dataRevision: 11 }, { key: "peer", slot: 1, dataRevision: 10 },
    ] }), "current");
    assert.equal(entries.calls.filter(call => call.method === "add").length, 1,
      "the exact manifest cannot inject a second native duplicate add");
    assert.equal(state.snapshot().targetPutSucceeded, true);
    assert.equal(state.snapshot().manifestPutSucceeded, true);
    assert.equal(state.snapshot().requestErrorDefaultPrevented, false);
    assert.equal(state.snapshot().requestErrorBubbles, true);
    assert.equal(state.snapshot().requestErrorCancelable, true);
    assert.equal(state.snapshot().transactionErrorName, "ConstraintError");
    assert.equal(state.snapshot().attempted?.scopeMatched, true, JSON.stringify(state.snapshot()));
    state.restore();
    assert.equal(Store.prototype.put.name, "put");
    assert.equal(globalThis.__mobileCacheTransactionAbortProbeV1, undefined);
    const canceledTransaction = new EventTarget();
    canceledTransaction.db = transaction.db;
    canceledTransaction.mode = "readwrite";
    canceledTransaction.objectStoreNames = ["manifest", "entries"];
    const canceledEntries = new Store("entries", canceledTransaction);
    const canceledManifest = new Store("manifest", canceledTransaction);
    installNativeAbortProbeInPage(plan);
    const canceledState = globalThis.__mobileCacheTransactionAbortProbeV1;
    assert.equal(canceledState.arm(), true);
    canceledEntries.put({ revision: 11, blob: new Blob([JSON.stringify({
      scope: { threadId: "WRONG_THREAD" }, anchor: { messageId: "u", offset: 24, followsLatest: false },
    })]) }, 2);
    canceledManifest.put(JSON.stringify({ revision: 11, lastKey: "target", entries: [
      { key: "target", slot: 2, dataRevision: 11 }, { key: "peer", slot: 1, dataRevision: 10 },
    ] }), "current");
    const canceledRead = canceledEntries.calls.find(call => call.method === "get");
    canceledRead.request.result = { revision: 10, blob: new Blob(["peer"], { type: "application/json" }) };
    canceledRead.request.dispatchEvent(new Event("success"));
    const canceledAdd = canceledEntries.calls.find(call => call.method === "add");
    canceledAdd.request.addEventListener("error", event => event.preventDefault());
    canceledAdd.request.error = { name: "ConstraintError" };
    canceledAdd.request.dispatchEvent(new Event("error", { bubbles: true, cancelable: true }));
    for (let index = 0; index < 20 && !canceledState.snapshot().attempted; index++) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(canceledState.snapshot().requestErrorDefaultPrevented, true,
      "the probe must observe cancellation after the entire request event dispatch");
    assert.equal(canceledState.snapshot().transactionAborted, false);
    assert.equal(canceledState.snapshot().attempted.scopeMatched, false);
    assert.equal(classifyNativeAbortObservation(canceledState.snapshot(), true), "INJECTION_INEFFECTIVE");
    canceledState.restore();
  } finally { globalThis.IDBObjectStore = original; }
});
