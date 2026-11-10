import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { projectResumeAssistantPageEvidence } from "../../harness/mobile-cache-timing-latest-assistant.mjs";
import { assertCachedSessionComposerReadOnly } from "../../harness/mobile-session-cache-readonly.mjs";
import {
  createDirectMobileTimingLaneDescriptor,
  createMobileTimingLaneRouteAudit,
  installMobileTimingLaneHttpGuard,
} from "../../harness/mobile-cache-timing-runner.mjs";
import { matchesBridgeRecordedResumeResponse } from "./mobile-session-cache-storage-corruption-fixture.mjs";

const sha256 = raw => createHash("sha256").update(raw).digest("hex");

/** Hold one exact original client request before the route calls upstream.send. */
export function createAgentListRequestGateV1({ rootRestore, threadId }) {
  assert.equal(rootRestore?.threadId, threadId);
  let held = null;
  let forwardedAtNodeMs = null;
  let discarded = false;
  let response = null;
  let duplicateCount = 0;
  return {
    capture({ raw, frame, request, socketOrdinal, forward }) {
      if (request?.method !== "agent/list" || request.threadId !== threadId ||
        frame?.params?.threadId !== threadId || rootRestore.request?.threadId !== threadId ||
        socketOrdinal !== rootRestore.request?.socketOrdinal || request.socketOrdinal !== socketOrdinal) return false;
      if (held) { duplicateCount += 1; return false; }
      assert.equal(typeof forward, "function");
      assert.ok(Number.isSafeInteger(frame.id) && frame.id >= 0 && String(frame.id) === request.id,
        "the held Mobile agent/list request must retain its original numeric JSON-RPC ID");
      held = { raw, frameId: frame.id, request, socketOrdinal, forward, requestSha256: sha256(raw) };
      return true;
    },
    release() {
      if (!held || forwardedAtNodeMs !== null || discarded) return false;
      held.forward();
      forwardedAtNodeMs = performance.now();
      held.forward = null;
      held.raw = null;
      return true;
    },
    observeResponse({ raw, frame, request, socketOrdinal }) {
      if (!held || forwardedAtNodeMs === null || response || socketOrdinal !== held.socketOrdinal ||
        frame?.jsonrpc !== "2.0" || !Object.is(frame.id, held.frameId) || typeof frame.method === "string" ||
        request !== held.request || request.method !== "agent/list" || request.threadId !== threadId) return false;
      response = { responseSucceeded: !frame.error && frame.result?.threadId === threadId &&
        Array.isArray(frame.result?.agents),
        responseSha256: sha256(raw), respondedAtNodeMs: performance.now() };
      return true;
    },
    discard() {
      if (!held || forwardedAtNodeMs !== null || discarded) return false;
      held.raw = null;
      held.forward = null;
      discarded = true;
      return true;
    },
    snapshot() {
      return { version: 1, threadId, requestId: held?.frameId ?? null,
        socketOrdinal: held?.socketOrdinal ?? null, requestSha256: held?.requestSha256 ?? null,
        held: Boolean(held && forwardedAtNodeMs === null && !discarded),
        requestForwarded: forwardedAtNodeMs !== null, forwardedAtNodeMs,
        responseSucceeded: response?.responseSucceeded ?? null,
        responseSha256: response?.responseSha256 ?? null,
        respondedAtNodeMs: response?.respondedAtNodeMs ?? null,
        duplicateCount, discarded };
    },
  };
}

