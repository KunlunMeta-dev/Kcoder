import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { runTrustedUserAnchorWheelSequenceV1 } from "../../harness/mobile-cache-timing-runner.mjs";
import { prepareUserReadingAnchorViewport } from "../../harness/mobile-session-cache-user-anchor.mjs";
import {
  armTrustedTranscriptWheelObservationWithViewport,
  readTrustedTranscriptWheelObservation as readTrustedWheelObservation,
  readTrustedTranscriptWheelTargetAtPoint as readTrustedWheelTargetAtPoint,
  readTranscriptViewport,
} from "../../harness/mobile-session-cache-transcript-scroll-host.mjs";
import {
  projectCacheStorageFixture,
  readCacheStorageSnapshot,
  selectCacheStorageFixture,
} from "./mobile-session-cache-storage-corruption-fixture.mjs";
import { seedStorageTargetPeerAndDraft } from "./mobile-session-cache-storage-seed.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");
const PROBE_NAME = "__mobileCacheTransactionAbortProbeV1";

/** Bind the fault to the exact UI-seeded physical slots and next save revision. */
export function deriveNativeAbortPlan(fixture) {
  const { manifest, target, peer, snapshot } = fixture;
  assert.ok(Number.isSafeInteger(manifest?.revision) && manifest.revision >= 0);
  assert.equal(manifest.lastKey, target.entry.key);
  assert.equal(manifest.entries.length, 2, "the short gate requires exactly target and peer records");
  assert.ok(manifest.entries.some(entry => entry.key === target.entry.key && entry.slot === target.entry.slot));
  assert.ok(manifest.entries.some(entry => entry.key === peer.entry.key && entry.slot === peer.entry.slot));
  assert.notEqual(target.entry.slot, peer.entry.slot);
  const occupied = manifest.entries.map(entry => entry.slot).sort((a, b) => a - b);
  assert.deepEqual(snapshot.rows.map(row => row.slot).sort((a, b) => a - b), occupied,
    "physical entries must match the exact manifest slots before a native fault");
  const freeSlot = Array.from({ length: 32 }, (_, slot) => slot).find(slot => !occupied.includes(slot));
  assert.ok(Number.isSafeInteger(freeSlot), "the target save needs a free physical slot");
  return { databaseName: "kcoder-confirmed-transcripts-v1", targetKey: target.entry.key,
    peerKey: peer.entry.key, freeSlot, peerSlot: peer.entry.slot,
    peerRevision: peer.entry.dataRevision, peerBytes: peer.entry.bytes,
    nextRevision: manifest.revision + 1,
    baselineRevision: manifest.revision, expectedScope: target.record.scope };
}

/** Keep raw cache records and unsent drafts out of run artifacts. */
export function projectPrivateStorageSnapshot(snapshot) {
  return { manifestSha256: hash(snapshot.manifestRaw),
    rows: snapshot.rows.map(row => ({ slot: row.slot, revision: row.revision,
      type: row.type, sha256: hash(row.raw) })).sort((a, b) => a.slot - b.slot),
    workspaceStates: snapshot.workspaceStates.map(row => ({ keySha256: hash(row.key),
      valueSha256: hash(row.raw) })).sort((a, b) => a.keySha256.localeCompare(b.keySha256)),
    profilesSha256: hash(JSON.stringify(snapshot.profiles)), activeIdSha256: hash(snapshot.activeId) };
}

/** Redact the attempted canonical row identity on both success and failure paths. */
export function projectPrivateNativeProbeSnapshot(snapshot) {
  if (!snapshot) return null;
  const anchor = snapshot.attempted?.anchor;
  return { ...snapshot, attempted: snapshot.attempted ? {
    ...snapshot.attempted,
    anchor: anchor ? { messageIdSha256: hash(anchor.messageId),
      offset: anchor.offset, followsLatest: anchor.followsLatest } : null,
  } : null };
}

