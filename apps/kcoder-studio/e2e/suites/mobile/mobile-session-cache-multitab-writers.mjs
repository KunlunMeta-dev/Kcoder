import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createDirectMobileTimingLaneDescriptor } from "../../harness/mobile-cache-timing-runner.mjs";
import { closeMobileTimingTaskPage, openMobileTimingCacheObserverPage } from "../../harness/mobile-cache-timing-page-ownership.mjs";
import { prepareUserReadingAnchorViewport } from "../../harness/mobile-session-cache-user-anchor.mjs";
import { readTranscriptViewport } from "../../harness/mobile-session-cache-transcript-scroll-host.mjs";
import { readCacheStorageSnapshot, TRANSCRIPT_DATABASE } from "./mobile-session-cache-storage-corruption-fixture.mjs";
import { seedStorageTargetPeerAndDraft } from "./mobile-session-cache-storage-seed.mjs";
import { projectPrivateStorageSnapshot, trustedAnchorWheel } from "./mobile-session-cache-transaction-abort.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");
const PROBE_NAME = "__mobileCacheMultitabWriterProbeV1";
const HOLDER_NAME = "__mobileCacheMultitabLockHolderV1";
const LOCK_NAME = "kcoder-mobile:gateway-profile-index";

export function safeMultitabFailure(error, phase, failureClass) {
  const sourceRef = String(error?.stack ?? "").match(/mobile-session-cache-multitab-writers\.mjs:\d+:\d+/)?.[0] ?? null;
  const name = /^(AssertionError|Error|TypeError|TimeoutError|ProtocolError)$/.test(error?.name)
    ? error.name : "Error";
  return { evidence: { name, phase, sourceRef },
    error: new Error(`multitab writers gate ${failureClass} at ${phase}` +
      (sourceRef ? ` (${sourceRef})` : "")) };
}

export function assertCanonicalResumeCacheIdentity(snapshot, threadId, marker, response) {
  const matches = snapshot.rows.flatMap(row => {
    const record = JSON.parse(row.raw);
    return record.scope?.threadId === threadId ? [record] : [];
  });
  assert.equal(matches.length, 1, "the resumed thread must have one native cached record");
  const users = matches[0].messages.filter(row => row.role === "user" && row.content.includes(marker));
  assert.equal(users.length, 1, "the resumed cache must retain one canonical marked user row");
  assert.equal(response.markerMessageId, users[0].id,
    "the unchanged authoritative resume and native cache must identify the same canonical user");
  return hash(users[0].id);
}

