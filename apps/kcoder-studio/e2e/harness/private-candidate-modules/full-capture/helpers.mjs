// Private historical candidate mechanisms; construction starts no resources.
export function createPrivateFullCaptureHelpers({
  GENERIC_STATIC_MOBILE_MOUNT_PATH,
  assert,
  lstat,
  performance,
  randomBytes,
  readFile,
  readdir,
  relative,
  repoRoot,
  resolve,
  sep,
  sha256,
  sha256File,
  waitFor,
}) {
function resolveProvenanceReference(reference, provenanceBase) {
  return reference.startsWith("/")
    ? resolve(reference)
    : reference.startsWith("target/")
      ? resolve(repoRoot, reference)
      : resolve(provenanceBase, reference);
}

async function readFrozenGatewayRuntime(rootArgument, binaryOverrideArgument, expectedBinarySha256, expectedSourceTreeSha256, expectedDependencyTreeSha256, expectedManifestSha256, binaryNotUsedInMock = false) {
  const root = resolve(rootArgument);
  const approvedBoundaries = [
    resolve(repoRoot, "target/test/apps/kcoder-studio/e2e"),
    resolve(repoRoot, "target/private-phone-ux-implementation"),
  ];
  assert.ok(approvedBoundaries.some((boundary) => root.startsWith(boundary + sep)), "frozen Gateway runtime must come from a retained or explicitly pinned private artifact, not the active workspace");
  const rootInfo = await lstat(root);
  assert.ok(rootInfo.isDirectory() && !rootInfo.isSymbolicLink(), "frozen Gateway runtime root must be an immutable artifact directory");
  const manifestPath = resolve(root, "gateway-runtime-freeze.json");
  const manifestBytes = await readFile(manifestPath);
  assert.equal(sha256(manifestBytes), expectedManifestSha256, "frozen Gateway runtime manifest differs from its explicit digest pin");
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  assert.equal(manifest.status, "complete", "frozen Gateway runtime manifest must be complete");
  const sourceRootLabel = String(manifest.sourceRoot ?? "").replaceAll("\\", "/");
  assert.ok(sourceRootLabel === "apps/kcoder-studio" || sourceRootLabel.endsWith("/apps/kcoder-studio"), "frozen Gateway runtime must pin the KCoder Studio source root");
  assert.equal(manifest.sourceTreeSha256, manifest.workspaceSourceTreeSha256, "frozen Gateway source tree must match the verified workspace source digest");
  assert.equal(manifest.dependencyTreeSha256, manifest.workspaceDependencyTreeSha256, "frozen Gateway dependencies must match the verified workspace dependency digest");
  assert.equal(manifest.sourceTreeSha256, expectedSourceTreeSha256, "frozen Gateway source tree must match its explicit digest pin");
  assert.equal(manifest.dependencyTreeSha256, expectedDependencyTreeSha256, "frozen Gateway dependencies must match their explicit digest pin");
  assert.ok(Array.isArray(manifest.sourceFiles) && manifest.sourceFiles.length > 0, "frozen Gateway source file inventory is required");
  assert.ok(Array.isArray(manifest.dependencyFiles) && manifest.dependencyFiles.length > 0, "frozen Gateway dependency file inventory is required");
  const manifestBinarySha256 = manifest.runtimeInputs?.kcoderBinarySha256 ?? manifest.kcoderBinarySha256 ?? null;
  assert.ok(typeof manifest.kcoderBinaryPath === "string" && manifest.kcoderBinaryPath.startsWith("/"), "frozen Gateway manifest must record its configured KCoder binary path");
  let binaryOverride = null;
  let actualBinarySha256 = null;
  let explicitBinary = null;
  if (binaryNotUsedInMock) {
    assert.equal(binaryOverrideArgument, null, "mock-only profile must not accept a Gateway binary path");
    assert.equal(expectedBinarySha256, null, "mock-only profile must not accept a Gateway binary digest");
    assert.equal(manifestBinarySha256, null, "mock-only profile requires a frozen runtime manifest with no KCoder binary SHA-256");
  } else {
    binaryOverride = resolve(binaryOverrideArgument);
    const binaryInfo = await lstat(binaryOverride);
    assert.ok(binaryInfo.isFile() && !binaryInfo.isSymbolicLink(), "explicit Gateway KCoder binary override must be a regular file");
    actualBinarySha256 = await sha256File(binaryOverride);
    assert.equal(actualBinarySha256, expectedBinarySha256, "explicit Gateway KCoder binary SHA-256 differs from its pinned digest");
    if (manifestBinarySha256 !== null) assert.equal(manifestBinarySha256, expectedBinarySha256, "explicit Gateway KCoder binary digest must match the restored runtime manifest input when it is recorded");
    explicitBinary = {
      path: binaryOverride,
      sha256: actualBinarySha256,
      size: binaryInfo.size,
      mtimeMs: binaryInfo.mtimeMs,
    };
  }
  const script = resolve(root, "dev-server.mjs");
  const scriptInfo = await lstat(script);
  assert.ok(scriptInfo.isFile() && !scriptInfo.isSymbolicLink(), "frozen Gateway entry script must be a regular file");
  assert.ok(typeof manifest.nodeExecutable === "string" && manifest.nodeExecutable.startsWith("/"), "frozen Gateway Node executable must be pinned by its freeze manifest");
  const provenance = {
    runtimeRoot: relative(repoRoot, root).split(sep).join("/"),
    manifestPath: relative(repoRoot, manifestPath).split(sep).join("/"),
    manifestSha256: sha256(manifestBytes),
    sourceTreeSha256: manifest.sourceTreeSha256,
    sourceFileCount: manifest.sourceFiles.length,
    dependencyTreeSha256: manifest.dependencyTreeSha256,
    dependencyFileCount: manifest.dependencyFiles.length,
    dependencyCopySemantics: manifest.dependencyCopySemantics,
    nodeExecutable: manifest.nodeExecutable,
    nodeVersion: manifest.nodeVersion,
    manifestKcoderBinaryPath: manifest.kcoderBinaryPath,
    kcoderBinaryPath: binaryOverride,
    kcoderBinarySha256: actualBinarySha256,
    manifestBinarySha256,
    binaryNotUsedInMock,
    kcoderBinaryStat: explicitBinary,
    binaryOverride: explicitBinary,
    runtimeInputs: {
      ...manifest.runtimeInputs,
      manifestKcoderBinaryPath: manifest.kcoderBinaryPath,
      kcoderBinaryPath: binaryOverride,
      kcoderBinarySha256: actualBinarySha256,
      kcoderBinaryStat: explicitBinary,
      binaryNotUsedInMock,
    },
    treeRehashedByRenderProfile: false,
  };
  return { root, script, nodeExecutable: manifest.nodeExecutable, kcoderBinaryPath: binaryOverride, binaryNotUsedInMock, manifestSha256: provenance.manifestSha256, provenance };
}

async function startFrozenGateway(context, runtime, options) {
  const label = options.label || "render-profile-frozen-gateway";
  assert.equal(options.staticMobileMountPath, GENERIC_STATIC_MOBILE_MOUNT_PATH, "profile must use the explicitly pinned generic static Mobile Web mount path");
  const host = "127.0.0.1";
  const authToken = randomBytes(24).toString("base64url");
  context.registerSecret(authToken);
  const env = context.isolatedEnvironment({
    KCODER_STUDIO_HOST: host,
    KCODER_STUDIO_PORT: "0",
    ...(runtime.binaryNotUsedInMock ? {} : { KCODER_STUDIO_KCODER_BIN: runtime.kcoderBinaryPath }),
    KCODER_STUDIO_WORKSPACE: options.workspace,
    KCODER_STUDIO_WEB_ROOT: options.webRoot,
    KCODER_STUDIO_SERVERS_FILE: options.serversFile,
    KCODER_STUDIO_AUTH_TOKEN: authToken,
    KCODER_STUDIO_ALLOWED_HOSTS: "127.0.0.1,localhost,::1",
    KCODER_STUDIO_MOCK: "1",
  }, []);
  if (runtime.binaryNotUsedInMock) {
    assert.equal(env.KCODER_STUDIO_MOCK, "1", "mock-only Gateway must be forced into JavaScript mock mode");
    assert.equal(Object.hasOwn(env, "KCODER_STUDIO_KCODER_BIN"), false, "mock-only Gateway must not receive a KCoder binary path");
  }
  const child = context.spawnOwned(label, runtime.nodeExecutable, ["dev-server.mjs"], {
    cwd: runtime.root,
    env,
  });
  const logPath = resolve(context.logsDir, `${label}.log`);
  const port = await waitFor(async () => {
    const log = await readFile(logPath, "utf8").catch(() => "");
    const match = log.match(/KCoder Studio: http:\/\/[^:]+:(\d+)/);
    if (child.exitCode !== null) throw new Error(`frozen Gateway exited with code ${child.exitCode}; inspect ${logPath}`);
    if (runtime.binaryNotUsedInMock) {
      if (!log.includes("JavaScript mock /rpc gateway enabled")) return null;
      assert.doesNotMatch(log, /Rust app-server gateway:/, "mock-only Gateway must not report a Rust app-server binary");
    }
    return match ? Number(match[1]) : null;
  }, 15_000, "frozen Gateway startup", 50, context.abortSignal);
  context.registerPort(label, port);
  return {
    child,
    port,
    host,
    baseUrl: `http://127.0.0.1:${port}`,
    staticMobileMountPath: options.staticMobileMountPath,
    wsUrl: `ws://127.0.0.1:${port}`,
    authToken,
    logPath,
    cwd: runtime.root,
    script: runtime.script,
    nodeExecutable: runtime.nodeExecutable,
    kcoderBinaryPath: runtime.kcoderBinaryPath,
    binaryNotUsedInMock: runtime.binaryNotUsedInMock,
  };
}

function assertSafeBundleRelativePath(value, sourceName) {
  assert.ok(typeof value === "string" && value.length > 0 && !value.startsWith("/") && !value.includes("\\"), `${sourceName} bundle path must be a non-empty POSIX relative path`);
  const parts = value.split("/");
  assert.ok(parts.every((part) => part && part !== "." && part !== ".."), `${sourceName} bundle path contains an unsafe segment`);
  assert.ok(!parts.some((part) => part === ".env" || part === ".npmrc" || part === ".netrc" || /(?:credential|secret|token|api[-_.]?key|private[-_.]?key)/i.test(part)), `${sourceName} public bundle cannot include credential-like paths`);
  assert.ok(!/\.(?:pem|key|p12|pfx|keystore|jks)$/i.test(value), `${sourceName} public bundle cannot include private key material`);
  return parts;
}

async function assertNoSymlinkAncestors(root, parts, label) {
  let current = root;
  for (const part of parts) {
    current = resolve(current, part);
    const info = await lstat(current);
    assert.ok(!info.isSymbolicLink(), `${label} bundle path contains a symlink`);
  }
}

async function verifyExactBundleTree(root, expectedFiles, label) {
  const foundFiles = new Set();
  const foundDirectories = new Set();
  async function visit(directory, prefix = "") {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const parts = assertSafeBundleRelativePath(relativePath, label);
      const absolutePath = resolve(directory, entry.name);
      const info = await lstat(absolutePath);
      assert.ok(!info.isSymbolicLink(), `${label} bundle tree cannot contain symlinks`);
      if (info.isDirectory()) {
        foundDirectories.add(relativePath);
        await visit(absolutePath, relativePath);
        continue;
      }
      assert.ok(info.isFile(), `${label} bundle tree cannot contain special files`);
      const expected = expectedFiles.get(relativePath);
      assert.ok(expected, `${label} bundle contains an unlisted file: ${relativePath}`);
      assert.equal(info.size, expected.size, `${label} bundle file size changed: ${relativePath}`);
      assert.equal(sha256(await readFile(absolutePath)), expected.sha256, `${label} bundle file digest changed: ${relativePath}`);
      foundFiles.add(relativePath);
    }
  }
  const rootInfo = await lstat(root);
  assert.ok(rootInfo.isDirectory() && !rootInfo.isSymbolicLink(), `${label} bundle root must be a real directory`);
  await visit(root);
  assert.deepEqual([...foundFiles].sort(), [...expectedFiles.keys()].sort(), `${label} bundle file set differs from its manifest`);
  for (const directory of foundDirectories) {
    assert.ok([...expectedFiles.keys()].some((file) => file.startsWith(`${directory}/`)), `${label} bundle contains an unlisted directory`);
  }
}