/** Distinguish a real, exact native abort from a missing or misleading injection. */
export function classifyNativeAbortObservation(snapshot, wheelObserved) {
  if (!wheelObserved) return "TRIGGER_PRECONDITION";
  if (!snapshot?.sameTransactionVerified || snapshot.injectionCount !== 1 ||
      snapshot.nativeRequestErrorName !== "ConstraintError" ||
      snapshot.requestErrorBubbles !== true || snapshot.requestErrorCancelable !== true ||
      snapshot.requestErrorDefaultPrevented !== false ||
      snapshot.transactionErrorName !== "ConstraintError" ||
      !snapshot.transactionAborted || snapshot.transactionCompleted) return "INJECTION_INEFFECTIVE";
  if (snapshot.attempted?.scopeMatched !== true || !snapshot.attempted.anchor) {
    return "POST_ABORT_CANDIDATE_MISMATCH";
  }
  return "VALID_NATIVE_TARGET_ABORT";
}

/** Preserve a narrow source reference without persisting AssertionError operands. */
export function safeNativeAbortFailure(error, phase, failureClass) {
  const sourceRef = String(error?.stack ?? "").match(/mobile-session-cache-[\w-]+\.mjs:\d+:\d+/)?.[0] ?? null;
  const name = /^(AssertionError|Error|TypeError|TimeoutError)$/.test(error?.name) ? error.name : "Error";
  return { evidence: { name, phase, sourceRef },
    error: new Error(`native abort gate ${failureClass} at ${phase}` +
      (sourceRef ? ` (${sourceRef})` : "")) };
}