/** A Page-local observer forwards each original lock request and IDB operation once. */
export function installMultitabWriterProbeInPage(plan) {
  const name = "__mobileCacheMultitabWriterProbeV1";
  const lockName = "kcoder-mobile:gateway-profile-index";
  if (globalThis[name]) throw new Error("multitab writer probe is already installed");
  const nativeLockRequest = navigator.locks.request;
  const proto = IDBObjectStore.prototype;
  const nativePut = proto.put, nativeAdd = proto.add;
  const nativeDelete = proto.delete, nativeClear = proto.clear;
  const candidates = new WeakMap();
  let phase = "observing", preArmLockRequests = 0, preArmWrites = 0;
  let lockRequests = 0, requestSettled = 0, callbackEntered = 0, callbackSettled = 0;
  let callbacksHaveExclusiveLock = true;
  let activeCallbackIndex = null, entryPutCallbackIndex = null, manifestPutCallbackIndex = null;
  let entryPuts = 0, manifestPuts = 0, entryDeletes = 0, unexpectedWrites = 0;
  let sameTransaction = false, entrySucceeded = false, manifestSucceeded = false;
  let transactionCompleted = false, transactionAborted = false, transactionErrorName = null;
  let invalidReason = null, attempted = null, attemptedPromise = null, manifest = null;
  const digest = async raw => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw)))]
    .map(byte => byte.toString(16).padStart(2, "0")).join("");
  const scoped = store => store?.transaction?.db?.name === plan.databaseName &&
    store.transaction.mode === "readwrite" &&
    Array.from(store.transaction.objectStoreNames).includes("entries") &&
    Array.from(store.transaction.objectStoreNames).includes("manifest");
  const snapshot = () => ({ phase, preArmLockRequests, preArmWrites, lockRequests, requestSettled,
    callbackEntered, callbackSettled, callbacksHaveExclusiveLock, entryPutCallbackIndex, manifestPutCallbackIndex,
    entryPuts, manifestPuts, entryDeletes,
    unexpectedWrites, sameTransaction, entrySucceeded, manifestSucceeded,
    transactionCompleted, transactionAborted, transactionErrorName, invalidReason,
    attempted, manifest });
  const state = { snapshot,
    arm() {
      if (phase !== "observing" || preArmLockRequests || preArmWrites) return false;
      phase = "armed"; return true;
    },
    async inspect() { if (attemptedPromise) await attemptedPromise; return snapshot(); },
    restore() {
      if (navigator.locks.request === wrappedLockRequest) navigator.locks.request = nativeLockRequest;
      if (proto.put === wrappedPut) proto.put = nativePut;
      if (proto.add === wrappedAdd) proto.add = nativeAdd;
      if (proto.delete === wrappedDelete) proto.delete = nativeDelete;
      if (proto.clear === wrappedClear) proto.clear = nativeClear;
      phase = "restored"; delete globalThis[name]; return true;
    },
  };
  function wrappedLockRequest(...args) {
    if (args[0] !== lockName) return Reflect.apply(nativeLockRequest, this, args);
    if (phase === "observing") preArmLockRequests++;
    else if (phase === "armed") lockRequests++;
    else invalidReason ||= "unexpected later lock request";
    if (lockRequests > 2) invalidReason ||= "more than one lease and one save lock request";
    const requestIndex = lockRequests;
    const callback = args.at(-1);
    if (typeof callback !== "function") invalidReason ||= "named lock request has no callback";
    else args[args.length - 1] = function(...callbackArgs) {
      callbackEntered++;
      callbacksHaveExclusiveLock &&= callbackArgs[0]?.name === lockName && callbackArgs[0]?.mode === "exclusive";
      activeCallbackIndex = requestIndex;
      let result;
      try { result = Reflect.apply(callback, this, callbackArgs); }
      catch (error) { activeCallbackIndex = null; callbackSettled++; throw error; }
      if (result && typeof result.then === "function") {
        const clear = () => {
          if (activeCallbackIndex === requestIndex) activeCallbackIndex = null;
          callbackSettled++;
        };
        void Promise.resolve(result).then(clear, clear);
      } else {
        if (activeCallbackIndex === requestIndex) activeCallbackIndex = null;
        callbackSettled++;
      }
      return result;
    };
    const result = Reflect.apply(nativeLockRequest, this, args);
    if (phase !== "observing") void Promise.resolve(result).then(
      () => { requestSettled++; }, () => { requestSettled++; });
    return result;
  }
  function wrappedPut(...args) {
    if (!scoped(this)) return Reflect.apply(nativePut, this, args);
    if (phase === "observing") preArmWrites++;
    const transaction = this.transaction;
    const [value, key] = args;
    if (phase === "armed" && this.name === "entries" && value?.blob instanceof Blob &&
        Number.isSafeInteger(key) && Number.isSafeInteger(value.revision)) {
      entryPuts++;
      entryPutCallbackIndex = activeCallbackIndex;
      const candidate = { transaction, value, key, request: null };
      candidates.set(transaction, candidate);
      attemptedPromise = value.blob.text().then(async raw => {
        const record = JSON.parse(raw);
        const { anchor: _anchor, ...body } = record;
        attempted = { key, revision: value.revision, bytes: new TextEncoder().encode(raw).length,
          scopeMatched: JSON.stringify(record.scope) === JSON.stringify(plan.expectedScope),
          bodySha256: await digest(JSON.stringify(body)),
          anchor: record.anchor };
      }).catch(() => { invalidReason = "native entry Blob could not be decoded"; });
    } else if (phase === "armed" && this.name === "manifest" && key === "current" &&
        typeof value === "string") {
      manifestPuts++;
      manifestPutCallbackIndex = activeCallbackIndex;
      try {
        const parsed = JSON.parse(value);
        manifest = { revision: parsed.revision, lastKeyMatched: parsed.lastKey === plan.expectedKey,
          epochMatched: parsed.epoch === plan.expectedEpoch,
          entries: parsed.entries?.map(row => ({ keyMatched: row.key === plan.expectedKey,
            slot: row.slot, dataRevision: row.dataRevision })) };
      } catch { invalidReason = "native manifest could not be decoded"; }
      const candidate = candidates.get(transaction);
      sameTransaction = candidate?.request?.transaction === transaction;
      transaction.addEventListener("complete", () => { transactionCompleted = true; }, { once: true });
      transaction.addEventListener("abort", () => {
        transactionAborted = true; transactionErrorName = transaction.error?.name ?? null;
      }, { once: true });
      phase = "triggered";
    } else if (phase !== "observing") { unexpectedWrites++; invalidReason ||= "unexpected native put"; }
    const request = Reflect.apply(nativePut, this, args);
    if (this.name === "entries" && phase === "armed") {
      const candidate = candidates.get(transaction);
      if (candidate?.value === value) {
        candidate.request = request;
        request.addEventListener("success", () => { entrySucceeded = true; }, { once: true });
      }
    }
    if (this.name === "manifest" && key === "current" && phase === "triggered")
      request.addEventListener("success", () => { manifestSucceeded = true; }, { once: true });
    return request;
  }
  function wrappedAdd(...args) {
    if (scoped(this)) {
      if (phase === "observing") preArmWrites++;
      else { unexpectedWrites++; invalidReason ||= "unexpected native add"; }
    }
    return Reflect.apply(nativeAdd, this, args);
  }
  function wrappedDelete(...args) {
    if (scoped(this)) {
      if (phase === "observing") preArmWrites++;
      else if (phase === "armed" && this.name === "entries" && candidates.has(this.transaction)) entryDeletes++;
      else { unexpectedWrites++; invalidReason ||= "unexpected native delete"; }
    }
    return Reflect.apply(nativeDelete, this, args);
  }
  function wrappedClear(...args) {
    if (scoped(this)) {
      if (phase === "observing") preArmWrites++;
      else { unexpectedWrites++; invalidReason ||= "unexpected native clear"; }
    }
    return Reflect.apply(nativeClear, this, args);
  }
  navigator.locks.request = wrappedLockRequest;
  proto.put = wrappedPut;
  proto.add = wrappedAdd;
  if (typeof nativeDelete === "function") proto.delete = wrappedDelete;
  if (typeof nativeClear === "function") proto.clear = wrappedClear;
  Object.defineProperty(globalThis, name, { value: state, configurable: true });
  return true;
}

