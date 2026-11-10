import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { repoRoot, runE2E, waitFor } from "../harness/run-context.mjs";
import { startChromium } from "../harness/chromium.mjs";

const GATEWAY = "http://127.0.0.1:4189";
const EXPECTED_PUBLIC_GATEWAY = "https://49.234.36.54:8451/g/hmr-preview-20261014";
const THREAD_ID = "LUyha";
const TITLE = "测试下你的shell工具";

function inside(root, path) {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel));
}

function secret(run, value) {
  if (typeof value !== "string" || value.length < 8) return;
  run.registerSecret(value);
  run.registerSecret(encodeURIComponent(value));
}

function registerUrlSecrets(run, url) {
  let count = 0;
  const add = params => {
    for (const [name, value] of params) {
      if (/token|secret|auth/i.test(name) && value.length >= 8) { secret(run, value); count++; }
    }
  };
  add(url.searchParams);
  const fragment = url.hash.slice(1);
  add(new URLSearchParams(fragment));
  const queryAt = fragment.indexOf("?");
  if (queryAt >= 0) add(new URLSearchParams(fragment.slice(queryAt + 1)));
  return count;
}

async function readPairingUrl(run) {
  const configured = process.env.KCODER_E2E_TASK_OPEN_PAIRING_FILE;
  if (!configured || !isAbsolute(configured)) throw new Error("pairing file must be an absolute private path");
  let path, info;
  try { path = await realpath(configured); info = await lstat(configured); }
  catch { throw new Error("pairing file is unavailable"); }
  if (!info.isFile() || info.isSymbolicLink() || typeof process.getuid !== "function" ||
      info.uid !== process.getuid() || info.nlink !== 1 || info.size > 16_384 ||
      (info.mode & 0o077) !== 0 || inside(repoRoot, path) || /^\.env(?:$|\.)/i.test(basename(path))) {
    throw new Error("pairing file must be a private regular file outside the repository");
  }
  let url;
  try { url = new URL((await readFile(path, "utf8")).trim()); }
  catch { throw new Error("pairing file does not contain a readable URL"); }
  const expectedPublic = new URL(EXPECTED_PUBLIC_GATEWAY);
  const expectedPairingPath = expectedPublic.pathname.replace(/\/+$/, "") + "/mobile/connect";
  if (url.protocol !== "https:" || url.username || url.password ||
      url.origin !== expectedPublic.origin || url.pathname !== expectedPairingPath) {
    throw new Error("pairing URL must use the authorized public Mobile Web connect path");
  }
  const gatewayHint = url.searchParams.get("gateway");
  let normalizedGateway;
  try {
    const parsedGateway = new URL(gatewayHint);
    normalizedGateway = parsedGateway.origin + parsedGateway.pathname.replace(/\/+$/, "");
  } catch { throw new Error("pairing URL must identify the authorized public Gateway"); }
  if (normalizedGateway !== EXPECTED_PUBLIC_GATEWAY) throw new Error("pairing URL targets a different Gateway");
  if (registerUrlSecrets(run, url) === 0) throw new Error("pairing URL has no query or fragment token");
  return url;
}

