import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { repoRoot, runE2E } from "../harness/run-context.mjs";

const GATEWAY = process.env.KCODER_E2E_TASK_OPEN_GATEWAY || "http://127.0.0.1:4189";
if (!["http://127.0.0.1:4186", "http://127.0.0.1:4189"].includes(GATEWAY)) {
  throw new Error("task-open diagnostic requires an authorized current loopback Gateway");
}
const TARGET_TITLE = process.env.KCODER_E2E_TASK_OPEN_TARGET_TITLE?.trim() || "测试下你的shell工具";
const requireRelay = createRequire(resolve(repoRoot, "apps/kcoder-relay/package.json"));
const WebSocket = requireRelay("ws");

class RpcError extends Error {
  constructor(code, message) {
    super(typeof message === "string" ? message : "JSON-RPC request failed");
    this.code = code ?? null;
  }
}

function inside(root, path) {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel));
}

function registerSecret(run, value) {
  if (typeof value !== "string" || value.length < 8) return false;
  for (const secret of new Set([
    value,
    encodeURIComponent(value),
    new URLSearchParams([["token", value]]).toString().slice("token=".length),
  ])) {
    if (secret.length >= 8) run.registerSecret(secret);
  }
  return true;
}

function safeError(error, run) {
  const code = error?.code;
  return {
    code: typeof code === "number" || typeof code === "string" ? code : null,
    message: run.redactText(String(error?.message ?? "diagnostic request failed")).slice(0, 800),
  };
}

function normalizeTitle(value) {
  return typeof value === "string" ? value.normalize("NFKC").replace(/\s+/gu, "") : "";
}

async function readPairingToken(run) {
  const configured = process.env.KCODER_E2E_TASK_OPEN_PAIRING_FILE;
  if (!configured || !isAbsolute(configured)) throw new Error("pairing file must be an absolute private path");
  let path;
  let info;
  try {
    path = await realpath(configured);
    info = await lstat(configured);
  } catch {
    throw new Error("pairing file is unavailable");
  }
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    typeof process.getuid !== "function" ||
    info.uid !== process.getuid() ||
    info.nlink !== 1 ||
    info.size > 16 * 1024 ||
    (info.mode & 0o077) !== 0 ||
    inside(repoRoot, path) ||
    /^\.env(?:$|\.)/i.test(basename(path))
  ) {
    throw new Error("pairing file must be a private regular file outside the repository");
  }
  let content;
  try {
    content = await readFile(path, "utf8");
  } catch {
    throw new Error("pairing file could not be read");
  }
  let pairingUrl;
  try {
    pairingUrl = new URL(content.trim());
  } catch {
    throw new Error("pairing file does not contain a valid mobile URL");
  }
  const token = new URLSearchParams(pairingUrl.hash.replace(/^#/, "")).get("token");
  if (!registerSecret(run, token)) throw new Error("mobile URL fragment has no valid pairing token");
  return token;
}

function makeRpc(socket) {
  let nextId = 1;
  const pending = new Map();
  const failAll = () => {
    for (const [id, request] of pending) {
      clearTimeout(request.timer);
      pending.delete(id);
      request.reject(new Error("RPC WebSocket closed"));
    }
  };
  socket.on("close", failAll);
  socket.on("error", failAll);
  socket.on("message", data => {
    let frames;
    try {
      const parsed = JSON.parse(data.toString());
      frames = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      return;
    }
    for (const frame of frames) {
      if (!frame || frame.id === undefined) continue;
      const request = pending.get(String(frame.id));
      if (!request) continue;
      pending.delete(String(frame.id));
      clearTimeout(request.timer);
      if (Object.hasOwn(frame, "error")) {
        request.reject(new RpcError(frame.error?.code, frame.error?.message));
      } else {
        request.resolve(frame.result);
      }
    }
  });
  return {
    request(method, params) {
      const id = nextId++;
      return new Promise((resolveRequest, rejectRequest) => {
        const key = String(id);
        const timer = setTimeout(() => {
          pending.delete(key);
          rejectRequest(new Error("RPC timeout: " + method));
        }, 12_000);
        pending.set(key, { resolve: resolveRequest, reject: rejectRequest, timer });
        socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }), error => {
          if (!error) return;
          const request = pending.get(key);
          if (!request) return;
          pending.delete(key);
          clearTimeout(request.timer);
          rejectRequest(new Error("RPC send failed: " + method));
        });
      });
    },
    notify(method, params = {}) {
      return new Promise((resolveNotification, rejectNotification) => {
        socket.send(JSON.stringify({ jsonrpc: "2.0", method, params }), error => {
          if (error) rejectNotification(new Error("RPC notification failed: " + method));
          else resolveNotification();
        });
      });
    },
  };
}