export function installMultitabLockHolderInPage() {
  const name = "__mobileCacheMultitabLockHolderV1";
  const lockName = "kcoder-mobile:gateway-profile-index";
  if (globalThis[name]) throw new Error("multitab lock holder is already installed");
  let firstEntered = false, firstReleased = false, firstReleaseRequested = false, releaseFirst = null;
  let secondQueued = false, secondEntered = false, secondReleased = false;
  let secondReleaseRequested = false, releaseSecond = null;
  let failed = false;
  const state = {
    snapshot: () => ({ firstEntered, firstReleased, firstReleaseRequested,
      secondQueued, secondEntered, secondReleased, secondReleaseRequested, failed }),
    queueSecond() {
      if (!firstEntered || firstReleased || secondQueued) return false;
      secondQueued = true;
      void navigator.locks.request(lockName, { mode: "exclusive" }, async lock => {
        if (lock?.name !== lockName || lock?.mode !== "exclusive") throw new Error("wrong second holder lock");
        secondEntered = true;
        await new Promise(resolve => { releaseSecond = resolve; if (secondReleaseRequested) releaseSecond(); });
        secondReleased = true;
      }).catch(() => { failed = true; });
      return true;
    },
    releaseFirst() { if (firstReleased) return false;
      firstReleaseRequested = true; releaseFirst?.(); return true; },
    releaseSecond() { if (!secondQueued || secondReleased) return false;
      secondReleaseRequested = true; releaseSecond?.(); return true; },
    restore() { if (!firstReleased || (secondQueued && !secondReleased)) return false;
      delete globalThis[name]; return true; },
  };
  Object.defineProperty(globalThis, name, { value: state, configurable: true });
  void navigator.locks.request(lockName, { mode: "exclusive" }, async lock => {
    if (lock?.name !== lockName || lock?.mode !== "exclusive") throw new Error("wrong first holder lock");
    firstEntered = true;
    await new Promise(resolve => { releaseFirst = resolve; if (firstReleaseRequested) releaseFirst(); });
    firstReleased = true;
  }).catch(() => { failed = true; });
  return true;
}

export async function readMultitabNamedLocksInPage() {
  const state = await navigator.locks.query();
  const lockName = "kcoder-mobile:gateway-profile-index";
  return { held: state.held.filter(row => row.name === lockName && row.mode === "exclusive").length,
    pending: state.pending.filter(row => row.name === lockName && row.mode === "exclusive").length };
}

export function assertNativeWriterProbe(snapshot, { baselineRevision, expectedBodySha256,
  expectedUserId, wheel }) {
  assert.equal(snapshot.preArmLockRequests, 0);
  assert.equal(snapshot.preArmWrites, 0);
  assert.equal(snapshot.lockRequests, 2);
  assert.equal(snapshot.requestSettled, 2);
  assert.equal(snapshot.callbackEntered, 2);
  assert.equal(snapshot.callbackSettled, 2);
  assert.equal(snapshot.callbacksHaveExclusiveLock, true);
  assert.equal(snapshot.entryPutCallbackIndex, 2);
  assert.equal(snapshot.manifestPutCallbackIndex, 2);
  assert.equal(snapshot.entryPuts, 1);
  assert.equal(snapshot.manifestPuts, 1);
  assert.equal(snapshot.unexpectedWrites, 0);
  assert.equal(snapshot.sameTransaction, true);
  assert.equal(snapshot.entrySucceeded, true);
  assert.equal(snapshot.manifestSucceeded, true);
  assert.equal(snapshot.transactionCompleted, true);
  assert.equal(snapshot.transactionAborted, false);
  assert.equal(snapshot.transactionErrorName, null);
  assert.equal(snapshot.invalidReason, null);
  assert.ok(snapshot.manifest.revision === baselineRevision + 1 ||
    snapshot.manifest.revision === baselineRevision + 2);
  assert.equal(snapshot.manifest.lastKeyMatched, true);
  assert.equal(snapshot.manifest.epochMatched, true);
  assert.equal(snapshot.manifest.entries.length, 2);
  assert.equal(snapshot.manifest.entries.filter(row => row.keyMatched).length, 1);
  assert.equal(snapshot.manifest.entries.find(row => row.keyMatched).dataRevision,
    snapshot.manifest.revision);
  assert.equal(snapshot.attempted.revision, snapshot.manifest.revision);
  assert.equal(snapshot.attempted.scopeMatched, true);
  assert.equal(snapshot.attempted.bodySha256, expectedBodySha256);
  assert.equal(snapshot.attempted.anchor?.messageId, expectedUserId);
  assert.equal(snapshot.attempted.anchor?.followsLatest, false);
  assert.ok(Math.abs(snapshot.attempted.anchor.offset - wheel.offset) <= 2);
}

export function projectMultitabWriterProbe(snapshot) {
  return { ...snapshot, attempted: snapshot.attempted ? {
    ...snapshot.attempted, anchor: snapshot.attempted.anchor ? {
      messageIdSha256: hash(snapshot.attempted.anchor.messageId),
      offset: snapshot.attempted.anchor.offset,
      followsLatest: snapshot.attempted.anchor.followsLatest,
    } : null,
  } : null };
}

