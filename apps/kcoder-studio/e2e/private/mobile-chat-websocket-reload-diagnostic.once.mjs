import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { startChromium } from "../harness/chromium.mjs";
import { startGateway } from "../harness/gateway.mjs";
import {
  findOwnedExecutableProcesses,
  hashExecutableFile,
} from "../harness/owned-executable-provenance.mjs";
import { repoRoot, runE2E, waitFor } from "../harness/run-context.mjs";

const configuredBinary = resolve(
  process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, "target/release/kcoder"),
);
const reusedWebRoot = resolve(
  repoRoot,
  "target/test/mobile-chat-ui-20261010/gateway-web-export",
);
const initialPrompt = "MOBILE_STRUCTURED_TRANSCRIPT_KCoder";
const followupPrompt = "MOBILE_PERMISSION_ASK_SECOND_TURN";
const browserSocketDiagnosticPrefix = "__KC_E2E_WS_DIAG__";

await runE2E(
  import.meta.url,
  {
    testId: "mobile-chat-websocket-reload-diagnostic",
    tier: "full-integration",
    modelPolicy:
      "diagnostic-only reload lifecycle using the deterministic local mixed-tools scenario; no Provider or model request",
    retainSuccessLogs: true,
  },
  async (context) => {
    const sourceExportManifest = JSON.parse(
      await readFile(resolve(reusedWebRoot, "kcoder-mobile-web.json"), "utf8"),
    );
    assert.equal(sourceExportManifest.version, 1);
    const sourceExportManifestBytes = await readFile(
      resolve(reusedWebRoot, "kcoder-mobile-web.json"),
    );

    const configuredBinaryBefore = await hashExecutableFile(configuredBinary);
    const ownedBinDir = context.pathInState("bin");
    await mkdir(ownedBinDir, { recursive: true, mode: 0o700 });
    const ownedBinary = resolve(ownedBinDir, "kcoder");
    await copyFile(configuredBinary, ownedBinary);
    await chmod(ownedBinary, 0o700);
    const [configuredBinaryAfterCopy, ownedBinaryBefore] = await Promise.all([
      hashExecutableFile(configuredBinary),
      hashExecutableFile(ownedBinary),
    ]);
    assert.equal(configuredBinaryAfterCopy.sha256, configuredBinaryBefore.sha256);
    assert.equal(ownedBinaryBefore.sha256, configuredBinaryBefore.sha256);

    const workspace = context.pathInState("workspace");
    const configDir = context.pathInState("config");
    await mkdir(resolve(workspace, "src"), { recursive: true, mode: 0o700 });
    await mkdir(configDir, { recursive: true, mode: 0o700 });
    await writeFile(resolve(workspace, "src/sample.txt"), "sample workspace file\n", "utf8");
    await context.writeStateJson("config/settings.json", {});
    const serversFile = await context.writeStateJson("servers.json", [
      {
        id: "local",
        label: "Owned WebSocket reload diagnostic",
        runtime: "kcoder",
        transport: "local",
        command: ownedBinary,
        workspace,
      },
    ]);
    const gateway = await startGateway(context, {
      label: "mobile-chat-websocket-reload-diagnostic-gateway",
      workspace,
      serversFile,
      kcoderBin: ownedBinary,
      env: {
        KCODER_CONFIG_DIR: configDir,
        KCODER_STUDIO_WEB_ROOT: reusedWebRoot,
        KCODER_STUDIO_MOBILE_WEB_ROOT: reusedWebRoot,
        KCODER_STUDIO_SCENARIO: "mixed-tools",
      },
    });
    const chromium = await startChromium(context, {
      label: "mobile-chat-websocket-reload-diagnostic-chromium",
    });
    const page = await chromium.newPage();
    const cdp = await page.context().newCDPSession(page);
    context.addCleanup("detach diagnostic Chromium CDP session", () => cdp.detach());
    await Promise.all([
      cdp.send("Network.enable"),
      cdp.send("Page.enable"),
      cdp.send("Runtime.enable"),
      cdp.send("Log.enable"),
    ]);

    const events = [];
    const sockets = new Map();
    const rpcRequests = [];
    const pendingRpc = new Map();
    let phase = "initial-load";
    let reloadStartedAtMs = null;
    let reloadResolvedAtMs = null;
    let diagnosticEvidencePersisted = false;
    const record = (kind, data = {}) => {
      events.push({
        observedAt: new Date().toISOString(),
        observedPhase: phase,
        kind,
        ...data,
      });
    };
    context.addCleanup("persist partial WebSocket diagnostic events", async () => {
      if (diagnosticEvidencePersisted) return;
      await context.writeArtifactJson("websocket-reload-diagnostic-partial.json", {
        kind: "partial diagnostic evidence; run did not reach successful result artifact",
        sourceBinding: "UNVERIFIED",
        phaseAtCleanup: phase,
        reloadStartedAt: reloadStartedAtMs === null
          ? null
          : new Date(reloadStartedAtMs).toISOString(),
        reloadResolvedAt: reloadResolvedAtMs === null
          ? null
          : new Date(reloadResolvedAtMs).toISOString(),
        websocketSockets: [...sockets.values()],
        rpcRequests,
        events,
      });
    });

    cdp.on("Network.webSocketCreated", ({ requestId, url }) => {
      const socket = {
        requestId,
        scope: safeWebSocketScope(url),
        cdpCreatedEventObservedAtMs: Date.now(),
        cdpCreatedEventObservedPhase: phase,
      };
      sockets.set(requestId, socket);
      record("cdp-websocket-created", socket);
    });
    cdp.on("Network.requestWillBeSent", (event) => {
      if (!/^wss?:\/\//.test(event.request.url)) return;
      const socket = sockets.get(event.requestId);
      const safeEvent = {
        requestId: event.requestId,
        scope: safeWebSocketScope(event.request.url),
        loaderId: event.loaderId ?? null,
        resourceType: event.type ?? null,
        monotonicSeconds: event.timestamp ?? null,
        wallTimeSeconds: event.wallTime ?? null,
        initiatorType: event.initiator?.type ?? null,
        observedPhase: phase,
      };
      if (socket) socket.requestWillBeSent = safeEvent;
      record("cdp-websocket-request-will-be-sent", safeEvent);
    });
    cdp.on("Network.webSocketWillSendHandshakeRequest", ({ requestId, timestamp, wallTime }) => {
      const socket = sockets.get(requestId);
      if (socket) {
        socket.handshakeEventObservedAtMs = Date.now();
        socket.handshakeEventObservedPhase = phase;
        socket.handshakeWallTimeMs = wallTime * 1000;
        socket.wallClockOffsetMs = wallTime * 1000 - timestamp * 1000;
      }
      record("cdp-websocket-handshake-request", {
        requestId,
        monotonicSeconds: timestamp,
        wallTimeSeconds: wallTime,
      });
    });
    cdp.on("Network.webSocketHandshakeResponseReceived", ({ requestId, timestamp, response }) => {
      const socket = sockets.get(requestId);
      if (socket) {
        socket.handshakeResponseEventObservedAtMs = Date.now();
        socket.handshakeResponseWallTimeMs =
          socket.wallClockOffsetMs === undefined
            ? null
            : timestamp * 1000 + socket.wallClockOffsetMs;
        socket.handshakeStatus = response.status;
      }
      record("cdp-websocket-handshake-response", {
        requestId,
        monotonicSeconds: timestamp,
        status: response.status,
      });
    });
    cdp.on("Network.webSocketClosed", ({ requestId, timestamp }) => {
      const socket = sockets.get(requestId);
      if (socket) {
        socket.closedEventObservedAtMs = Date.now();
        socket.closedWallTimeMs =
          socket.wallClockOffsetMs === undefined
            ? null
            : timestamp * 1000 + socket.wallClockOffsetMs;
      }
      record("cdp-websocket-closed", {
        requestId,
        monotonicSeconds: timestamp,
        wallTimeMs: socket?.closedWallTimeMs ?? null,
      });
    });
    cdp.on("Network.webSocketFrameError", ({ requestId, timestamp, errorMessage }) => {
      record("cdp-websocket-frame-error", {
        requestId,
        monotonicSeconds: timestamp,
        errorMessage: context.redactText(errorMessage),
      });
    });
    cdp.on("Network.loadingFailed", ({ requestId, timestamp, errorText, canceled }) => {
      if (!sockets.has(requestId)) return;
      const socket = sockets.get(requestId);
      if (socket) socket.loadingFailedEventObservedAtMs = Date.now();
      record("cdp-websocket-loading-failed", {
        requestId,
        monotonicSeconds: timestamp,
        errorText,
        canceled: Boolean(canceled),
      });
    });
    cdp.on("Page.frameStartedLoading", ({ frameId }) => {
      record("cdp-frame-started-loading", { frameId });
    });
    cdp.on("Page.frameStoppedLoading", ({ frameId }) => {
      record("cdp-frame-stopped-loading", { frameId });
    });
    cdp.on("Page.frameNavigated", ({ frame }) => {
      if (!frame.parentId) {
        record("cdp-main-frame-navigated", {
          frameId: frame.id,
          loaderId: frame.loaderId,
          url: safeNavigationUrl(frame.url),
        });
      }
    });
    cdp.on("Network.webSocketFrameSent", ({ requestId, timestamp, response }) => {
      captureRpcFrame("sent", requestId, timestamp, response?.payloadData);
    });
    cdp.on("Network.webSocketFrameReceived", ({ requestId, timestamp, response }) => {
      captureRpcFrame("received", requestId, timestamp, response?.payloadData);
    });
    cdp.on("Log.entryAdded", ({ entry }) => {
      if (!["warning", "error"].includes(entry.level)) return;
      record("cdp-log-diagnostic", {
        level: entry.level,
        source: entry.source,
        timestampEpochSeconds: entry.timestamp ?? null,
        timestampEpochMs: Number.isFinite(entry.timestamp) ? entry.timestamp * 1000 : null,
        text: sanitizeConsoleText(entry.text),
        url: entry.url ? safeNavigationUrl(entry.url) : null,
        lineNumber: entry.lineNumber ?? null,
      });
    });

    function captureRpcFrame(direction, requestId, monotonicSeconds, payload) {
      const messages = parseJsonMessages(payload);
      const socket = sockets.get(requestId);
      const wallTimeMs = socket?.wallClockOffsetMs === undefined
        ? Date.now()
        : monotonicSeconds * 1000 + socket.wallClockOffsetMs;
      for (const message of messages) {
        if (!message || typeof message !== "object") continue;
        if (
        direction === "sent" &&
        message.id !== undefined &&
          ["initialize", "thread/list", "turn/start"].includes(message.method)
        ) {
          const request = {
            requestId,
            rpcId: String(message.id),
            method: message.method,
            phase,
            sentAt: wallTimeMs,
            monotonicSeconds,
            permissionModePresent:
              message.method === "turn/start" &&
              Object.hasOwn(message.params ?? {}, "permissionMode"),
            permissionMode:
              message.method === "turn/start" &&
              Object.hasOwn(message.params ?? {}, "permissionMode")
                ? message.params.permissionMode
                : null,
            response: null,
          };
          rpcRequests.push(request);
          pendingRpc.set(`${requestId}:${request.rpcId}`, request);
          record("appserver-rpc-request", {
            requestId,
            rpcId: request.rpcId,
            method: request.method,
            permissionModePresent: request.permissionModePresent,
            permissionMode: request.permissionMode,
          });
        } else if (
          direction === "received" &&
          message.method &&
          ["item/started", "item/completed"].includes(message.method)
        ) {
          const params = message.params && typeof message.params === "object"
            ? message.params
            : {};
          const item = params.item && typeof params.item === "object"
            ? params.item
            : {};
          if (item.type === "agentMessage") {
            record("appserver-agent-message-event", {
              requestId,
              method: message.method,
              agentMessageId: item.id ?? null,
              turnId: params.turnId ?? item.turnId ?? null,
            });
          }
        } else if (
          direction === "received" &&
          message.id !== undefined &&
          !message.method
        ) {
          const request = pendingRpc.get(`${requestId}:${String(message.id)}`);
          if (!request) continue;
          pendingRpc.delete(`${requestId}:${String(message.id)}`);
          if (request.method === "initialize") {
            request.response = {
              ok: !message.error,
              turnPermissions:
                message.result?.capabilities?.experimental?.turnPermissions === true,
              errorCode: message.error?.code ?? null,
              receivedAt:
                socket?.wallClockOffsetMs === undefined
                  ? Date.now()
                  : monotonicSeconds * 1000 + socket.wallClockOffsetMs,
            };
          } else {
            request.response = {
              ok: !message.error,
              errorCode: message.error?.code ?? null,
              receivedAt:
                socket?.wallClockOffsetMs === undefined
                  ? Date.now()
                  : monotonicSeconds * 1000 + socket.wallClockOffsetMs,
            };
          }
          record("appserver-rpc-response", {
            requestId,
            rpcId: request.rpcId,
            method: request.method,
            ...request.response,
          });
        }
      }
    }

    page.on("console", (message) => {
      const timestamped = {
        type: message.type(),
        text: sanitizeConsoleText(message.text()),
        location: safeConsoleLocation(message.location()),
      };
      if (
        timestamped.type === "debug" &&
        timestamped.text.startsWith(browserSocketDiagnosticPrefix)
      ) {
        try {
          record(
            "page-websocket-lifecycle",
            JSON.parse(timestamped.text.slice(browserSocketDiagnosticPrefix.length)),
          );
        } catch {
          record("page-websocket-lifecycle-unparsed", timestamped);
        }
      } else if (["warning", "error"].includes(timestamped.type)) {
        record("page-console-diagnostic", timestamped);
      }
    });
    page.on("pageerror", (error) => {
      record("page-error", { text: context.redactText(error.message) });
    });
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) {
        record("playwright-main-frame-navigated", {
          url: safeNavigationUrl(frame.url()),
        });
      }
    });

    await page.addInitScript(() => {
      const prefix = "__KC_E2E_WS_DIAG__";
      const NativeWebSocket = window.WebSocket;
      const localIds = new WeakMap();
      const trackedSockets = [];
      let nextLocalId = 0;
      const scope = (value) => {
        try {
          const url = new URL(value, window.location.href);
          return {
            origin: url.origin,
            path: url.pathname,
            server: url.searchParams.get("server"),
            channel: url.searchParams.get("channel"),
            workspaceScopePresent: url.searchParams.has("workspace"),
          };
        } catch {
          return { path: "unparseable" };
        }
      };
      const emit = (event) => {
        try {
          console.debug(prefix + JSON.stringify({
            pageTimeOrigin: performance.timeOrigin,
            pageElapsedMs: performance.now(),
            ...event,
          }));
        } catch {}
      };
      const originalClose = NativeWebSocket.prototype.close;
      Object.defineProperty(NativeWebSocket.prototype, "close", {
        configurable: true,
        writable: true,
        value: function (...args) {
          emit({
            event: "close-call",
            localSocketId: localIds.get(this) ?? null,
            scope: scope(this.url),
            readyState: this.readyState,
            stack: String(new Error().stack ?? "").slice(0, 1800),
          });
          return Reflect.apply(originalClose, this, args);
        },
      });
      let WrappedWebSocket;
      WrappedWebSocket = new Proxy(NativeWebSocket, {
        construct(target, args, newTarget) {
          const socket = Reflect.construct(
            target,
            args,
            newTarget === WrappedWebSocket ? target : newTarget,
          );
          const localSocketId = ++nextLocalId;
          localIds.set(socket, localSocketId);
          trackedSockets.push({ localSocketId, socket });
          emit({
            event: "created",
            localSocketId,
            scope: scope(socket.url),
            readyState: socket.readyState,
          });
          socket.addEventListener("open", () => emit({
            event: "open",
            localSocketId,
            scope: scope(socket.url),
            readyState: socket.readyState,
          }));
          socket.addEventListener("error", () => emit({
            event: "error",
            localSocketId,
            scope: scope(socket.url),
            readyState: socket.readyState,
          }));
          socket.addEventListener("close", (event) => emit({
            event: "close-event",
            localSocketId,
            scope: scope(socket.url),
            readyState: socket.readyState,
            code: event.code,
            wasClean: event.wasClean,
          }));
          return socket;
        },
      });
      Object.defineProperty(window, "WebSocket", {
        configurable: true,
        writable: true,
        value: WrappedWebSocket,
      });
      Object.defineProperty(window, "__KC_E2E_WS_SNAPSHOT", {
        configurable: false,
        value: () => trackedSockets.map(({ localSocketId, socket }) => ({
          localSocketId,
          scope: scope(socket.url),
          readyState: socket.readyState,
        })),
      });
    });

    const workspacePath = context.pathInState("workspace");
    await connect(page, gateway);
    phase = "home-thread-list";
    const homeThreadList = await waitFor(
      () => rpcRequests.find((request) =>
        request.method === "thread/list" && request.response?.ok,
      ),
      15_000,
      "successful home thread/list response",
      50,
      context.abortSignal,
    );
    record("home-thread-list-ready", {
      requestId: homeThreadList.requestId,
      rpcId: homeThreadList.rpcId,
    });
    phase = "create-workspace";
    await page.getByTestId("new-workspace").click();
    await page.getByTestId("server-option-local").click();
    await page.getByTestId("workspace-path").waitFor({
      state: "visible",
      timeout: 30_000,
    });
    await page.getByTestId("new-workspace-prompt").fill(initialPrompt);
    await page.getByTestId("create-workspace").click();
    phase = "first-turn";
    await page
      .getByText("tui-lab-mixed-tools-final-sentinel", { exact: false })
      .waitFor({ state: "visible", timeout: 60_000 });
    const firstTurn = await waitFor(
      () => rpcRequests.find((request) =>
        request.method === "turn/start" && request.response?.ok && !request.permissionModePresent,
      ),
      15_000,
      "successful first default turn/start",
      50,
      context.abortSignal,
    );

    phase = "before-reload";
    const preReloadLocalSockets = await page.evaluate(
      () => window.__KC_E2E_WS_SNAPSHOT?.() ?? [],
    );
    reloadStartedAtMs = Date.now();
    record("suite-reload-requested", { reloadStartedAtMs, preReloadLocalSockets });
    phase = "reload-in-flight";
    await page.reload({ waitUntil: "domcontentloaded" });
    reloadResolvedAtMs = Date.now();
    record("suite-reload-resolved", { reloadResolvedAtMs });
    phase = "after-reload";
    await page
      .getByText("tui-lab-mixed-tools-final-sentinel", { exact: false })
      .waitFor({ state: "visible", timeout: 30_000 });

    const permissionButton = page.getByTestId("composer-permission-selector");
    await permissionButton.waitFor({ state: "visible", timeout: 30_000 });
    await permissionButton.click();
    const permissionSheet = page.getByTestId("permission-mode-sheet");
    await permissionSheet.waitFor({ state: "visible", timeout: 10_000 });
    await page.getByTestId("permission-mode-ask").click();
    await permissionSheet.waitFor({ state: "hidden", timeout: 10_000 });
    phase = "second-turn-ask";
    await page.getByTestId("message-input").fill(followupPrompt);
    await page.getByTestId("send-message").click();
    await page
      .getByText("tui-lab-second-turn-sentinel", { exact: false })
      .last()
      .waitFor({ state: "visible", timeout: 60_000 });

    const replacementSockets = [...sockets.values()].filter(
      (socket) =>
        socket.scope.path === "/rpc" &&
        socket.scope.server === "local" &&
        socket.scope.channel === "runtime" &&
        socket.handshakeWallTimeMs >= reloadStartedAtMs,
    );
    const replacementInitializes = rpcRequests.filter((request) =>
      request.method === "initialize" &&
      request.sentAt >= reloadStartedAtMs &&
      request.response?.ok &&
      request.response.turnPermissions,
    );
    const askTurn = await waitFor(
      () => rpcRequests.find((request) =>
        request.method === "turn/start" &&
        request.sentAt >= reloadStartedAtMs &&
        request.permissionMode === "ask" &&
        request.response?.ok,
      ),
      15_000,
      "successful post-reload ask turn/start",
      50,
      context.abortSignal,
    );

    const gatewayProcessGroupId = context.processes.get(
      "mobile-chat-websocket-reload-diagnostic-gateway",
    )?.pgid ?? gateway.child.pid;
    const ownedProcesses = await findOwnedExecutableProcesses({
      pgid: gatewayProcessGroupId,
      executablePath: ownedBinary,
    });
    const [configuredBinaryAfter, ownedBinaryAfter] = await Promise.all([
      hashExecutableFile(configuredBinary),
      hashExecutableFile(ownedBinary),
    ]);
    assert.equal(configuredBinaryAfter.sha256, configuredBinaryBefore.sha256);
    assert.equal(ownedBinaryAfter.sha256, ownedBinaryBefore.sha256);
    assert.ok(ownedProcesses.some((process) => process.sha256 === ownedBinaryBefore.sha256));
    assert.ok(firstTurn.response.ok);
    const askSocket = sockets.get(askTurn.requestId);
    const askSocketInitialize = replacementInitializes.find(
      (request) => request.requestId === askTurn.requestId,
    );
    assert.ok(askSocket, "successful ask turn must belong to an observed WebSocket");
    assert.ok(askSocket.handshakeWallTimeMs >= reloadStartedAtMs);
    assert.equal(askSocket.handshakeStatus, 101);
    assert.ok(askSocketInitialize, "same post-reload WebSocket must initialize with turnPermissions");
    assert.ok(askTurn.response.ok);

    const evidence = {
      kind: "diagnostic-only; not registered source-bound suite evidence",
      sourceBinding: "UNVERIFIED",
      reusedMobileExport: {
        path: reusedWebRoot,
        manifestSha256: createHash("sha256").update(sourceExportManifestBytes).digest("hex"),
        fileCount: Array.isArray(sourceExportManifest.files)
          ? sourceExportManifest.files.length
          : null,
      },
      appServer: {
        sourceBinding: "UNVERIFIED",
        configuredSha256: configuredBinaryBefore.sha256,
        ownedSha256: ownedBinaryBefore.sha256,
        configuredUnchanged: configuredBinaryAfter.sha256 === configuredBinaryBefore.sha256,
        ownedUnchanged: ownedBinaryAfter.sha256 === ownedBinaryBefore.sha256,
        processGroupId: gatewayProcessGroupId,
        ownedProcesses,
      },
      reload: {
        requestedAt: new Date(reloadStartedAtMs).toISOString(),
        resolvedAt: reloadResolvedAtMs === null ? null : new Date(reloadResolvedAtMs).toISOString(),
        firstTurnRequestId: firstTurn.requestId,
        replacementSocketRequestIds: replacementSockets.map((socket) => socket.requestId),
        replacementInitializeRequestIds: replacementInitializes.map((request) => request.requestId),
        successfulAskRequestId: askTurn.requestId,
        successfulAskSocketHandshakeStatus: askSocket.handshakeStatus,
        successfulAskSocketInitializeTurnPermissions: askSocketInitialize.response.turnPermissions,
      },
      websocketSockets: [...sockets.values()],
      rpcRequests,
      events,
      diagnostics: events.filter((event) =>
        [
          "page-console-diagnostic",
          "page-error",
          "cdp-log-diagnostic",
          "cdp-websocket-frame-error",
          "cdp-websocket-loading-failed",
        ].includes(event.kind),
      ),
      modelOrProviderRequest: false,
      workspaceFixturePath: workspacePath,
    };
    await context.writeArtifactJson("websocket-reload-diagnostic.json", evidence);
    diagnosticEvidencePersisted = true;
    assert.deepEqual(evidence.diagnostics, [], "console/network diagnostics must remain empty");
    return {
      sourceBinding: "UNVERIFIED",
      websocketCount: sockets.size,
      warningCount: evidence.diagnostics.length,
      homeThreadListRequestId: homeThreadList.requestId,
      postReloadReplacementSocketCount: replacementSockets.length,
      postReloadInitializeCount: replacementInitializes.length,
      askTurnStartOk: askTurn.response.ok,
      artifact: "artifacts/websocket-reload-diagnostic.json",
    };
  },
);

