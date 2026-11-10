import assert from "node:assert/strict";
import { relative, resolve, sep } from "node:path";
import { closeRpcAndWait, gatewayRpcUrl, openRpc } from "../../harness/rpc.mjs";
import { assertCachedSessionComposerReadOnly } from "../../harness/mobile-session-cache-readonly.mjs";
import {
  correlateMobilePageRpcRoutes,
  mobilePageRpcRoutesClosed,
} from "../../harness/mobile-page-rpc-lifecycle.mjs";

const THREAD_PRESENCE_CAPABILITY = "threadPresenceReadV1";
const ABSENT_REASON = "boundDeletedPrimarySource";

export async function runConfirmedAbsenceSmoke({
  context,
  page,
  gateway,
  ownedWorkspacePath,
  protocol,
  threadId,
  taskPath,
  promptMarker,
  mobileEntryUrl,
  mobileMountPath,
  scopeExpectation,
  seededCacheReadiness,
  rpcCredentials,
  armServerHold,
  releaseServerHold,
  waitFor,
  waitForReadOnlyTranscriptCache,
}) {
  assert.match(seededCacheReadiness.entryKey ?? "", /^[a-f0-9]{64}$/, "the UI-seeded cache must expose its exact manifest key");
  assert.ok(Number.isSafeInteger(seededCacheReadiness.entrySlot) && Number.isSafeInteger(seededCacheReadiness.entryRevision),
    "the UI-seeded cache must expose its committed slot and revision");
  assert.equal(scopeExpectation.threadId, threadId, "the confirmed absence route and real task must identify the same thread");
  const workspaceRelative = relative(resolve(ownedWorkspacePath), resolve(scopeExpectation.routeCwd));
  assert.ok(workspaceRelative === "" || (workspaceRelative !== ".." && !workspaceRelative.startsWith(`..${sep}`) &&
    !workspaceRelative.startsWith(sep)), "the task's exact route cwd must remain inside this run's owned workspace");
  assert.ok(rpcCredentials?.rpcToken && rpcCredentials?.headers,
    "the logged-in Mobile page must supply owned Gateway RPC credentials");
  assert.equal(protocol.requests.filter(request => request.method === "turn/start" && request.threadId === threadId).length, 1,
    "the UI must complete its one real full turn before cross-client deletion");
  assert.equal(protocol.requests.filter(request => request.method === "thread/presence/read" && request.threadId === threadId).length, 0,
    "normal task creation must not add a presence probe before the deletion recovery path");

  const mobileRpcPairs = correlateMobilePageRpcRoutes(protocol.pageWebSockets, protocol.routeDiagnostics);
  const activeMobileRpcPairs = mobileRpcPairs.filter(({ routeDiagnostic }) =>
    !mobilePageRpcRoutesClosed([{ routeDiagnostic }]));
  assert.ok(activeMobileRpcPairs.length > 0, "the completed Mobile page must still own an open Gateway RPC bridge");
  const ownerPair = mobileRpcPairs.find(({ routeDiagnostic }) =>
    routeDiagnostic.socketOrdinal === protocol.activeTaskSocketOrdinal);
  assert.ok(ownerPair, "the full-turn Mobile owner must map to one observed page RPC and route bridge");
  assert.equal(ownerPair.routeDiagnostic.clientClosedAtMs, null,
    "the full-turn Mobile owner route client must still be open before the page is blanked");
  assert.equal(ownerPair.routeDiagnostic.upstreamClosedAtMs, null,
    "the full-turn Mobile owner route upstream must still be open before the page is blanked");
  assert.ok(activeMobileRpcPairs.includes(ownerPair), "the full-turn Mobile owner must be included in the active close barrier");
  await page.goto("about:blank", { waitUntil: "domcontentloaded" });
  await waitFor(() => mobilePageRpcRoutesClosed(activeMobileRpcPairs) ? true : null,
    15_000, "every active Mobile page RPC route client and upstream socket to report a close event");

  const rpcUrl = new URL(gatewayRpcUrl(gateway, scopeExpectation.routeServerId, rpcCredentials.rpcToken));
  rpcUrl.searchParams.set("workspace", scopeExpectation.routeCwd);
  const observer = await openRpc(rpcUrl.toString(), { headers: rpcCredentials.headers, timeoutMs: 15_000 });
  context.addCleanup("close confirmed-absence observer WebSocket", async () => {
    await closeRpcAndWait(observer, "confirmed-absence observer WebSocket");
  });
  let observerEvidence;
  let observerRequestId = 0;
  try {
    const initialized = await requestWithSafeReceipt(observer, "initialize", {
      protocolVersion: "2026-07-27",
      clientInfo: { name: "mobile-session-cache-confirmed-absence", version: "1" },
      capabilities: { experimental: { [THREAD_PRESENCE_CAPABILITY]: true } },
    }, ++observerRequestId);
    assert.equal(initialized.result.capabilities?.experimental?.[THREAD_PRESENCE_CAPABILITY], true,
      "the independent observer must negotiate the real thread-presence capability");
    const resumed = await requestWithSafeReceipt(observer, "thread/resume", { threadId }, ++observerRequestId);
    assert.equal(resumed.result.thread?.id, threadId, "the independent observer must resume the exact UI-created thread");
    const deletion = await requestWithSafeReceipt(observer, "thread/delete", { threadId }, ++observerRequestId);
    assert.equal(deletion.result.threadId, threadId, "the real delete response must identify the exact task thread");
    assert.equal(deletion.result.deleted, true, "the independent Gateway client must delete the real task thread");
    const presence = await requestWithSafeReceipt(observer, "thread/presence/read", { threadId }, ++observerRequestId);
    assert.deepEqual(presence.result, {
      status: "absent",
      threadId,
      reason: ABSENT_REASON,
    }, "the negotiated real presence read must confirm the bound deleted primary source");
    observerEvidence = {
      initializedPresenceCapability: true,
      resumedThreadId: resumed.result.thread?.id,
      deleted: deletion.result.deleted,
      deletedFiles: Number.isSafeInteger(deletion.result.deletedFiles) ? deletion.result.deletedFiles : null,
      presence: {
        requestId: presence.requestId,
        echoId: presence.echoId,
        status: presence.result.status,
        reason: presence.result.reason,
        threadId: presence.result.threadId,
      },
      workspaceQueryMatchedRouteCwd: rpcUrl.searchParams.get("workspace") === scopeExpectation.routeCwd,
      serverId: scopeExpectation.routeServerId,
      mobileOwnerPageSocketCloseEventObserved: Number.isFinite(ownerPair.pageSocket.closedAtMs),
      mobileBridgeClientClosed: Number.isFinite(ownerPair.routeDiagnostic.clientClosedAtMs),
      mobileBridgeUpstreamClosed: Number.isFinite(ownerPair.routeDiagnostic.upstreamClosedAtMs),
      mobilePageRpcRouteClosures: activeMobileRpcPairs.map(({ pageSocket, routeDiagnostic }) => ({
        rpcOrdinal: pageSocket.rpcOrdinal,
        routeSocketOrdinal: routeDiagnostic.socketOrdinal,
        pageSocketCloseEventAtMs: Number.isFinite(pageSocket.closedAtMs) ? pageSocket.closedAtMs : null,
        clientClosedAtMs: Number.isFinite(routeDiagnostic.clientClosedAtMs) ? routeDiagnostic.clientClosedAtMs : null,
        upstreamClosedAtMs: Number.isFinite(routeDiagnostic.upstreamClosedAtMs) ? routeDiagnostic.upstreamClosedAtMs : null,
      })),
    };
  } finally {
    await closeRpcAndWait(observer, "confirmed-absence observer WebSocket");
  }

  const priorTurnStarts = protocol.requests.filter(request => request.method === "turn/start" && request.threadId === threadId).length;
  const serverHold = armServerHold();
  try {
    protocol.rootRestore = {
      minSocketOrdinal: protocol.nextSocketOrdinal + 1,
      threadId,
      holdMode: "forward",
    };
    await page.goto(mobileEntryUrl, { waitUntil: "domcontentloaded" });
    await waitFor(() => serverHold.pending > 0 ? true : null,
      30_000, "production Mobile reload to hold its owned /api/servers request");
    await page.waitForURL(url => url.pathname === taskPath, { timeout: 30_000 });
    const cachedView = page.getByTestId("session-cache-view");
    await cachedView.waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(await cachedView.count(), 1, "the production Mobile reload must expose exactly one cached transcript view");
    const cachedPrompt = cachedView.getByTestId("message-user").filter({ hasText: promptMarker });
    await cachedPrompt.waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(await cachedPrompt.count(), 1, "the exact cached transcript must show its original prompt once");
    const cachedPromptVisibleCount = await cachedPrompt.count();
    const cacheStatus = cachedView.getByTestId("session-cache-status");
    await cacheStatus.waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(await cacheStatus.count(), 1, "the cached transcript must expose its read-only status");
    const cachedReadOnlyStatusVisible = await cacheStatus.isVisible();
    await assertCachedSessionComposerReadOnly(page,
      "the cached transcript while catalog access is held");
    const reloadedCache = await waitForReadOnlyTranscriptCache(page, {
      threadId,
      gatewayOrigin: new URL(gateway.baseUrl).origin,
      marker: promptMarker,
      expectedScope: scopeExpectation,
    }, 30_000);
    assert.ok(reloadedCache.ready, "the reloaded Mobile page must read the same confirmed cache entry");
    assert.equal(reloadedCache.entryKey, seededCacheReadiness.entryKey, "the cached view must use the exact UI-seeded manifest entry");
    assert.equal(reloadedCache.entrySlot, seededCacheReadiness.entrySlot, "the cached view must use the exact UI-seeded slot");
    assert.equal(reloadedCache.entryRevision, seededCacheReadiness.entryRevision,
      "the cached view must retain the exact UI-seeded data revision until authoritative presence arrives");
    assert.equal(serverHold.pending, 1, "the read-only cache must be visible behind exactly one held catalog request");

    releaseServerHold();
    const rootRestore = await waitFor(() => protocol.rootRestore?.response?.forwardedAt !== null &&
      protocol.rootRestore?.response?.forwardedAt !== undefined ? protocol.rootRestore.response : null,
    30_000, "the real Mobile thread/resume failure to be forwarded after catalog release");
    assert.equal(rootRestore.success, false, "the deleted thread must fail the Mobile resume request");
    assert.equal(rootRestore.errorCode, -32022, "Mobile must receive the typed deleted-thread resume error");
    const rootSocketOrdinal = protocol.rootRestore.minSocketOrdinal;
    const mobilePresence = await waitFor(() => protocol.presenceReads.find(read =>
      read.threadId === threadId && read.requestSocketOrdinal >= rootSocketOrdinal) ?? null,
    30_000, "the real Mobile negotiated thread-presence response for the deleted task");
    assert.equal(mobilePresence.echoId, mobilePresence.requestId, "the real Mobile presence response must echo its request ID");
    assert.equal(mobilePresence.errorCode, null, "the real Mobile presence request must succeed");
    assert.equal(mobilePresence.status, "absent", "the Mobile bridge must observe real authoritative absence");
    assert.equal(mobilePresence.reason, ABSENT_REASON, "the Mobile bridge must observe the exact bound-deletion reason");
    await page.getByTestId("sessions-confirmed-absence-notice").waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(await page.getByTestId("session-cache-view").count(), 0,
      "authoritative confirmed absence must remove the cached conversation view");
    assert.equal(await page.getByTestId("message-input").count(), 0,
      "the scoped Sessions route after cache revocation must not retain a composer");
    const sessionsUrl = new URL(page.url());
    assert.equal(sessionsUrl.pathname, `${mobileMountPath}/sessions`, "confirmed absence must replace the task with the mounted Sessions route");
    assert.equal(sessionsUrl.searchParams.get("profileId"), scopeExpectation.routeProfileId,
      "the Sessions route must retain the task's exact Gateway profile");
    assert.equal(sessionsUrl.searchParams.get("serverId"), scopeExpectation.routeServerId,
      "the Sessions route must retain the task's exact server");
    assert.equal(sessionsUrl.searchParams.get("cwd"), scopeExpectation.routeCwd,
      "the Sessions route must retain the exact workspace scope");
    assert.equal(sessionsUrl.searchParams.get("notice"), "confirmed-thread-absent",
      "the Sessions route must carry the confirmed-absence notice");

    const cacheRevocation = await waitFor(async () => {
      const snapshot = await readExactCacheRevocation(page, {
        entryKey: seededCacheReadiness.entryKey,
        entrySlot: seededCacheReadiness.entrySlot,
        entryRevision: seededCacheReadiness.entryRevision,
      });
      return snapshot.ready ? snapshot : null;
    }, 30_000, "the exact UI-seeded cache entry CAS tombstone and slot revision change");
    const finalTurnStarts = protocol.requests.filter(request => request.method === "turn/start" && request.threadId === threadId).length;
    assert.equal(finalTurnStarts, priorTurnStarts, "confirmed-absence recovery must not start or replay another turn");
    return {
      caseId: "mobile-session-cache-production-mobile-mount-confirmed-absence-smoke",
      status: "PASS_CONFIRMED_ABSENCE_SMOKE",
      boundary: "One real Mobile full turn seeds IndexedDB, a second Gateway RPC client resumes/deletes/confirms absence, Mobile reload shows the exact cache read-only, then the real resume error and presence response drive cache CAS invalidation and the scoped Sessions notice. No durable replay or whole-database-empty claim.",
      threadId,
      observer: observerEvidence,
      cachedView: {
        promptVisibleCount: cachedPromptVisibleCount,
        readOnlyStatusVisible: cachedReadOnlyStatusVisible,
        editableComposerVisible: false,
        heldCatalogRequestCount: serverHold.pending,
        exactSeedEntryReadBack: reloadedCache.entryKey === seededCacheReadiness.entryKey &&
          reloadedCache.entrySlot === seededCacheReadiness.entrySlot && reloadedCache.entryRevision === seededCacheReadiness.entryRevision,
      },
      recovery: {
        resumeErrorCode: rootRestore.errorCode,
        presence: {
          requestId: mobilePresence.requestId,
          echoId: mobilePresence.echoId,
          status: mobilePresence.status,
          reason: mobilePresence.reason,
          threadId: mobilePresence.threadId,
        },
      },
      cacheRevocation: {
        entryKey: seededCacheReadiness.entryKey,
        entrySlot: seededCacheReadiness.entrySlot,
        entryRevision: seededCacheReadiness.entryRevision,
        ...cacheRevocation,
      },
      sessions: {
        profileMatches: sessionsUrl.searchParams.get("profileId") === scopeExpectation.routeProfileId,
        serverMatches: sessionsUrl.searchParams.get("serverId") === scopeExpectation.routeServerId,
        workspaceMatches: sessionsUrl.searchParams.get("cwd") === scopeExpectation.routeCwd,
        confirmedAbsenceNoticeVisible: true,
      },
      turnStartCount: finalTurnStarts,
    };
  } finally {
    releaseServerHold();
  }
}