/** Browser-serializable, Page-local native request probe; no product handler is replaced. */
export function installNativeAbortProbeInPage(plan) {
  const name = "__mobileCacheTransactionAbortProbeV1";
  if (globalThis[name]) throw new Error("native transaction abort probe is already installed");
  const proto = IDBObjectStore.prototype;
  const nativePut = proto.put, nativeGet = proto.get, nativeAdd = proto.add;
  const nativeDelete = proto.delete, nativeClear = proto.clear;
  const candidates = new WeakMap();
  let phase = "observing";
  let preArmEntryWrites = 0, preArmManifestWrites = 0, preArmOtherWrites = 0, unexpectedWrites = 0;
  let matchedEntryPuts = 0, matchedManifestPuts = 0, injectionCount = 0, sameTransactionVerified = false;
  let targetPutSucceeded = false, manifestPutSucceeded = false, peerOccupancyVerified = false;
  let nativeRequestErrorName = null, requestErrorDefaultPrevented = null;
  let requestErrorBubbles = null, requestErrorCancelable = null;
  let transactionAborted = false, transactionCompleted = false, transactionErrorName = null, invalidReason = null;
  let attempted = null;
  const scoped = store => store?.transaction?.db?.name === plan.databaseName &&
    store.transaction.mode === "readwrite" &&
    Array.from(store.transaction.objectStoreNames).includes("entries") &&
    Array.from(store.transaction.objectStoreNames).includes("manifest");
  const digest = async raw => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw)))]
    .map(byte => byte.toString(16).padStart(2, "0")).join("");
  const inspectBlob = blob => {
    void blob.text().then(async raw => {
      const record = JSON.parse(raw);
      const { anchor: _anchor, ...body } = record;
      attempted = { blobSha256: await digest(raw), bodySha256: await digest(JSON.stringify(body)),
        bytes: new TextEncoder().encode(raw).length,
        scopeMatched: JSON.stringify(record.scope) === JSON.stringify(plan.expectedScope),
        anchor: record.anchor && typeof record.anchor.messageId === "string" &&
          Number.isFinite(record.anchor.offset) && typeof record.anchor.followsLatest === "boolean"
          ? { messageId: record.anchor.messageId, offset: record.anchor.offset,
            followsLatest: record.anchor.followsLatest } : null };
    }).catch(() => { invalidReason = "attempted Blob could not be decoded"; });
  };
  const snapshot = () => ({ phase, preArmEntryWrites, preArmManifestWrites, preArmOtherWrites, unexpectedWrites,
    matchedEntryPuts, matchedManifestPuts, injectionCount, sameTransactionVerified, targetPutSucceeded,
    manifestPutSucceeded, peerOccupancyVerified, nativeRequestErrorName,
    requestErrorDefaultPrevented, requestErrorBubbles, requestErrorCancelable,
    transactionAborted, transactionCompleted, transactionErrorName,
    invalidReason, attempted });
  const state = { snapshot,
    arm() {
      if (phase !== "observing" || preArmEntryWrites || preArmManifestWrites || preArmOtherWrites) return false;
      phase = "armed"; return true;
    },
    restore() {
      if (proto.put === wrappedPut) proto.put = nativePut;
      if (proto.add === wrappedAdd) proto.add = nativeAdd;
      if (proto.delete === wrappedDelete) proto.delete = nativeDelete;
      if (proto.clear === wrappedClear) proto.clear = nativeClear;
      phase = "restored";
      delete globalThis[name];
      return true;
    },
  };
  function wrappedPut(value, key) {
    if (!scoped(this)) return nativePut.call(this, value, key);
    const transaction = this.transaction;
    if (this.name === "entries") {
      if (phase === "observing") preArmEntryWrites++;
      else if (phase === "armed") {
        if (key === plan.freeSlot && value?.revision === plan.nextRevision && value.blob instanceof Blob) {
          matchedEntryPuts++;
          candidates.set(transaction, { store: this, value, request: null });
        } else { unexpectedWrites++; invalidReason = "unexpected entries.put before target publication"; }
      }
      const request = nativePut.call(this, value, key);
      if (candidates.get(transaction)?.value === value) candidates.get(transaction).request = request;
      if (phase === "armed" && candidates.get(transaction)?.value === value) {
        request.addEventListener("success", () => { targetPutSucceeded = true; }, { once: true });
        inspectBlob(value.blob);
      }
      return request;
    }
    if (this.name !== "manifest" || key !== "current") return nativePut.call(this, value, key);
    if (phase === "observing") preArmManifestWrites++;
    const candidate = candidates.get(transaction);
    let matches = false;
    if (phase === "armed" && candidate && typeof value === "string") {
      try {
        const manifest = JSON.parse(value);
        const target = manifest.entries?.filter(row => row.key === plan.targetKey);
        const peer = manifest.entries?.filter(row => row.key === plan.peerKey);
        matches = manifest.revision === plan.nextRevision && manifest.lastKey === plan.targetKey &&
          manifest.entries.length === 2 && target?.length === 1 && peer?.length === 1 &&
          target[0].slot === plan.freeSlot && target[0].dataRevision === plan.nextRevision &&
          peer[0].slot === plan.peerSlot && peer[0].dataRevision === plan.peerRevision;
      } catch { invalidReason = "target manifest could not be decoded"; }
    }
    const request = nativePut.call(this, value, key);
    if (!matches || phase !== "armed") {
      if (phase === "armed") { unexpectedWrites++; invalidReason ||= "manifest did not match exact target save"; }
      return request;
    }
    phase = "triggered";
    matchedManifestPuts++;
    request.addEventListener("success", () => { manifestPutSucceeded = true; }, { once: true });
    transaction.addEventListener("abort", () => {
      transactionAborted = true;
      transactionErrorName = transaction.error?.name ?? null;
    }, { once: true });
    transaction.addEventListener("complete", () => { transactionCompleted = true; }, { once: true });
    try {
      const peerRead = nativeGet.call(candidate.store, plan.peerSlot);
      peerRead.addEventListener("success", () => {
        const peer = peerRead.result;
        if (peer?.revision !== plan.peerRevision || !(peer.blob instanceof Blob) ||
            peer.blob.size !== plan.peerBytes || peer.blob.type !== "application/json") {
          invalidReason = "peer slot was not occupied at native transaction time"; return;
        }
        peerOccupancyVerified = true;
        try {
          const duplicate = nativeAdd.call(candidate.store, peer, plan.peerSlot);
          sameTransactionVerified = candidate.request?.transaction === transaction &&
            request.transaction === transaction && peerRead.transaction === transaction &&
            duplicate.transaction === transaction;
          injectionCount++;
          duplicate.addEventListener("error", event => {
            nativeRequestErrorName = duplicate.error?.name ?? null;
            requestErrorBubbles = event.bubbles;
            requestErrorCancelable = event.cancelable;
            queueMicrotask(() => { requestErrorDefaultPrevented = event.defaultPrevented; });
          }, { once: true });
        } catch { invalidReason = "native duplicate add threw synchronously"; }
      }, { once: true });
      peerRead.addEventListener("error", () => { invalidReason = "native peer read failed"; }, { once: true });
    } catch { invalidReason = "native peer get threw synchronously"; }
    return request;
  }
  function wrappedAdd(...args) {
    if (phase === "observing" && scoped(this)) preArmOtherWrites++;
    return nativeAdd.apply(this, args);
  }
  function wrappedDelete(...args) {
    if (phase === "observing" && scoped(this)) preArmOtherWrites++;
    return nativeDelete.apply(this, args);
  }
  function wrappedClear(...args) {
    if (phase === "observing" && scoped(this)) preArmOtherWrites++;
    return nativeClear.apply(this, args);
  }
  proto.put = wrappedPut;
  proto.add = wrappedAdd;
  if (typeof nativeDelete === "function") proto.delete = wrappedDelete;
  if (typeof nativeClear === "function") proto.clear = wrappedClear;
  Object.defineProperty(globalThis, name, { value: state, configurable: true });
  return true;
}

