import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { prepareUserReadingAnchorViewport } from "../../harness/mobile-session-cache-user-anchor.mjs";
import { readTranscriptViewport } from "../../harness/mobile-session-cache-transcript-scroll-host.mjs";
import {
  projectCacheStorageFixture, readCacheStorageSnapshot, selectCacheStorageFixture,
} from "./mobile-session-cache-storage-corruption-fixture.mjs";
import { seedStorageTargetPeerAndDraft } from "./mobile-session-cache-storage-seed.mjs";
import {
  deriveNativeAbortPlan, projectPrivateStorageSnapshot, trustedAnchorWheel,
} from "./mobile-session-cache-transaction-abort.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");
const PROBE_NAME = "__mobileCacheQuotaProbeV1";
const QUOTA_SIZE = 1;

/** A quota result is valid only when the original target transaction aborts natively. */
export function classifyQuotaObservation(snapshot, wheelObserved) {
  if (!wheelObserved) return "TRIGGER_PRECONDITION";
  if (!snapshot || snapshot.matchedEntryPuts !== 1 || snapshot.matchedManifestPuts !== 1 ||
      !snapshot.sameTransactionVerified || snapshot.unexpectedWrites !== 0 || snapshot.invalidReason ||
      !snapshot.transactionAborted || snapshot.transactionCompleted ||
      snapshot.transactionErrorName !== "QuotaExceededError") return "NATIVE_QUOTA_UNVERIFIED";
  if (snapshot.attempted?.scopeMatched !== true || !snapshot.attempted.anchor)
    return "POST_ABORT_CANDIDATE_MISMATCH";
  return "VALID_NATIVE_QUOTA_ABORT";
}

export function projectPrivateQuotaProbeSnapshot(snapshot) {
  if (!snapshot) return null;
  const anchor = snapshot.attempted?.anchor;
  return { ...snapshot, attempted: snapshot.attempted ? {
    ...snapshot.attempted,
    anchor: anchor ? { messageIdSha256: hash(anchor.messageId),
      offset: anchor.offset, followsLatest: anchor.followsLatest } : null,
  } : null };
}

export function safeQuotaFailure(error, phase, failureClass) {
  const sourceRef = String(error?.stack ?? "").match(/mobile-session-cache-quota\.mjs:\d+:\d+/)?.[0] ?? null;
  const name = /^(AssertionError|Error|TypeError|TimeoutError|ProtocolError)$/.test(error?.name)
    ? error.name : "Error";
  return { evidence: { name, phase, sourceRef },
    error: new Error(`native quota gate ${failureClass} at ${phase}` +
      (sourceRef ? ` (${sourceRef})` : "")) };
}

