import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createDirectMobileTimingLaneDescriptor } from "../../harness/mobile-cache-timing-runner.mjs";
import {
  closeMobileTimingTaskPage,
  openMobileTimingCacheObserverPage,
} from "../../harness/mobile-cache-timing-page-ownership.mjs";
import {
  installTranscriptCorruptionReadProbe,
  matchesBridgeRecordedResumeResponse,
  projectCacheStorageFixture,
  readCacheStorageSnapshot,
  selectCacheStorageFixture,
  writeTranscriptCorruption,
} from "./mobile-session-cache-storage-corruption-fixture.mjs";
import { seedStorageTargetPeerAndDraft } from "./mobile-session-cache-storage-seed.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");

/** Real UI seeds and native IDB faults; shared harnesses retain every process/Page owner. */
export async function runCacheStorageCorruptionSmoke({
  context, page, protocol, kind, expectedScope, threadId, taskUrl, promptMarker, tailMarker,
  gateway, mobileEntryUrl, getChromium, createPeerTask, createRestorePage, releaseChromium,
  waitFor, waitForReadOnlyTranscriptCache, releaseHeldAuthority,
}) {
  assert.ok(["invalid-json", "unsupported-schema"].includes(kind));
  assert.equal(expectedScope.threadId, threadId);
  assert.equal(new URL(taskUrl).origin, new URL(gateway.baseUrl).origin);
  const lane = createDirectMobileTimingLaneDescriptor({ gatewayUrl: gateway.baseUrl, mobileUrl: mobileEntryUrl });
  const evidence = { version: 1, kind, phase: "real-unsent-draft",
    boundary: "Web loopback, real Gateway/Rust and native IndexedDB with one controlled record Blob fault; no pending intent, quota, transaction-failure, native or model claim",
    scopeEvidence: { descriptorSource: expectedScope.descriptorSource,
      descriptorResponseStatus: expectedScope.descriptorResponseStatus,
      observedProfileTargetWorkspaceMatched: false, connectionFingerprintIndependentlyVerified: false },
    releases: [],
  };
  let currentPage = page;
  let observer = null;
  let firstRouteSocketOrdinal = 0;
  let firstPageRpcOrdinal = 0;
  let browserReleased = false;
  let cleanupAttempted = false;
  try {
    evidence.phase = "real-peer-seed";
    const { draft, peerThreadId } = await seedStorageTargetPeerAndDraft({
      page, protocol, expectedScope, threadId, taskUrl, promptMarker, gateway,
      createPeerTask, waitFor, waitForReadOnlyTranscriptCache,
    });

    evidence.phase = "exact-page-release-before-fault";
    evidence.seedPageRelease = await closeMobileTimingTaskPage({ page, protocol, waitFor,
      requiredSocketOrdinal: protocol.activeTaskSocketOrdinal, label: "storage corruption seed Page" });
    currentPage = null;
    observer = await openMobileTimingCacheObserverPage({ chromium: getChromium(), lane });
    const fixture = selectCacheStorageFixture(await readCacheStorageSnapshot(observer), {
      expectedScope, targetThreadId: threadId, peerThreadId, marker: promptMarker, draft,
    });
    evidence.scopeEvidence.observedProfileTargetWorkspaceMatched = true;
    evidence.before = projectCacheStorageFixture(fixture);
    evidence.phase = "guarded-target-blob-fault";
    const payload = await writeTranscriptCorruption(observer, fixture, kind);
    evidence.fault = { classification: payload.classification, jsonParseable: payload.jsonParseable,
      schemaVersion: payload.schemaVersion, bytes: payload.bytes, sha256: payload.sha256,
      equalUtf8Length: payload.equalUtf8Length, productChecksumClaim: false,
      manifestRevisionUnchanged: true, lastKeyUnchanged: true, peerUnchanged: true, draftUnchanged: true };
    evidence.phase = "same-profile-cold-restart";
    evidence.releases.push(await releaseChromium("storage-fault-restart", { observerPages: [observer] }));
    observer = null;
    const restarted = evidence.releases[0];
    assert.equal(restarted.gracefulExitObserved, true);
    assert.equal(restarted.sameProfileDir, true);
    assert.notEqual(restarted.oldPid, restarted.newPid);

    firstRouteSocketOrdinal = protocol.nextSocketOrdinal;
    firstPageRpcOrdinal = protocol.nextPageRpcSocketOrdinal;
    const requestBaseline = protocol.requests.length;
    currentPage = await createRestorePage();
    await installTranscriptCorruptionReadProbe(currentPage, fixture, payload);
    protocol.rootRestore = { minSocketOrdinal: firstRouteSocketOrdinal + 1, threadId, holdMode: "full" };
    evidence.phase = "cold-native-fault-read";
    await currentPage.goto(taskUrl, { waitUntil: "domcontentloaded" });
    const observedRead = await waitFor(() => currentPage.evaluate(() =>
      globalThis.__mobileTranscriptCorruptionReadsV1?.[0] ?? null), 30_000,
    "the product's native IDB get to observe the exact controlled target Blob");
    assert.equal(observedRead.sha256, payload.sha256);
    assert.equal(observedRead.classification, kind);
    assert.equal(observedRead.revision, fixture.target.entry.dataRevision);
    if (kind === "unsupported-schema") {
      assert.equal(observedRead.schemaVersion, 2);
      assert.equal(observedRead.scopeMatches, true);
    }
    evidence.nativeRead = observedRead;
    const response = await waitFor(() => protocol.rootRestore?.heldResponse ?? null, 30_000,
      "the unchanged online Rust resume response behind the cold recovery barrier");
    assert.equal(protocol.errors.length, 0, "the native record fault must not break the RPC bridge");
    assert.equal(response.success, true);
    assert.equal(response.fixtureTransformed, false);
    assert.equal(response.threadId, threadId);
    assert.equal(response.forwardedAt, null);
    const held = protocol.heldAuthority;
    assert.ok(held && held.response === response);
    const frame = JSON.parse(String(held.raw));
    assert.equal(matchesBridgeRecordedResumeResponse(protocol.rootRestore.request, frame, {
      socketOrdinal: response.socketOrdinal, threadId,
    }), true, "the unchanged Rust resume frame must echo this Mobile numeric request ID on the exact socket");
    assert.equal(frame.result.thread.id, threadId);
    const messages = frame.result.history?.page?.messages;
    assert.ok(Array.isArray(messages));
    assert.equal(messages.filter(row => row.role === "user" && row.content.includes(promptMarker)).length, 1);
    assert.equal(messages.filter(row => row.role === "assistant" && row.content.includes(tailMarker)).length, 1);
    assert.equal(await currentPage.getByTestId("session-cache-view").count(), 0,
      "the rejected record must not appear as a readable cached transcript while online authority is held");
    assert.equal(await currentPage.getByTestId("message-user").filter({ hasText: promptMarker }).count(), 0,
      "the faulted record must not populate the UI before the authority frame is forwarded");
    evidence.authority = { requestId: frame.id, socketOrdinal: response.socketOrdinal, threadId,
      rawSha256: hash(held.raw), fixtureTransformed: false, userCount: 1, assistantCount: 1,
      rangeStart: frame.result.history.page.rangeStart, rangeEnd: frame.result.history.page.rangeEnd };

    evidence.phase = "online-authority-fallback";
    assert.equal(releaseHeldAuthority(protocol), true);
    const user = currentPage.getByTestId("message-user").filter({ hasText: promptMarker });
    const assistant = currentPage.getByTestId("message-assistant").filter({ hasText: tailMarker });
    await user.waitFor({ state: "visible", timeout: 30_000 });
    await assistant.waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(await user.count(), 1);
    assert.equal(await assistant.count(), 1);
    const restoredComposer = currentPage.getByTestId("message-input");
    await waitFor(async () => await restoredComposer.isEditable() && await restoredComposer.inputValue() === draft,
      15_000, "online authority to restore editable UI with the exact unsent composer draft");
    await waitForReadOnlyTranscriptCache(currentPage, { threadId, gatewayOrigin: new URL(gateway.baseUrl).origin,
      marker: promptMarker, expectedScope }, 30_000);
    const recovered = selectCacheStorageFixture(await readCacheStorageSnapshot(currentPage), {
      expectedScope, targetThreadId: threadId, peerThreadId, marker: promptMarker, draft,
    });
    assert.equal(recovered.peer.entry.key, fixture.peer.entry.key);
    assert.equal(recovered.peer.entry.dataRevision, fixture.peer.entry.dataRevision);
    assert.equal(recovered.peer.sha256, fixture.peer.sha256, "online fallback must not rewrite the peer transcript");
    assert.equal(recovered.target.entry.key, fixture.target.entry.key);
    assert.deepEqual(recovered.target.record.scope, fixture.target.record.scope);
    const recoveryRequests = protocol.requests.slice(requestBaseline);
    const turnStartCount = recoveryRequests.filter(row => row.method === "turn/start").length;
    const threadStartCount = recoveryRequests.filter(row => row.method === "thread/start").length;
    assert.equal(turnStartCount, 0, "online cache fallback must not resend the real unsent draft or seed turn");
    assert.equal(threadStartCount, 0, "online cache fallback must resume its exact existing thread");
    evidence.after = projectCacheStorageFixture(recovered);
    evidence.onlineFallback = { visibleUserCount: 1, visibleAssistantCount: 1, editable: true,
      realUnsentDraftPreserved: true, peerKeyRevisionPayloadPreserved: true, lastKeyIsOriginalTarget: true,
      threadStartCount, turnStartCount };
    evidence.phase = "final-exact-owner-release";
    cleanupAttempted = true;
    evidence.releases.push(await releaseChromium("storage-fallback-complete", { restart: false, page: currentPage,
      protocol, firstRouteSocketOrdinal, firstPageRpcOrdinal, requiredSocketOrdinal: response.socketOrdinal }));
    currentPage = null;
    browserReleased = true;
    evidence.phase = "complete";
    evidence.status = "PASS_RECORD_FAULT_ONLINE_AUTHORITY_FALLBACK";
    return evidence;
  } catch (error) {
    const cleanupErrors = [];
    if (!browserReleased && !cleanupAttempted) {
      cleanupAttempted = true;
      releaseHeldAuthority(protocol);
      try {
        evidence.releases.push(await releaseChromium("storage-fallback-failure", { restart: false,
          ...(currentPage && !currentPage.isClosed() ? { page: currentPage, protocol,
            firstRouteSocketOrdinal, firstPageRpcOrdinal,
            requiredSocketOrdinal: protocol.rootRestore?.request?.socketOrdinal ?? protocol.activeTaskSocketOrdinal } : {}),
          observerPages: observer ? [observer] : [] }));
      } catch (cleanupError) { cleanupErrors.push(cleanupError); }
    }
    evidence.status = "FAIL";
    evidence.error = context.redactText(String(error?.message ?? error)).slice(0, 2000);
    evidence.cleanupErrors = cleanupErrors.map(value => context.redactText(String(value?.message ?? value)).slice(0, 1000));
    await context.writeArtifactJson("mobile-session-cache-storage-corruption-failure.json", evidence);
    if (cleanupErrors.length) throw new AggregateError([error, ...cleanupErrors], "storage fallback failed and exact owner cleanup failed");
    throw error;
  }
}
