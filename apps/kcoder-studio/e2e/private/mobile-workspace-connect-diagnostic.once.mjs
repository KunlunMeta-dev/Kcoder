import { readFile } from "node:fs/promises";
import { startChromium } from "../harness/chromium.mjs";
import { runE2E } from "../harness/run-context.mjs";

const PID = 3736827;
const ORIGIN = "http://127.0.0.1:4187";
const ENTRY = "entry-6f2463212746af0387747dee2ca2b5cf.js";
const PROFILE_KEY = "kcoder-studio-mobile.gateway-profiles.v2";
const READS = new Set(["initialize", "runtime.workspaces.list", "runtime.worktrees.list", "runtime.models.list"]);

async function gatewayToken(run) {
  const [status, cmdline, raw] = await Promise.all([
    readFile(`/proc/${PID}/status`, "utf8"),
    readFile(`/proc/${PID}/cmdline`, "utf8"),
    readFile(`/proc/${PID}/environ`),
  ]);
  const processUid = Number(status.match(/^Uid:\s+(\d+)/m)?.[1]);
  if (!Number.isInteger(processUid) || processUid !== process.getuid() || !cmdline.includes("dev-server.mjs")) throw new Error("gateway-identity-mismatch");
  const token = raw.toString("utf8").split("\0").find(value => value.startsWith("KCODER_STUDIO_AUTH_TOKEN="))?.slice("KCODER_STUDIO_AUTH_TOKEN=".length) ?? "";
  if (token.length < 32) throw new Error("gateway-token-unavailable");
  run.registerSecret(token);
  run.registerSecret(encodeURIComponent(token));
  return token;
}

function frames(payload) {
  try { const value = JSON.parse(payload); return Array.isArray(value) ? value : [value]; } catch { return []; }
}