/** Observe only Page-local original native writes; this hook queues no request. */
export function installQuotaProbeInPage(plan, clock = () => performance.now()) {
  const name = "__mobileCacheQuotaProbeV1";
  const quietWindowMs = 32_000;
  if (globalThis[name]) throw new Error("quota probe is already installed");
  const proto = IDBObjectStore.prototype;
  const nativePut = proto.put, nativeAdd = proto.add;
  const nativeDelete = proto.delete, nativeClear = proto.clear;
  const candidates = new WeakMap();
  let phase = "observing";
  let preArmEntryWrites = 0, preArmManifestWrites = 0, preArmOtherWrites = 0;
  let unexpectedWrites = 0, matchedEntryPuts = 0, matchedManifestPuts = 0;
  let sameTransactionVerified = false, targetPutSucceeded = false, manifestPutSucceeded = false;
  let targetPutErrorName = null, manifestPutErrorName = null;
  let transactionAborted = false, transactionCompleted = false, transactionErrorName = null;
  let invalidReason = null, attempted = null, attemptedPromise = null;
  const observingStartedAtMs = clock();
  let armedAfterQuietMs = null;
  const scoped = store => store?.transaction?.db?.name === plan.databaseName &&
    store.transaction.mode === "readwrite" &&
    Array.from(store.transaction.objectStoreNames).includes("entries") &&
    Array.from(store.transaction.objectStoreNames).includes("manifest");
  const digest = async raw => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw)))]
    .map(byte => byte.toString(16).padStart(2, "0")).join("");
  const inspectBlob = blob => {
    attemptedPromise = blob.text().then(async raw => {
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
  const snapshot = () => ({ phase, quietWindowMs,
    observingElapsedMs: clock() - observingStartedAtMs, armedAfterQuietMs,
    preArmEntryWrites, preArmManifestWrites, preArmOtherWrites,
    unexpectedWrites, matchedEntryPuts, matchedManifestPuts, sameTransactionVerified,
    targetPutSucceeded, manifestPutSucceeded, targetPutErrorName, manifestPutErrorName,
    transactionAborted, transactionCompleted, transactionErrorName, invalidReason, attempted });
  const state = { snapshot,
    arm() {
      const elapsedMs = clock() - observingStartedAtMs;
      if (phase !== "observing" || elapsedMs < quietWindowMs ||
          preArmEntryWrites || preArmManifestWrites || preArmOtherWrites) return false;
      armedAfterQuietMs = elapsedMs;
      phase = "armed"; return true;
    },
    async inspectAttempt() { if (attemptedPromise) await attemptedPromise; return snapshot(); },
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
  function wrappedPut(...args) {
    if (!scoped(this)) return Reflect.apply(nativePut, this, args);
    const [value, key] = args;
    const transaction = this.transaction;
    if (this.name === "entries") {
      if (phase === "observing") preArmEntryWrites++;
      else if (phase === "triggered") unexpectedWrites++;
      if (phase === "armed") {
        if (key === plan.freeSlot && value?.revision === plan.nextRevision && value.blob instanceof Blob) {
          matchedEntryPuts++;
          candidates.set(transaction, { value, request: null });
        } else { unexpectedWrites++; invalidReason = "unexpected entries.put"; }
      }
      const request = Reflect.apply(nativePut, this, args);
      const candidate = candidates.get(transaction);
      if (phase === "armed" && candidate?.value === value) {
        candidate.request = request;
        request.addEventListener("success", () => { targetPutSucceeded = true; }, { once: true });
        request.addEventListener("error", () => { targetPutErrorName = request.error?.name ?? null; }, { once: true });
        inspectBlob(value.blob);
      }
      return request;
    }
    if (this.name !== "manifest" || key !== "current") return Reflect.apply(nativePut, this, args);
    if (phase === "observing") preArmManifestWrites++;
    else if (phase === "triggered") unexpectedWrites++;
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
    const request = Reflect.apply(nativePut, this, args);
    if (phase === "armed") {
      if (!matches) { unexpectedWrites++; invalidReason ||= "manifest did not match exact target save"; }
      else {
        matchedManifestPuts++;
        sameTransactionVerified = candidate.request?.transaction === transaction &&
          request.transaction === transaction;
        phase = "triggered";
        request.addEventListener("success", () => { manifestPutSucceeded = true; }, { once: true });
        request.addEventListener("error", () => { manifestPutErrorName = request.error?.name ?? null; }, { once: true });
        transaction.addEventListener("abort", () => {
          transactionAborted = true;
          transactionErrorName = transaction.error?.name ?? null;
        }, { once: true });
        transaction.addEventListener("complete", () => { transactionCompleted = true; }, { once: true });
      }
    }
    return request;
  }
  function wrappedAdd(...args) {
    if (scoped(this) && phase === "observing") preArmOtherWrites++;
    else if (scoped(this) && (phase === "armed" || phase === "triggered")) unexpectedWrites++;
    return Reflect.apply(nativeAdd, this, args);
  }
  function wrappedDelete(...args) {
    if (scoped(this) && phase === "observing") preArmOtherWrites++;
    else if (scoped(this) && phase === "armed" && !candidates.has(this.transaction)) unexpectedWrites++;
    return Reflect.apply(nativeDelete, this, args);
  }
  function wrappedClear(...args) {
    if (scoped(this) && phase === "observing") preArmOtherWrites++;
    else if (scoped(this) && (phase === "armed" || phase === "triggered")) unexpectedWrites++;
    return Reflect.apply(nativeClear, this, args);
  }
  proto.put = wrappedPut;
  proto.add = wrappedAdd;
  if (typeof nativeDelete === "function") proto.delete = wrappedDelete;
  if (typeof nativeClear === "function") proto.clear = wrappedClear;
  Object.defineProperty(globalThis, name, { value: state, configurable: true });
  return true;
}

const readProbe = page => page.evaluate(name => globalThis[name]?.snapshot() ?? null, PROBE_NAME);
const inspectProbe = page => page.evaluate(name => globalThis[name]?.inspectAttempt() ?? null, PROBE_NAME);
const restoreProbe = page => page.evaluate(name => globalThis[name]?.restore() ?? false, PROBE_NAME);

function quotaNumbers(result) {
  return { usage: result?.usage, quota: result?.quota, overrideActive: result?.overrideActive };
}

/** Caller owns the reset obligation as soon as override is sent. */
export async function overrideOriginQuota(cdp, origin, beforeOverride = () => {}) {
  const before = await cdp.send("Storage.getUsageAndQuota", { origin });
  assert.equal(before.overrideActive, false);
  assert.ok(Number.isFinite(before.usage) && before.usage > QUOTA_SIZE);
  beforeOverride();
  await cdp.send("Storage.overrideQuotaForOrigin", { origin, quotaSize: QUOTA_SIZE });
  const after = await cdp.send("Storage.getUsageAndQuota", { origin });
  assert.equal(after.overrideActive, true);
  assert.equal(after.quota, QUOTA_SIZE);
  return { before: quotaNumbers(before), active: quotaNumbers(after) };
}

export async function resetOriginQuota(cdp, origin) {
  await cdp.send("Storage.overrideQuotaForOrigin", { origin });
  const after = await cdp.send("Storage.getUsageAndQuota", { origin });
  assert.equal(after.overrideActive, false);
  return quotaNumbers(after);
}

function assertNoNewTurns(protocol, baseline) {
  assert.equal(protocol.requests.slice(baseline).filter(row =>
    row.method === "turn/start" || row.method === "thread/start").length, 0);
}

/** One CDP quota clamp, native abort, verified reset, then a distinct real UI save. */
export async function runCacheQuotaSmoke({
  context, page, protocol, expectedScope, threadId, taskUrl, promptMarker, gateway,
  createPeerTask, releaseChromium, waitFor, waitForReadOnlyTranscriptCache,
}) {
  const evidence = { version: 1, phase: "real-ui-seed", status: "RUNNING",
    boundary: "Web loopback CDP origin quota override; native IndexedDB QuotaExceededError transaction abort, atomic rollback and real UI recovery; no physical disk-full/native-device/model claim",
    releases: [] };
  let cleanupAttempted = false, installed = false, wheelObserved = false;
  let cdp = null, origin = null, resetOwed = false, resetVerified = false;
  let probeSnapshot = null, failedWheel = null;
  const quotaCleanupErrors = [];
  try {
    assert.equal(expectedScope.threadId === threadId, true);
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
    const prepared = await prepareUserReadingAnchorViewport({ page, promptMarker, readTranscriptViewport });
    await waitFor(async () => {
      const first = projectPrivateStorageSnapshot(await readCacheStorageSnapshot(page));
      await new Promise(resolve => setTimeout(resolve, 350));
      const second = projectPrivateStorageSnapshot(await readCacheStorageSnapshot(page));
      return JSON.stringify(first) === JSON.stringify(second) ? true : null;
    }, 15_000, "preparation scroll and normal anchor writer to settle");
    const baseline = selectCacheStorageFixture(await readCacheStorageSnapshot(page), fixtureOptions);
    const plan = deriveNativeAbortPlan(baseline);
    const user = baseline.target.record.messages.filter(row => row.role === "user" &&
      row.content.includes(promptMarker));
    assert.equal(user.length, 1);
    assert.equal(user[0].id === canonicalUserId, true);
    const { anchor: _baselineAnchor, ...baselineBody } = baseline.target.record;
    const bodySha256 = hash(JSON.stringify(baselineBody));
    const requestBaseline = protocol.requests.length;
    evidence.before = projectCacheStorageFixture(baseline);
    evidence.slotPlan = { freeSlot: plan.freeSlot, peerSlot: plan.peerSlot,
      nextRevision: plan.nextRevision, baselineRevision: plan.baselineRevision,
      exactTargetKeySha256: hash(plan.targetKey), exactPeerKeySha256: hash(plan.peerKey),
      rowDomIdSha256: hash(prepared.rowDomId) };
    evidence.phase = "page-local-passive-probe-and-quiet-baseline";
    assert.equal(await page.evaluate(installQuotaProbeInPage, plan), true);
    installed = true;
    const beforeQuiet = await readCacheStorageSnapshot(page);
    // Let the native bucket's earlier cached space expire while the probe observes normal writes.
    await new Promise(resolve => setTimeout(resolve, 32_000));
    const afterQuiet = await readCacheStorageSnapshot(page);
    assert.deepEqual(projectPrivateStorageSnapshot(afterQuiet), projectPrivateStorageSnapshot(beforeQuiet));
    assert.deepEqual(projectPrivateStorageSnapshot(afterQuiet), projectPrivateStorageSnapshot(baseline.snapshot));
    probeSnapshot = await readProbe(page);
    assert.equal(probeSnapshot.preArmEntryWrites, 0);
    assert.equal(probeSnapshot.preArmManifestWrites, 0);
    assert.equal(probeSnapshot.preArmOtherWrites, 0);
    assert.equal(probeSnapshot.quietWindowMs, 32_000);
    assert.ok(probeSnapshot.observingElapsedMs >= probeSnapshot.quietWindowMs);
    assert.equal(await page.evaluate(name => globalThis[name].arm(), PROBE_NAME), true);
    probeSnapshot = await readProbe(page);
    assert.ok(probeSnapshot.armedAfterQuietMs >= probeSnapshot.quietWindowMs);
    evidence.quietBaseline = { requiredMilliseconds: probeSnapshot.quietWindowMs,
      observedMilliseconds: probeSnapshot.armedAfterQuietMs,
      completeStorageUnchanged: true, nativeWrites: 0 };

    evidence.phase = "cdp-origin-quota-override";
    origin = new URL(page.url()).origin;
    cdp = await page.context().newCDPSession(page);
    try {
      // Register the reset before sending the override, including a partial send/readback failure.
      evidence.quota = await overrideOriginQuota(cdp, origin, () => { resetOwed = true; });
      evidence.phase = "one-trusted-wheel-native-quota-abort";
      failedWheel = await trustedAnchorWheel(page, promptMarker, prepared.rowDomId);
      wheelObserved = true;
      assert.ok(Math.abs(failedWheel.offset - failedWheel.startOffset) > 0.5);
      probeSnapshot = await waitFor(async () => {
        const current = await readProbe(page);
        return current?.transactionAborted || current?.transactionCompleted ? current : null;
      }, 15_000, "the original native target transaction to settle under the CDP quota clamp");
      probeSnapshot = await inspectProbe(page);
      assert.equal(classifyQuotaObservation(probeSnapshot, wheelObserved), "VALID_NATIVE_QUOTA_ABORT");
      assert.equal(probeSnapshot.attempted.bodySha256, bodySha256);
      assert.equal(probeSnapshot.attempted.anchor.messageId === canonicalUserId, true);
      assert.equal(probeSnapshot.attempted.anchor.followsLatest, false);
      assert.ok(Math.abs(probeSnapshot.attempted.anchor.offset - failedWheel.offset) <= 2);
      assert.equal(JSON.stringify(probeSnapshot.attempted.anchor) !==
        JSON.stringify(baseline.target.record.anchor), true);
      evidence.nativeQuotaAbort = projectPrivateQuotaProbeSnapshot(probeSnapshot);
      evidence.nativeQuotaAbort.attempted.anchor.offsetMatchesTrustedWheel = true;
      evidence.nativeQuotaAbort.attempted.byteDeltaFromBaseline =
        probeSnapshot.attempted.bytes - baseline.target.entry.bytes;
      const { rowDomId: failedRowDomId, ...failedWheelGeometry } = failedWheel;
      evidence.failedWheel = { ...failedWheelGeometry, rowDomIdSha256: hash(failedRowDomId) };

      evidence.phase = "atomic-rollback-readback";
      const rolledBack = await readCacheStorageSnapshot(page);
      assert.deepEqual(projectPrivateStorageSnapshot(rolledBack), projectPrivateStorageSnapshot(baseline.snapshot));
      selectCacheStorageFixture(rolledBack, fixtureOptions);
      assertNoNewTurns(protocol, requestBaseline);
      assert.equal(await page.getByTestId("message-user").filter({ hasText: promptMarker }).count(), 1);
      assert.equal(await page.getByTestId("message-input").inputValue() === draft, true);
      assert.equal(await page.getByTestId("message-input").isEditable(), true);
      evidence.rollback = { completeStorageUnchanged: true, targetAndPeerAndDraftUnchanged: true,
        visibleTranscriptAndEditableComposer: true, noNewTurn: true };
    } finally {
      if (resetOwed && cdp) {
        try {
          evidence.quota = { ...(evidence.quota ?? {}), reset: await resetOriginQuota(cdp, origin) };
          resetVerified = true;
          resetOwed = false;
        } catch (resetError) { quotaCleanupErrors.push(resetError); }
      }
      if (cdp && !resetOwed) {
        try { await cdp.detach(); cdp = null; }
        catch (detachError) { quotaCleanupErrors.push(detachError); }
      }
    }
    evidence.phase = "quota-reset-verify-and-disarm";
    assert.equal(quotaCleanupErrors.length, 0, "quota reset and Page CDP detach must complete");
    assert.equal(resetVerified, true);
    assert.equal(await restoreProbe(page), true);
    installed = false;
    evidence.phase = "distinct-trusted-wheel-success";
    const successfulWheel = await trustedAnchorWheel(page, promptMarker, prepared.rowDomId);
    assert.ok(Math.abs(successfulWheel.offset - failedWheel.offset) > 0.5);
    const committed = await waitFor(async () => {
      const snapshot = await readCacheStorageSnapshot(page);
      return JSON.parse(snapshot.manifestRaw).revision >= plan.nextRevision ? snapshot : null;
    }, 15_000, "the restored origin quota to permit a later real anchor save");
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
    assert.equal(after.target.record.anchor?.messageId === canonicalUserId, true);
    assert.equal(after.target.record.anchor?.followsLatest, false);
    assert.ok(Math.abs(after.target.record.anchor.offset - successfulWheel.offset) <= 2);
    assert.equal(await page.getByTestId("message-input").inputValue() === draft, true);
    assertNoNewTurns(protocol, requestBaseline);
    evidence.after = projectCacheStorageFixture(after);
    const { rowDomId: successfulRowDomId, ...successfulWheelGeometry } = successfulWheel;
    evidence.successfulWheel = { ...successfulWheelGeometry, rowDomIdSha256: hash(successfulRowDomId) };
    evidence.recovery = { committedRevision: after.manifest.revision, anchorMessageIdSha256: hash(canonicalUserId),
      anchorMatchesTrustedWheel: true, exactTargetBodyUnchanged: true, peerAndDraftUnchanged: true,
      noNewTurn: true, overrideResetVerified: resetVerified };
    evidence.phase = "exact-owner-release";
    cleanupAttempted = true;
    evidence.releases.push(await releaseChromium("storage-quota-complete", { restart: false,
      page, protocol, requiredSocketOrdinal: protocol.activeTaskSocketOrdinal }));
    evidence.phase = "complete";
    evidence.status = "PASS_NATIVE_QUOTA_EXCEEDED_ATOMIC_ABORT_AND_RECOVERY";
    return evidence;
  } catch (error) {
    const cleanupErrors = [...quotaCleanupErrors];
    if (installed && !page.isClosed()) {
      try { probeSnapshot = await inspectProbe(page); }
      catch (inspectError) { cleanupErrors.push(inspectError); }
      try { await restoreProbe(page); }
      catch (restoreError) { cleanupErrors.push(restoreError); }
    }
    if (probeSnapshot) {
      evidence.failedProbe = projectPrivateQuotaProbeSnapshot(probeSnapshot);
      if (Number.isFinite(probeSnapshot.attempted?.bytes) && Number.isFinite(evidence.before?.target?.bytes))
        evidence.failedProbe.attempted.byteDeltaFromBaseline =
          probeSnapshot.attempted.bytes - evidence.before.target.bytes;
    }
    if (error?.wheelDiagnostic) evidence.triggerDiagnostic = error.wheelDiagnostic;
    evidence.quotaResetVerified = resetVerified;
    if (!cleanupAttempted) {
      cleanupAttempted = true;
      try { evidence.releases.push(await releaseChromium("storage-quota-failure", { restart: false,
        ...(!page.isClosed() ? { page, protocol, requiredSocketOrdinal: protocol.activeTaskSocketOrdinal } : {}) })); }
      catch (releaseError) { cleanupErrors.push(releaseError); }
    }
    evidence.status = "FAIL";
    evidence.failureClass = evidence.phase === "one-trusted-wheel-native-quota-abort"
      ? classifyQuotaObservation(probeSnapshot, wheelObserved) === "VALID_NATIVE_QUOTA_ABORT"
        ? "POST_ABORT_CANDIDATE_OR_ASSERTION_FAILURE" : classifyQuotaObservation(probeSnapshot, wheelObserved)
      : evidence.phase === "cdp-origin-quota-override" ? "CDP_OVERRIDE_UNVERIFIED"
      : "PRECONDITION_OR_ASSERTION_FAILURE";
    const safe = safeQuotaFailure(error, evidence.phase, evidence.failureClass);
    evidence.error = safe.evidence;
    evidence.cleanupErrors = cleanupErrors.map(value =>
      safeQuotaFailure(value, "quota-reset-or-owner-cleanup", "CLEANUP_FAILURE").evidence);
    await context.writeArtifactJson("mobile-session-cache-quota-failure.json", evidence);
    if (cleanupErrors.length) throw new AggregateError([safe.error,
      ...cleanupErrors.map(() => new Error("exact quota reset or owner cleanup failed"))],
    "native quota gate and owner cleanup failed");
    throw safe.error;
  }
}