async function connect(page, gateway) {
  await page.goto(new URL("/mobile/", gateway.baseUrl).href, {
    waitUntil: "domcontentloaded",
  });
  await page.getByTestId("welcome-direct-connection").waitFor({
    state: "visible",
    timeout: 30_000,
  });
  await page.getByTestId("welcome-direct-connection").click();
  await page.getByTestId("gateway-endpoint").fill(gateway.baseUrl);
  await page.getByTestId("gateway-connect").click();
  await page.getByTestId("new-workspace").waitFor({
    state: "visible",
    timeout: 30_000,
  });
}

function safeWebSocketScope(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return {
      origin: url.origin,
      path: url.pathname,
      server: url.searchParams.get("server"),
      channel: url.searchParams.get("channel"),
      workspaceScopePresent: url.searchParams.has("workspace"),
    };
  } catch {
    return { path: "unparseable" };
  }
}

function safeNavigationUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return { origin: url.origin, path: url.pathname };
  } catch {
    return { path: "unparseable" };
  }
}

function safeConsoleLocation(location) {
  return {
    url: location?.url ? safeNavigationUrl(location.url) : null,
    lineNumber: location?.lineNumber ?? null,
    columnNumber: location?.columnNumber ?? null,
  };
}

function sanitizeConsoleText(text) {
  return String(text).replace(/wss?:\/\/[^\s'"<>]+/g, (rawUrl) => {
    const scope = safeWebSocketScope(rawUrl);
    return `${scope.origin ?? "ws://[redacted]"}${scope.path ?? ""}?server=${scope.server ?? ""}&channel=${scope.channel ?? ""}&workspace=${scope.workspaceScopePresent ? "present" : "absent"}`;
  });
}

function parseJsonMessages(payload) {
  try {
    const decoded = JSON.parse(typeof payload === "string" ? payload : String(payload ?? ""));
    return Array.isArray(decoded) ? decoded : [decoded];
  } catch {
    return [];
  }
}
