import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { closeRpcAndWait, gatewayRpcUrl, openRpc } from "../../harness/rpc.mjs";
import { closeMobileTimingTaskPage, observeMobilePageRpcSockets } from "../../harness/mobile-cache-timing-page-ownership.mjs";
import { mobilePageRpcRoutesClosed } from "../../harness/mobile-page-rpc-lifecycle.mjs";
import { confirmedCompletedTurnRows, createOwnerHandoffResumeGate, projectFullIdleRollbackAuthority,
  projectSafeOwnerHandoffFailure } from "./mobile-session-cache-owner-handoff-gate.mjs";

const marker = () => `OWNER_HANDOFF_ROLLBACK_TURN2_${randomBytes(6).toString("hex").toUpperCase()}`;

/** One legal ownership handoff on a mounted Page; the actor never races its old owner. */
export async function runOwnerHandoffRollbackSmoke({
  context, seedPage, chromium, gateway, protocol, threadId, taskUrl, turn1Marker,
  mobileEntryUrl, expectedScope, rpcCredentials, pageSocketCredentials,
  gatewayBaseUrl, gatewayRpcPath, bridge, readLiveMessageIdentityRows, waitFor,
}) {
  assert.equal(expectedScope?.threadId, threadId);
  assert.ok(rpcCredentials?.rpcToken && rpcCredentials?.headers);
  const evidence = { version: 1, phase: "seed-owner-release", status: "PREFLIGHT", threadId,
    boundary: "same mounted Mobile Web Page reconnect, exact pre-Gateway resume request hold, legal same-scope actor rollback; deterministic local full turns, no external Provider or physical-phone claim" };
  const turn2Marker = marker();
  let subject = null;
  let actor = null;
  let gate = null;
  let actorStep = "not-started";
  let subjectFirstRouteOrdinal = protocol.nextSocketOrdinal;
  let subjectFirstPageRpcOrdinal = protocol.nextPageRpcSocketOrdinal;
  try {
    await closeMobileTimingTaskPage({ page: seedPage, protocol, waitFor,
      requiredSocketOrdinal: protocol.activeTaskSocketOrdinal, label: "owner-handoff seed Page" });
    evidence.seedPageReleased = true;
    subjectFirstRouteOrdinal = protocol.nextSocketOrdinal;
    subjectFirstPageRpcOrdinal = protocol.nextPageRpcSocketOrdinal;
    gate = createOwnerHandoffResumeGate({ threadId });
    subject = await chromium.newPersistentPage();
    await subject.setViewportSize({ width: 390, height: 844 });
    context.addCleanup("close owner-handoff subject Page", async () => { if (!subject.isClosed()) await subject.close(); });
    observeMobilePageRpcSockets(subject, protocol, context, gatewayBaseUrl, gatewayRpcPath, pageSocketCredentials);
    await bridge(subject, gate);
    evidence.phase = "history-entry";
    await subject.goto(mobileEntryUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await waitFor(async () => await subject.getByTestId("task-header").count() === 1 ||
      await subject.getByTestId("sessions").count() === 1, 30_000, "subject route to expose task or home navigation");
    if (await subject.getByTestId("task-header").count() === 1) {
      const language = await subject.evaluate(() => document.documentElement.lang);
      assert.ok(language === "en" || language === "zh-CN");
      const back = subject.getByTestId("task-header").getByRole("button", {
        name: language === "zh-CN" ? "返回" : "Back", exact: true });
      assert.equal(await back.count(), 1);
      await back.click();
    }
    const sessions = subject.getByTestId("sessions");
    await sessions.waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(await sessions.count(), 1);
    await sessions.click();
    const historyRow = subject.getByTestId(`session-${threadId}`);
    await historyRow.waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(await historyRow.count(), 1);
    await historyRow.click();
    await subject.waitForURL(url => url.pathname === new URL(taskUrl).pathname, { timeout: 30_000 });
    const turn1User = subject.getByTestId("message-user").filter({ hasText: turn1Marker });
    await turn1User.waitFor({ state: "visible", timeout: 30_000 });
    const restoredComposer = subject.getByTestId("message-input");
    await waitFor(async () => await restoredComposer.count() === 1 && await restoredComposer.isEditable(),
      30_000, "the restored live composer before reading authoritative message identities");
    assert.equal(await turn1User.count(), 1);
    const beforeRows = await readLiveMessageIdentityRows(subject);
    assert.ok(beforeRows.some(row => row.role === "user"));
    assert.ok(beforeRows.some(row => row.role === "assistant"));
    evidence.historyEntry = { fromSessionsRow: true, turn1UserVisible: true,
      beforeRowCount: beforeRows.length, pathMatched: true };

    evidence.phase = "ui-turn2-completion";
    const beforeTurnStartCount = protocol.requests.filter(row => row.method === "turn/start" && row.threadId === threadId).length;
    const composer = subject.getByTestId("message-input");
    const send = subject.getByTestId("send-message");
    assert.equal(await composer.count(), 1);
    assert.equal(await composer.isEditable(), true);
    await composer.fill(turn2Marker);
    assert.equal(await send.count(), 1);
    assert.equal(await send.isEnabled(), true);
    await send.click();
    const turn2User = subject.getByTestId("message-user").filter({ hasText: turn2Marker });
    await turn2User.waitFor({ state: "visible", timeout: 30_000 });
    const turn2Start = await waitFor(() => protocol.requests.filter(row => row.method === "turn/start" && row.threadId === threadId)[beforeTurnStartCount] ?? null,
      30_000, "one exact UI turn2 start");
    assert.equal(protocol.rpcResponses.some(row => row.method === "thread/resume" &&
      row.threadId === threadId && row.socketOrdinal === turn2Start.socketOrdinal && row.success), true,
    "the subject history socket must receive its real successful resume before UI turn2");
    const turn2Completion = await waitFor(() => protocol.turnCompletions.find(row => row.threadId === threadId &&
      row.status === "completed" && row.socketOrdinal === turn2Start.socketOrdinal && row.at > turn2Start.at) ?? null,
    60_000, "one exact UI turn2 completion");
    await subject.getByTestId("send-message").waitFor({ state: "visible", timeout: 30_000 });
    const confirmedTurn2 = await waitFor(() => confirmedCompletedTurnRows(protocol.indexedHistoryReads, {
      threadId, socketOrdinal: turn2Start.socketOrdinal, turnId: turn2Completion.turnId,
      completedAtMs: turn2Completion.at,
    }), 30_000, "same-socket indexed history confirms the completed turn before disconnect");
    const beforeIds = new Set(beforeRows.map(row => row.id));
    const afterRows = await waitFor(async () => {
      const rows = await readLiveMessageIdentityRows(subject);
      const added = rows.filter(row => !beforeIds.has(row.id));
      return added.some(row => row.role === "user" && row.id === confirmedTurn2.userId) &&
        added.some(row => row.role === "assistant" && row.id === confirmedTurn2.assistantId) ? rows : null;
    }, 30_000, "the two confirmed completed turn2 rows in the mounted subject Page");
    const liveTurn2Rows = afterRows.filter(row => !beforeIds.has(row.id));
    assert.equal(liveTurn2Rows.filter(row => row.role === "user").length, 1);
    assert.equal(liveTurn2Rows.filter(row => row.role === "assistant").length, 1);
    assert.equal(await turn2User.count(), 1);
    protocol.activeTaskSocketOrdinal = turn2Start.socketOrdinal;
    const subjectUrl = subject.url();
    const subjectNonce = await subject.evaluate(() => {
      globalThis.__ownerHandoffPageNonceV1 = crypto.randomUUID();
      return globalThis.__ownerHandoffPageNonceV1;
    });
    evidence.uiTurn2 = { startSocketOrdinal: turn2Start.socketOrdinal,
      completionOnSameSocket: turn2Completion.socketOrdinal === turn2Start.socketOrdinal,
      completed: turn2Completion.status === "completed", liveUserAndAssistant: true,
      canonicalIndexedReadBeforeDisconnect: true, canonicalDomIdsBeforeDisconnect: true,
      canonicalReadRequestId: confirmedTurn2.requestId,
      stableTurnId: typeof turn2Completion.turnId === "string" && turn2Completion.turnId.length > 0 };
    assert.equal(evidence.uiTurn2.stableTurnId, true);

    evidence.phase = "hold-reconnect-before-gateway";
    gate.arm(protocol.nextSocketOrdinal + 1);
    const oldRoute = protocol.routeDiagnostics.find(row => row.socketOrdinal === turn2Start.socketOrdinal);
    assert.ok(oldRoute?.closeForwarding);
    assert.equal(oldRoute.closeForwarding.requestCloseFromOwnerRelease(), true);
    await waitFor(() => mobilePageRpcRoutesClosed([{ routeDiagnostic: oldRoute }]) ? true : null,
    15_000, "exact old Mobile owner route client and upstream closes");
    await waitFor(() => gate.snapshot().held ? true : null, 30_000,
      "same Page automatic reconnect resume held before Gateway dispatch");
    assert.equal(subject.isClosed(), false);
    assert.equal(subject.url(), subjectUrl);
    assert.equal(await subject.evaluate(() => globalThis.__ownerHandoffPageNonceV1), subjectNonce);
    assert.equal(gate.snapshot().forwardedAtMs, null);
    const resumedSocket = gate.snapshot().socketOrdinal;
    assert.ok(resumedSocket > turn2Start.socketOrdinal);
    assert.ok(protocol.requests.some(row => row.socketOrdinal === resumedSocket && row.method === "initialize"));
    evidence.samePageHold = { exactOldClientAndUpstreamClosed: true, sameUrl: true,
      sameJsInstance: true, initializeObserved: true, resumeHeldNotForwarded: true,
      gate: gate.snapshot() };

    evidence.phase = "legal-actor-rollback";
    actorStep = "open-exact-actor-socket";
    const actorUrl = new URL(gatewayRpcUrl(gateway, expectedScope.routeServerId, rpcCredentials.rpcToken));
    actorUrl.searchParams.set("workspace", expectedScope.routeCwd);
    actor = await openRpc(actorUrl.toString(), { headers: rpcCredentials.headers, timeoutMs: 15_000 });
    context.addCleanup("close owner-handoff actor RPC", () => closeRpcAndWait(actor, "owner-handoff actor RPC"));
    actorStep = "initialize-actor";
    const initialized = await actor.request("initialize", { protocolVersion: "2026-07-27",
      clientInfo: { name: "mobile-owner-handoff-rollback", version: "1" },
      capabilities: { experimental: { threadResumeHistoryPageV1: true, threadIndexedPagesV1: true,
        threadTranscriptObservationV1: true } } });
    actorStep = "check-inline-history-capability";
    evidence.actorDiagnostic = { initialized: true,
      inlineHistoryCapability: initialized.capabilities?.experimental?.threadResumeHistoryPageV1 === true };
    assert.equal(evidence.actorDiagnostic.inlineHistoryCapability, true);
    actorStep = "resume-exact-thread";
    const resumed = await actor.request("thread/resume", { threadId, history: { limit: 50, indexed: true } });
    actorStep = "check-resumed-thread";
    evidence.actorDiagnostic.resumedExactThread = resumed.thread?.id === threadId;
    assert.equal(resumed.thread?.id, threadId);
    const beforePage = resumed.history?.status === "ready" ? resumed.history.page : null;
    actorStep = "check-pre-rollback-full-page";
    evidence.actorDiagnostic.beforePage = { ready: Boolean(beforePage),
      messageCount: Array.isArray(beforePage?.messages) ? beforePage.messages.length : null,
      rangeStart: Number.isSafeInteger(beforePage?.rangeStart) ? beforePage.rangeStart : null,
      rangeEnd: Number.isSafeInteger(beforePage?.rangeEnd) ? beforePage.rangeEnd : null,
      hasMoreBefore: beforePage?.hasMoreBefore === true };
    assert.ok(beforePage && Array.isArray(beforePage.messages));
    assert.equal(beforePage.rangeStart, 0);
    assert.equal(beforePage.rangeEnd, beforePage.messages.length);
    assert.equal(beforePage.hasMoreBefore, false);
    assert.equal(new Set(beforePage.messages.map(row => row.id)).size, beforePage.messages.length);
    const canonicalTurn1User = beforePage.messages.filter(row => row.role === "user" &&
      typeof row.content === "string" && row.content.includes(turn1Marker));
    actorStep = "check-canonical-turn1-user";
    evidence.actorDiagnostic.canonicalTurn1UserCount = canonicalTurn1User.length;
    assert.equal(canonicalTurn1User.length, 1);
    assert.equal(beforeRows.some(row => row.role === "user" && row.id === canonicalTurn1User[0].id), true);
    const canonicalTurn2User = beforePage.messages.filter(row => row.role === "user" &&
      typeof row.content === "string" && row.content.includes(turn2Marker));
    actorStep = "check-canonical-turn2-user";
    evidence.actorDiagnostic.canonicalTurn2UserCount = canonicalTurn2User.length;
    assert.equal(canonicalTurn2User.length, 1);
    const canonicalTurn2Assistant = beforePage.messages.filter(row => row.role === "assistant" &&
      row.turnId === canonicalTurn2User[0].turnId);
    actorStep = "check-canonical-turn2-assistant-and-identity";
    evidence.actorDiagnostic.canonicalTurn2AssistantCount = canonicalTurn2Assistant.length;
    evidence.actorDiagnostic.canonicalTurn2UserTurnMatchesCompletion =
      canonicalTurn2User[0].turnId === turn2Completion.turnId;
    assert.equal(canonicalTurn2Assistant.length, 1);
    assert.equal(canonicalTurn2User[0].turnId, turn2Completion.turnId);
    assert.equal(liveTurn2Rows.some(row => row.role === "user" && row.id === canonicalTurn2User[0].id), true);
    assert.equal(liveTurn2Rows.some(row => row.role === "assistant" && row.id === canonicalTurn2Assistant[0].id), true);
    const canonicalTurn2Rows = beforePage.messages.filter(row => row.turnId === turn2Completion.turnId);
    actorStep = "check-canonical-turn2-row-count";
    evidence.actorDiagnostic.canonicalTurn2RowCount = canonicalTurn2Rows.length;
    assert.equal(canonicalTurn2Rows.length, 2);
    const knownAfterRollback = beforePage.messages.filter(row => row.turnId !== turn2Completion.turnId).length;
    assert.ok(knownAfterRollback >= 2);
    actorStep = "request-rollback-turn2";
    const rollback = await actor.request("thread/rollback", { threadId, turn: 2 });
    actorStep = "check-rollback-ack";
    evidence.actorDiagnostic.rollback = { exactThread: rollback.threadId === threadId,
      turnIsTwo: rollback.turn === 2,
      removedMessagesPositive: Number.isSafeInteger(rollback.removedMessages) && rollback.removedMessages > 0 };
    assert.equal(rollback.threadId, threadId);
    assert.equal(rollback.turn, 2);
    assert.ok(Number.isSafeInteger(rollback.removedMessages) && rollback.removedMessages > 0);
    actorStep = "request-confirmed-nonforce-detach";
    const detach = await actor.request("gateway/client/detach", { confirm: true, force: false });
    actorStep = "check-detach-ack-and-socket-close";
    assert.equal(detach.detached, true);
    await closeRpcAndWait(actor, "owner-handoff actor RPC");
    actor = null;
    evidence.actor = { exactGatewayServerAndWorkspace: true, initialized: true,
      resumedExactThread: true, beforePageFull: true, turn2CanonicalUserAndAssistant: true,
      rollbackTurn: rollback.turn, removedMessages: rollback.removedMessages,
      detachAcknowledged: true, socketClosed: true };
    assert.equal(gate.snapshot().held, true);
    assert.equal(gate.snapshot().forwardedAtMs, null);

    evidence.phase = "subject-authority-after-handoff";
    assert.equal(gate.release(), true);
    await waitFor(() => gate.responseFrame() ?? null, 30_000,
      "original same-socket Mobile resume response after actor detach");
    const authority = projectFullIdleRollbackAuthority(gate.responseFrame(), {
      threadId, turn1Marker, turn2Marker, turn1UserId: canonicalTurn1User[0].id,
      turn2UserId: canonicalTurn2User[0].id, turn2AssistantId: canonicalTurn2Assistant[0].id,
      knownCount: knownAfterRollback,
    });
    evidence.authority = { ...authority, gate: gate.snapshot() };
    assert.equal(authority.complete, true, "the unmodified post-rollback authority must be full and idle");
    assert.equal(authority.turn1UserCount, 1);
    assert.equal(authority.turn1UserIdCount, 1);
    assert.equal(authority.turn2UserCount, 0);
    assert.equal(gate.snapshot().duplicateCount, 0);
    await subject.getByTestId("message-input").waitFor({ state: "visible", timeout: 30_000 });
    await waitFor(async () => await subject.getByTestId("message-input").isEditable(),
      30_000, "same Page reconnect composer after real full authority");
    assert.equal(subject.url(), subjectUrl);
    assert.equal(await subject.evaluate(() => globalThis.__ownerHandoffPageNonceV1), subjectNonce);
    const finalRows = await readLiveMessageIdentityRows(subject);
    assert.equal(finalRows.every(row => typeof row.id === "string" && row.id.length > 0), true);
    assert.equal(new Set(finalRows.map(row => row.id)).size, finalRows.length);
    evidence.uiAfterAuthority = {
      turn1RowIdentityPreserved: finalRows.some(row => row.role === "user" && row.id === canonicalTurn1User[0].id),
      turn2UserAbsent: !finalRows.some(row => row.id === canonicalTurn2User[0].id),
      turn2AssistantAbsent: !finalRows.some(row => row.id === canonicalTurn2Assistant[0].id),
      sameUrl: true, sameJsInstance: true, composerEditable: true,
      noNewTurnStart: protocol.requests.filter(row => row.method === "turn/start" && row.threadId === threadId).length === beforeTurnStartCount + 1,
    };
    evidence.phase = "ui-rollback-assertion";
    if (!evidence.uiAfterAuthority.turn2UserAbsent || !evidence.uiAfterAuthority.turn2AssistantAbsent) {
      evidence.status = "RED_PRODUCT_LIVE_GHOST_AFTER_FULL_IDLE_AUTHORITY";
      await context.writeArtifactJson("mobile-session-cache-owner-handoff-rollback-red.json", evidence);
      throw new Error("owner-handoff rollback: completed live row remained after full idle authority");
    }
    assert.equal(evidence.uiAfterAuthority.turn1RowIdentityPreserved, true);
    assert.equal(evidence.uiAfterAuthority.noNewTurnStart, true);
    evidence.status = "PASS_OWNER_HANDOFF_ROLLBACK";
    return evidence;
  } catch (error) {
    gate?.discard();
    evidence.failure = projectSafeOwnerHandoffFailure(error, evidence.phase, actorStep, gate?.snapshot() ?? null);
    await context.writeArtifactJson("mobile-session-cache-owner-handoff-rollback-failure.json", evidence).catch(() => {});
    throw new Error(`owner-handoff rollback ${evidence.status === "RED_PRODUCT_LIVE_GHOST_AFTER_FULL_IDLE_AUTHORITY" ? "PRODUCT_RED" : "GATE_PRECONDITION"} at ${evidence.phase}`);
  } finally {
    if (actor) await closeRpcAndWait(actor, "owner-handoff actor RPC").catch(() => {});
    if (subject && !subject.isClosed()) {
      try {
        const closed = await closeMobileTimingTaskPage({ page: subject, protocol, waitFor,
          firstRouteSocketOrdinal: subjectFirstRouteOrdinal,
          firstPageRpcOrdinal: subjectFirstPageRpcOrdinal,
          requiredSocketOrdinal: gate?.snapshot().socketOrdinal ?? null,
          label: "owner-handoff subject Page" });
        await context.writeArtifactJsonInternal("mobile-session-cache-owner-handoff-subject-cleanup.json", {
          status: "PASS", exactRoutesClosed: true, result: closed });
      } catch {
        await subject.close().catch(() => {});
        await context.writeArtifactJsonInternal("mobile-session-cache-owner-handoff-subject-cleanup.json", {
          status: "FAIL", exactRoutesClosed: false }).catch(() => {});
        if (evidence.status === "PASS_OWNER_HANDOFF_ROLLBACK")
          throw new Error("owner-handoff subject Page exact RPC cleanup failed");
      }
    }
  }
}
