import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readCacheStorageSnapshot } from "./mobile-session-cache-storage-corruption-fixture.mjs";

/** Shared real-UI target/peer/draft setup for exact Mobile cache storage faults. */
export async function seedStorageTargetPeerAndDraft({
  page, protocol, expectedScope, threadId, taskUrl, promptMarker, gateway,
  createPeerTask, waitFor, waitForReadOnlyTranscriptCache,
}) {
  assert.equal(expectedScope?.threadId, threadId);
  assert.equal(new URL(taskUrl).origin, new URL(gateway.baseUrl).origin);
  const draft = `UNSENT_STORAGE_DRAFT_${randomBytes(8).toString("hex")}`;
  const peerMarker = `STORAGE_PEER_${randomBytes(8).toString("hex")}`;
  const composer = page.getByTestId("message-input");
  assert.equal(await composer.count(), 1);
  assert.equal(await composer.isEditable(), true);
  await composer.fill(draft);
  await waitFor(async () => {
    const snapshot = await readCacheStorageSnapshot(page);
    return snapshot.workspaceStates.some(state => JSON.parse(state.raw).composerDraft === draft);
  }, 15_000, "the real composer draft to be durably written before storage fault");

  await backToHome(page);
  await createPeerTask(peerMarker);
  const peerTaskUrl = page.url();
  const peerThreadId = decodeURIComponent(new URL(page.url()).pathname.split("/").filter(Boolean).at(-1));
  assert.notEqual(peerThreadId, threadId);
  assert.equal(new URL(peerTaskUrl).origin, new URL(taskUrl).origin);
  assert.equal(new URL(page.url()).searchParams.get("cwd"), expectedScope.routeCwd);
  await waitFor(() => protocol.turnCompletions.some(row => row.threadId === peerThreadId && row.status === "completed"),
    60_000, "the peer's single real UI turn to complete");
  await waitForReadOnlyTranscriptCache(page, { threadId: peerThreadId,
    gatewayOrigin: new URL(gateway.baseUrl).origin, marker: peerMarker,
    expectedScope: { ...expectedScope, threadId: peerThreadId } }, 30_000);
  await backToHome(page);
  const targetCard = page.getByTestId(`thread-${threadId}`);
  await targetCard.waitFor({ state: "visible", timeout: 30_000 });
  assert.equal(await targetCard.count(), 1);
  await targetCard.click();
  const targetUrl = new URL(taskUrl);
  await waitFor(() => {
    const actual = new URL(page.url());
    return actual.origin === targetUrl.origin && actual.pathname === targetUrl.pathname &&
      actual.searchParams.get("cwd") === expectedScope.routeCwd;
  }, 15_000, "the original profile/server/thread route and exact cwd to be restored by its card");
  const returnedUrl = new URL(page.url());
  assert.equal(returnedUrl.origin, targetUrl.origin);
  assert.equal(returnedUrl.pathname, targetUrl.pathname);
  assert.equal(returnedUrl.searchParams.get("cwd"), expectedScope.routeCwd);
  await waitFor(async () => await page.getByTestId("message-input").inputValue() === draft,
    15_000, "the original unsent draft to survive visiting its real peer");
  await waitForReadOnlyTranscriptCache(page, { threadId, gatewayOrigin: new URL(gateway.baseUrl).origin,
    marker: promptMarker, expectedScope }, 30_000);
  assert.equal(protocol.requests.filter(row => row.method === "turn/start" && row.threadId === threadId).length, 1);
  assert.equal(protocol.requests.filter(row => row.method === "turn/start" && row.threadId === peerThreadId).length, 1);
  assert.equal(protocol.requests.filter(row => row.method === "turn/start").length, 2,
    "only the two real UI seeds may execute a turn; the composer draft remains unsent");
  return { draft, peerMarker, peerThreadId, peerTaskUrl };
}

async function backToHome(page) {
  const header = page.getByTestId("task-header");
  assert.equal(await header.count(), 1);
  const language = await page.evaluate(() => navigator.languages?.[0] || navigator.language || "en");
  const back = header.getByRole("button", { name: /^zh(?:-|$)/i.test(language) ? "返回" : "Back", exact: true });
  assert.equal(await back.count(), 1, "the current-locale Back action must be unique inside the task header");
  await back.click();
  await page.getByTestId("new-workspace").waitFor({ state: "visible", timeout: 30_000 });
}