function parseFrames(payload) {
  try {
    const parsed = JSON.parse(typeof payload === "string" ? payload : payload.toString());
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch { return []; }
}

function installPeerFrameObserver() {
  const LABEL = "kcoder-gateway-v1", MAX_MESSAGE_BYTES = 256 * 1024;
  const probe = { connections: 0, opens: [], resumes: [] }, channels = new WeakMap();
  Object.defineProperty(window, "__mobileTaskOpenPeerProbe", {
    value: { snapshot: () => ({ connectionCount: probe.connections, opens: probe.opens, resumes: probe.resumes }) }, configurable: false,
  });
  const Peer = globalThis.RTCPeerConnection, DataChannel = globalThis.RTCDataChannel;
  if (!Peer?.prototype || !DataChannel?.prototype?.send) return;
  const originalCreate = Peer.prototype.createDataChannel, originalSend = DataChannel.prototype.send;
  if (typeof originalCreate !== "function") return;

  function attach(channel) {
    const state = { connectionId: `p2p-${++probe.connections}`, operations: new Map(), assemblies: new Map() };
    channels.set(channel, state);
    channel.addEventListener("message", event => observe(state, "in", event.data));
    channel.addEventListener("close", () => { state.operations.clear(); state.assemblies.clear(); });
  }
  function finishMessage(state, assembly) {
    try {
      if (assembly.total !== assembly.byteLength || assembly.binary) return;
      const bytes = new Uint8Array(assembly.total);
      let offset = 0;
      for (const chunk of assembly.chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      const value = JSON.parse(new TextDecoder().decode(bytes));
      for (const rpc of Array.isArray(value) ? value : [value]) {
        if (!rpc || typeof rpc !== "object") continue;
        const operation = state.operations.get(assembly.operationId);
        if (!operation) continue;
        if (assembly.direction === "out" && rpc.method === "thread/resume" &&
            rpc.params?.threadId === "LUyha" && (typeof rpc.id === "string" || typeof rpc.id === "number") &&
            operation.requests.size < 32 && probe.resumes.length < 32) {
          operation.requestCount += 1;
          const record = { connectionId: state.connectionId, socketId: assembly.operationId,
            requestCount: operation.requestCount, method: "thread/resume", threadId: "LUyha",
            requestedAtMs: Date.now(), status: "request-observed", respondedAtMs: null, error: null };
          operation.requests.set(String(rpc.id), record);
          probe.resumes.push(record);
        } else if (assembly.direction === "in") {
          const record = operation.requests.get(String(rpc.id));
          if (!record) continue;
          operation.requests.delete(String(rpc.id));
          record.respondedAtMs = Date.now();
          if (rpc.error && typeof rpc.error === "object") {
            const code = rpc.error.code;
            record.status = "error";
            record.error = { code: typeof code === "number" || typeof code === "string" ? code : null,
              message: typeof rpc.error.message === "string" ? rpc.error.message.slice(0, 1200) : "" };
          } else record.status = "response-success";
        }
      }
    } catch { /* Ignore malformed or non-JSON-RPC payloads without retaining them. */ }
  }
  function observe(state, direction, raw) {
    try {
      if (typeof raw !== "string" || raw.length > 20_000) return;
      const frame = JSON.parse(raw);
      if (!frame || frame.version !== 1 || typeof frame.type !== "string") return;
      if (frame.type === "ws.open" && direction === "out" && typeof frame.path === "string" &&
          typeof frame.id === "string" && /^[A-Za-z0-9_-]{1,96}$/.test(frame.id) && probe.opens.length < 16) {
        const url = new URL(frame.path, "http://127.0.0.1");
        const server = url.searchParams.get("server"), workspace = url.searchParams.get("workspace"), channel = url.searchParams.get("channel");
        if (url.pathname !== "/rpc" || server !== "local" || channel !== "runtime") return;
        state.operations.set(frame.id, { server, workspace, channel, requestCount: 0, requests: new Map() });
        probe.opens.push({ connectionId: state.connectionId, socketId: frame.id, server, workspace, channel, openedAtMs: Date.now() });
        return;
      }
      if (!state.operations.has(frame.id)) return;
      const assemblyKey = `${direction}\u0000${frame.id}\u0000${frame.messageId}`;
      if (frame.type === "ws.message.start" && typeof frame.messageId === "string" && /^[A-Za-z0-9_-]{1,96}$/.test(frame.messageId) &&
          Number.isSafeInteger(frame.byteLength) && frame.byteLength >= 0 && frame.byteLength <= MAX_MESSAGE_BYTES &&
          state.assemblies.size < 8) {
        state.assemblies.set(assemblyKey, { operationId: frame.id, direction, binary: frame.binary,
          byteLength: frame.byteLength, total: 0, nextSeq: 0, chunks: [] });
      } else if (frame.type === "ws.message.chunk") {
        const assembly = state.assemblies.get(assemblyKey);
        if (!assembly || assembly.operationId !== frame.id || assembly.direction !== direction || frame.seq !== assembly.nextSeq ||
            typeof frame.data !== "string" || frame.data.length > 11_000) { state.assemblies.delete(assemblyKey); return; }
        const decoded = atob(frame.data), chunk = new Uint8Array(decoded.length);
        for (let index = 0; index < decoded.length; index++) chunk[index] = decoded.charCodeAt(index);
        if (decoded.length > 8192 || assembly.total + chunk.length > assembly.byteLength) { state.assemblies.delete(assemblyKey); return; }
        assembly.chunks.push(chunk); assembly.total += chunk.length; assembly.nextSeq += 1;
      } else if (frame.type === "ws.message.end") {
        const assembly = state.assemblies.get(assemblyKey);
        state.assemblies.delete(assemblyKey);
        if (assembly && assembly.operationId === frame.id && assembly.direction === direction) finishMessage(state, assembly);
      }
    } catch { /* Frame data and unrelated RPC contents are never logged. */ }
  }
  Peer.prototype.createDataChannel = function(label, options) {
    const channel = Reflect.apply(originalCreate, this, [label, options]);
    if (label === LABEL && probe.connections < 8) attach(channel);
    return channel;
  };
  DataChannel.prototype.send = function(data) {
    const result = Reflect.apply(originalSend, this, [data]);
    const state = channels.get(this);
    if (state) observe(state, "out", data);
    return result;
  };
}

function safeFailure(error, run) {
  const code = error?.code;
  return { code: typeof code === "number" || typeof code === "string" ? code : null,
    message: run.redactText(String(error?.message ?? "UI diagnostic failed")).slice(0, 1000) };
}

function urlHasToken(url) {
  const parsed = new URL(url);
  const has = params => [...params.keys()].some(name => /token|secret|auth/i.test(name));
  const fragment = parsed.hash.slice(1);
  return has(parsed.searchParams) || has(new URLSearchParams(fragment)) ||
    (fragment.includes("?") && has(new URLSearchParams(fragment.slice(fragment.indexOf("?") + 1))));
}

if (process.env.KCODER_E2E_TASK_OPEN_UI !== "1") {
  throw new Error("set KCODER_E2E_TASK_OPEN_UI=1 to enable this one-task live UI diagnostic");
}
process.umask(0o077);

await runE2E(import.meta.url, {
  testId: "mobile-task-open-ui-once", tier: "manual-live",
  modelPolicy: "Open only the authorized existing thread; no model, turn, stop, permission change, or manual cache cleanup; revoke exact browser-owned session",
}, async run => {
  const report = {
    target: { threadId: THREAD_ID, title: TITLE },
    pairing: { status: "not-started", grantCount: 0 },
    ui: { status: "not-started", composerVisible: false, errorText: null, screenshot: "not-taken" },
    threadResume: { status: "not-observed", websocketConnections: [], errors: [] },
    peerTransport: { connectionCount: 0, opens: [], resumes: [] },
    cleanup: { page: "not-created", browser: "not-created", sessionRevocation: "not-needed" },
  };
  const grants = [], grantReads = [], cleanupFailures = [];
  let browser = null, page = null, failure = null, sessionRequestSeen = false, errorHeading = null;
  const revokeGrant = grant => {
    if (!grant.revocation) grant.revocation = (async () => {
      try {
        const response = await fetch(GATEWAY + "/api/mobile/session", {
          method: "DELETE", headers: { authorization: "Bearer " + grant.accessToken }, signal: AbortSignal.timeout(5_000),
        });
        return response.status === 204 ? "revoked" : "rejected-http-" + response.status;
      } catch { return "unknown-no-retry"; }
    })();
    return grant.revocation;
  };
  try {
    if (process.env.KCODER_E2E_TASK_OPEN_GATEWAY !== GATEWAY) throw new Error("KCODER_E2E_TASK_OPEN_GATEWAY must be http://127.0.0.1:4189");
    if (resolve(process.cwd()) !== repoRoot) throw new Error("run this diagnostic from the repository root");
    const pairingUrl = await readPairingUrl(run);
    browser = await startChromium(run, { label: "mobile-task-open-ui", noSandbox: process.env.KCODER_E2E_CHROMIUM_NO_SANDBOX === "1" });
    page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.addInitScript(installPeerFrameObserver);
    run.addCleanup("settle this UI's device grant receipts", async () => {
      await Promise.allSettled(grantReads);
      if (sessionRequestSeen && grants.length === 0) throw new Error("UI device grant outcome is unknown; no retry attempted");
    });
    await page.emulateMedia({ colorScheme: "light" });
    page.on("request", request => {
      try { const url = new URL(request.url()); if (request.method() === "POST" && url.pathname.endsWith("/api/mobile/session")) sessionRequestSeen = true; } catch {}
    });
    page.on("response", response => {
      try {
        const url = new URL(response.url());
        if (response.request().method() !== "POST" || !url.pathname.endsWith("/api/mobile/session") ||
            ![pairingUrl.host, new URL(GATEWAY).host].includes(url.host)) return;
        grantReads.push(response.json().then(grant => {
          for (const name of ["accessToken", "rpcToken", "refreshToken"]) secret(run, grant?.[name]);
          if (typeof grant?.accessToken === "string" && grant.accessToken.length >= 8 &&
              !grants.some(item => item.accessToken === grant.accessToken)) {
            const owned = { accessToken: grant.accessToken };
            grants.push(owned);
            run.addCleanup("revoke this UI's device grant " + grants.length, async () => {
              if (await revokeGrant(owned) !== "revoked") throw new Error("UI device revocation was not confirmed; no retry attempted");
            });
          }
        }).catch(() => { report.pairing.status = "grant-response-unreadable"; }));
      } catch { report.pairing.status = "grant-response-unreadable"; }
    });
    let websocketSequence = 0;
    page.on("websocket", socket => {
      const connection = {
        connectionId: `websocket-${++websocketSequence}`, openedAtMs: Date.now(),
        requestCount: 0, requests: [],
      };
      report.threadResume.websocketConnections.push(connection);
      const pending = new Map();
      socket.on("framesent", event => {
        for (const frame of parseFrames(event.payload)) if (frame?.method === "thread/resume" &&
            frame.params?.threadId === THREAD_ID && frame.id !== undefined) {
          const record = {
            requestCount: ++connection.requestCount, requestedAtMs: Date.now(),
            status: "request-observed", respondedAtMs: null, error: null,
          };
          pending.set(String(frame.id), record);
          connection.requests.push(record);
          report.threadResume.status = "request-observed";
        }
      });
      socket.on("framereceived", event => {
        for (const frame of parseFrames(event.payload)) {
          const id = String(frame?.id);
          const record = pending.get(id);
          if (!record) continue;
          pending.delete(id);
          record.respondedAtMs = Date.now();
          if (frame.error && typeof frame.error === "object") {
            record.status = "error";
            record.error = {
              code: typeof frame.error.code === "number" || typeof frame.error.code === "string" ? frame.error.code : null,
              message: run.redactText(String(frame.error.message ?? "")).slice(0, 1000),
            };
            report.threadResume.errors.push({
              connectionId: connection.connectionId, requestCount: record.requestCount,
              code: record.error.code, message: record.error.message,
            });
            report.threadResume.status = "error";
          } else {
            record.status = "response-success";
            report.threadResume.status = "response-success";
          }
        }
      });
    });
    await page.goto(pairingUrl.toString(), { waitUntil: "commit", timeout: 30_000 });
    await page.getByTestId("toggle-server-local").waitFor({ state: "visible", timeout: 45_000 });
    const project = page.getByTestId("toggle-server-local");
    if (await project.getAttribute("aria-expanded") === "false") await project.click();
    const target = page.getByTestId(`thread-${THREAD_ID}`);
    await target.getByText(TITLE, { exact: true }).waitFor({ state: "visible", timeout: 45_000 });
    await target.click();
    const composer = page.getByTestId("message-input");
    errorHeading = page.getByText(/^(无法打开任务|Unable to open task)$/).first();
    report.ui.status = await waitFor(async () => {
      if (await composer.isVisible().catch(() => false)) return "opened";
      if (await errorHeading.isVisible().catch(() => false)) return "open-error";
      return false;
    }, 90_000, "target composer or task-open error page", 200, run.abortSignal);
    report.ui.composerVisible = report.ui.status === "opened";
    if (report.ui.status === "open-error") {
      report.ui.errorText = run.redactText(await errorHeading.locator("..").innerText()).slice(0, 1200);
    }
    await Promise.allSettled(grantReads);
    report.pairing.grantCount = grants.length;
    report.pairing.status = grants.length === 1 ? "one-owned-grant-captured" : "unexpected-owned-grant-count";
    if (report.ui.status === "opened") {
      if (urlHasToken(page.url())) report.ui.screenshot = "withheld-token-remains-in-url";
      else {
        await page.screenshot({ path: run.pathInArtifacts("mobile-task-LUyha-390x844.png"),
          mask: [page.getByTestId("message-list"), page.getByTestId("message-input")], maskColor: "#111111" });
        report.ui.screenshot = "written-message-list-and-input-masked";
      }
    }
  } catch (error) { failure = error; report.failure = safeFailure(error, run); }
  finally {
    if (page) {
      try {
        const evidence = await page.evaluate(() => window.__mobileTaskOpenPeerProbe?.snapshot?.() ?? null);
        if (evidence && typeof evidence === "object") {
          report.peerTransport.connectionCount = Number.isSafeInteger(evidence.connectionCount) ? evidence.connectionCount : 0;
          report.peerTransport.opens = Array.isArray(evidence.opens) ? evidence.opens.slice(0, 16).map(open => ({
            connectionId: String(open.connectionId ?? ""), socketId: String(open.socketId ?? ""),
            server: String(open.server ?? ""), workspace: run.redactText(String(open.workspace ?? "")).slice(0, 500),
            channel: String(open.channel ?? ""), openedAtMs: Number(open.openedAtMs) || null,
          })) : [];
          report.peerTransport.resumes = Array.isArray(evidence.resumes) ? evidence.resumes.slice(0, 32).map(resume => ({
            connectionId: String(resume.connectionId ?? ""), socketId: String(resume.socketId ?? ""),
            requestCount: Number(resume.requestCount) || 0, method: "thread/resume", threadId: THREAD_ID,
            requestedAtMs: Number(resume.requestedAtMs) || null, status: String(resume.status ?? ""),
            respondedAtMs: Number(resume.respondedAtMs) || null,
            error: resume.error && typeof resume.error === "object" ? {
              code: typeof resume.error.code === "number" || typeof resume.error.code === "string" ? resume.error.code : null,
              message: run.redactText(String(resume.error.message ?? "")).slice(0, 1000),
            } : null,
          })) : [];
        }
      } catch { report.peerTransport.snapshot = "unavailable"; }
      let failurePage = report.ui.status === "open-error";
      if (!failurePage && errorHeading) failurePage = await errorHeading.isVisible().catch(() => false);
      if (failurePage) {
        if (urlHasToken(page.url())) report.ui.screenshot = "failure-withheld-token-remains-in-url";
        else {
          try {
            await page.screenshot({ path: run.pathInArtifacts("mobile-task-LUyha-open-error-390x844.png"),
              mask: [page.getByTestId("message-list"), page.getByTestId("message-input")], maskColor: "#111111" });
            report.ui.screenshot = "written-failure-page-message-list-masked";
          } catch { report.ui.screenshot = "failure-screenshot-unavailable"; }
        }
      }
      try { await page.close(); report.cleanup.page = "closed"; }
      catch { report.cleanup.page = "close-failed"; cleanupFailures.push("page-close"); }
    }
    if (browser) {
      try { await browser.close(); report.cleanup.browser = "closed"; }
      catch { report.cleanup.browser = "close-failed"; cleanupFailures.push("browser-close"); }
    }
    await Promise.allSettled(grantReads);
    if (sessionRequestSeen && grants.length === 0) {
      report.cleanup.sessionRevocation = "unknown-no-owned-access-token-no-retry";
      cleanupFailures.push("session-grant-unknown");
    } else if (grants.length) {
      const outcomes = [];
      for (const grant of grants) {
        outcomes.push(await revokeGrant(grant));
      }
      report.cleanup.sessionRevocation = outcomes.every(value => value === "revoked") ? "revoked" : outcomes.join(",");
      if (outcomes.some(value => value !== "revoked")) cleanupFailures.push("session-revocation");
    }
  }
  await run.writeArtifactJson("mobile-task-open-ui-report.json", report);
  console.log(JSON.stringify(run.redactValue(report)));
  if (cleanupFailures.length) throw new Error("owned UI cleanup was not confirmed; no retry attempted: " + cleanupFailures.join(","));
  if (failure) throw new Error(run.redactText(String(failure?.message ?? "UI diagnostic failed")));
  if (report.ui.status !== "opened") throw new Error("target task did not reach a visible composer");
  if (report.pairing.grantCount !== 1) throw new Error("expected exactly one owned browser session grant");
  return report;
});