function waitForOpen(socket) {
  return new Promise((resolveOpen, rejectOpen) => {
    const finish = error => {
      clearTimeout(timer);
      socket.off("open", onOpen);
      socket.off("error", onError);
      socket.off("close", onClose);
      if (error) rejectOpen(error);
      else resolveOpen();
    };
    const onOpen = () => finish();
    const onError = () => finish(new Error("RPC WebSocket connection failed"));
    const onClose = () => finish(new Error("RPC WebSocket closed before opening"));
    const timer = setTimeout(() => finish(new Error("RPC WebSocket open timed out")), 12_000);
    socket.once("open", onOpen);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

function closeSocket(socket) {
  if (!socket || socket.readyState === WebSocket.CLOSED) return Promise.resolve("already-closed");
  return new Promise(resolveClose => {
    let settled = false;
    const finish = status => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off("close", onClose);
      resolveClose(status);
    };
    const onClose = () => finish("closed");
    const timer = setTimeout(() => {
      try { socket.terminate(); } catch {}
      finish("terminated-after-timeout");
    }, 2_000);
    socket.once("close", onClose);
    if (socket.readyState === WebSocket.OPEN) socket.close(1000, "diagnostic complete");
    else {
      try { socket.terminate(); } catch {}
    }
  });
}

await runE2E(import.meta.url, {
  testId: "mobile-task-open-diagnostic-once",
  tier: "manual-live",
  modelPolicy: "authorized target resume only when enabled; no model, turn, interrupt, or delete; exact session cleanup",
  targetOwner: "caller-authorized loopback Gateway at " + GATEWAY,
}, async run => {
  const report = {
    status: "starting",
    observedAt: new Date().toISOString(),
    interpretation: "visibility and presence are a diagnostic snapshot, not proof that the original cause is resolved",
    search: { status: "not-started", pages: 0, matchCount: 0, threadIdFilter: null },
    target: null,
    pairing: { status: "not-started", httpStatus: null },
    cleanup: { websocket: "not-created", sessionRevocation: "not-created" },
  };
  let socket = null;
  let accessToken = null;
  let revokePromise = null;
  let closePromise = null;
  const revokeSession = () => {
    if (revokePromise) return revokePromise;
    revokePromise = (async () => {
      if (!accessToken) return "no-access-token-received";
      try {
        const response = await fetch(GATEWAY + "/api/mobile/session", {
          method: "DELETE",
          headers: { authorization: "Bearer " + accessToken },
          signal: AbortSignal.timeout(5_000),
        });
        return response.status === 204 ? "revoked" : "rejected-http-" + response.status;
      } catch {
        return "unknown-no-retry";
      }
    })();
    return revokePromise;
  };
  const closeOwnedSocket = () => {
    if (!socket) return Promise.resolve("not-created");
    if (!closePromise) closePromise = closeSocket(socket);
    return closePromise;
  };

  try {
    if (process.env.KCODER_E2E_TASK_OPEN_DIAGNOSE !== "1") {
      throw new Error("set KCODER_E2E_TASK_OPEN_DIAGNOSE=1 to enable this live diagnostic");
    }
    if (process.env.KCODER_E2E_TASK_OPEN_GATEWAY !== GATEWAY) {
      throw new Error("KCODER_E2E_TASK_OPEN_GATEWAY must identify the authorized Gateway");
    }
    if (resolve(process.cwd()) !== repoRoot) throw new Error("run this diagnostic from the repository root");

    const requestedThreadId = process.env.KCODER_E2E_TASK_OPEN_TARGET_THREAD_ID?.trim() || null;
    if (requestedThreadId && !/^[A-Za-z0-9_-]{1,200}$/.test(requestedThreadId)) {
      throw new Error("target thread id has an invalid format");
    }
    report.search.threadIdFilter = requestedThreadId;
    const pairingToken = await readPairingToken(run);
    const pairResponse = await fetch(GATEWAY + "/api/mobile/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: pairingToken,
        durableDeviceAuthorization: true,
        deviceLabel: "KCoder task-open diagnostic " + randomUUID(),
      }),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null);
    if (!pairResponse) {
      report.pairing = { status: "unknown-no-retry", httpStatus: null };
      throw new Error("session exchange outcome is unknown; it was not retried");
    }
    report.pairing.httpStatus = pairResponse.status;
    let grant = null;
    try { grant = await pairResponse.json(); } catch {}
    for (const name of ["accessToken", "rpcToken", "refreshToken"]) {
      if (typeof grant?.[name] === "string") registerSecret(run, grant[name]);
    }
    accessToken = typeof grant?.accessToken === "string" ? grant.accessToken : null;
    if (accessToken && accessToken.length >= 8) {
      run.addCleanup("revoke this diagnostic mobile session", async () => {
        if (await revokeSession() !== "revoked") {
          throw new Error("owned diagnostic session revocation was not confirmed; no retry attempted");
        }
      });
    }
    if (!pairResponse.ok || !accessToken || accessToken.length < 8 || typeof grant?.rpcToken !== "string") {
      report.pairing.status = pairResponse.ok ? "invalid-session-grant" : "rejected";
      throw new Error("session exchange did not provide a usable diagnostic session");
    }
    report.pairing.status = "granted";

    const rpcUrl = new URL("/rpc", GATEWAY.replace(/^http:/, "ws:"));
    rpcUrl.searchParams.set("token", grant.rpcToken);
    rpcUrl.searchParams.set("server", "local");
    rpcUrl.searchParams.set("workspace", repoRoot);
    rpcUrl.searchParams.set("channel", "runtime");
    socket = new WebSocket(rpcUrl, {
      headers: { Authorization: "Bearer " + accessToken, Origin: GATEWAY },
      handshakeTimeout: 12_000,
      perMessageDeflate: false,
    });
    run.addCleanup("close this diagnostic RPC WebSocket", async () => {
      if (!["closed", "already-closed"].includes(await closeOwnedSocket())) {
        throw new Error("owned diagnostic WebSocket close was not confirmed");
      }
    });
    const rpc = makeRpc(socket);
    await waitForOpen(socket);
    const initialized = await rpc.request("initialize", {
      protocolVersion: "2026-07-27",
      clientInfo: { name: "mobile-task-open-diagnose", version: "1" },
      capabilities: { experimental: {
        threadRunSummaryV1: true,
        threadResumeHistoryPageV1: true,
        threadPresenceReadV1: true,
      } },
    });
    await rpc.notify("initialized");
    const experimental = initialized?.capabilities?.experimental ?? {};

    report.search.status = "listing";
    const matches = new Map();
    const seenCursors = new Set();
    let cursor;
    let complete = false;
    for (let page = 0; page < 5; page += 1) {
      const params = { limit: 100, ...(cursor ? { cursor } : {}) };
      const result = await rpc.request("thread/list", params);
      report.search.pages += 1;
      for (const thread of Array.isArray(result?.threads) ? result.threads : []) {
        const idMatches = requestedThreadId ? thread?.id === requestedThreadId : false;
        const titleMatches = !requestedThreadId && normalizeTitle(thread?.title) === normalizeTitle(TARGET_TITLE);
        if (!idMatches && !titleMatches) continue;
        if (typeof thread?.id === "string") {
          matches.set(thread.id, {
            id: thread.id,
            title: typeof thread.title === "string" ? thread.title : TARGET_TITLE,
            status: typeof thread.status === "string" ? thread.status : "unknown",
            runSummary: thread.runSummary ?? null,
          });
        }
      }
      const next = result?.nextCursor;
      if (typeof next !== "string" || next.length === 0) {
        complete = true;
        break;
      }
      if (seenCursors.has(next)) break;
      seenCursors.add(next);
      cursor = next;
    }
    report.search.matchCount = matches.size;
    report.search.status = complete ? "complete" : "page-limit-or-cursor-loop";
    if (!complete || matches.size !== 1) {
      report.status = matches.size > 1 ? "ambiguous-target" : complete ? "target-not-visible" : "search-incomplete";
    } else {
      const match = [...matches.values()][0];
      const titleMatchesExpected = normalizeTitle(match.title) === normalizeTitle(TARGET_TITLE);
      report.target = {
        serverId: "local",
        threadId: match.id,
        title: run.redactText(match.title).slice(0, 240),
        idVerifiedFromList: requestedThreadId ? match.id === requestedThreadId : null,
        titleVerifiedFromList: titleMatchesExpected,
        status: match.status,
        runSummary: match.runSummary,
        presence: { status: "not-run" },
        resume: { status: "not-enabled" },
      };
      if (!titleMatchesExpected) {
        report.target.presence = { status: "skipped-title-mismatch" };
        report.target.resume = { status: "skipped-title-mismatch" };
        report.status = "target-id-title-mismatch";
      } else if (experimental.threadPresenceReadV1 === true) {
        try {
          const presence = await rpc.request("thread/presence/read", { threadId: match.id });
          report.target.presence = {
            status: typeof presence?.status === "string" ? presence.status : "invalid-response",
            reason: typeof presence?.reason === "string" ? presence.reason : null,
          };
        } catch (error) {
          report.target.presence = { status: "error", ...safeError(error, run) };
        }
        if (process.env.KCODER_E2E_TASK_OPEN_TRY_RESUME === "1") {
          if (experimental.threadResumeHistoryPageV1 !== true) {
            report.target.resume = { status: "skipped-history-capability-unavailable" };
          } else {
            try {
              const resumed = await rpc.request("thread/resume", {
                threadId: match.id,
                history: { limit: 1 },
              });
              report.target.status = typeof resumed?.thread?.status === "string" ? resumed.thread.status : match.status;
              report.target.resume = { status: "succeeded", threadId: match.id, threadStatus: report.target.status };
            } catch (error) {
              report.target.resume = { status: "error", ...safeError(error, run) };
            }
          }
        } else {
          report.target.resume = { status: "not-enabled" };
        }
        report.status = "diagnostic-complete";
      } else {
        report.target.presence = { status: "skipped-capability-unavailable" };
        report.target.resume = { status: process.env.KCODER_E2E_TASK_OPEN_TRY_RESUME === "1"
          ? "skipped-presence-capability-unavailable"
          : "not-enabled" };
        report.status = "diagnostic-complete";
      }
    }
  } catch (error) {
    report.status = "diagnostic-error";
    report.error = safeError(error, run);
  } finally {
    report.cleanup.websocket = await closeOwnedSocket();
    report.cleanup.sessionRevocation = await revokeSession();
  }

  await run.writeArtifactJson("mobile-task-open-diagnose.json", report);
  console.log(JSON.stringify(run.redactValue(report)));
  if (
    (socket && !["closed", "already-closed"].includes(report.cleanup.websocket)) ||
    (accessToken && report.cleanup.sessionRevocation !== "revoked")
  ) {
    throw new Error("diagnostic cleanup was not confirmed; no retry attempted");
  }
  if (report.status !== "diagnostic-complete") {
    throw new Error("task-open diagnostic did not complete; inspect the redacted report before any retry");
  }
  return report;
});