/** Report preparation drift without emitting cache records, IDs, drafts or hashes. */
export function projectMultitabPreparationChange(before, after, elapsedMs) {
  const left = projectPrivateStorageSnapshot(before);
  const right = projectPrivateStorageSnapshot(after);
  const revision = snapshot => {
    try {
      const value = JSON.parse(snapshot.manifestRaw).revision;
      return Number.isSafeInteger(value) && value >= 0 ? value : null;
    } catch { return null; }
  };
  const leftRows = new Map(left.rows.map(row => [row.slot, JSON.stringify(row)]));
  const rightRows = new Map(right.rows.map(row => [row.slot, JSON.stringify(row)]));
  const changedRows = new Set([...leftRows.keys(), ...rightRows.keys()]);
  return { elapsedMs: Number.isFinite(elapsedMs) ? Math.max(0, Math.round(elapsedMs)) : null,
    manifestRevisionBefore: revision(before), manifestRevisionAfter: revision(after),
    manifestChanged: left.manifestSha256 !== right.manifestSha256,
    changedRowCount: [...changedRows].filter(slot => leftRows.get(slot) !== rightRows.get(slot)).length,
    workspaceStatesChanged: JSON.stringify(left.workspaceStates) !== JSON.stringify(right.workspaceStates),
    profilesChanged: left.profilesSha256 !== right.profilesSha256,
    activeIdChanged: left.activeIdSha256 !== right.activeIdSha256 };
}

export function assertTwoWriterStorage({ baseline, final, targetThreadId, peerThreadId,
  targetMarker, peerMarker, targetWheel, peerWheel, targetProbe, peerProbe }) {
  const before = JSON.parse(baseline.manifestRaw);
  const after = JSON.parse(final.manifestRaw);
  assert.equal(before.schemaVersion, 1);
  assert.equal(before.entries.length, 2);
  assert.equal(before.entries.every(row => typeof row.workspaceKey === "string" && row.workspaceKey.length === 64), true);
  assert.equal(before.entries[0].workspaceKey, before.entries[1].workspaceKey);
  assert.equal(after.revision, before.revision + 2, "two native anchor saves must each advance the manifest once");
  assert.equal(after.clock, before.clock + 2);
  assert.equal(after.epoch, before.epoch, "ordinary saves must preserve the cache epoch");
  assert.deepEqual(after.invalidations, before.invalidations);
  assert.deepEqual(after.workspaceGenerations?.map(row => row.key), before.workspaceGenerations?.map(row => row.key));
  const workspaceKey = before.entries[0].workspaceKey;
  const beforeGeneration = before.workspaceGenerations?.find(row => row.key === workspaceKey)?.generation ?? 0;
  const afterGeneration = after.workspaceGenerations?.find(row => row.key === workspaceKey)?.generation ?? 0;
  assert.equal(afterGeneration, beforeGeneration + 2);
  assert.equal(after.entries.length, 2);
  assert.equal(final.rows.length, 2);
  assert.deepEqual(final.workspaceStates, baseline.workspaceStates, "both Pages must preserve every unsent draft");
  assert.deepEqual(final.profiles, baseline.profiles);
  assert.equal(final.activeId, baseline.activeId);
  const rowBySlot = new Map(final.rows.map(row => [row.slot, row]));
  assert.equal(rowBySlot.size, final.rows.length);
  assert.deepEqual([...rowBySlot.keys()].sort((a, b) => a - b),
    after.entries.map(row => row.slot).sort((a, b) => a - b),
  "every physical slot must be referenced exactly once by the final manifest");
  const readRecord = (snapshot, manifest, threadId, marker) => {
    const matches = manifest.entries.flatMap(entry => {
      const row = snapshot.rows.find(value => value.slot === entry.slot);
      assert.ok(row);
      const record = JSON.parse(row.raw);
      return record.scope?.threadId === threadId ? [{ entry, row, record }] : [];
    });
    assert.equal(matches.length, 1);
    const result = matches[0];
    assert.equal(result.entry.key, hash(JSON.stringify(result.record.scope)));
    assert.equal(result.entry.workspaceKey, workspaceKey);
    assert.equal(result.entry.dataRevision, result.row.revision);
    assert.equal(result.entry.bytes, Buffer.byteLength(result.row.raw));
    assert.equal(result.record.messages.filter(row => row.role === "user" &&
      row.content.includes(marker)).length, 1);
    return result;
  };
  const specifications = [
    { threadId: targetThreadId, marker: targetMarker, wheel: targetWheel, probe: targetProbe },
    { threadId: peerThreadId, marker: peerMarker, wheel: peerWheel, probe: peerProbe },
  ];
  for (const specification of specifications) {
    const old = readRecord(baseline, before, specification.threadId, specification.marker);
    const current = readRecord(final, after, specification.threadId, specification.marker);
    assert.equal(current.entry.key, old.entry.key);
    assert.equal(current.entry.profileKey, old.entry.profileKey);
    assert.equal(current.entry.dataRevision, specification.probe.manifest.revision);
    const { anchor: _oldAnchor, ...oldBody } = old.record;
    const { anchor: _currentAnchor, ...currentBody } = current.record;
    assert.equal(hash(JSON.stringify(currentBody)), hash(JSON.stringify(oldBody)));
    const user = current.record.messages.find(row => row.role === "user" && row.content.includes(specification.marker));
    assert.equal(current.record.anchor?.messageId, user.id);
    assert.equal(current.record.anchor?.followsLatest, false);
    assert.ok(Math.abs(current.record.anchor.offset - specification.wheel.offset) <= 2);
    assert.notDeepEqual(current.record.anchor, old.record.anchor);
    assert.equal(current.record.anchor.messageId, specification.probe.attempted.anchor.messageId);
    assert.equal(current.record.anchor.offset, specification.probe.attempted.anchor.offset);
  }
  const lastWriter = targetProbe.manifest.revision > peerProbe.manifest.revision ? targetProbe : peerProbe;
  assert.notEqual(targetProbe.manifest.revision, peerProbe.manifest.revision);
  const lastEntry = after.entries.find(row => row.dataRevision === lastWriter.manifest.revision);
  assert.ok(lastEntry, "the final manifest must contain the last native writer's data revision");
  assert.equal(after.lastKey, lastEntry.key);
  return { baselineRevision: before.revision, committedRevision: after.revision,
    targetAndPeerBodyUnchanged: true, bothAnchorsMatchTrustedWheels: true,
    physicalSlotsMatchManifest: true, draftAndProfilesUnchanged: true,
    epochStable: true, workspaceGenerationAdvancedTwice: true };
}