/** One Direct real-UI, same-profile cold-restart causal preflight. */
export async function runAgentListCausalSmoke({
  context, page, protocol, threadId, taskUrl, promptMarker, tailMarker, gateway, mobileEntryUrl,
  seededCacheReadiness, expectedScope, getChromium, releaseChromium, createRestorePage,
  waitFor, releaseHeldAuthority,
}) {
  assert.equal(expectedScope?.threadId, threadId);
  assert.equal(seededCacheReadiness?.ready, true);
  assert.equal(new URL(taskUrl).origin, new URL(gateway.baseUrl).origin);
  const assistantId = seededCacheReadiness.messageIdentities.filter(row => row.role === "assistant").at(-1)?.id;
  assert.ok(typeof assistantId === "string" && assistantId.length > 0);
  const lane = createDirectMobileTimingLaneDescriptor({ gatewayUrl: gateway.baseUrl, mobileUrl: mobileEntryUrl });
  const evidence = { version: 1, lane: lane.safeSummary(), phase: "seed-owner-release", releases: [],
    boundary: "one real Mobile Web/Gateway/Rust Direct preflight; original agent/list request held before Gateway; no RTT or model-performance claim" };
  let currentPage = null;
  let gate = null;
  let firstRouteSocketOrdinal = 0;
  let firstPageRpcOrdinal = 0;
  let cleanupAttempted = false;
  try {
    evidence.releases.push(await releaseChromium("agent-list-causal-seed", { page, protocol,
      requiredSocketOrdinal: protocol.activeTaskSocketOrdinal }));
    const restoredOwner = getChromium();
    assert.equal(evidence.releases[0].newPid, restoredOwner.child.pid);
    assert.equal(evidence.releases[0].sameProfileDir, true);
    firstRouteSocketOrdinal = protocol.nextSocketOrdinal;
    firstPageRpcOrdinal = protocol.nextPageRpcSocketOrdinal;
    const requestBaseline = protocol.requests.length;
    protocol.rootRestore = { minSocketOrdinal: firstRouteSocketOrdinal + 1, threadId, holdMode: "full" };
    gate = createAgentListRequestGateV1({ rootRestore: protocol.rootRestore, threadId });
    currentPage = await restoredOwner.newPersistentPage();
    await currentPage.setViewportSize({ width: 390, height: 844 });
    const routeAudit = createMobileTimingLaneRouteAudit("agent-list-causal-direct");
    await installMobileTimingLaneHttpGuard(currentPage, lane, routeAudit);
    await createRestorePage(currentPage, gate, lane);
    evidence.phase = "cold-cache-before-authority";
    await currentPage.goto(mobileEntryUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await currentPage.waitForURL(url => url.origin === lane.origin &&
      url.pathname === new URL(taskUrl).pathname, { timeout: 30_000 });
    const heldResume = await waitFor(() => protocol.rootRestore?.heldResponse ?? null, 30_000,
      "the unchanged real Rust resume response held behind the cache-first barrier");
    assert.equal(heldResume.success, true);
    assert.equal(heldResume.fixtureTransformed, false);
    assert.equal(heldResume.forwardedAt, null);
    const resumeFrame = JSON.parse(String(protocol.heldAuthority.raw));
    assert.equal(matchesBridgeRecordedResumeResponse(protocol.rootRestore.request, resumeFrame, {
      socketOrdinal: heldResume.socketOrdinal, threadId,
    }), true);
    const authorityPage = projectResumeAssistantPageEvidence(resumeFrame, {
      expectedThreadId: threadId, expectedAssistantMessageId: assistantId, tailMarker,
    });
    const resumeRawSha256 = sha256(protocol.heldAuthority.raw);
    assert.equal(authorityPage.matched, true, "the untransformed Rust resume must contain one bounded canonical assistant tail");
    assert.equal(resumeFrame.result.history.page.messages.filter(row => row.role === "user" &&
      typeof row.content === "string" && row.content.includes(promptMarker)).length, 1,
    "the untransformed Rust resume must contain the exact original user prompt once");
    await currentPage.getByTestId("session-cache-view").waitFor({ state: "visible", timeout: 30_000 });
    await currentPage.getByTestId("session-cache-status").waitFor({ state: "visible", timeout: 30_000 });
    const cachedUser = currentPage.getByTestId("message-user").filter({ hasText: promptMarker });
    const cachedAssistant = currentPage.getByTestId("message-assistant").filter({ hasText: tailMarker });
    await cachedUser.waitFor({ state: "visible", timeout: 30_000 });
    await cachedAssistant.waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(await cachedUser.count(), 1);
    assert.equal(await cachedAssistant.count(), 1);
    await assertCachedSessionComposerReadOnly(currentPage,
      "the actual cached transcript before authority release");
    evidence.cacheObservedAtNodeMs = performance.now();
    evidence.cache = { realUiReadable: true, readOnly: true, cachedAssistantId: assistantId,
      manifestRevision: seededCacheReadiness.manifestRevision, scopeMatched: seededCacheReadiness.expectedScopeMatches };
    assert.equal(gate.snapshot().requestForwarded, false);
    evidence.phase = "authority-while-agent-list-held";
    assert.equal(releaseHeldAuthority(protocol), true);
    await waitFor(() => gate.snapshot().held ? true : null, 30_000,
      "the exact thread/socket agent/list request to be held before Gateway forwarding");
    await currentPage.getByTestId("session-cache-view").waitFor({ state: "detached", timeout: 30_000 });
    await cachedUser.waitFor({ state: "visible", timeout: 30_000 });
    await cachedAssistant.waitFor({ state: "visible", timeout: 30_000 });
    const composer = currentPage.getByTestId("message-input");
    await waitFor(async () => await composer.count() === 1 && await composer.isEditable(), 30_000,
      "the real authoritative history and editable composer before agent/list is forwarded");
    assert.equal(await cachedUser.count(), 1);
    assert.equal(await cachedAssistant.count(), 1);
    assert.equal(gate.snapshot().held, true);
    assert.equal(gate.snapshot().requestForwarded, false);
    assert.equal(gate.snapshot().duplicateCount, 0);
    assert.equal(protocol.requests.slice(requestBaseline).filter(row => row.method === "turn/start").length, 0);
    assert.equal(protocol.requests.slice(requestBaseline).filter(row => row.method === "thread/start").length, 0);
    assert.equal(protocol.errors.length, 0);
    assert.equal(routeAudit.violations.length, 0);
    evidence.authorityAndComposerObservedAtNodeMs = performance.now();
    evidence.authority = { ...authorityPage, exactResumeSocketOrdinal: heldResume.socketOrdinal,
      unchangedResumeRawSha256: resumeRawSha256,
      uniqueVisibleUserAndAssistant: true, cacheViewExited: true, composerEditable: true };
    evidence.heldAgentList = gate.snapshot();
    assert.ok(evidence.cacheObservedAtNodeMs < evidence.authorityAndComposerObservedAtNodeMs);
    evidence.phase = "forward-original-agent-list";
    assert.equal(gate.release(), true);
    await waitFor(() => gate.snapshot().respondedAtNodeMs ?? null, 30_000,
      "the same-socket original agent/list request to receive its real Gateway response");
    const after = gate.snapshot();
    assert.equal(after.responseSucceeded, true);
    assert.equal(after.duplicateCount, 0);
    assert.equal(after.socketOrdinal, heldResume.socketOrdinal);
    assert.ok(after.forwardedAtNodeMs > evidence.authorityAndComposerObservedAtNodeMs);
    assert.ok(after.respondedAtNodeMs >= after.forwardedAtNodeMs);
    assert.equal(protocol.rpcResponses.filter(row => row.method === "agent/list" &&
      row.threadId === threadId && row.socketOrdinal === after.socketOrdinal &&
      row.requestId === String(after.requestId) && row.success).length, 1);
    evidence.agentList = after;
    cleanupAttempted = true;
    evidence.releases.push(await releaseChromium("agent-list-causal-complete", { restart: false,
      page: currentPage, protocol, firstRouteSocketOrdinal, firstPageRpcOrdinal,
      requiredSocketOrdinal: after.socketOrdinal }));
    currentPage = null;
    evidence.phase = "complete";
    evidence.status = "PASS_AGENT_LIST_REQUEST_CAUSAL_PREFLIGHT";
    return evidence;
  } catch (error) {
    gate?.discard();
    evidence.agentListAtFailure = gate?.snapshot() ?? null;
    protocol.heldAuthority = null;
    if (!cleanupAttempted) {
      cleanupAttempted = true;
      try { evidence.releases.push(await releaseChromium("agent-list-causal-failure", { restart: false,
        ...(currentPage && !currentPage.isClosed() ? { page: currentPage, protocol,
          firstRouteSocketOrdinal, firstPageRpcOrdinal } : {}) })); }
      catch (cleanupError) { error = new AggregateError([error, cleanupError], "causal preflight and exact owner cleanup failed"); }
    }
    evidence.phase = "failed";
    evidence.status = "FAIL";
    evidence.error = context.redactText(String(error?.message ?? error)).slice(0, 2000);
    await context.writeArtifactJson("mobile-session-cache-agent-list-causal-failure.json", evidence);
    throw error;
  }
}