function installPerformanceInstrumentation() {
  const interactions = new Map();
  const completed = new Map();
  const mutationWaiters = new Map();
  const longTasks = [];
  const longAnimationFrames = [];
  const longAnimationFrameSupport = typeof PerformanceObserver === "function"
    && PerformanceObserver.supportedEntryTypes?.includes("long-animation-frame") === true;
  const eventTasks = [];
  const focusEvents = [];
  const mockSockets = new Map();
  const now = () => Number(performance.now().toFixed(3));
  const safeUrlPath = (value) => {
    try { return new URL(String(value), location.href).pathname; } catch { return ""; }
  };
  const ensureMockSocketRecord = (socket) => {
    if (!socket || typeof socket._id !== "string" || typeof socket._apiSendToPage !== "function") return null;
    let record = mockSockets.get(socket._id);
    if (!record) {
      record = { socket, browserMockId: socket._id, url: String(socket.url ?? ""), outgoingRpc: [], openSeen: false };
      mockSockets.set(socket._id, record);
    }
    return record;
  };
  const nativeDispatchEvent = EventTarget.prototype.dispatchEvent;
  EventTarget.prototype.dispatchEvent = function (event) {
    if (event?.type === "open" && typeof this?.url === "string") {
      const socketRecord = ensureMockSocketRecord(this);
      if (socketRecord) socketRecord.openSeen = true;
    }
    return nativeDispatchEvent.call(this, event);
  };
  window.__phoneRenderFocusEvents = () => focusEvents.slice(-40);
  const describeFocusTarget = (target) => ({
    tag: target instanceof Element ? target.tagName : null,
    testId: target instanceof Element ? target.getAttribute("data-testid") : null,
    role: target instanceof Element ? target.getAttribute("role") : null,
    ariaLabel: target instanceof Element ? target.getAttribute("aria-label") : null,
    className: target instanceof HTMLElement ? String(target.className).slice(0, 100) : null,
  });
  document.addEventListener("focusin", (event) => focusEvents.push({ type: "focusin", at: now(), target: describeFocusTarget(event.target) }), true);
  document.addEventListener("focusout", (event) => focusEvents.push({ type: "focusout", at: now(), target: describeFocusTarget(event.target), relatedTarget: describeFocusTarget(event.relatedTarget) }), true);
  window.__phoneRenderInstallMockSocketSendObserver = () => {
    const prototype = window.WebSocket?.prototype;
    if (!prototype || typeof prototype.send !== "function") return { installed: false, reason: "app-facing WebSocket mock prototype is unavailable" };
    if (prototype.__phoneRenderSendObserverInstalled) return { installed: true, alreadyInstalled: true };
    const originalSend = prototype.send;
    Object.defineProperty(prototype, "send", {
      configurable: true,
      writable: true,
      value(message) {
        const socketRecord = ensureMockSocketRecord(this);
        if (socketRecord) {
          try {
            const frame = JSON.parse(String(message));
            if (typeof frame?.method === "string") {
              socketRecord.outgoingRpc.push({
                method: frame.method,
                id: frame.id ?? null,
                threadId: frame.params?.threadId ?? null,
                at: now(),
              });
              if (socketRecord.outgoingRpc.length > 100) socketRecord.outgoingRpc.shift();
            }
          } catch {}
        }
        return originalSend.call(this, message);
      },
    });
    Object.defineProperty(prototype, "__phoneRenderSendObserverInstalled", { configurable: true, value: true });
    return { installed: true, mockClassName: prototype.constructor?.name ?? null };
  };
  const matchingMockSockets = (payload) => [...mockSockets.values()].filter(({ socket, url, outgoingRpc, openSeen }) => {
    try {
      const parsed = new URL(url, location.href);
      return socket.readyState === WebSocket.OPEN
        && openSeen === true
        && typeof socket._apiSendToPage === "function"
        && parsed.searchParams.get("server") === payload.server
        && parsed.searchParams.get("channel") === payload.channel
        && parsed.searchParams.get("workspace") === payload.workspace
        && outgoingRpc.some((request) => request.method === "thread/read" && request.threadId === payload.threadId && request.id === payload.threadReadId);
    } catch { return false; }
  });
  window.__phoneRenderDeliverFrames = (frames, expectedServer, expectedChannel, expectedWorkspace, expectedThreadId, expectedThreadReadId, captureDispatchDetails = false) => {
    const candidates = matchingMockSockets({ server: expectedServer, channel: expectedChannel, workspace: expectedWorkspace, threadId: expectedThreadId, threadReadId: expectedThreadReadId });
    if (candidates.length !== 1) return {
      delivered: 0,
      eligibleSocketCount: candidates.length,
      candidates: [...mockSockets.values()].map(({ socket, url, browserMockId, outgoingRpc }) => {
        const parsed = new URL(url, location.href);
        return {
          browserMockId,
          hasApiSendToPage: typeof socket._apiSendToPage === "function",
          path: parsed.pathname,
          server: parsed.searchParams.get("server"),
          channel: parsed.searchParams.get("channel"),
          workspace: parsed.searchParams.get("workspace"),
          readyState: socket.readyState,
          onMessageHandler: typeof socket.onmessage === "function",
          recentRequests: outgoingRpc.slice(-16),
          threadReadRequests: outgoingRpc.filter((request) => request.method === "thread/read").slice(-8),
        };
      }),
    };
    const dispatchStartedAt = now();
    for (const state of interactions.values()) {
      if (state.kind === "mutation" && state.finishedAt === null && state.startedAt === null) {
        state.dispatchStartedAt = dispatchStartedAt;
        state.startedAt = dispatchStartedAt;
      }
    }
    const { socket, browserMockId } = candidates[0];
    const dispatchTaskDurationsMs = [];
    const frameResults = [];
    for (const frame of frames) {
      const pageDispatchStartedAt = captureDispatchDetails ? Number(performance.now().toFixed(3)) : null;
      const domRowCountBefore = captureDispatchDetails
        ? document.querySelectorAll('[data-testid="message-user"], [data-testid="message-assistant"]').length
        : null;
      const taskStartedAt = performance.now();
      socket._apiSendToPage(JSON.stringify(frame));
      const dispatchHandlerSyncMs = Number((performance.now() - taskStartedAt).toFixed(3));
      const pageDispatchCompletedAt = captureDispatchDetails ? Number(performance.now().toFixed(3)) : null;
      const domRowCountAfter = captureDispatchDetails
        ? document.querySelectorAll('[data-testid="message-user"], [data-testid="message-assistant"]').length
        : null;
      dispatchTaskDurationsMs.push(dispatchHandlerSyncMs);
      frameResults.push({
        method: frame.method,
        sequence: frame.params?.sequence ?? null,
        serverId: frame.params?.serverId ?? null,
        threadId: frame.params?.threadId ?? null,
        turnId: frame.params?.turnId ?? null,
        browserMockId,
        dispatchHandlerSyncMs,
        ...(captureDispatchDetails ? {
          pageDispatchStartedAtMs: pageDispatchStartedAt,
          pageDispatchCompletedAtMs: pageDispatchCompletedAt,
          domRowCountBefore,
          domRowCountAfter,
        } : {}),
      });
    }
    return {
      delivered: frames.length,
      socketCopies: 1,
      browserMockId,
      dispatchStartedAt,
      frameResults,
      dispatchMethods: frames.map((frame) => frame.method),
      dispatchTaskDurationsMs,
    };
  };
  window.__phoneRenderSocketDiagnostics = () => [...mockSockets.values()].map(({ socket, url, browserMockId, outgoingRpc, openSeen }) => {
    try {
      const parsed = new URL(url, location.href);
      return {
        browserMockId,
        hasApiSendToPage: typeof socket._apiSendToPage === "function",
        openSeen,
        path: parsed.pathname,
        server: parsed.searchParams.get("server"),
        channel: parsed.searchParams.get("channel"),
        workspace: parsed.searchParams.get("workspace"),
        readyState: socket.readyState,
        onMessageHandler: typeof socket.onmessage === "function",
        recentRequests: outgoingRpc.slice(-16),
        threadReadRequests: outgoingRpc.filter((request) => request.method === "thread/read").slice(-8),
      };
    } catch { return { browserMockId, readyState: socket.readyState }; }
  });
  window.__phoneRenderDispatchFrameInTask = async (payload) => {
    const candidates = matchingMockSockets(payload);
    if (candidates.length !== 1) return {
      delivered: false,
      eligibleSocketCount: candidates.length,
      sockets: window.__phoneRenderSocketDiagnostics(),
    };
    const { socket, browserMockId } = candidates[0];
    return new Promise((resolve) => setTimeout(async () => {
      const eventDispatchAt = now();
      if (payload.startMeasurementAtThisFrame) {
        for (const state of interactions.values()) {
          if (state.kind === "mutation" && state.finishedAt === null && state.startedAt === null) {
            state.dispatchStartedAt = eventDispatchAt;
            state.startedAt = eventDispatchAt;
          }
        }
      }
      const taskStartedAt = performance.now();
      // Deliver through Playwright 1.62's app-facing WebSocketMock API. The
      // captured NativeWebSocket is only the upstream transport endpoint.
      socket._apiSendToPage(JSON.stringify(payload.frame));
      const dispatchHandlerSyncMs = Number((performance.now() - taskStartedAt).toFixed(3));
      let twoFrameOpportunityAt = null;
      let finalAssistantRow = null;
      if (payload.waitTwoFrames) {
        await new Promise((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(resolveFrame)));
        twoFrameOpportunityAt = now();
        if (payload.finalMarker) {
          const rows = [...document.querySelectorAll('[data-testid="message-assistant"]')];
          const row = rows.find((element) => (element.textContent ?? "").includes(payload.finalMarker));
          finalAssistantRow = row ? {
            present: true,
            textLength: (row.textContent ?? "").length,
            finalMarkerPresent: (row.textContent ?? "").includes(payload.finalMarker),
            failureMarkerPresent: Boolean(row.querySelector('[data-testid="message-attempt-failure"]')),
            unknownMarkerPresent: Boolean(row.querySelector('[data-testid="message-attempt-unknown"]')),
            runtimeTerminalUi: !document.querySelector('[data-testid="stop-turn"]')
              && Boolean(document.querySelector('[data-testid="send-message"]'))
              && !Boolean(document.querySelector('[data-testid="queue-message"]')),
          } : { present: false, textLength: null, finalMarkerPresent: false };
        }
      }
      resolve({
        delivered: true,
        browserMockId,
        eventDispatchAt,
        dispatchHandlerSyncMs,
        twoFrameOpportunityAt,
        dispatchMethod: payload.frame.method,
        dispatchSequence: payload.frame.params?.sequence ?? null,
        finalAssistantRow,
      });
    }, 0));
  };
  window.__phoneRenderDispatchActiveStreamInTasks = async (payload) => {
    const candidates = matchingMockSockets(payload);
    if (candidates.length !== 1) return {
      delivered: false,
      eligibleSocketCount: candidates.length,
      sockets: window.__phoneRenderSocketDiagnostics(),
    };
    const { socket, browserMockId } = candidates[0];
    const channel = new MessageChannel();
    const frameResults = [];
    const taskResults = [];
    let frameIndex = 0;
    let firstDeltaDispatchAt = null;
    let completionDispatchAt = null;
    const dispatchFrame = (frame) => {
      const eventDispatchAt = now();
      if (frame.method === "item/delta" && firstDeltaDispatchAt === null) {
        firstDeltaDispatchAt = eventDispatchAt;
        for (const state of interactions.values()) {
          if (state.kind === "mutation" && state.finishedAt === null && state.startedAt === null) {
            state.dispatchStartedAt = eventDispatchAt;
            state.startedAt = eventDispatchAt;
          }
        }
      }
      if (frame.method === "turn/completed") completionDispatchAt = eventDispatchAt;
      const handlerStartedAt = performance.now();
      socket._apiSendToPage(JSON.stringify(frame));
      frameResults.push({
        method: frame.method,
        sequence: frame.params?.sequence ?? null,
        serverId: frame.params?.serverId ?? null,
        threadId: frame.params?.threadId ?? null,
        turnId: frame.params?.turnId ?? null,
        eventDispatchAt,
        dispatchHandlerSyncMs: Number((performance.now() - handlerStartedAt).toFixed(3)),
        browserMockId,
      });
    };
    return new Promise((resolve, reject) => {
      channel.port1.onmessage = async () => {
        const browserTaskStartedAt = performance.now();
        const taskMethods = [];
        try {
          const frame = payload.frames[frameIndex++];
          dispatchFrame(frame);
          taskMethods.push(frame.method);
          // Keep the terminal pair in one browser task so turn/completed must flush
          // the final delta while its normal batching timer is still pending.
          if (frame.method === "item/delta" && frameIndex < payload.frames.length && payload.frames[frameIndex].method === "turn/completed") {
            const completionFrame = payload.frames[frameIndex++];
            dispatchFrame(completionFrame);
            taskMethods.push(completionFrame.method);
          }
          taskResults.push({
            frameMethods: taskMethods,
            wallMs: Number((performance.now() - browserTaskStartedAt).toFixed(3)),
          });
          if (frameIndex < payload.frames.length) {
            channel.port2.postMessage(null);
            return;
          }
          channel.port1.close();
          channel.port2.close();
          resolve({
            delivered: frameResults.length,
            browserMockId,
            frameResults,
            taskResults,
            firstDeltaDispatchAt,
            completionDispatchAt,
            deltaBurstDispatchMs: Number((completionDispatchAt - firstDeltaDispatchAt).toFixed(3)),
          });
        } catch (error) {
          channel.port1.close();
          channel.port2.close();
          reject(error);
        }
      };
      channel.port2.postMessage(null);
    });
  };
  const finish = (state, finishedAt, detail = {}) => {
    if (state.finishedAt !== null) return;
    state.finishedAt = finishedAt;
    const result = {
      id: state.id,
      startedAt: state.startedAt,
      finishedAt: state.finishedAt,
      durationMs: Number((state.finishedAt - state.startedAt).toFixed(3)),
      armToNotificationDispatchMs: Number.isFinite(state.dispatchStartedAt) ? Number((state.dispatchStartedAt - state.armedAt).toFixed(3)) : null,
      notificationDispatchAt: Number.isFinite(state.dispatchStartedAt) ? state.dispatchStartedAt : null,
      agentRevisionAt: Number.isFinite(state.agentRevisionAt) ? state.agentRevisionAt : null,
      notificationDispatchToAgentRevisionMs: Number.isFinite(state.dispatchStartedAt) && Number.isFinite(state.agentRevisionAt) ? Number((state.agentRevisionAt - state.dispatchStartedAt).toFixed(3)) : null,
      notificationDispatchToTwoFrameOpportunityMs: Number.isFinite(state.dispatchStartedAt) ? Number((state.finishedAt - state.dispatchStartedAt).toFixed(3)) : null,
      synchronousEventTaskMs: state.synchronousEventTaskMs,
      scrollEventTaskMs: state.scrollEventTaskMs,
      mutationObserverCallbackMs: state.mutationObserverCallbackMs ?? null,
      ...detail,
    };
    completed.set(state.id, result);
    const waiter = mutationWaiters.get(state.id);
    if (waiter) {
      clearTimeout(waiter.timer);
      mutationWaiters.delete(state.id);
      waiter.resolve(result);
    }
    state.cleanup?.();
    interactions.delete(state.id);
  };
  const targetIsInput = (target) => target instanceof Element && Boolean(target.closest('[data-testid="message-input"]'));
  const targetIsScrollList = (target) => target instanceof Element && Boolean(target.closest("[data-phone-ux-scroll-host]"));
  const recordTask = (eventName, state, start) => {
    queueMicrotask(() => {
      const durationMs = Number((performance.now() - start).toFixed(3));
      eventTasks.push({ eventName, durationMs, at: now() });
      if (state && state.finishedAt === null) {
        if (eventName === "scroll") state.scrollEventTaskMs = durationMs;
        else state.synchronousEventTaskMs = durationMs;
      }
    });
  };

  window.__phoneRenderArmInput = (id) => {
    interactions.set(id, { id, kind: "input", startedAt: null, finishedAt: null, synchronousEventTaskMs: null, scrollEventTaskMs: null });
  };
  window.__phoneRenderInputResult = (id) => completed.get(id) ?? null;
  window.__phoneRenderArmScroll = (id) => {
    interactions.set(id, { id, kind: "scroll", startedAt: null, finishedAt: null, initialScrollTop: null, host: null, synchronousEventTaskMs: null, scrollEventTaskMs: null });
  };
  window.__phoneRenderArmMutation = (id, marker) => {
    const state = {
      id,
      marker,
      kind: "mutation",
      armedAt: now(),
      startedAt: null,
      dispatchStartedAt: null,
      agentRevisionAt: null,
      finishedAt: null,
      synchronousEventTaskMs: null,
      scrollEventTaskMs: null,
      mutationObserverCallbackMs: null,
      agentRevision: null,
      changesFilenameMarkerAt: null,
      cleanup: null,
    };
    const root = document.querySelector('[data-testid="message-list"]');
    const changesRoot = document.querySelector('[data-testid="changes-panel"]');
    const baseline = new Map(
      [...(root?.querySelectorAll('[data-testid="message-assistant"]') ?? [])]
        .map((row) => [row, row.textContent ?? ""]),
    );
    const observers = [];
    if (root) {
      const observer = new MutationObserver(() => {
        const callbackStartedAt = performance.now();
        const rows = [...root.querySelectorAll('[data-testid="message-assistant"]')];
        const changedIndex = rows.findIndex((row) => {
          const text = row.textContent ?? "";
          return text.includes(marker) && (!baseline.has(row) || baseline.get(row) !== text);
        });
        if (changedIndex < 0 || state.finishedAt !== null) return;
        const row = rows[changedIndex];
        state.mutationObserverCallbackMs = Number((performance.now() - callbackStartedAt).toFixed(3));
        state.agentRevisionAt = now();
        state.agentRevision = {
          assistantRowCount: rows.length,
          changedRowIndex: changedIndex,
          textLength: (row.textContent ?? "").length,
          fixtureMarkerPresent: (row.textContent ?? "").includes(marker),
        };
        requestAnimationFrame(() => requestAnimationFrame(() => finish(state, now(), {
          event: "synthetic-websocket-frame-to-agent-content-revision-two-frame-opportunity",
          agentRevision: state.agentRevision,
          changesFilenameMarkerObserved: state.changesFilenameMarkerAt !== null,
          changesFilenameMarkerAt: state.changesFilenameMarkerAt,
        })));
      });
      observer.observe(root, { childList: true, subtree: true, characterData: true });
      observers.push(observer);
    }
    if (changesRoot) {
      const changesObserver = new MutationObserver(() => {
        if (state.changesFilenameMarkerAt !== null || state.finishedAt !== null) return;
        const matched = changesRoot.textContent?.includes(marker) ?? false;
        if (matched) state.changesFilenameMarkerAt = now();
      });
      changesObserver.observe(changesRoot, { childList: true, subtree: true, characterData: true });
      observers.push(changesObserver);
    }
    state.cleanup = () => observers.forEach((observer) => observer.disconnect());
    interactions.set(id, state);
    return { observedRoot: Boolean(root), primaryBoundary: "changed assistant-row text under Mobile message-list followed by two requestAnimationFrame callbacks", supplementalChangesObserver: Boolean(changesRoot) };
  };
  window.__phoneRenderMutationResult = (id) => completed.get(id) ?? null;
  window.__phoneRenderAwaitMutationResult = (id, timeoutMs = 5_000) => {
    const existing = completed.get(id);
    if (existing) return Promise.resolve(existing);
    const state = interactions.get(id);
    if (!state || state.kind !== "mutation") return Promise.reject(new Error("mutation observer is not armed"));
    if (mutationWaiters.has(id)) return Promise.reject(new Error("mutation observer already has an active completion waiter"));
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 5_000) {
      return Promise.reject(new Error("mutation completion timeout must be between 1 and 5000 ms"));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        mutationWaiters.delete(id);
        reject(new Error(`assistant-row mutation plus two animation frames did not complete within ${timeoutMs} ms`));
      }, timeoutMs);
      mutationWaiters.set(id, { resolve, reject, timer });
    });
  };
  window.__phoneRenderLongTasks = () => longTasks.slice();
  window.__phoneRenderLongTasksBetween = (startedAt, finishedAt) => longTasks.filter((task) => task.startTimeMs < finishedAt && task.startTimeMs + task.durationMs >= startedAt);
  window.__phoneRenderLongAnimationFrameSupport = () => longAnimationFrameSupport;
  window.__phoneRenderLongAnimationFramesBetween = (startedAt, finishedAt) => longAnimationFrames.filter((frame) => frame.startTimeMs < finishedAt && frame.startTimeMs + frame.durationMs >= startedAt);
  window.__phoneRenderEventTasks = () => eventTasks.slice();

  document.addEventListener("keydown", (event) => {
    if (!targetIsInput(event.target)) return;
    const state = [...interactions.values()].find((value) => value.kind === "input" && value.startedAt === null);
    if (!state) return;
    state.startedAt = now();
    state.expectedValue = `${event.target.value ?? ""}${event.key.length === 1 ? event.key : ""}`;
    const start = performance.now();
    recordTask("keydown", state, start);
    requestAnimationFrame(() => {
      const input = document.querySelector('[data-testid="message-input"]');
      if (!(input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement)) return;
      if (input.value === state.expectedValue) finish(state, now(), { event: "keydown", inputValueLength: input.value.length });
    });
  }, true);
  document.addEventListener("input", (event) => {
    if (!targetIsInput(event.target)) return;
    const state = [...interactions.values()].find((value) => value.kind === "input" && value.startedAt === null);
    if (state) {
      state.startedAt = now();
      state.expectedValue = event.target.value;
      const start = performance.now();
      recordTask("input", state, start);
      requestAnimationFrame(() => finish(state, now(), { event: "input", inputValueLength: String(event.target.value ?? "").length }));
    }
  }, true);
  document.addEventListener("touchstart", (event) => {
    const state = [...interactions.values()].find((value) => value.kind === "scroll" && value.startedAt === null);
    if (!state || !targetIsScrollList(event.target)) return;
    const host = event.target.closest("[data-phone-ux-scroll-host]");
    state.startedAt = now();
    state.host = host;
    state.initialScrollTop = host.scrollTop;
    const start = performance.now();
    recordTask("touchstart", state, start);
  }, true);
  document.addEventListener("scroll", (event) => {
    const state = [...interactions.values()].find((value) => value.kind === "scroll" && value.startedAt !== null && value.finishedAt === null && !value.scrollSeen);
    if (!state || event.target !== state.host) return;
    state.scrollSeen = true;
    const start = performance.now();
    recordTask("scroll", state, start);
    requestAnimationFrame(() => {
      const delta = Math.abs(Number(state.host.scrollTop) - Number(state.initialScrollTop));
      if (delta > 1) finish(state, now(), { event: "touchstart-to-scroll-frame", scrollDeltaPx: Number(delta.toFixed(2)) });
    });
  }, true);

  if (typeof PerformanceObserver === "function") {
    try {
      new PerformanceObserver((listValue) => {
        for (const entry of listValue.getEntries()) {
          longTasks.push({
            startTimeMs: Number(entry.startTime.toFixed(3)),
            durationMs: Number(entry.duration.toFixed(3)),
            name: String(entry.name ?? "unknown").slice(0, 100),
            attribution: (entry.attribution ?? []).slice(0, 4).map((item) => ({
              containerType: String(item.containerType ?? "").slice(0, 40),
              containerName: String(item.containerName ?? "").slice(0, 100),
              containerSrcPath: safeUrlPath(item.containerSrc),
            })),
          });
        }
      }).observe({ type: "longtask", buffered: true });
    } catch {}
    if (longAnimationFrameSupport) {
      try {
        new PerformanceObserver((listValue) => {
          for (const entry of listValue.getEntries()) {
            longAnimationFrames.push({
              startTimeMs: Number(entry.startTime.toFixed(3)),
              durationMs: Number(entry.duration.toFixed(3)),
              blockingDurationMs: Number((entry.blockingDuration ?? 0).toFixed(3)),
              renderStartMs: Number((entry.renderStart ?? 0).toFixed(3)),
              styleAndLayoutStartMs: Number((entry.styleAndLayoutStart ?? 0).toFixed(3)),
              firstUIEventTimestampMs: Number((entry.firstUIEventTimestamp ?? 0).toFixed(3)),
              scripts: (entry.scripts ?? []).slice(0, 20).map((script) => ({
                startTimeMs: Number((script.startTime ?? 0).toFixed(3)),
                durationMs: Number((script.duration ?? 0).toFixed(3)),
                executionStartMs: Number((script.executionStart ?? 0).toFixed(3)),
                forcedStyleAndLayoutDurationMs: Number((script.forcedStyleAndLayoutDuration ?? 0).toFixed(3)),
                pauseDurationMs: Number((script.pauseDuration ?? 0).toFixed(3)),
                sourceFunctionName: String(script.sourceFunctionName ?? "").slice(0, 160),
                sourceUrlPath: safeUrlPath(script.sourceURL),
                sourceCharPosition: Number.isInteger(script.sourceCharPosition) ? script.sourceCharPosition : null,
                invoker: String(script.invoker ?? "").slice(0, 160),
                invokerType: String(script.invokerType ?? "").slice(0, 80),
                windowAttribution: String(script.windowAttribution ?? "").slice(0, 40),
              })),
            });
          }
        }).observe({ type: "long-animation-frame", buffered: true });
      } catch {}
    }
  }
}