await runE2E(import.meta.url, {
  testId: "mobile-workspace-connect-diagnostic-once",
  tier: "manual-live",
  modelPolicy: "real Mobile browser pairing and read-only workspace/model catalog; no model request, session history, message, or workspace creation",
  targetOwner: `shared preview PID ${PID} on 4187`,
}, async run => {
  const result = {
    classification: "isolated real Chromium against shared root-owned preview; browser/catalog evidence only",
    gatewayPid: PID, pageStatus: null, pairingStatus: null, entryLoaded: false,
    pairedProfilePresent: false, urlCleanAfterPairing: null, urlCleanOnNewPage: null,
    rpc: [], newPageStatus: null, workspaceOptionCount: null,
    modelSelectorVisible: false, modelSelectorDisabled: null,
    newWorkspaceErrorVisible: false, sessionReadObserved: false,
    cleanup: { status: null, outcome: "no-session-created" }, durationMs: null,
  };
  const started = Date.now();
  let sessionToken = null;
  let context = null;
  let stage = "preflight";
  let revoked = false;
  const revoke = async () => {
    if (revoked) return result.cleanup;
    revoked = true;
    if (!sessionToken) return result.cleanup;
    try {
      const response = await fetch(`${ORIGIN}/api/mobile/session`, { method: "DELETE", headers: { authorization: `Bearer ${sessionToken}` }, signal: AbortSignal.timeout(5000) });
      result.cleanup = { status: response.status, outcome: response.status === 204 ? "own-session-revoked" : "revoke-rejected" };
    } catch (error) { result.cleanup = { status: null, outcome: error?.name === "TimeoutError" ? "timeout" : "request-failed" }; }
    return result.cleanup;
  };
  try {
    const token = await gatewayToken(run);
    stage = "chromium";
    const chrome = await startChromium(run, { label: "mobile-workspace-connect-diagnostic", executablePath: "/usr/bin/chromium", noSandbox: true, startTimeoutMs: 15000 });
    context = await chrome.browser.newContext({ viewport: { width: 390, height: 844 }, locale: "zh-CN", colorScheme: "dark" });
    run.addCleanup("close diagnostic browser context", () => context?.close().catch(() => undefined));
    run.addCleanup("revoke diagnostic mobile session", revoke);
    const page = await context.newPage();
    const pending = new Map();
    const socketIds = new Map();
    let expectedEntrySeen = false;
    page.on("response", response => {
      try {
        const url = new URL(response.url());
        if (url.origin === ORIGIN && url.pathname.endsWith(`/${ENTRY}`) && response.status() === 200) expectedEntrySeen = true;
      } catch { /* Never retain response URLs. */ }
    });
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    cdp.on("Network.webSocketCreated", event => {
      try {
        const url = new URL(event.url);
        if (["ws:", "wss:"].includes(url.protocol) && url.host === new URL(ORIGIN).host && url.pathname === "/rpc") socketIds.set(event.requestId, true);
      } catch { /* Ignore malformed URLs. */ }
    });
    const observe = (direction, socket, payload) => {
      if (!socketIds.has(socket)) return;
      for (const frame of frames(payload)) {
        if (direction === "sent" && typeof frame?.method === "string") {
          if (/^(?:thread|session|turn)\//i.test(frame.method)) result.sessionReadObserved = true;
          if (frame.id !== undefined && READS.has(frame.method)) {
            const row = { method: frame.method, outcome: "pending", durationMs: null };
            result.rpc.push(row);
            pending.set(`${socket}:${String(frame.id)}`, { row, at: Date.now() });
          }
        } else if (direction === "received" && frame?.id !== undefined) {
          const found = pending.get(`${socket}:${String(frame.id)}`);
          if (found) {
            found.row.outcome = Object.hasOwn(frame, "error") ? "error" : "ok";
            found.row.durationMs = Date.now() - found.at;
            pending.delete(`${socket}:${String(frame.id)}`);
          }
        }
      }
    };
    cdp.on("Network.webSocketFrameSent", event => observe("sent", event.requestId, event.response.payloadData));
    cdp.on("Network.webSocketFrameReceived", event => observe("received", event.requestId, event.response.payloadData));

    stage = "pairing";
    const pairResponse = page.waitForResponse(response => {
      try { const url = new URL(response.url()); return response.request().method() === "POST" && url.origin === ORIGIN && url.pathname === "/api/mobile/session"; } catch { return false; }
    }, { timeout: 12000 }).then(async response => {
      result.pairingStatus = response.status();
      if (!response.ok()) return;
      const body = await response.json();
      for (const key of ["accessToken", "rpcToken", "refreshToken"]) if (typeof body?.[key] === "string") run.registerSecret(body[key]);
      sessionToken = typeof body?.accessToken === "string" ? body.accessToken : null;
    }).catch(() => undefined);
    const connectUrl = `${ORIGIN}/mobile/connect?gateway=${encodeURIComponent(ORIGIN)}#token=${encodeURIComponent(token)}`;
    const response = await page.goto(connectUrl, { waitUntil: "domcontentloaded", timeout: 8000 });
    result.pageStatus = response?.status() ?? null;
    await pairResponse;
    await page.waitForFunction(key => {
      try { const data = JSON.parse(localStorage.getItem(key) || "null"); return data?.profiles?.some(profile => typeof profile?.id === "string"); } catch { return false; }
    }, PROFILE_KEY, { timeout: 7000 }).catch(() => undefined);
    const profile = await page.evaluate(({ key, origin }) => {
      try { const data = JSON.parse(localStorage.getItem(key) || "null"); const item = data?.profiles?.find(value => typeof value?.id === "string" && new URL(value.baseUrl).origin === origin); return item ? { id: item.id } : null; } catch { return null; }
    }, { key: PROFILE_KEY, origin: ORIGIN });
    result.pairedProfilePresent = Boolean(profile?.id);
    result.urlCleanAfterPairing = await page.evaluate(() => !new URLSearchParams(location.search).has("token") && !location.hash.startsWith("#token="));
    if (profile?.id && sessionToken) {
      stage = "new-workspace-page";
      const newUrl = `${ORIGIN}/mobile/new?profileId=${encodeURIComponent(profile.id)}&serverId=local`;
      const newResponse = await page.goto(newUrl, { waitUntil: "domcontentloaded", timeout: 8000 });
      result.newPageStatus = newResponse?.status() ?? null;
      const rpcDeadline = Date.now() + 39000;
      while (Date.now() < rpcDeadline) {
        const ui = await page.evaluate(() => ({
          workspaceOptionCount: document.querySelectorAll('[data-testid^="workspace-option-"]').length,
          modelSelectorVisible: Boolean(document.querySelector('[data-testid="model-selector"]')),
          modelSelectorDisabled: document.querySelector('[data-testid="model-selector"]')?.hasAttribute("disabled") ?? null,
          newWorkspaceErrorVisible: Boolean(document.querySelector('[data-testid="new-workspace-error"]')),
          urlCleanOnNewPage: !new URLSearchParams(location.search).has("token") && !location.hash.startsWith("#token="),
        }));
        Object.assign(result, ui);
        const settled = new Set(result.rpc.filter(row => row.outcome !== "pending").map(row => row.method));
        const catalogsDone = ["runtime.workspaces.list", "runtime.worktrees.list", "runtime.models.list"].every(method => settled.has(method));
        if (catalogsDone || (ui.newWorkspaceErrorVisible && settled.has("initialize"))) break;
        await new Promise(resolve => setTimeout(resolve, 150));
      }
      result.entryLoaded = expectedEntrySeen;
      await cdp.detach().catch(() => undefined);
    }
  } catch (error) {
    result.failureStage = stage;
    result.failureName = error?.name ?? "Error";
  } finally {
    await revoke();
    await context?.close().catch(() => undefined);
    result.durationMs = Date.now() - started;
  }
  return result;
});