const readProbe = page => page.evaluate(name => globalThis[name]?.snapshot() ?? null, PROBE_NAME);
const restoreProbe = page => page.evaluate(name => globalThis[name]?.restore() ?? false, PROBE_NAME);

/** Keep the trigger failure inspectable without persisting a marker or transcript text. */
export function projectTrustedWheelFailure(error, diagnostics, audit) {
  const message = String(error?.cause?.message ?? error?.message ?? "");
  const failureCode = error?.name === "ReferenceError" || error?.cause?.name === "ReferenceError"
    ? "HARNESS_REFERENCE_ERROR"
    : /no safe RNW inverted-wheel direction/.test(message) ? "NO_SAFE_DIRECTION"
    : /must reach the RNW inverted-list wheel handler/.test(message) ? "RNW_HANDLER_NOT_REACHED"
    : /to move the same user row/.test(message) ? "NO_HOST_MOVEMENT"
    : /frame must show the source-predicted/.test(message) ? "SCROLL_PREDICTION_MISMATCH"
    : /target ancestry|hit target|targetPath/.test(message) ? "TARGET_ANCESTRY_MISMATCH"
    : /exact marker Range|visible intersection/.test(message) ? "MARKER_GEOMETRY_INVALID"
    : "OTHER_TRIGGER_FAILURE";
  const step = diagnostics?.finalWheel;
  const geometry = value => value ? { hostScrollTop: value.host?.scrollTop ?? null,
    hostScrollHeight: value.host?.scrollHeight ?? null,
    hostClientHeight: value.host?.clientHeight ?? null,
    rowOffset: value.row?.offsetFromHost ?? null,
    markerIntersectsList: value.markerIntersectsList === true,
    markerIntersectsWindow: value.markerIntersectsWindow === true } : null;
  return { failureCode, phase: step?.phase ?? "preflight", deltaY: step?.deltaY ?? null,
    start: geometry(step?.startGeometry ?? diagnostics?.wheelSequence?.initialGeometry),
    last: geometry(step?.lastGeometry), after: geometry(step?.afterGeometry),
    hit: step?.targetPreflight ? { targetInsideList: step.targetPreflight.targetInsideList === true,
      targetIsHost: step.targetPreflight.targetIsHost === true,
      pathReachesHost: step.targetPreflight.pathReachesHost === true,
      pathLength: step.targetPreflight.targetPath?.length ?? null } : null,
    events: (audit?.events ?? []).slice(-4).map(event => ({
      isTrusted: event.isTrusted === true, cancelable: event.cancelable === true,
      deltaY: event.deltaY ?? null, targetInsideList: event.targetInsideList === true,
      defaultPreventedAtCapture: event.defaultPreventedAtCapture === true,
      defaultPreventedAfterDispatch: event.defaultPreventedAfterDispatch === true ? true
        : event.defaultPreventedAfterDispatch === false ? false : null,
      hostScrollTopAtCapture: event.hostScrollTopAtCapture ?? null,
      hostScrollTopAfterDispatch: event.hostScrollTopAfterDispatch ?? null,
      hostScrollTopAfterFrame: event.hostScrollTopAfterFrame ?? null,
    })) };
}