async function configureRuntimeConsumerProbe(page, marker) {
  const safeMarker = marker.replace(/[^A-Za-z0-9_-]/g, "_");
  const identity = {
    marker,
    turnId: `ux-profile-turn-${safeMarker}`,
    itemId: `ux-profile-item-${safeMarker}`,
  };
  let result;
  try {
    result = await page.evaluate((value) => {
      const probe = window.__phoneRuntimeProbe;
      if (!probe || typeof probe.configure !== "function" || typeof probe.drain !== "function") {
        return { status: "PROBE_GLOBAL_UNAVAILABLE" };
      }
      try {
        return {
          status: probe.configure(value) === true ? "CONFIGURED" : "PROBE_CONFIG_REJECTED",
          configuredMarker: value.marker,
        };
      } catch {
        return { status: "PROBE_CONFIG_THROWN" };
      }
    }, identity);
  } catch (error) {
    result = { status: "PROBE_PAGE_CONFIGURATION_READ_FAILED", error: safeSeedErrorMessage(error) };
  }
  return { ...result, identity };
}

function safeSeedErrorMessage(error) {
  let message = String(error?.message || error || "seed failure");
  const routeDetails = message.indexOf("routeEvidence=");
  if (routeDetails >= 0) message = `${message.slice(0, routeDetails)}[route details omitted]`;
  const candidateDetails = message.indexOf("candidates=");
  if (candidateDetails >= 0) message = `${message.slice(0, candidateDetails)}[candidate details omitted]`;
  message = message.replace(/\b(?:https?|wss?|file):\/\/[^\s"'<>]+/gi, "[url omitted]");
  return message.slice(0, 500);
}

function safeSeedErrorStack(error) {
  if (typeof error?.stack !== "string") return null;
  return error.stack.split("\n").slice(0, 8).join("\n")
    .replace(/\b(?:https?|wss?|file):\/\/[^\s"'<>]+/gi, "[url omitted]")
    .slice(0, 1_200);
}

function beginSeedUiTraceInPage({ marker }) {
  const list = document.querySelector('[data-testid="message-list"]');
  if (!(list instanceof HTMLElement)) throw new Error("seed DOM trace could not find message-list");
  const scrollables = [list, ...list.querySelectorAll("*")].filter((element) =>
    element instanceof HTMLElement && element.scrollHeight > element.clientHeight + 16,
  ).sort((left, right) => (right.scrollHeight - right.clientHeight) - (left.scrollHeight - left.clientHeight));
  const hostCandidate = list.querySelector("[data-phone-ux-scroll-host]");
  const host = hostCandidate instanceof HTMLElement ? hostCandidate : scrollables[0] ?? list;
  const maxEntries = 200;
  const trace = {
    schemaVersion: 1,
    boundary: "seed only; standard DOM scroll/pointer/touch/wheel/MutationObserver/ResizeObserver; no React internals",
    marker,
    startedAtPageTimeMs: Number(performance.now().toFixed(3)),
    initialLayout: null,
    finalLayout: null,
    scrollEvents: [],
    resizeEvents: [],
    mutationEvents: [],
    pointerEvents: [],
    dropped: { scrollEvents: 0, resizeEvents: 0, mutationEvents: 0, pointerEvents: 0 },
  };
  let stopped = false;
  const resizeObserved = new WeakSet();
  const append = (key, value) => {
    if (trace[key].length < maxEntries) trace[key].push(value);
    else trace.dropped[key] += 1;
  };
  const rect = (element) => {
    if (!(element instanceof Element)) return null;
    const value = element.getBoundingClientRect();
    return {
      top: Number(value.top.toFixed(2)),
      bottom: Number(value.bottom.toFixed(2)),
      left: Number(value.left.toFixed(2)),
      right: Number(value.right.toFixed(2)),
      width: Number(value.width.toFixed(2)),
      height: Number(value.height.toFixed(2)),
    };
  };
  const rowsNow = () => [...list.querySelectorAll('[data-testid="message-user"], [data-testid="message-assistant"]')];
  const markerTokens = (text) => [...new Set(text.match(/(?:HISTORY-\d{4}|seed-[A-Za-z0-9_-]+|UX-[A-Za-z0-9_-]+)/g) ?? [])].slice(0, 12);
  const rowEvidence = () => {
    const rows = rowsNow();
    const selectedIndexes = new Set();
    for (let index = 0; index < Math.min(4, rows.length); index += 1) selectedIndexes.add(index);
    for (let index = Math.max(0, rows.length - 4); index < rows.length; index += 1) selectedIndexes.add(index);
    rows.forEach((row, index) => {
      const text = row.textContent ?? "";
      if (text.includes(marker) || /HISTORY-\d{4}/.test(text)) selectedIndexes.add(index);
    });
    const listRect = list.getBoundingClientRect();
    return [...selectedIndexes].sort((left, right) => left - right).slice(0, 24).map((index) => {
      const row = rows[index];
      const rowRect = row.getBoundingClientRect();
      return {
        mountedDomIndex: index,
        testId: row.getAttribute("data-testid"),
        dataIndex: row.getAttribute("data-index"),
        ariaPosInSet: row.getAttribute("aria-posinset"),
        markerTokens: markerTokens(row.textContent ?? ""),
        targetMarkerFound: (row.textContent ?? "").includes(marker),
        textLength: (row.textContent ?? "").length,
        rect: rect(row),
        intersectsMessageList: rowRect.width > 0 && rowRect.height > 0
          && rowRect.right > listRect.left && rowRect.left < listRect.right
          && rowRect.bottom > listRect.top && rowRect.top < listRect.bottom,
      };
    });
  };
  const spacerEvidence = () => {
    const candidates = [...new Set([list, ...list.children, host, ...host.children])];
    return candidates.map((element, index) => {
      if (!(element instanceof HTMLElement)) return null;
      const textLength = (element.textContent ?? "").trim().length;
      const box = rect(element);
      if (textLength !== 0 || !box || (box.height <= 0 && element.scrollHeight <= 0)) return null;
      const parentLabel = element === list ? "message-list"
        : element === host ? "scroll-host"
          : element.parentElement === list ? "message-list-child"
            : element.parentElement === host ? "scroll-host-child" : "container-child";
      return {
        candidateIndex: index,
        parentLabel,
        tagName: element.tagName,
        testId: element.getAttribute("data-testid"),
        dataIndex: element.getAttribute("data-index"),
        textLength,
        childCount: element.children.length,
        rect: box,
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
      };
    }).filter(Boolean).slice(0, 24);
  };
  const metrics = () => {
    const listRect = list.getBoundingClientRect();
    const jump = document.querySelector('[data-testid="jump-to-latest"]');
    const jumpRect = jump?.getBoundingClientRect();
    const jumpStyle = jump instanceof HTMLElement ? getComputedStyle(jump) : null;
    const jumpVisible = Boolean(jumpRect && jumpRect.width > 0 && jumpRect.height > 0
      && jumpStyle?.display !== "none" && jumpStyle?.visibility !== "hidden");
    return {
      pageTimeMs: Number(performance.now().toFixed(3)),
      scrollHostTestId: host.getAttribute("data-testid"),
      scrollTop: Number(host.scrollTop.toFixed(2)),
      scrollHeight: host.scrollHeight,
      clientHeight: host.clientHeight,
      bottomGapPx: Number(Math.max(0, host.scrollHeight - host.clientHeight - host.scrollTop).toFixed(2)),
      listRect: rect(list),
      renderedMessageRowCount: rowsNow().length,
      targetMarkerRowFound: rowsNow().some((row) => (row.textContent ?? "").includes(marker)),
      jumpToLatestVisible: jumpVisible,
    };
  };
  const layout = () => ({ ...metrics(), rows: rowEvidence(), nonTextChildSpacers: spacerEvidence() });
  const testIdFor = (target) => {
    const element = target instanceof Element ? target : null;
    const nearest = element?.closest("[data-testid]");
    return nearest?.getAttribute("data-testid") ?? null;
  };
  const syncResizeTargets = () => {
    for (const element of [list, host, list.firstElementChild, host.firstElementChild, ...list.children, ...host.children]) {
      if (!(element instanceof Element) || resizeObserved.has(element)) continue;
      resizeObserved.add(element);
      try { resizeObserver.observe(element); } catch {}
    }
  };
  const onScroll = (event) => append("scrollEvents", {
    eventType: "scroll",
    isTrusted: event.isTrusted,
    targetTestId: testIdFor(event.target),
    ...metrics(),
  });
  const onPointer = (event) => append("pointerEvents", {
    eventType: event.type,
    isTrusted: event.isTrusted,
    targetTestId: testIdFor(event.target),
    pageTimeMs: Number(performance.now().toFixed(3)),
    eventTimeStampMs: Number(event.timeStamp.toFixed(3)),
    ...metrics(),
  });
  document.addEventListener("scroll", onScroll, true);
  for (const eventName of ["pointerdown", "touchstart", "wheel"]) document.addEventListener(eventName, onPointer, true);
  const resizeObserver = new ResizeObserver((entries) => {
    append("resizeEvents", {
      eventType: "resize-observer",
      pageTimeMs: Number(performance.now().toFixed(3)),
      entries: entries.slice(0, 24).map((entry) => ({
        targetTestId: entry.target.getAttribute?.("data-testid") ?? null,
        targetTagName: entry.target.tagName,
        contentRect: {
          width: Number(entry.contentRect.width.toFixed(2)),
          height: Number(entry.contentRect.height.toFixed(2)),
        },
        scrollHeight: entry.target.scrollHeight ?? null,
        clientHeight: entry.target.clientHeight ?? null,
      })),
      layout: layout(),
    });
  });
  const mutationObserver = new MutationObserver((records) => {
    syncResizeTargets();
    append("mutationEvents", {
      eventType: "mutation-observer",
      pageTimeMs: Number(performance.now().toFixed(3)),
      recordCount: records.length,
      childListRecords: records.filter((record) => record.type === "childList").length,
      characterDataRecords: records.filter((record) => record.type === "characterData").length,
      targetTestIds: [...new Set(records.map((record) => testIdFor(record.target)).filter(Boolean))].slice(0, 12),
      layout: layout(),
    });
  });
  syncResizeTargets();
  resizeObserver.observe(list);
  resizeObserver.observe(host);
  mutationObserver.observe(list, { childList: true, subtree: true, characterData: true });
  trace.initialLayout = layout();
  window.__phoneSeedUiTrace = {
    stop() {
      if (stopped) return trace;
      stopped = true;
      const pendingMutations = mutationObserver.takeRecords();
      if (pendingMutations.length) {
        append("mutationEvents", {
          eventType: "mutation-observer-pending-at-stop",
          pageTimeMs: Number(performance.now().toFixed(3)),
          recordCount: pendingMutations.length,
          childListRecords: pendingMutations.filter((record) => record.type === "childList").length,
          characterDataRecords: pendingMutations.filter((record) => record.type === "characterData").length,
          targetTestIds: [...new Set(pendingMutations.map((record) => testIdFor(record.target)).filter(Boolean))].slice(0, 12),
          layout: layout(),
        });
      }
      trace.finalLayout = layout();
      trace.endedAtPageTimeMs = Number(performance.now().toFixed(3));
      trace.resizeEventCount = trace.resizeEvents.length;
      trace.mutationEventCount = trace.mutationEvents.length;
      trace.scrollEventCount = trace.scrollEvents.length;
      trace.pointerEventCount = trace.pointerEvents.length;
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      document.removeEventListener("scroll", onScroll, true);
      for (const eventName of ["pointerdown", "touchstart", "wheel"]) document.removeEventListener(eventName, onPointer, true);
      delete window.__phoneSeedUiTrace;
      return trace;
    },
  };
  return { started: true, pageTimeMs: trace.startedAtPageTimeMs, initialLayout: trace.initialLayout };
}

function endSeedUiTraceInPage() {
  return window.__phoneSeedUiTrace?.stop?.() ?? null;
}

async function captureSeedFailureDom(page, state, marker) {
  return page.evaluate(({ expectedWorkspace, expectedMarker }) => {
    const list = document.querySelector('[data-testid="message-list"]');
    if (!(list instanceof HTMLElement)) return { sampledAtPageTimeMs: Number(performance.now().toFixed(3)), listFound: false };
    const scrollables = [list, ...list.querySelectorAll("*")].filter((element) =>
      element instanceof HTMLElement && element.scrollHeight > element.clientHeight + 16,
    ).sort((left, right) => (right.scrollHeight - right.clientHeight) - (left.scrollHeight - left.clientHeight));
    const hostCandidate = list.querySelector("[data-phone-ux-scroll-host]");
    const host = hostCandidate instanceof HTMLElement ? hostCandidate : scrollables[0] ?? list;
    const listRect = list.getBoundingClientRect();
    const rect = (element) => {
      if (!(element instanceof Element)) return null;
      const value = element.getBoundingClientRect();
      return { top: Number(value.top.toFixed(2)), bottom: Number(value.bottom.toFixed(2)), height: Number(value.height.toFixed(2)), width: Number(value.width.toFixed(2)) };
    };
    const tokens = (text) => [...new Set(text.match(/(?:HISTORY-\d{4}|seed-[A-Za-z0-9_-]+|UX-[A-Za-z0-9_-]+)/g) ?? [])].slice(0, 12);
    const rows = [...list.querySelectorAll('[data-testid="message-user"], [data-testid="message-assistant"]')];
    const selected = new Set();
    for (let index = 0; index < Math.min(4, rows.length); index += 1) selected.add(index);
    for (let index = Math.max(0, rows.length - 4); index < rows.length; index += 1) selected.add(index);
    rows.forEach((row, index) => { if ((row.textContent ?? "").includes(expectedMarker)) selected.add(index); });
    const rowSummaries = [...selected].sort((a, b) => a - b).slice(0, 16).map((index) => {
      const row = rows[index];
      const rowRect = row.getBoundingClientRect();
      const text = row.textContent ?? "";
      return {
        mountedDomIndex: index,
        testId: row.getAttribute("data-testid"),
        dataIndex: row.getAttribute("data-index"),
        ariaPosInSet: row.getAttribute("aria-posinset"),
        markerTokens: tokens(text),
        targetMarkerFound: text.includes(expectedMarker),
        textLength: text.length,
        rect: rect(row),
        intersectsMessageList: rowRect.width > 0 && rowRect.height > 0
          && rowRect.right > listRect.left && rowRect.left < listRect.right
          && rowRect.bottom > listRect.top && rowRect.top < listRect.bottom,
      };
    });
    const jump = document.querySelector('[data-testid="jump-to-latest"]');
    const jumpRect = jump?.getBoundingClientRect();
    const jumpStyle = jump instanceof HTMLElement ? getComputedStyle(jump) : null;
    const visible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return box.width > 0 && box.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const sockets = (window.__phoneRenderSocketDiagnostics?.() ?? []).map((socket) => ({
      browserMockId: socket.browserMockId,
      hasApiSendToPage: socket.hasApiSendToPage,
      openSeen: socket.openSeen,
      path: socket.path,
      server: socket.server,
      channel: socket.channel,
      workspaceMatchesFixture: socket.workspace === expectedWorkspace,
      readyState: socket.readyState,
      onMessageHandler: socket.onMessageHandler,
      recentRequests: (socket.recentRequests ?? []).map((request) => ({ method: request.method, id: request.id ?? null, threadId: request.threadId ?? null, at: request.at ?? null })),
      threadReadRequests: (socket.threadReadRequests ?? []).map((request) => ({ method: request.method, id: request.id ?? null, threadId: request.threadId ?? null, at: request.at ?? null })),
    }));
    const spacerCandidates = [...new Set([list, ...list.children, host, ...host.children])].map((element, index) => {
      if (!(element instanceof HTMLElement) || (element.textContent ?? "").trim().length > 0) return null;
      const box = rect(element);
      if (!box || (box.height <= 0 && element.scrollHeight <= 0)) return null;
      return { candidateIndex: index, tagName: element.tagName, testId: element.getAttribute("data-testid"), dataIndex: element.getAttribute("data-index"), childCount: element.children.length, rect: box, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight };
    }).filter(Boolean).slice(0, 24);
    const composer = {};
    for (const testId of ["send-message", "stop-turn", "queue-message"]) {
      const element = document.querySelector(`[data-testid="${testId}"]`);
      composer[testId] = { visible: visible(element), disabled: element instanceof HTMLButtonElement ? element.disabled : null };
    }
    return {
      sampledAtPageTimeMs: Number(performance.now().toFixed(3)),
      viewport: {
        scrollHostTestId: host.getAttribute("data-testid"),
        scrollTop: Number(host.scrollTop.toFixed(2)),
        scrollHeight: host.scrollHeight,
        clientHeight: host.clientHeight,
        bottomGapPx: Number(Math.max(0, host.scrollHeight - host.clientHeight - host.scrollTop).toFixed(2)),
        listRect: rect(list),
        renderedMessageRowCount: rows.length,
        targetMarkerRowFound: rowSummaries.some((row) => row.targetMarkerFound),
        jumpToLatestVisible: Boolean(jumpRect && jumpRect.width > 0 && jumpRect.height > 0 && jumpStyle?.display !== "none" && jumpStyle?.visibility !== "hidden"),
      },
      marker: expectedMarker,
      rows: rowSummaries,
      nonTextChildSpacers: spacerCandidates,
      composer,
      sockets,
    };
  }, { expectedWorkspace: state.workspacePath, expectedMarker: marker });
}

return { resolveProvenanceReference, readFrozenGatewayRuntime, startFrozenGateway, assertSafeBundleRelativePath, assertNoSymlinkAncestors, verifyExactBundleTree, installPerformanceInstrumentation, configureRuntimeConsumerProbe, safeSeedErrorMessage, safeSeedErrorStack, beginSeedUiTraceInPage, endSeedUiTraceInPage, captureSeedFailureDom };
}
