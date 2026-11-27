import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { isAbsolute, resolve } from "node:path";

const CONTROL_PATH = "/__kcoder_e2e_lab";

export async function startLabControl(context, { getStatus }) {
  if (typeof getStatus !== "function") throw new Error("lab control requires a status provider");
  const token = randomBytes(32).toString("base64url");
  context.registerSecret(token);
  let requestStop;
  const stopRequested = new Promise(resolve => { requestStop = resolve; });
  const server = createServer(async (request, response) => {
    if (!authorized(request, token)) {
      sendJson(response, 401, { error: "unauthorized" });
      return;
    }
    if (request.method === "GET" && request.url === `${CONTROL_PATH}/status`) {
      try {
        sendJson(response, 200, await getStatus());
      } catch {
        sendJson(response, 500, { error: "status_unavailable" });
      }
      return;
    }
    if (request.method === "POST" && request.url === `${CONTROL_PATH}/stop`) {
      sendJson(response, 202, { accepted: true });
      setImmediate(() => requestStop({ reason: "requested" }));
      return;
    }
    sendJson(response, 404, { error: "not_found" });
  });
  server.headersTimeout = 5_000;
  server.requestTimeout = 5_000;
  server.keepAliveTimeout = 1_000;

  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("lab control did not bind a TCP port");
    context.registerPort("lab-control", address.port);
    context.addCleanup("close lab control server", () => closeServer(server));
    const controlFile = await context.writeStateJson("lab-control.json", {
      schemaVersion: 1,
      host: "127.0.0.1",
      port: address.port,
      token,
    });
    return {
      baseUrl: `http://127.0.0.1:${address.port}${CONTROL_PATH}`,
      token,
      controlFile,
      stopRequested,
      close: () => closeServer(server),
    };
  } catch (error) {
    await closeServer(server).catch(() => {});
    throw error;
  }
}

export async function waitForLabStop(stopRequested, { timeoutMs, signal, ownerProcess } = {}) {
  if (!stopRequested || typeof stopRequested.then !== "function") {
    throw new Error("lab stop signal must be a Promise");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("lab timeout must be a positive integer");
  if (signal?.aborted) throw signal.reason || new Error("lab interrupted");

  let timeout;
  let abort;
  let ownerExit;
  let ownerExitListener;
  const stopped = new Promise((resolve, reject) => {
    abort = () => reject(signal.reason || new Error("lab interrupted"));
    signal?.addEventListener("abort", abort, { once: true });
    timeout = setTimeout(() => reject(new Error(`lab timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  if (ownerProcess) {
    ownerExit = new Promise((_, reject) => {
      ownerExitListener = (code, processSignal) => reject(new Error(`owned Gateway exited unexpectedly (code=${code}, signal=${processSignal})`));
      if (ownerProcess.exitCode !== null || ownerProcess.signalCode !== null) {
        ownerExitListener(ownerProcess.exitCode, ownerProcess.signalCode);
      } else {
        ownerProcess.once("exit", ownerExitListener);
      }
    });
  }
  try {
    return await Promise.race(ownerExit ? [stopRequested, stopped, ownerExit] : [stopRequested, stopped]);
  } finally {
    clearTimeout(timeout);
    if (abort) signal?.removeEventListener("abort", abort);
    if (ownerExitListener) ownerProcess.removeListener("exit", ownerExitListener);
  }
}

export function validLabRunManifest(manifest, runId, { activeOnly = true } = {}) {
  const validProcesses = Array.isArray(manifest?.processes) && manifest.processes.every(process =>
    process && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(process.label || "")
      && typeof process.command === "string"
      && (process.pid === null || Number.isSafeInteger(process.pid) && process.pid > 0)
      && (process.pgid === null || Number.isSafeInteger(process.pgid) && process.pgid > 0)
      && typeof process.stopped === "boolean");
  const validPorts = Array.isArray(manifest?.ports) && manifest.ports.every(port =>
    port && typeof port.label === "string" && Number.isInteger(port.port) && port.port >= 1 && port.port <= 65_535);
  const validTemporaryDirectories = Array.isArray(manifest?.temporaryDirectories)
    && manifest.temporaryDirectories.every(isSafeRunRelativePath);
  const validWorkspaceFixtures = Array.isArray(manifest?.workspaceFixtures) && manifest.workspaceFixtures.every(fixture =>
    fixture && typeof fixture.id === "string" && isSafeRunRelativePath(fixture.path));
  return manifest?.schemaVersion === 1
    && manifest.source === "apps/kcoder-studio/e2e/lab.mjs"
    && manifest.testId === "interactive-studio-lab"
    && (activeOnly ? manifest.status === "running" : ["running", "passed", "failed"].includes(manifest.status))
    && validProcesses
    && validPorts
    && validTemporaryDirectories
    && validWorkspaceFixtures
    && manifest.seed
    && /^\d{8}-\d{6}\.\d{3}Z(?:-p\d+-\d+-[a-f0-9]{4})?$/.test(runId || "");
}

export function unavailableLabStatus({ runId, runRoot, manifest, session }) {
  return {
    runId,
    phase: "control-unavailable",
    ownerPid: session?.ownerPid ?? null,
    cleanup: "retained-unconfirmed",
    message: "The lab control listener is unavailable. Recorded processes and files remain untouched because this client cannot reattach their original process identities.",
    resources: {
      runRoot,
      stateDirectory: resolve(runRoot, "state"),
      temporaryDirectories: manifest.temporaryDirectories,
      workspaceFixtures: manifest.workspaceFixtures.map(({ id, path }) => ({ id, path })),
      workspace: session?.workspace ?? null,
      home: session?.home ?? null,
      configDirectory: session?.gatewayConfig ?? null,
      targetProfile: session?.targetProfile ?? null,
    },
    processes: manifest.processes.map(({ label, pid, pgid, command, stopped }) => ({ label, pid, pgid, command, stopped })),
    ports: manifest.ports.map(({ label, port }) => ({ label, port })),
  };
}

function isSafeRunRelativePath(path) {
  return typeof path === "string" && path.length > 0 && !isAbsolute(path) &&
    !path.split(/[\\/]/).some(segment => segment === ".." || segment === "");
}

function authorized(request, token) {
  const authorization = request.headers.authorization || "";
  const supplied = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  const expectedBytes = Buffer.from(token);
  const suppliedBytes = Buffer.from(supplied);
  return suppliedBytes.length === expectedBytes.length && timingSafeEqual(suppliedBytes, expectedBytes);
}

function sendJson(response, statusCode, value) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(`${JSON.stringify(value)}\n`);
}

function closeServer(server) {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeIdleConnections?.();
  });
}