export async function trustedAnchorWheel(page, promptMarker, rowDomId) {
  const armed = await armTrustedTranscriptWheelObservationWithViewport(page, {
    markerText: promptMarker, rowDomId, rowTestId: "message-user",
  });
  assert.equal(armed?.rowDomId, rowDomId);
  assert.equal(armed?.markerIntersectsList, true);
  assert.equal(armed?.markerIntersectsWindow, true);
  assert.ok(armed?.wheelStart, "trusted wheel must have the exact list start geometry");
  const diagnostics = {};
  let result;
  try {
    result = await runTrustedUserAnchorWheelSequenceV1({
      page, markerText: promptMarker, rowDomId, initialGeometry: armed,
      wheelStart: armed.wheelStart, readTranscriptViewport,
      readTrustedWheelTargetAtPoint, readTrustedWheelObservation,
      diagnostics, deadlineAtMs: Date.now() + 5_000,
    });
  } catch (error) {
    let audit = null;
    try { audit = await readTrustedWheelObservation(page); } catch {}
    const safeError = new Error("trusted wheel trigger failed");
    safeError.wheelDiagnostic = projectTrustedWheelFailure(error, diagnostics, audit);
    throw safeError;
  }
  assert.equal(result.finalWheel.dispatch?.isTrusted, true);
  assert.equal(result.finalWheel.dispatch?.defaultPreventedAfterDispatch, true);
  assert.equal(result.afterWheelGeometry.rowDomId, rowDomId);
  assert.ok(Math.abs(result.afterWheelGeometry.host.scrollTop - armed.host.scrollTop) > 0.5);
  return { rowDomId, startOffset: armed.row.offsetFromHost,
    offset: result.afterWheelGeometry.row.offsetFromHost,
    startScrollTop: armed.host.scrollTop, endScrollTop: result.afterWheelGeometry.host.scrollTop,
    deltaY: result.finalWheel.deltaY, isTrusted: true, handledByList: true };
}

function assertNoNewTurns(protocol, baseline) {
  const additions = protocol.requests.slice(baseline).filter(row =>
    row.method === "turn/start" || row.method === "thread/start");
  assert.equal(additions.length, 0, "an anchor save must not start or resend a turn");
}