async function requestWithSafeReceipt(rpc, method, params, expectedId) {
  const messageCount = rpc.messages().length;
  let result;
  try {
    result = await rpc.request(method, params, 30_000);
  } catch {
    const errorFrame = rpc.messages().slice(messageCount).find(message => message.error && Number.isSafeInteger(message.error.code));
    const code = Number.isSafeInteger(errorFrame?.error?.code) ? errorFrame.error.code : null;
    throw new Error(`${method} failed with typed RPC code ${code ?? "unknown"}`);
  }
  const response = rpc.messages().slice(messageCount).find(message => message.id !== undefined && !message.method);
  assert.ok(response && !response.error, `${method} must have a real successful Gateway RPC response`);
  assert.equal(String(response.id), String(expectedId), `${method} must echo the observer request ID`);
  return { result, requestId: String(expectedId), echoId: String(response.id) };
}

async function readExactCacheRevocation(page, expected) {
  return page.evaluate(async ({ entryKey, entrySlot, entryRevision }) => {
    const databaseName = "kcoder-confirmed-transcripts-v1";
    const invalid = reason => ({ ready: false, reason });
    if (!/^[a-f0-9]{64}$/.test(entryKey) || !Number.isSafeInteger(entrySlot) ||
        !Number.isSafeInteger(entryRevision) || typeof indexedDB === "undefined" || typeof indexedDB.databases !== "function") {
      return invalid("invalid-expectation");
    }
    let databases;
    try {
      databases = await Promise.race([
        indexedDB.databases(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("cache inventory timeout")), 1_500)),
      ]);
    } catch { return invalid("database-inventory-failed"); }
    if (!databases.some(database => database.name === databaseName)) return invalid("database-not-created");
    let db;
    try {
      db = await new Promise((resolve, reject) => {
        let settled = false;
        const finish = (callback, value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          callback(value);
        };
        const timer = setTimeout(() => finish(reject, new Error("cache open timeout")), 1_500);
        const request = indexedDB.open(databaseName);
        request.onupgradeneeded = () => request.transaction?.abort();
        request.onsuccess = () => {
          if (settled) { request.result.close(); return; }
          finish(resolve, request.result);
        };
        request.onerror = () => finish(reject, new Error("cache open failed"));
        request.onblocked = () => finish(reject, new Error("cache open blocked"));
      });
      return await new Promise(resolve => {
        let settled = false;
        let manifest;
        let record;
        const finish = value => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          db.close();
          resolve(value);
        };
        const timer = setTimeout(() => finish(invalid("readonly-transaction-timeout")), 1_500);
        let transaction;
        try { transaction = db.transaction(["manifest", "entries"], "readonly"); }
        catch { finish(invalid("readonly-transaction-failed")); return; }
        const manifestRequest = transaction.objectStore("manifest").get("current");
        const slotRequest = transaction.objectStore("entries").get(entrySlot);
        manifestRequest.onsuccess = () => {
          if (typeof manifestRequest.result !== "string" || manifestRequest.result.length > 64 * 1024) return;
          try { manifest = JSON.parse(manifestRequest.result); } catch { return; }
        };
        slotRequest.onsuccess = () => { record = slotRequest.result; };
        transaction.oncomplete = () => {
          if (!manifest || manifest.schemaVersion !== 1 || !Number.isSafeInteger(manifest.revision) ||
              !Array.isArray(manifest.entries) || manifest.entries.length > 16 ||
              !Array.isArray(manifest.invalidations) || manifest.invalidations.length > 32) {
            finish(invalid("invalid-manifest"));
            return;
          }
          const matchingTombstone = manifest.invalidations.find(item => item?.key === `t:${entryKey}`) ?? null;
          const slotOwner = manifest.entries.find(item => item?.slot === entrySlot) ?? null;
          const oldSlotRevisionRetained = record?.revision === entryRevision;
          const snapshot = {
            ready: !manifest.entries.some(item => item?.key === entryKey) && manifest.lastKey !== entryKey &&
              Number.isSafeInteger(matchingTombstone?.revision) && matchingTombstone.revision > entryRevision &&
              !oldSlotRevisionRetained,
            manifestRevision: manifest.revision,
            oldEntryRemoved: !manifest.entries.some(item => item?.key === entryKey),
            lastKeyMoved: manifest.lastKey !== entryKey,
            exactTombstonePresent: Number.isSafeInteger(matchingTombstone?.revision),
            tombstoneRevision: Number.isSafeInteger(matchingTombstone?.revision) ? matchingTombstone.revision : null,
            oldSlotRevisionRetained,
            slotReusedByOtherEntry: Boolean(slotOwner && slotOwner.key !== entryKey && record?.revision === slotOwner.dataRevision),
          };
          finish(snapshot);
        };
        transaction.onabort = () => finish(invalid("readonly-transaction-aborted"));
        transaction.onerror = () => {};
      });
    } catch {
      db?.close();
      return invalid("readonly-cache-read-failed");
    }
  }, expected);
}