/** Exercise two independent real Mobile owners before the WebLock contention gate. */
export async function runCacheMultitabWritersSmoke({
  context, page, protocol, expectedScope, threadId, taskUrl, promptMarker, tailMarker,
  gateway, mobileEntryUrl, getChromium, createPeerTask, createProtocolState, createRestorePage, releaseChromium,
  waitFor, waitForReadOnlyTranscriptCache,
}) {
  const evidence = { version: 1, phase: "real-ui-seed", status: "RUNNING",
    boundary: "same-origin/profile/Gateway two real Mobile Runtime Pages, standard WebLock lease and save contention, original native IndexedDB anchor commits; no shared app-server process or native-device claim",
    releases: [] };
  const pages = [];
  let holder = null;
  const installedProbes = new Set();
  let seedPageOpen = true, chromiumReleaseAttempted = false;
  const cleanupErrors = [];
  const readProbe = subject => subject.page.evaluate(name => globalThis[name]?.snapshot() ?? null, PROBE_NAME);
  const inspectProbe = subject => subject.page.evaluate(name => globalThis[name]?.inspect() ?? null, PROBE_NAME);
  const restoreProbes = async () => {
    for (const subject of installedProbes) {
      if (subject.page.isClosed()) continue;
      assert.equal(await subject.page.evaluate(name => globalThis[name]?.restore() ?? false, PROBE_NAME), true);
    }
    installedProbes.clear();
  };
  const holderSnapshot = () => holder.evaluate(name => globalThis[name]?.snapshot() ?? null, HOLDER_NAME);
  const holderAction = method => holder.evaluate(([name, action]) => globalThis[name]?.[action]() ?? false,
    [HOLDER_NAME, method]);
  try {
    assert.equal(expectedScope.threadId, threadId);
    assert.equal(new URL(taskUrl).origin, new URL(gateway.baseUrl).origin);
    const { draft, peerMarker, peerThreadId, peerTaskUrl } = await seedStorageTargetPeerAndDraft({
      page, protocol, expectedScope, threadId, taskUrl, promptMarker, gateway,
      createPeerTask, waitFor, waitForReadOnlyTranscriptCache,
    });
    assert.equal(new URL(peerTaskUrl).origin, new URL(taskUrl).origin);
    assert.equal(new URL(peerTaskUrl).searchParams.get("cwd"), expectedScope.routeCwd);
    evidence.seed = { targetThreadIdSha256: hash(threadId), peerThreadIdSha256: hash(peerThreadId),
      sameOrigin: true, sameCwd: true, draftPersisted: true };

    evidence.phase = "exact-seed-page-close";
    evidence.seedPageRelease = await closeMobileTimingTaskPage({ page, protocol, waitFor,
      requiredSocketOrdinal: protocol.activeTaskSocketOrdinal, label: "multitab seed Page" });
    seedPageOpen = false;

    evidence.phase = "two-independent-real-resumes";
    for (const subject of [
      { threadId, taskUrl, marker: promptMarker, name: "target" },
      { threadId: peerThreadId, taskUrl: peerTaskUrl, marker: peerMarker, name: "peer" },
    ]) {
      const subjectProtocol = createProtocolState();
      subjectProtocol.targetThreadId = subject.threadId;
      subjectProtocol.rootRestore = { minSocketOrdinal: 1, threadId: subject.threadId, holdMode: "forward" };
      const subjectPage = await createRestorePage(subjectProtocol, subject.marker);
      pages.push({ ...subject, page: subjectPage, protocol: subjectProtocol });
      await subjectPage.goto(subject.taskUrl, { waitUntil: "domcontentloaded" });
      await waitFor(() => subjectProtocol.rootRestore.response?.forwardedAt !== null &&
        subjectProtocol.rootRestore.response?.forwardedAt !== undefined
        ? subjectProtocol.rootRestore.response : null,
      30_000, `the real ${subject.name} thread/resume response to be forwarded`);
      const response = subjectProtocol.rootRestore.response;
      assert.equal(response.success, true);
      assert.equal(response.fixtureTransformed, false);
      assert.equal(response.threadId, subject.threadId);
      assert.equal(subjectProtocol.requests.filter(row => row.method === "thread/resume" &&
        row.threadId === subject.threadId).length, 1);
      assert.equal(subjectProtocol.requests.filter(row => row.method === "turn/start" ||
        row.method === "thread/start").length, 0);
      assert.equal(subjectProtocol.errors.length, 0);
      await subjectPage.getByTestId("message-user").filter({ hasText: subject.marker })
        .waitFor({ state: "visible", timeout: 30_000 });
      await subjectPage.getByTestId("message-assistant").filter({ hasText: tailMarker })
        .waitFor({ state: "visible", timeout: 30_000 });
      assert.equal(await subjectPage.getByTestId("message-user").filter({ hasText: subject.marker }).count(), 1);
      assert.equal(await subjectPage.getByTestId("message-assistant").filter({ hasText: tailMarker }).count(), 1);
      assert.equal(await subjectPage.getByTestId("message-input").isEditable(), true);
      if (subject.name === "target")
        assert.equal(await subjectPage.getByTestId("message-input").inputValue(), draft);
      await waitForReadOnlyTranscriptCache(subjectPage, { threadId: subject.threadId,
        gatewayOrigin: new URL(gateway.baseUrl).origin, marker: subject.marker,
        expectedScope: { ...expectedScope, threadId: subject.threadId } }, 30_000);
      const canonicalUserIdSha256 = assertCanonicalResumeCacheIdentity(
        await readCacheStorageSnapshot(subjectPage), subject.threadId, subject.marker, response);
      const prepared = await prepareUserReadingAnchorViewport({ page: subjectPage,
        promptMarker: subject.marker, readTranscriptViewport });
      assert.equal(prepared.geometry.host?.scrollHeight > prepared.geometry.host?.clientHeight, true,
        `the ${subject.name} user anchor must have a real scroll range`);
      pages.at(-1).prepared = prepared;
      evidence[subject.name] = { resumeSuccess: true, unchangedAuthority: true,
        requestSocketOrdinal: response.socketOrdinal, visibleRowsAndCanonicalUser: true,
        editableComposer: true, canonicalUserIdSha256, anchorRowDomIdSha256: hash(prepared.rowDomId),
        scrollRange: prepared.geometry.host.scrollHeight - prepared.geometry.host.clientHeight };
    }

    evidence.phase = "startup-writes-quiet";
    evidence.preparationChanges = [];
    const preparationStartedAt = Date.now();
    const settled = await waitFor(async () => {
      const firstRaw = await readCacheStorageSnapshot(pages[0].page);
      await new Promise(resolve => setTimeout(resolve, 350));
      const secondRaw = await readCacheStorageSnapshot(pages[0].page);
      await new Promise(resolve => setTimeout(resolve, 350));
      const thirdRaw = await readCacheStorageSnapshot(pages[0].page);
      const first = projectPrivateStorageSnapshot(firstRaw);
      const second = projectPrivateStorageSnapshot(secondRaw);
      const third = projectPrivateStorageSnapshot(thirdRaw);
      if (JSON.stringify(first) === JSON.stringify(second) &&
          JSON.stringify(second) === JSON.stringify(third)) return third;
      if (evidence.preparationChanges.length < 20 && JSON.stringify(first) !== JSON.stringify(second))
        evidence.preparationChanges.push(projectMultitabPreparationChange(
          firstRaw, secondRaw, Date.now() - preparationStartedAt));
      if (evidence.preparationChanges.length < 20 && JSON.stringify(second) !== JSON.stringify(third))
        evidence.preparationChanges.push(projectMultitabPreparationChange(
          secondRaw, thirdRaw, Date.now() - preparationStartedAt));
      return null;
    }, 15_000, "both resumed Pages and prepared anchors to finish ordinary startup saves");
    assert.deepEqual(projectPrivateStorageSnapshot(await readCacheStorageSnapshot(pages[0].page)), settled,
      "a complete quiet snapshot must still match after startup save settlement");
    evidence.startupStorageQuiet = true;

    evidence.phase = "passive-writer-probes-and-holder-entry";
    const lane = createDirectMobileTimingLaneDescriptor({ gatewayUrl: gateway.baseUrl, mobileUrl: mobileEntryUrl });
    holder = await openMobileTimingCacheObserverPage({ chromium: getChromium(), lane });
    const baseline = await readCacheStorageSnapshot(holder);
    assert.deepEqual(projectPrivateStorageSnapshot(baseline), settled);
    assert.deepEqual(await holder.evaluate(readMultitabNamedLocksInPage), { held: 0, pending: 0 });
    const baselineManifest = JSON.parse(baseline.manifestRaw);
    assert.equal(baselineManifest.entries.length, 2);
    const plans = pages.map(subject => {
      const rows = baseline.rows.flatMap(row => {
        const record = JSON.parse(row.raw);
        return record.scope?.threadId === subject.threadId ? [{ record, row }] : [];
      });
      assert.equal(rows.length, 1);
      const { anchor: _anchor, ...body } = rows[0].record;
      const user = rows[0].record.messages.filter(row => row.role === "user" &&
        row.content.includes(subject.marker));
      assert.equal(user.length, 1);
      const expectedKey = hash(JSON.stringify(rows[0].record.scope));
      assert.equal(baselineManifest.entries.filter(row => row.key === expectedKey).length, 1);
      return { databaseName: TRANSCRIPT_DATABASE, expectedScope: rows[0].record.scope,
        expectedKey, expectedEpoch: baselineManifest.epoch,
        expectedBodySha256: hash(JSON.stringify(body)), expectedUserId: user[0].id };
    });
    for (let index = 0; index < pages.length; index++) {
      assert.equal(await pages[index].page.evaluate(installMultitabWriterProbeInPage, plans[index]), true);
      installedProbes.add(pages[index]);
    }
    const beforeProbeQuiet = projectPrivateStorageSnapshot(await readCacheStorageSnapshot(holder));
    await new Promise(resolve => setTimeout(resolve, 350));
    const afterProbeQuiet = projectPrivateStorageSnapshot(await readCacheStorageSnapshot(holder));
    assert.deepEqual(beforeProbeQuiet, afterProbeQuiet);
    assert.deepEqual(afterProbeQuiet, projectPrivateStorageSnapshot(baseline));
    for (const subject of pages) {
      const observed = await readProbe(subject);
      assert.equal(observed.preArmWrites, 0);
      assert.equal(observed.preArmLockRequests, 0);
      assert.equal(await subject.page.evaluate(name => globalThis[name].arm(), PROBE_NAME), true);
    }
    assert.equal(await holder.evaluate(installMultitabLockHolderInPage), true);
    await waitFor(async () => (await holderSnapshot())?.firstEntered ? true : null,
      15_000, "the first same-origin standard WebLock holder to enter");
    assert.deepEqual(await holder.evaluate(readMultitabNamedLocksInPage), { held: 1, pending: 0 });

    evidence.phase = "two-real-lease-requests-behind-first-holder";
    const wheels = [];
    for (const subject of pages) {
      const wheel = await trustedAnchorWheel(subject.page, subject.marker, subject.prepared.rowDomId);
      assert.ok(Math.abs(wheel.offset - wheel.startOffset) > 0.5);
      wheels.push(wheel);
    }
    await waitFor(async () => {
      const snapshots = await Promise.all(pages.map(readProbe));
      return snapshots.every(row => row.lockRequests === 1 && row.callbackEntered === 0 &&
        row.entryPuts === 0 && row.manifestPuts === 0) ? snapshots : null;
    }, 15_000, "both original lease lock requests to queue behind the first holder");
    await waitFor(async () => {
      const locks = await holder.evaluate(readMultitabNamedLocksInPage);
      return locks.held === 1 && locks.pending === 2 ? locks : null;
    }, 15_000, "first holder plus both original lease requests in the WebLock queue");
    assert.equal(await holderAction("queueSecond"), true);
    await waitFor(async () => {
      const locks = await holder.evaluate(readMultitabNamedLocksInPage);
      return locks.held === 1 && locks.pending === 3 ? locks : null;
    }, 15_000, "the second holder queued behind both original lease requests");
    evidence.firstBarrier = { holderHeld: 1, originalLeaseRequestsPending: 2,
      queuedSecondHolderBehindLeases: true, originalNativeWrites: 0 };

    evidence.phase = "two-real-save-requests-behind-second-holder";
    assert.equal(await holderAction("releaseFirst"), true);
    await waitFor(async () => {
      const state = await holderSnapshot();
      const snapshots = await Promise.all(pages.map(readProbe));
      return state?.secondEntered && snapshots.every(row => row.lockRequests === 2 &&
        row.callbackEntered === 1 && row.entryPuts === 0 && row.manifestPuts === 0)
        ? snapshots : null;
    }, 15_000, "both real lease callbacks to finish and both save locks to queue behind second holder");
    await waitFor(async () => {
      const locks = await holder.evaluate(readMultitabNamedLocksInPage);
      return locks.held === 1 && locks.pending === 2 ? locks : null;
    }, 15_000, "second holder plus both original save requests in the WebLock queue");
    evidence.secondBarrier = { holderHeld: 1, originalSaveRequestsPending: 2,
      leaseCallbacksEnteredPerPage: 1, saveCallbacksEntered: 0, originalNativeWrites: 0 };

    evidence.phase = "two-original-native-transactions-complete";
    assert.equal(await holderAction("releaseSecond"), true);
    await waitFor(async () => (await holderSnapshot())?.secondReleased ? true : null,
      15_000, "the second holder to release after both save requests were pending");
    await waitFor(async () => {
      const snapshots = await Promise.all(pages.map(readProbe));
      return snapshots.every(row => (row.transactionCompleted || row.transactionAborted) &&
        row.requestSettled === 2 && row.callbackSettled === 2) ? snapshots : null;
    }, 15_000, "both original IndexedDB transactions to settle after second holder release");
    const probes = await Promise.all(pages.map(inspectProbe));
    for (let index = 0; index < pages.length; index++)
      assertNativeWriterProbe(probes[index], { baselineRevision: baselineManifest.revision,
        expectedBodySha256: plans[index].expectedBodySha256,
        expectedUserId: plans[index].expectedUserId, wheel: wheels[index] });
    assert.deepEqual(probes.map(row => row.manifest.revision).sort((a, b) => a - b),
      [baselineManifest.revision + 1, baselineManifest.revision + 2]);
    const final = await waitFor(async () => {
      const snapshot = await readCacheStorageSnapshot(holder);
      return JSON.parse(snapshot.manifestRaw).revision >= baselineManifest.revision + 2 ? snapshot : null;
    }, 15_000, "both native cache anchor transactions to appear in complete storage readback");
    evidence.storage = assertTwoWriterStorage({ baseline, final,
      targetThreadId: threadId, peerThreadId, targetMarker: promptMarker, peerMarker,
      targetWheel: wheels[0], peerWheel: wheels[1], targetProbe: probes[0], peerProbe: probes[1] });
    evidence.nativeWriters = probes.map(projectMultitabWriterProbe);
    evidence.trustedWheels = wheels.map(({ rowDomId, ...geometry }) => ({
      ...geometry, rowDomIdSha256: hash(rowDomId) }));
    for (const subject of pages) {
      assert.equal(subject.protocol.requests.filter(row => row.method === "turn/start" ||
        row.method === "thread/start").length, 0);
      assert.equal(subject.protocol.errors.length, 0);
      assert.equal(await subject.page.getByTestId("message-input").isEditable(), true);
    }
    assert.equal(protocol.requests.filter(row => row.method === "turn/start").length, 2,
      "concurrent cache writers must not create a third user turn");
    assert.equal(await holder.evaluate(name => globalThis[name]?.restore() ?? false, HOLDER_NAME), true);
    await restoreProbes();

    evidence.phase = "exact-owner-release";
    for (const subject of pages) {
      evidence.releases.push(await closeMobileTimingTaskPage({ page: subject.page,
        protocol: subject.protocol, waitFor,
        requiredSocketOrdinal: subject.protocol.rootRestore.response.socketOrdinal,
        label: `multitab ${subject.name} Page` }));
    }
    pages.length = 0;
    chromiumReleaseAttempted = true;
    evidence.releases.push(await releaseChromium("multitab-writers-complete", {
      restart: false, observerPages: [holder] }));
    holder = null;
    evidence.phase = "complete";
    evidence.status = "PASS";
    return evidence;
  } catch (error) {
    if (holder && !holder.isClosed()) {
      try {
        const state = await holderSnapshot();
        if (state && !state.firstReleased) await holderAction("releaseFirst");
        if (state?.secondQueued && !state.secondReleased) await holderAction("releaseSecond");
        if (state) await waitFor(async () => {
          const current = await holderSnapshot();
          return current?.firstReleased && (!current.secondQueued || current.secondReleased) ? true : null;
        }, 15_000, "both owned holder locks to release during failure cleanup");
      } catch (releaseError) { cleanupErrors.push(releaseError); }
    }
    for (const subject of installedProbes) {
      if (subject.page.isClosed()) continue;
      try {
        const observed = await readProbe(subject);
        if (observed?.lockRequests > 0) await waitFor(async () => {
          const current = await readProbe(subject);
          if (!current || current.requestSettled !== current.lockRequests ||
              current.callbackSettled !== current.callbackEntered) return null;
          await new Promise(resolve => setTimeout(resolve, 350));
          const stable = await readProbe(subject);
          return stable.requestSettled === stable.lockRequests &&
            stable.callbackSettled === stable.callbackEntered &&
            stable.lockRequests === current.lockRequests &&
            (stable.entryPuts === 0 || stable.transactionCompleted || stable.transactionAborted)
            ? true : null;
        }, 15_000, `the ${subject.name} original lock requests and any native writer to settle after owned holder release`);
      } catch (settleError) { cleanupErrors.push(settleError); }
    }
    try { await restoreProbes(); }
    catch (restoreError) { cleanupErrors.push(restoreError); }
    for (const subject of pages) {
      if (subject.page.isClosed()) continue;
      try { evidence.releases.push(await closeMobileTimingTaskPage({ page: subject.page,
        protocol: subject.protocol, waitFor,
        requiredSocketOrdinal: subject.protocol.rootRestore.response?.socketOrdinal ?? null,
        label: `multitab ${subject.name} Page failure` })); }
      catch (closeError) { cleanupErrors.push(closeError); }
    }
    if (!chromiumReleaseAttempted) {
      chromiumReleaseAttempted = true;
      try { evidence.releases.push(await releaseChromium("multitab-writers-failure", {
        restart: false, ...(seedPageOpen && !page.isClosed() ? { page, protocol,
          requiredSocketOrdinal: protocol.activeTaskSocketOrdinal } : {}),
        ...(holder && !holder.isClosed() ? { observerPages: [holder] } : {}) })); }
      catch (releaseError) { cleanupErrors.push(releaseError); }
    }
    const safe = safeMultitabFailure(error, evidence.phase, "PRECONDITION_OR_ASSERTION_FAILURE");
    evidence.status = "FAIL";
    evidence.error = safe.evidence;
    evidence.cleanupErrors = cleanupErrors.map(value =>
      safeMultitabFailure(value, "exact-owner-cleanup", "CLEANUP_FAILURE").evidence);
    await context.writeArtifactJson("mobile-session-cache-multitab-writers-failure.json", evidence);
    if (cleanupErrors.length) throw new AggregateError([safe.error,
      ...cleanupErrors.map(() => new Error("exact multitab owner cleanup failed"))],
      "multitab writers gate and exact owner cleanup failed");
    throw safe.error;
  }
}