/** One native ConstraintError abort followed by a distinct real UI anchor save. */
export async function runCacheTransactionAbortSmoke({
  context, page, protocol, expectedScope, threadId, taskUrl, promptMarker, gateway,
  createPeerTask, releaseChromium, waitFor, waitForReadOnlyTranscriptCache,
}) {
  assert.equal(expectedScope.threadId, threadId);
  const evidence = { version: 1, phase: "real-ui-seed", status: "RUNNING",
    boundary: "Web loopback native IndexedDB request ConstraintError and atomic transaction abort; no quota, disk-full, model or native-device claim",
    releases: [] };
  let released = false;
  let cleanupAttempted = false;
  let installed = false;
  let wheelObserved = false;
  let probeSnapshot = null;
  try {
    const { draft, peerThreadId } = await seedStorageTargetPeerAndDraft({
      page, protocol, expectedScope, threadId, taskUrl, promptMarker, gateway,
      createPeerTask, waitFor, waitForReadOnlyTranscriptCache,
    });
    assert.equal(await page.getByTestId("message-input").isEditable(), true);
    const fixtureOptions = { expectedScope, targetThreadId: threadId, peerThreadId,
      marker: promptMarker, draft };
    const beforePreparation = selectCacheStorageFixture(await readCacheStorageSnapshot(page), fixtureOptions);
    const seedUser = beforePreparation.target.record.messages.filter(row => row.role === "user" &&
      row.content.includes(promptMarker));
    assert.equal(seedUser.length, 1);
    const canonicalUserId = seedUser[0].id;
    assert.ok(typeof canonicalUserId === "string" && canonicalUserId.length > 0);
    const beforePreparationGeometry = await readTranscriptViewport(page, {
      markerText: promptMarker, rowTestId: "message-user",
    });
    const prepared = await prepareUserReadingAnchorViewport({ page, promptMarker, readTranscriptViewport });
    const preparationMovedList = Number.isFinite(beforePreparationGeometry.host?.scrollTop) &&
      Math.abs(prepared.geometry.host.scrollTop - beforePreparationGeometry.host.scrollTop) > 0.5;
    await waitFor(async () => {
      const first = projectPrivateStorageSnapshot(await readCacheStorageSnapshot(page));
      await new Promise(resolve => setTimeout(resolve, 350));
      const second = projectPrivateStorageSnapshot(await readCacheStorageSnapshot(page));
      return JSON.stringify(first) === JSON.stringify(second) ? true : null;
    }, 15_000, "preparation scroll and any normal anchor writer to settle before the fault baseline");
    const baseline = selectCacheStorageFixture(await readCacheStorageSnapshot(page), fixtureOptions);
    const plan = deriveNativeAbortPlan(baseline);
    const user = baseline.target.record.messages.filter(row => row.role === "user" &&
      row.content.includes(promptMarker));
    assert.equal(user.length, 1);
    assert.ok(user[0].id === canonicalUserId, "the exact UI-seeded user row must survive preparation");
    const { anchor: _baselineAnchor, ...baselineBody } = baseline.target.record;
    const bodySha256 = hash(JSON.stringify(baselineBody));
    const requestBaseline = protocol.requests.length;
    evidence.before = projectCacheStorageFixture(baseline);
    evidence.preparation = { movedList: preparationMovedList,
      stableStorageReadback: true,
      rowDomIdSha256: hash(prepared.rowDomId) };
    evidence.slotPlan = { freeSlot: plan.freeSlot, peerSlot: plan.peerSlot,
      nextRevision: plan.nextRevision, baselineRevision: plan.baselineRevision,
      exactTargetKeySha256: hash(plan.targetKey), exactPeerKeySha256: hash(plan.peerKey) };
    evidence.phase = "page-local-native-probe-and-quiet-baseline";
    assert.equal(await page.evaluate(installNativeAbortProbeInPage, plan), true);
    installed = true;
    const beforeQuiet = await readCacheStorageSnapshot(page);
    await new Promise(resolve => setTimeout(resolve, 350));
    const afterQuiet = await readCacheStorageSnapshot(page);
    assert.deepEqual(projectPrivateStorageSnapshot(afterQuiet), projectPrivateStorageSnapshot(beforeQuiet),
      "a quiet native baseline must retain every manifest, entry, profile and draft byte");
    assert.deepEqual(projectPrivateStorageSnapshot(afterQuiet), projectPrivateStorageSnapshot(baseline.snapshot),
      "the native probe must start before any background writer touches the seed");
    probeSnapshot = await readProbe(page);
    assert.equal(probeSnapshot.preArmEntryWrites, 0, "no entries writer may run during the quiet baseline");
    assert.equal(probeSnapshot.preArmManifestWrites, 0, "no manifest writer may run during the quiet baseline");
    assert.equal(probeSnapshot.preArmOtherWrites, 0, "no other native cache writer may run during the quiet baseline");
    assert.equal(await page.evaluate(name => globalThis[name].arm(), PROBE_NAME), true);
    evidence.quietBaseline = { milliseconds: 350, nativeEntryWrites: 0, nativeManifestWrites: 0,
      nativeOtherWrites: 0,
      completeStorageUnchanged: true };

    evidence.phase = "one-trusted-wheel-native-abort";
    const failedWheel = await trustedAnchorWheel(page, promptMarker, prepared.rowDomId);
    wheelObserved = true;
    assert.ok(Math.abs(failedWheel.offset - failedWheel.startOffset) > 0.5,
      "the failed attempt must contain a changed user-row anchor offset");
    probeSnapshot = await waitFor(async () => {
      const current = await readProbe(page);
      return current?.transactionAborted && current?.attempted &&
        current.requestErrorDefaultPrevented !== null ? current : null;
    }, 15_000, "one native duplicate-key request error and transaction abort");
    assert.equal(probeSnapshot.phase, "triggered");
    assert.equal(probeSnapshot.matchedEntryPuts, 1);
    assert.equal(probeSnapshot.matchedManifestPuts, 1);
    assert.equal(probeSnapshot.injectionCount, 1);
    assert.equal(probeSnapshot.sameTransactionVerified, true);
    assert.equal(probeSnapshot.peerOccupancyVerified, true);
    assert.equal(probeSnapshot.targetPutSucceeded, true);
    assert.equal(probeSnapshot.manifestPutSucceeded, true);
    assert.equal(probeSnapshot.nativeRequestErrorName, "ConstraintError");
    assert.equal(probeSnapshot.requestErrorBubbles, true);
    assert.equal(probeSnapshot.requestErrorCancelable, true);
    assert.equal(probeSnapshot.requestErrorDefaultPrevented, false);
    assert.equal(probeSnapshot.transactionAborted, true);
    assert.equal(probeSnapshot.transactionCompleted, false);
    assert.equal(probeSnapshot.transactionErrorName, "ConstraintError",
      "the native transaction must abort for the uncanceled duplicate-key request error");
    assert.equal(probeSnapshot.invalidReason, null);
    assert.equal(probeSnapshot.unexpectedWrites, 0);
    assert.equal(probeSnapshot.attempted.scopeMatched, true);
    assert.equal(classifyNativeAbortObservation(probeSnapshot, true), "VALID_NATIVE_TARGET_ABORT");
    assert.equal(probeSnapshot.attempted.bodySha256, bodySha256,
      "the rejected original Blob must retain the exact target transcript body");
    assert.ok(probeSnapshot.attempted.anchor?.messageId === canonicalUserId,
      "the attempted native Blob must point to the exact canonical user row");
    assert.equal(probeSnapshot.attempted.anchor?.followsLatest, false);
    assert.ok(Math.abs(probeSnapshot.attempted.anchor.offset - failedWheel.offset) <= 2,
      "the rejected product Blob must contain the trusted wheel's measured anchor");
    assert.ok(JSON.stringify(probeSnapshot.attempted.anchor) !== JSON.stringify(baseline.target.record.anchor),
      "the rejected product Blob must attempt a new reading anchor");
    evidence.nativeAbort = projectPrivateNativeProbeSnapshot(probeSnapshot);
    evidence.nativeAbort.attempted.anchor.offsetMatchesTrustedWheel = true;
    evidence.nativeAbort.attempted.anchor.changedFromBaseline = true;
    const { rowDomId: failedRowDomId, ...failedWheelGeometry } = failedWheel;
    evidence.failedWheel = { ...failedWheelGeometry, rowDomIdSha256: hash(failedRowDomId) };

    evidence.phase = "atomic-rollback-readback";
    const rolledBack = await readCacheStorageSnapshot(page);
    assert.deepEqual(projectPrivateStorageSnapshot(rolledBack), projectPrivateStorageSnapshot(baseline.snapshot),
      "native abort must roll back every manifest, target, peer and draft byte");
    selectCacheStorageFixture(rolledBack, fixtureOptions);
    assertNoNewTurns(protocol, requestBaseline);
    assert.equal(await page.getByTestId("message-user").filter({ hasText: promptMarker }).count(), 1);
    assert.ok(await page.getByTestId("message-input").inputValue() === draft,
      "the original unsent composer draft must remain visible after native abort");
    assert.equal(await page.getByTestId("message-input").isEditable(), true);
    evidence.rollback = { completeStorageUnchanged: true, targetAndPeerAndDraftUnchanged: true,
      visibleTranscriptAndEditableComposer: true, noNewTurn: true };

    evidence.phase = "disarm-and-distinct-trusted-wheel-success";
    assert.equal(await restoreProbe(page), true);
    installed = false;
    const successfulWheel = await trustedAnchorWheel(page, promptMarker, prepared.rowDomId);
    assert.ok(Math.abs(successfulWheel.offset - failedWheel.offset) > 0.5,
      "the recovery wheel must save a distinct later anchor");
    const committed = await waitFor(async () => {
      const snapshot = await readCacheStorageSnapshot(page);
      const manifest = JSON.parse(snapshot.manifestRaw);
      return manifest.revision >= plan.nextRevision ? snapshot : null;
    }, 15_000, "the disarmed native transaction to commit the later trusted anchor");
    const after = selectCacheStorageFixture(committed, fixtureOptions);
    assert.equal(after.manifest.revision, plan.nextRevision);
    assert.equal(after.target.entry.slot, plan.freeSlot);
    assert.equal(after.target.entry.dataRevision, plan.nextRevision);
    assert.equal(after.peer.entry.slot, baseline.peer.entry.slot);
    assert.equal(after.peer.entry.dataRevision, baseline.peer.entry.dataRevision);
    assert.equal(after.peer.sha256, baseline.peer.sha256);
    assert.equal(hash(after.draft.raw), hash(baseline.draft.raw));
    const { anchor: _committedAnchor, ...committedBody } = after.target.record;
    assert.equal(hash(JSON.stringify(committedBody)), bodySha256);
    assert.ok(after.target.record.anchor?.messageId === canonicalUserId,
      "the recovery save must retain the same canonical user row");
    assert.equal(after.target.record.anchor?.followsLatest, false);
    assert.ok(Math.abs(after.target.record.anchor.offset - successfulWheel.offset) <= 2);
    assert.equal(await page.getByTestId("message-user").filter({ hasText: promptMarker }).count(), 1);
    assert.ok(await page.getByTestId("message-input").inputValue() === draft);
    assert.equal(await page.getByTestId("message-input").isEditable(), true);
    assertNoNewTurns(protocol, requestBaseline);
    evidence.after = projectCacheStorageFixture(after);
    const { rowDomId: successfulRowDomId, ...successfulWheelGeometry } = successfulWheel;
    evidence.successfulWheel = { ...successfulWheelGeometry, rowDomIdSha256: hash(successfulRowDomId) };
    evidence.recovery = { committedRevision: after.manifest.revision, anchorMessageIdSha256: hash(canonicalUserId),
      anchorMatchesTrustedWheel: true, exactTargetBodyUnchanged: true, peerAndDraftUnchanged: true,
      noNewTurn: true };
    evidence.phase = "exact-owner-release";
    cleanupAttempted = true;
    evidence.releases.push(await releaseChromium("storage-abort-complete", { restart: false,
      page, protocol, requiredSocketOrdinal: protocol.activeTaskSocketOrdinal }));
    released = true;
    evidence.phase = "complete";
    evidence.status = "PASS_NATIVE_CONSTRAINT_ERROR_ATOMIC_ABORT_AND_RECOVERY";
    return evidence;
  } catch (error) {
    const cleanupErrors = [];
    if (installed && !page.isClosed()) {
      try { probeSnapshot = await readProbe(page); await restoreProbe(page); }
      catch (restoreError) { cleanupErrors.push(restoreError); }
    }
    if (probeSnapshot) evidence.failedProbe = projectPrivateNativeProbeSnapshot(probeSnapshot);
    if (error?.wheelDiagnostic) evidence.triggerDiagnostic = error.wheelDiagnostic;
    if (!released && !cleanupAttempted) {
      cleanupAttempted = true;
      try { evidence.releases.push(await releaseChromium("storage-abort-failure", { restart: false,
        ...(!page.isClosed() ? { page, protocol, requiredSocketOrdinal: protocol.activeTaskSocketOrdinal } : {}) })); }
      catch (cleanupError) { cleanupErrors.push(cleanupError); }
    }
    evidence.status = "FAIL";
    const nativeAssessment = classifyNativeAbortObservation(probeSnapshot, wheelObserved);
    evidence.failureClass = evidence.phase === "one-trusted-wheel-native-abort"
      ? nativeAssessment === "VALID_NATIVE_TARGET_ABORT" ? "POST_ABORT_CANDIDATE_OR_ASSERTION_FAILURE"
        : nativeAssessment : "PRECONDITION_OR_ASSERTION_FAILURE";
    const safe = safeNativeAbortFailure(error, evidence.phase, evidence.failureClass);
    evidence.error = safe.evidence;
    evidence.cleanupErrors = cleanupErrors.map(value => ({
      name: /^(AssertionError|Error|TypeError|TimeoutError)$/.test(value?.name) ? value.name : "Error" }));
    await context.writeArtifactJson("mobile-session-cache-transaction-abort-failure.json", evidence);
    if (cleanupErrors.length) throw new AggregateError([safe.error,
      ...cleanupErrors.map(() => new Error("exact owner cleanup failed"))], "native abort gate and owner cleanup failed");
    throw safe.error;
  }
}
