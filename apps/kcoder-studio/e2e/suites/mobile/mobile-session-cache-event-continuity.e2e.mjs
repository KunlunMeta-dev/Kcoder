import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { AppServerStdioClient, waitForStdioChildClose } from "../../harness/app-server-stdio.mjs";
import { startApprovalModelFixture } from "../../harness/approval-model.mjs";
import { startChromium } from "../../harness/chromium.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { restorePinnedGatewayMobileDeployment } from "../../harness/mobile-pinned-gateway-deployment.mjs";
import { findOwnedExecutableProcesses, hashExecutableFile } from "../../harness/owned-executable-provenance.mjs";
import { requireExecutable, runE2E, waitFor } from "../../harness/run-context.mjs";
import {
  attemptMessages,
  isExactTurnStartNotification,
  isCompletedTurnNotification,
  loadSharedTurnMessageStatusDecoder,
  matchesExactHistoryReadResponse,
  matchesExactResumeResponse,
  matchesExactTurnNotification,
  matchesPostTerminalHistoryAuthority,
  notificationServerIdFromInitializeResponse,
  parseRpcFrame,
  readPageMessages,
  resumePageMessages,
} from "./mobile-session-cache-event-continuity.protocol.mjs";

const MOBILE_MOUNT = "/mobile";
const CASE_TIMEOUT_MS = 60_000;
const suffix = randomBytes(8).toString("hex");
const seedPrompt = `CACHE_EVENT_CONTINUITY_SEED_${suffix}`;
const actorPrompt = `CACHE_EVENT_CONTINUITY_ACTOR_${suffix}`;
const finalBody = `CACHE_EVENT_CONTINUITY_FINAL_${suffix}`;
const seedTitle = `Cache event continuity seed ${suffix}`;
const toolCallId = `cache-continuity-read-${suffix}`;
const toolFileMarker = `CACHE_EVENT_CONTINUITY_TOOL_FILE_${suffix}`;
const actorClientMessageId = `cache-continuity-client-${suffix}`;
const rustBinary = requiredAbsolutePath("KCODER_E2E_KCODER_BIN");
const expectedRustSha256 = requiredSha256("KCODER_E2E_KCODER_BIN_SHA256");

await runE2E(import.meta.url, {
  testId: "mobile-session-cache-event-continuity-first-door",
  tier: "full-integration",
  modelPolicy: "first-door only: a real local deterministic fixture turn reaches the Mobile runtime while its exact old authoritative resume page is held; no real Provider or paid model call",
  coverage: {
    included: ["held old thread/resume page", "real fixture turn notifications delivered before the unchanged old page", "visible and IndexedDB transcript continuity"],
    excluded: ["Gateway Broker duplicate-frame gate", "out-of-order upstream delivery overlap gate", "cross-process persistence recovery after a write failure"],
  },
}, async context => {
  const deployment = await restorePinnedGatewayMobileDeployment(context, {
    outputName: "mobile-session-cache-event-continuity-deployment",
  });
  const rustStat = await lstat(rustBinary);
  assert.ok(rustStat.isFile() && (rustStat.mode & 0o111) !== 0,
    "caller-pinned KCoder app-server must be an executable regular file");
  await requireExecutable(rustBinary, "caller-pinned KCoder app-server");
  const pinnedRust = await hashExecutableFile(rustBinary);
  assert.equal(pinnedRust.sha256, expectedRustSha256,
    "caller-pinned KCoder app-server bytes must match KCODER_E2E_KCODER_BIN_SHA256");

  const workspace = context.pathInState("workspace");
  const configDir = context.pathInState("config");
  const homeDir = context.pathInState("home");
  const tempRoot = context.pathInState("tmp");
  const emptyDesktopWebRoot = context.pathInState("empty-desktop-web-root");
  await Promise.all([
    mkdir(workspace, { recursive: true, mode: 0o700 }),
    mkdir(configDir, { recursive: true, mode: 0o700 }),
    mkdir(homeDir, { recursive: true, mode: 0o700 }),
    mkdir(tempRoot, { recursive: true, mode: 0o700 }),
    mkdir(emptyDesktopWebRoot, { recursive: true, mode: 0o700 }),
  ]);
  const toolFile = resolve(workspace, "event-continuity-tool.txt");
  await writeFile(toolFile, `${toolFileMarker}\n`, { encoding: "utf8", mode: 0o600 });

  const fixtureAudit = { unexpectedRequests: [], invalidToolResults: 0 };
  const model = await startApprovalModelFixture(context, {
    responseSteps: ({ body }) => {
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const serialized = JSON.stringify(messages);
      const hasActorPrompt = serialized.includes(actorPrompt);
      const hasSeedPrompt = serialized.includes(seedPrompt);
      const hasToolResult = messages.some(message => message?.role === "tool");
      if (hasActorPrompt && hasToolResult) {
        const lastMessage = messages.at(-1);
        if (lastMessage?.role !== "tool" || !String(lastMessage.content ?? "").includes(toolFileMarker)) {
          fixtureAudit.invalidToolResults++;
          return [{ delta: { role: "assistant", content: "FIXTURE_TOOL_RESULT_MISMATCH" } }, { finishReason: "stop" }];
        }
        return [
          { delta: { role: "assistant", content: "CACHE_EVENT_CONTINUITY_FINAL_" } },
          { delta: { content: `${suffix}` } },
          { finishReason: "stop" },
        ];
      }
      if (hasActorPrompt) {
        return [
          { delta: { role: "assistant", reasoning_content: "Inspecting the owned fixture file." } },
          {
            delta: {
              tool_calls: [{
                index: 0,
                id: toolCallId,
                type: "function",
                function: {
                  name: "read",
                  arguments: JSON.stringify({ file_path: toolFile, offset: 1, limit: 10 }),
                },
              }],
            },
          },
          { finishReason: "tool_calls" },
        ];
      }
      if (hasSeedPrompt) {
        return [
          { delta: { role: "assistant", content: `CACHE_EVENT_CONTINUITY_SEED_REPLY_${suffix}` } },
          { finishReason: "stop" },
        ];
      }
      fixtureAudit.unexpectedRequests.push({
        requestNumber: model.requests.length + 1,
        roles: messages.map(message => message?.role ?? "unknown"),
      });
      return [{ delta: { role: "assistant", content: "UNEXPECTED_CACHE_CONTINUITY_FIXTURE_REQUEST" } }, { finishReason: "stop" }];
    },
  });

  const apiKey = `cache-continuity-local-fixture-key-${suffix}`;
  context.registerSecret(apiKey);
  const settingsFile = await context.writeStateJson("event-continuity-settings.json", {
    active_provider: "cache-event-continuity-fixture",
    permission_mode: "yolo",
    max_retries: 0,
    providers: {
      "cache-event-continuity-fixture": {
        api_format: "openai_chat_completions",
        endpoint: model.baseUrl,
        default_model: "cache-event-continuity-model",
        context_window_tokens: 128_000,
        output_headroom_tokens: 1_024,
        max_output_tokens: 512,
        request_timeout_secs: 30,
        no_proxy: true,
        extra_body: {},
      },
    },
  });
  await context.writeStateJson("config/settings.json", {});
  await context.writeStateJson("config/credentials.json", {
    "cache-event-continuity-fixture": { type: "api", key: apiKey },
  });
  const serversFile = await context.writeStateJson("event-continuity-servers.json", [{
    id: "local",
    label: "Event continuity fixture",
    transport: "local",
    command: pinnedRust.path,
    workspace,
    settingsFile,
  }]);

  const processEnv = {
    HOME: homeDir,
    USERPROFILE: homeDir,
    XDG_CONFIG_HOME: configDir,
    KCODER_CONFIG_DIR: configDir,
    TMPDIR: tempRoot,
    TMP: tempRoot,
    TEMP: tempRoot,
    KCODER_TRAINING_MODE: "true",
  };
  const seed = await seedCompletedThread(context, {
    binaryPath: pinnedRust.path,
    binarySha256: expectedRustSha256,
    configDir,
    homeDir,
    tempRoot,
    settingsFile,
    workspace,
    title: seedTitle,
    prompt: seedPrompt,
    env: processEnv,
  });
  assert.equal(typeof seed.title, "string", "the stdio seed helper must return the title it wrote to the real thread");
  assert.ok(seed.title.trim().length > 0, "the seeded thread title must be non-empty before Browser interaction begins");
  assert.equal(seed.title, seedTitle, "the seeded thread title must match the exact configured Mobile search title");

  // Register before Gateway startup so RunContext's reverse cleanup stops all owned
  // Rust children before this final on-disk executable-pin check runs.
  context.addCleanup("verify caller-pinned Rust app-server bytes remain unchanged", async () => {
    const current = await hashExecutableFile(rustBinary);
    assert.equal(current.sha256, expectedRustSha256,
      "the configured Rust app-server bytes changed during the E2E run");
    await context.writeArtifactJsonInternal("mobile-session-cache-event-continuity-rust-postflight.json", {
      unchanged: true,
      callerSha256: expectedRustSha256,
      executablePath: current.path,
      size: current.size,
    });
  });

  const gatewayLabel = "mobile-session-cache-event-continuity-gateway";
  const gateway = await startGateway(context, {
    auth: true,
    label: gatewayLabel,
    workspace,
    serversFile,
    kcoderBin: pinnedRust.path,
    env: {
      ...processEnv,
      KCODER_STUDIO_MOCK: "0",
      KCODER_STUDIO_WEB_ROOT: emptyDesktopWebRoot,
      KCODER_STUDIO_MOBILE_WEB_ROOT: deployment.deployment.path,
      KCODER_STUDIO_SCENARIO: "",
    },
  });
  assert.ok(gateway.authToken.length > 0, "the owned Gateway must use auth:true for the Mobile bootstrap gate");
  const mobileEntryUrl = new URL(`${MOBILE_MOUNT}/`, gateway.baseUrl).href;
  const mobileResponse = await fetch(mobileEntryUrl, { headers: { accept: "text/html" } });
  assert.equal(mobileResponse.status, 200,
    "the pinned production Mobile archive must be served at the actual Gateway /mobile/ mount");
  await mobileResponse.body?.cancel();

  const chromium = await startChromium(context, {
    label: "mobile-session-cache-event-continuity-chromium",
    profileName: "mobile-session-cache-event-continuity",
    startTimeoutMs: 60_000,
  });
  const page = await chromium.newPage({ viewport: { width: 390, height: 844 } });
  const protocol = createContinuityBridgeState(seed.threadId, workspace);
  const bootstrap = createBootstrapCapture(context, page, gateway);
  const cdp = await page.context().newCDPSession(page);
  const handshake = installWebSocketHandshakeCapture(cdp);
  await cdp.send("Network.enable");
  await installEventContinuityBridge(page, protocol, {
    threadId: seed.threadId,
    serverId: "local",
    workspace,
    prompt: actorPrompt,
    clientMessageId: actorClientMessageId,
    bootstrap,
  });
  const browserErrors = [];
  page.on("pageerror", error => browserErrors.push(error.message));

  await page.goto(mobileEntryUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await connectAuthenticatedMobile(page, gateway, mobileEntryUrl);
  await waitFor(() => bootstrap.result?.rpcToken ? true : null,
    15_000, "the actual auth:true Mobile session bootstrap response with Gateway-issued access and RPC tokens", 50, context.abortSignal);
  assert.equal(bootstrap.requestCount, 1,
    "Mobile must perform one actual POST /api/mobile/session during the direct connection flow");
  assert.deepEqual(bootstrap.statuses, [200], "the actual Mobile session bootstrap must return HTTP 200");
  assert.equal(bootstrap.postedPairingTokenMatches, true,
    "Mobile's session bootstrap must carry the exact auth:true Gateway pairing token entered in the UI");
  assert.ok(bootstrap.result.accessToken && bootstrap.result.rpcToken,
    "the actual bootstrap response must provide both session accessToken and a distinct RPC token");
  assert.notEqual(bootstrap.result.accessToken, bootstrap.result.rpcToken,
    "the Gateway session accessToken and RPC token must remain distinct credentials");
  assert.notEqual(bootstrap.result.rpcToken, gateway.authToken,
    "the RPC token must come from the actual session response, not the UI pairing token");

  const profileId = profileIdFromMobileRoute(page.url());
  await page.getByTestId("sessions").click();
  await page.getByTestId("session-search").fill(seed.title);
  const session = page.getByTestId(`session-${seed.threadId}`);
  await session.waitFor({ state: "visible", timeout: 20_000 });
  assert.equal(await session.count(), 1,
    "the searched thread id must identify exactly one visible Mobile session row");
  await session.click();

  let terminal;
  try {
    terminal = await waitFor(() => {
      throwIfBridgeFailed(protocol);
      return protocol.terminal && protocol.heldResume?.releasedAtMs !== null
        ? protocol.terminal
        : null;
    }, CASE_TIMEOUT_MS, "the real fixture turn to finish and its exact old resume page to be released afterwards", 25, context.abortSignal);
  } catch (error) {
    await context.writeArtifactJson("mobile-session-cache-event-continuity-terminal-barrier-failure.json",
      projectTerminalBarrierFailure(protocol, {
        pageUrl: page.url(),
        bootstrap,
        serverId: "local",
        workspace,
        threadId: seed.threadId,
        browserErrorCount: browserErrors.length,
        seedPrompt,
        actorPrompt,
        modelRequests: model.requests,
        fixtureAudit,
      })).catch(() => undefined);
    throw error;
  }
  assert.ok(protocol.heldResume, "the target's exact thread/resume response must be held during the fixture turn");
  assert.equal(protocol.heldResume.socketId, terminal.socketId,
    "the held resume and injected turn must use the same exact Mobile runtime WebSocket");
  assert.equal(protocol.heldResume.responseIdMatched, true,
    "the held response must match the original browser JSON-RPC request id by type and value");
  assert.equal(protocol.heldResume.rawForwardedUnchanged, true,
    "the stale authoritative resume frame must be forwarded without changing its raw bytes");
  assert.ok(terminal.forwardedAtMs < protocol.heldResume.releasedAtMs,
    "the terminal fixture notification must reach Mobile before the old resume response is released");
  assert.equal(protocol.heldResume.resumeRequestThreadId, seed.threadId,
    "the held browser request must target the seeded canonical thread");
  assert.equal(protocol.heldResume.responseThreadId, seed.threadId,
    "the unchanged held response must belong to the seeded canonical thread");
  assert.equal(protocol.heldResume.historyStatus, "ready",
    "the held response must contain the old authoritative ready history page");
  assert.equal(protocol.heldResume.pageContainsSeed, true,
    "the held old page must contain the separately seeded intent");
  assert.equal(protocol.heldResume.pageContainsActorPrompt, false,
    "the held old page must not contain the later injected user turn");
  protocol.heldResume.pageContainsActorTurn = protocol.heldResume.pageTurnIds.includes(protocol.actorAck.turnId);
  assert.equal(protocol.heldResume.pageContainsActorTurn, false,
    "the held old page must not contain the later injected turn identity");

  const route = taskRoute(page.url());
  assert.equal(route.profileId, profileId, "the real task route must retain the Mobile-created profile");
  assert.equal(route.serverId, "local", "the task route must remain on the exact local fixture server");
  assert.equal(route.threadId, seed.threadId, "the task route must remain on the seeded thread");
  assert.equal(route.cwd, workspace, "the task route must preserve the exact owned workspace path");

  assert.equal(protocol.browserMethodCounts["thread/start"] ?? 0, 0,
    "Mobile must not create a new thread in this resume-continuity gate");
  assert.equal(protocol.browserMethodCounts["turn/start"] ?? 0, 0,
    "the Browser Mobile client must not issue the fixture actor's turn/start");
  assert.equal(protocol.actorTurnStartCount, 1,
    "the bridge must issue exactly one separate, actual fixture-actor turn/start");
  assert.equal(protocol.actorAck?.threadId, seed.threadId,
    "the actual Rust turn/start acknowledgement must name the seeded thread");
  assert.equal(protocol.actorAck?.socketId, protocol.heldResume.socketId,
    "the fixture actor acknowledgement must arrive on the same exact runtime socket as the held resume");
  assert.equal(protocol.actorAck?.status, "running",
    "the actual Rust turn/start acknowledgement must confirm a running fixture turn");
  assert.equal(typeof protocol.actorAck?.turnId, "string");
  assert.equal(typeof protocol.actorAck?.attemptId, "string");

  const actorSocket = protocol.sockets.find(socket => socket.socketId === protocol.heldResume.socketId);
  assert.ok(typeof actorSocket?.notificationServerId === "string" && actorSocket.notificationServerId,
    "the held runtime socket must identify the real upstream app-server before accepting its turn notifications");
  assert.equal(actorSocket.notificationServerIdentityConflict, false,
    "the exact runtime socket must not report conflicting upstream server identities");
  const actorIdentity = {
    serverId: actorSocket.notificationServerId,
    threadId: seed.threadId,
    turnId: protocol.actorAck.turnId,
    attemptId: protocol.actorAck.attemptId,
    expectedSocketId: protocol.heldResume.socketId,
  };
  const actorNotifications = protocol.notifications.filter(notification => matchesExactTurnNotification(
    notification.frame,
    { ...actorIdentity, socketId: notification.socketId },
  ));
  assert.ok(actorNotifications.length >= 7,
    "actual exact-owner notifications must include turn start, thinking, tool, text chunks, completion, and terminal");
  assert.ok(actorSocket.notificationServerId !== "local",
    "the Rust app-server notification identity must stay distinct from the Gateway route alias");
  assert.ok(actorNotifications.every(notification => notification.frame.params?.serverId === actorSocket.notificationServerId &&
    notification.frame.params?.threadId === seed.threadId),
  "every recorded fixture notification must remain bound to the exact upstream app-server and seeded thread");
  assert.ok(protocol.actorEvents.every(event => event.socketId === protocol.heldResume.socketId),
    "every recorded fixture event must arrive on the exact held-resume runtime socket");
  assert.ok(protocol.actorEvents.some(event => event.method === "turn/started" && event.attemptId === protocol.actorAck.attemptId),
    "the actual started event must retain the attempt id returned by the real turn/start acknowledgement");
  assert.ok(protocol.actorEvents.some(event => event.method === "item/event" && event.eventType === "assistant_thinking_delta"),
    "the actual provider reasoning stream must project a thinking event");
  assert.ok(protocol.actorEvents.some(event => event.method === "item/started" && event.itemType === "toolCall" && event.itemName === "read" && event.itemId === toolCallId),
    "the actual fixture turn must start its unique owned read tool call");
  assert.ok(protocol.actorEvents.some(event => event.method === "item/completed" && event.itemType === "toolCall" && event.itemId === toolCallId && event.itemStatus === "completed"),
    "the actual fixture turn must complete its read tool call");
  assert.ok(protocol.actorEvents.filter(event => event.method === "item/delta" && event.deltaText.length > 0).length >= 2,
    "the actual final assistant body must reach Mobile in at least two text chunks");
  assert.ok(protocol.actorEvents.some(event => event.method === "turn/completed" && event.turnStatus === "completed"),
    "the real Rust terminal notification must report completed");
  assert.equal(protocol.actorEvents.some(event => event.actorTurnId !== protocol.actorAck.turnId), false,
    "recorded actor notifications must not drift to another turn id");
  for (let index = 1; index < protocol.actorEvents.length; index++) {
    assert.ok(protocol.actorEvents[index - 1].wireSequence < protocol.actorEvents[index].wireSequence,
      "the exact turn's real server sequence must advance monotonically on this socket");
  }

  const handshakeProof = await waitFor(() => {
    const result = matchingAuthenticatedHandshake(
      handshake,
      gateway,
      bootstrap.result,
      workspace,
      protocol.heldResume?.runtimeSocketUrl,
    );
    return result ?? null;
  }, 10_000, "the actual Mobile runtime WebSocket handshake with the paired access token, Origin, protocol, and RPC query", 25, context.abortSignal);
  assert.equal(handshakeProof.matches, true,
    "the Mobile runtime WebSocket must use the exact Gateway-issued access token, Origin, and RPC token");
  assert.equal(handshakeProof.channel, "runtime", "the resume socket must be the runtime channel");
  assert.equal(handshakeProof.serverId, "local", "the resume socket must target the exact local server");
  assert.equal(handshakeProof.workspace, workspace, "the resume socket must carry the exact workspace scope");
  protocol.heldResume.cdpRequestId = handshakeProof.requestId;
  assert.ok(protocol.heldResume.cdpRequestId,
    "the exact held resume socket URL must resolve to a concrete CDP WebSocket request id");
  assert.equal(protocol.heldResume.socketUrlProof?.matchesBootstrapRpcToken, true,
    "the WebSocket intercepted for the exact resume must use the bootstrap-issued RPC token");
  assert.equal(protocol.heldResume.runtimeSocketRouteMatches, true,
    "the held resume socket must be the exact runtime channel with the owned server and workspace query");

  const authority = await waitFor(() => {
    throwIfBridgeFailed(protocol);
    return protocol.readResponses.find(response => matchesPostTerminalHistoryAuthority({
      response,
      requests: protocol.browserRequests,
      terminalAtMs: terminal.receivedAtMs,
      socketId: protocol.heldResume?.socketId,
      serverId: "local",
      workspace,
      threadId: seed.threadId,
    })) ?? null;
  }, CASE_TIMEOUT_MS, "the post-terminal real Mobile transcript read to contain the actual fixture attempt", 50, context.abortSignal);
  const readRequests = protocol.browserRequests.filter(request =>
    ["thread/read", "thread/read/indexed"].includes(request.method) && request.threadId === seed.threadId);
  const postTerminalReads = readRequests.filter(request => request.sentAtMs >= terminal.receivedAtMs);
  const authorityRequest = readRequests.find(request =>
    Object.is(request.id, authority.requestId) && request.socketId === authority.socketId);
  assert.ok(postTerminalReads.length >= 1,
    "the real completed turn must cause Mobile to fetch an authoritative transcript page");
  assert.ok(postTerminalReads.length <= 3,
    "post-terminal authoritative transcript reads must remain bounded to at most three requests");
  assert.ok(readRequests.length <= 4,
    "all exact-thread transcript reads in the continuity gate must remain bounded");
  assert.ok(readRequests.every(request => request.socketId === protocol.heldResume.socketId),
    "every exact-thread transcript read must use the same exact Mobile runtime socket as the held resume");
  assert.ok(readRequests.every(request => request.serverId === "local" && request.channel === "runtime" && request.workspace === workspace),
    "every exact-thread transcript read must retain the held resume's exact server and workspace scope");
  assert.ok(authorityRequest,
    "the authoritative response must correlate to its own exact browser transcript-read request");
  assert.ok(authorityRequest.sentAtMs >= terminal.receivedAtMs,
    "the authoritative transcript-read request itself must be sent after the terminal event");
  assert.ok(authority.receivedAtMs >= terminal.receivedAtMs,
    "the authoritative transcript-read response must arrive after the terminal event");
  assert.ok(postTerminalReads.some(request => request === authorityRequest),
    "the response that proves the injected attempt must be one of the bounded post-terminal reads");
  assert.equal(authority.socketId, protocol.heldResume.socketId,
    "the authoritative post-terminal read must arrive on the held resume's exact runtime socket");
  assert.equal(authority.serverId, "local",
    "the authoritative read response must be correlated to the exact fixture server");
  assert.equal(authority.channel, "runtime",
    "the authoritative read response must be correlated to the runtime channel");
  assert.equal(authority.workspace, workspace,
    "the authoritative read response must be correlated to the exact fixture workspace");
  assert.equal(authority.responseThreadId, seed.threadId,
    "the authoritative response envelope containing the injected attempt must name the exact resumed thread");
  assert.equal(authority.userMessageCount, 1,
    "the authoritative page must contain exactly one user row for the actual injected attempt");
  assert.equal(authority.assistantMessageCount, 1,
    "the authoritative page must contain exactly one completed assistant row for the actual injected attempt");
  assert.equal(authority.assistantContent, finalBody,
    "the authoritative page must carry the exact final assistant content from the real fixture turn");
  assert.equal(authority.responseIdMatched, true,
    "the authoritative transcript page must match the exact browser history-read request id");

  const assistantRow = page.getByTestId("message-assistant").filter({ hasText: finalBody });
  await assistantRow.waitFor({ state: "visible", timeout: 30_000 });
  assert.equal(await assistantRow.count(), 1,
    "the final assistant turn must render as exactly one visible Mobile assistant row");
  const visibleAssistantText = normalizeVisibleText(await assistantRow.innerText());
  assert.equal(countLiteralOccurrences(visibleAssistantText, finalBody), 1,
    "the final assistant body must occur exactly once in the visible row after the old snapshot arrives");
  const visibleUserRow = page.getByTestId("message-list").getByTestId("message-user").filter({ hasText: actorPrompt });
  try {
    await visibleUserRow.waitFor({ state: "visible", timeout: 20_000 });
    assert.equal(await visibleUserRow.count(), 1,
      "the actual fixture actor's user intent must render exactly once after the late old snapshot arrives");
  } catch (error) {
    const diagnostics = await captureActorUserVisibilityDiagnostics(page, {
      profileId,
      gatewayBaseUrl: gateway.baseUrl,
      authMode: bootstrap.result.authMode,
      deviceId: bootstrap.result.deviceId,
      authorizationGeneration: bootstrap.result.authorizationGeneration,
      workspace,
      threadId: seed.threadId,
      serverId: "local",
      heldSocketId: protocol.heldResume.socketId,
      actorPrompt,
      finalBody,
      actorAck: protocol.actorAck,
      authority,
    }).catch(() => null);
    if (diagnostics) {
      await context.writeArtifactJson("mobile-session-cache-event-continuity-actor-user-visibility-failure.json", diagnostics)
        .catch(() => undefined);
    }
    throw error;
  }
  const visibleUserRowCount = await visibleUserRow.count();
  const sendButton = page.getByTestId("send-message");
  const messageInput = page.getByTestId("message-input");
  await sendButton.waitFor({ state: "visible", timeout: 20_000 });
  let composerProbe = null;
  let composerFailurePhase = "empty-draft";
  try {
    await messageInput.fill("");
    assert.equal(await messageInput.inputValue(), "",
      "the composer must be empty before checking idle send availability");
    assert.equal(await sendButton.isEnabled(), false,
      "an empty Mobile composer must keep send disabled after the real terminal and late old snapshot");
    assert.equal(await page.getByTestId("stop-turn").count(), 0,
      "the late old snapshot must not downgrade the completed turn back to a running state");

    composerFailurePhase = "unsent-probe-draft";
    const probeDraft = `CACHE_EVENT_CONTINUITY_UNSENT_PROBE_${suffix}`;
    await messageInput.fill(probeDraft);
    await waitFor(async () => (await sendButton.isEnabled()) ? true : null,
      5_000, "send to become enabled for a nonempty unsent probe draft", 25, context.abortSignal);
    assert.equal(await messageInput.inputValue(), probeDraft,
      "the run-owned probe draft must remain in the composer without being sent");
    assert.equal(await sendButton.isEnabled(), true,
      "Mobile must enable send for a nonempty draft after the real terminal and late old snapshot");
    assert.equal(await page.getByTestId("stop-turn").count(), 0,
      "an unsent probe draft must not make the completed turn appear running");
    composerProbe = {
      emptyDraftDisabled: true,
      nonemptyProbeDraftEnabled: true,
      probeDraftLength: probeDraft.length,
      probeClicked: false,
      stopTurnCount: 0,
    };
  } catch (error) {
    const diagnostics = await captureComposerSendStateDiagnostics(page, {
      phase: composerFailurePhase,
      protocol,
      terminal,
      authority,
      expectedWorkspace: workspace,
      expectedThreadId: seed.threadId,
    }).catch(() => null);
    if (diagnostics) {
      await context.writeArtifactJson("mobile-session-cache-event-continuity-composer-send-state-failure.json", diagnostics)
        .catch(() => undefined);
    }
    throw error;
  }

  const currentTranscript = await waitFor(async () => {
    const snapshot = await readCurrentTranscript(page);
    if (!snapshot.ready || snapshot.lastKey !== snapshot.entry?.key ||
        snapshot.scope?.threadId !== seed.threadId) return null;
    const exact = projectAttemptEvidence(snapshot.messages, protocol.actorAck, actorPrompt, finalBody);
    return exact ? { ...snapshot, exact } : null;
  }, 30_000, "the exact final attempt to become the read-only current IndexedDB transcript", 100, context.abortSignal);
  assert.equal(currentTranscript.scope.profile.id, profileId,
    "the current IndexedDB transcript must belong to the profile established by the actual Mobile bootstrap");
  assert.equal(currentTranscript.scope.profile.baseUrl, gateway.baseUrl,
    "the current IndexedDB transcript must bind the exact authenticated Gateway base URL");
  assert.equal(currentTranscript.scope.profile.authMode, bootstrap.result.authMode,
    "the current IndexedDB transcript must bind the authorization mode from the real Mobile bootstrap");
  if (bootstrap.result.authMode === "device") {
    assert.equal(currentTranscript.scope.profile.deviceId, bootstrap.result.deviceId,
      "the device-bound IndexedDB scope must match the exact device id returned by Mobile bootstrap");
    assert.equal(typeof bootstrap.result.authorizationGeneration, "string",
      "the actual durable-device bootstrap must return an authorization generation");
    assert.equal(currentTranscript.scope.profile.authorizationGeneration, bootstrap.result.authorizationGeneration,
      "the current IndexedDB transcript must bind the exact bootstrap authorization generation");
  }
  assert.equal(currentTranscript.scope.target.id, "local",
    "the current IndexedDB transcript must bind the exact local target identity");
  assert.equal(currentTranscript.scope.cwd, workspace,
    "the current IndexedDB transcript must bind the exact workspace path");
  assert.match(currentTranscript.scope.target.connectionFingerprint, /^[a-f0-9]{64}$/,
    "the current IndexedDB transcript must retain a canonical target connection fingerprint");
  assert.equal(currentTranscript.exact.userMessageCount, 1,
    "the current IndexedDB transcript must contain one actual injected user row");
  assert.equal(currentTranscript.exact.assistantMessageCount, 1,
    "the current IndexedDB transcript must contain one actual final assistant row");
  assert.equal(currentTranscript.exact.assistantId, authority.assistantId,
    "the current IndexedDB transcript must use the actual authoritative history row id, not a guessed id");
  assert.equal(currentTranscript.exact.assistantContent, finalBody,
    "the current IndexedDB transcript must contain the exact terminal assistant body");
  const decodeTurnMessageStatus = await loadSharedTurnMessageStatusDecoder();
  const decodedAssistantStatus = decodeTurnMessageStatus(currentTranscript.exact.assistantStatus);
  assert.equal(decodedAssistantStatus.status, "done",
    "the current authority-correlated cache row must decode to a completed visible message status");

  assert.equal(protocol.actorTurnStartCount, 1,
    "one injected fixture actor intent must be the only post-seed turn/start in this gate");
  assert.equal(seed.turnStartCount, 1,
    "the separate stdio seed must account for exactly one isolated seed intent");
  assert.equal(model.requests.length, 3,
    "the deterministic fixture must observe one seed request and the actor's tool-call plus tool-result continuation");
  assert.deepEqual(fixtureAudit.unexpectedRequests, [],
    "the fixture must not receive an unrelated or unclassified model request");
  assert.equal(fixtureAudit.invalidToolResults, 0,
    "the actor continuation must be based on the actual owned read tool result");
  assert.deepEqual(browserErrors, [], "the archived production Mobile page must not raise browser page errors");

  const gatewayRuntime = await verifyOwnedGatewayRuntime(context, gateway, gatewayLabel, rustBinary, expectedRustSha256, workspace);
  await context.writeArtifactJson("mobile-session-cache-event-continuity-evidence.json", {
    gate: "first-door held old authoritative resume page; fixture turn notifications arrive and complete before the unchanged page is forwarded",
    coverage: {
      included: ["exact resume socket/request id/thread match", "actual local provider reasoning, read tool, chunked final body, and ACK-bound turn-level terminal correlation", "visible exactly-once transcript", "read-only IndexedDB current transcript"],
      excluded: ["Gateway Broker duplicate-frame gate", "upstream overlap ordering gate", "cross-process persistence recovery after a failed cache write"],
    },
    mobilePins: deployment.sourcePins,
    rustPin: { path: pinnedRust.path, sha256: expectedRustSha256, size: pinnedRust.size },
    gatewayRuntime,
    seed: {
      method: "separate RunContext-owned app-server stdio intent before Gateway startup",
      threadId: seed.threadId,
      turnId: seed.turnId,
      attemptId: seed.attemptId,
      turnStartCount: seed.turnStartCount,
      historyMessageCount: seed.messageCount,
      appServer: seed.provenance,
    },
    browser: {
      bootstrap: {
        requestCount: bootstrap.requestCount,
        statuses: bootstrap.statuses,
        pairingTokenMatched: bootstrap.postedPairingTokenMatches,
        accessTokenCapturedInMemory: true,
        rpcTokenCapturedFromSameResponseInMemory: true,
        rawCredentialValuesPersisted: false,
      },
      websocket: handshakeProof,
      route: {
        runtimeSocketId: protocol.heldResume.socketId,
        exactResumeRequestId: String(protocol.heldResume.requestId),
        exactResponseIdMatched: protocol.heldResume.responseIdMatched,
        heldRawFrameForwardedUnchanged: protocol.heldResume.rawForwardedUnchanged,
        oldPageHadSeed: protocol.heldResume.pageContainsSeed,
        oldPageHadActorPrompt: protocol.heldResume.pageContainsActorPrompt,
        oldPageHadActorTurn: protocol.heldResume.pageContainsActorTurn,
      },
      mobileTurnStartCount: protocol.browserMethodCounts["turn/start"] ?? 0,
      mobileThreadStartCount: protocol.browserMethodCounts["thread/start"] ?? 0,
      fixtureActorTurnStartCount: protocol.actorTurnStartCount,
      exactTurnId: protocol.actorAck.turnId,
      exactAttemptId: protocol.actorAck.attemptId,
      notificationServerIdentity: {
        captured: Boolean(actorSocket.notificationServerId),
        source: actorSocket.notificationServerIdSource,
        distinctFromGatewayRouteAlias: actorSocket.notificationServerId !== "local",
        conflict: actorSocket.notificationServerIdentityConflict === true,
      },
      eventKinds: protocol.actorEvents.map(event => ({
        method: event.method,
        eventType: event.eventType,
        itemType: event.itemType,
        itemId: event.itemId,
        itemName: event.itemName,
        itemStatus: event.itemStatus,
        hasTextDelta: event.deltaText.length > 0,
        sequence: event.wireSequence,
      })),
      terminalBeforeOldResumeRelease: terminal.forwardedAtMs < protocol.heldResume.releasedAtMs,
      terminalCorrelation: {
        basis: "exact ACK-bound turn id plus upstream server, thread, and held runtime socket; any supplied attempt id must match",
        notificationAttemptIdPresent: terminal.attemptId !== null,
        notificationAttemptIdMatchesAcknowledgement: terminal.attemptId === null
          ? null
          : terminal.attemptId === protocol.actorAck.attemptId,
      },
      postTerminalTranscriptReadCount: postTerminalReads.length,
      allTargetTranscriptReadCount: readRequests.length,
      authoritativeAttempt: {
        runtimeSocketId: authority.socketId,
        readRequestId: String(authority.requestId),
        readRequestMsAfterTerminal: authorityRequest.sentAtMs - terminal.receivedAtMs,
        responseMsAfterTerminal: authority.receivedAtMs - terminal.receivedAtMs,
        serverId: authority.serverId,
        channel: authority.channel,
        cwd: authority.workspace,
        threadId: authority.responseThreadId,
        userMessageCount: authority.userMessageCount,
        assistantMessageCount: authority.assistantMessageCount,
        assistantMessageId: authority.assistantId,
        assistantContentSha256: sha256(finalBody),
      },
      visibleAssistantRowCount: await assistantRow.count(),
      visibleFinalBodyOccurrences: countLiteralOccurrences(visibleAssistantText, finalBody),
      visibleUserRowCount,
      composerProbe,
      sendEnabled: await sendButton.isEnabled(),
      stopTurnCount: await page.getByTestId("stop-turn").count(),
      indexedDb: {
        readOnly: true,
        currentManifestKeyMatchesEntry: currentTranscript.lastKey === currentTranscript.entry.key,
        key: currentTranscript.entry.key,
        slot: currentTranscript.entry.slot,
        dataRevision: currentTranscript.entry.dataRevision,
        profileId: currentTranscript.scope.profile.id,
        serverId: currentTranscript.scope.target.id,
        cwd: currentTranscript.scope.cwd,
        threadId: currentTranscript.scope.threadId,
        userMessageId: currentTranscript.exact.userId,
        assistantMessageId: currentTranscript.exact.assistantId,
        assistantStatus: currentTranscript.exact.assistantStatus,
        assistantContentSha256: sha256(currentTranscript.exact.assistantContent),
      },
      fixture: {
        requestCount: model.requests.length,
        unexpectedRequestCount: fixtureAudit.unexpectedRequests.length,
        invalidToolResultCount: fixtureAudit.invalidToolResults,
        requests: model.requests.map(request => ({
          model: request.model ?? null,
          roles: (request.messages ?? []).map(message => message?.role ?? "unknown"),
          includesSeedPrompt: JSON.stringify(request.messages ?? []).includes(seedPrompt),
          includesActorPrompt: JSON.stringify(request.messages ?? []).includes(actorPrompt),
          toolResultCount: (request.messages ?? []).filter(message => message?.role === "tool").length,
        })),
        noExternalProvider: true,
      desktopRendererMounted: false,
      },
      browserErrors,
    },
  });

  await cdp.detach().catch(() => {});
});

async function seedCompletedThread(context, input) {
  const label = "mobile-session-cache-event-continuity-stdio-seed";
  const binary = await hashExecutableFile(input.binaryPath);
  assert.equal(binary.sha256, input.binarySha256, "seed executable must retain its caller-pinned SHA-256");
  const env = context.isolatedEnvironment({
    ...input.env,
    KCODER_STUDIO_MOCK: "0",
  });
  const child = context.spawnOwned(label, binary.path, [
    "--settings-file", input.settingsFile,
    "--cwd", input.workspace,
    "app-server", "--training-mode",
  ], { cwd: input.workspace, env, stdin: "pipe" });
  assert.ok(child.stdin && child.stdout, "the owned stdio seed app-server must expose JSONL stdin/stdout");
  const client = new AppServerStdioClient(label, child, { defaultTimeoutMs: CASE_TIMEOUT_MS });
  const owner = context.processes.get(label);
  assert.ok(owner?.pid === child.pid && owner.pgid > 0,
    "the seed app-server must be registered under its exact RunContext process owner");
  const seedProcess = await waitFor(async () => {
    const matches = await findOwnedExecutableProcesses({ pgid: owner.pgid, executablePath: binary.path });
    return matches.find(item => item.pid === child.pid) ?? null;
  }, 10_000, "the pinned app-server stdio seed process", 50, context.abortSignal);
  assert.equal(seedProcess.sha256, input.binarySha256, "the running seed app-server bytes must match the caller pin");
  assert.equal(await realpath(`/proc/${child.pid}/cwd`), input.workspace,
    "the seed app-server must run in the exact owned workspace");

  let closed = false;
  context.addCleanup(`close owned ${label} JSONL child`, async () => {
    if (closed) return;
    if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end();
    await waitForStdioChildClose(child, 10_000, label).catch(() => undefined);
    await context.stopOwned(label).catch(() => undefined);
    client.closeReader();
    closed = true;
  });
  const initialized = await client.request("initialize", {
    protocolVersion: "2026-07-27",
    clientInfo: { name: "mobile-session-cache-event-continuity-seed", version: "1" },
  });
  assert.equal(initialized.error, undefined, "the separate stdio seed app-server must initialize successfully");
  const started = await client.request("thread/start", {});
  assert.equal(started.error, undefined, "the separate stdio seed must create one completed history thread");
  const threadId = started.result?.thread?.id;
  assert.ok(typeof threadId === "string" && threadId.length > 0,
    "the stdio seed app-server must return its canonical thread id");
  const turn = await client.request("turn/start", {
    threadId,
    input: [{ type: "text", text: input.prompt }],
    permissionMode: "yolo",
  });
  assert.equal(turn.error, undefined, "the separate seed intent must be accepted by the real app-server");
  const turnId = turn.result?.turn?.id;
  const attemptId = turn.result?.turn?.attemptId;
  assert.ok(typeof turnId === "string" && turnId.length > 0,
    "the seed turn/start must return an actual turn id");
  assert.ok(typeof attemptId === "string" && attemptId.length > 0,
    "the seed turn/start must return its actual attempt id");
  const completed = await client.waitForNotification(frame =>
    frame.method === "turn/completed" && frame.params?.threadId === threadId && frame.params?.turnId === turnId,
  CASE_TIMEOUT_MS, "seed turn/completed");
  assert.equal(completed.params?.turn?.status, "completed", "the stdio seed intent must complete before Gateway startup");
  const metadata = await client.request("thread/metadata/update", { threadId, title: input.title });
  assert.equal(metadata.error, undefined, "the seeded thread title must be available to the Mobile history list");
  const page = await client.request("thread/read", { threadId, limit: 50 });
  assert.equal(page.error, undefined, "the separate stdio seed must read back its authoritative completed history");
  assert.ok(Array.isArray(page.result?.messages) && page.result.messages.length > 0,
    "the seed app-server must persist a real history page before the Mobile Gateway starts");
  assert.ok(page.result.messages.some(message => message.role === "user" && message.content?.includes(input.prompt)),
    "the completed seed history must contain its unique separately archived intent");
  const messageIds = page.result.messages.map(message => message.id);
  assert.equal(new Set(messageIds).size, messageIds.length, "the seed authoritative page must have unique canonical row ids");
  const evidence = {
    pid: child.pid,
    pgid: owner.pgid,
    cwd: input.workspace,
    binaryPath: binary.path,
    binarySha256: seedProcess.sha256,
    binarySize: binary.size,
  };

  if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end();
  const exit = await waitForStdioChildClose(child, 10_000, label);
  await context.stopOwned(label);
  client.closeReader();
  closed = true;
  assert.equal(exit.code, 0, "the stdio seed app-server must exit cleanly before Gateway startup");
  const remaining = await findOwnedExecutableProcesses({ pgid: owner.pgid, executablePath: binary.path });
  assert.deepEqual(remaining, [], "the completed stdio seed process group must be gone before Gateway startup");
  return {
    threadId,
    title: input.title,
    turnId,
    attemptId,
    turnStartCount: 1,
    messageCount: page.result.messages.length,
    provenance: { ...evidence, exitCode: exit.code, allSeedChildrenGoneBeforeGateway: true },
  };
}

function createContinuityBridgeState(threadId, workspace) {
  return {
    threadId,
    workspace,
    socketCount: 0,
    browserRequests: [],
    browserMethodCounts: {},
    notifications: [],
    notificationMetadata: [],
    actorEvents: [],
    readResponses: [],
    actorTurnStartCount: 0,
    actorAck: null,
    heldResume: null,
    terminal: null,
    error: null,
    sockets: [],
  };
}

async function installEventContinuityBridge(page, state, expected) {
  await page.routeWebSocket("**/rpc*", route => {
    const socketId = `mobile-runtime-${++state.socketCount}`;
    let url;
    try { url = new URL(route.url()); } catch { url = null; }
    const socketProjection = {
      socketId,
      pathname: url?.pathname ?? null,
      serverId: url?.searchParams.get("server") ?? null,
      channel: url?.searchParams.get("channel") ?? null,
      workspace: url?.searchParams.get("workspace") ?? null,
      hasRpcToken: Boolean(url?.searchParams.get("token")),
      notificationServerId: null,
      notificationServerIdSource: null,
      notificationServerIdentityConflict: false,
    };
    state.sockets.push(socketProjection);
    const exactRuntimeSocket = url?.pathname.endsWith("/rpc") === true &&
      url.searchParams.get("server") === expected.serverId &&
      url.searchParams.get("channel") === "runtime" &&
      url.searchParams.get("workspace") === expected.workspace;
    const upstream = route.connectToServer();
    const requests = new Map();
    let heldResumeRaw = null;
    let heldResumeRequest = null;
    let actorRequestId = null;
    let actorTurnId = null;
    let actorAttemptId = null;
    let actorTerminalSent = false;

    route.onMessage(raw => {
      const frame = parseRpcFrame(raw);
      if (frame && frame.id !== undefined && typeof frame.method === "string") {
        const params = frame.params ?? {};
        const request = {
          socketId,
          id: frame.id,
          method: frame.method,
          threadId: typeof params.threadId === "string" ? params.threadId : null,
          params,
          sentAtMs: performance.now(),
        };
        requests.set(frame.id, request);
        state.browserRequests.push({
          socketId,
          id: frame.id,
          method: frame.method,
          threadId: request.threadId,
          serverId: socketProjection.serverId,
          channel: socketProjection.channel,
          workspace: socketProjection.workspace,
          sentAtMs: request.sentAtMs,
        });
        state.browserMethodCounts[frame.method] = (state.browserMethodCounts[frame.method] ?? 0) + 1;
      }
      upstream.send(raw);
    });

    upstream.onMessage(raw => {
      const frame = parseRpcFrame(raw);
      if (frame && actorRequestId !== null && frame.id !== undefined && Object.is(frame.id, actorRequestId)) {
        if (frame.error || typeof frame.result?.turn?.id !== "string" ||
            frame.result.turn.threadId !== expected.threadId || typeof frame.result.turn.attemptId !== "string") {
          state.error = new Error("the injected fixture actor did not receive a valid real turn/start acknowledgement");
          releaseOldResumeUnchanged();
          return;
        }
        actorTurnId = frame.result.turn.id;
        actorAttemptId = frame.result.turn.attemptId;
        state.actorAck = {
          socketId,
          requestId: actorRequestId,
          threadId: frame.result.turn.threadId,
          turnId: actorTurnId,
          attemptId: actorAttemptId,
          status: frame.result.turn.status,
        };
        return;
      }

      const request = frame && frame.id !== undefined ? requests.get(frame.id) : null;
      if (request?.method === "initialize" && frame && exactRuntimeSocket &&
          Object.is(request.id, frame.id)) {
        const notificationServerId = notificationServerIdFromInitializeResponse(frame);
        if (notificationServerId) {
          if (!socketProjection.notificationServerId) {
            socketProjection.notificationServerId = notificationServerId;
            socketProjection.notificationServerIdSource = "same-socket-initialize-session-id";
          } else if (socketProjection.notificationServerId !== notificationServerId) {
            socketProjection.notificationServerIdentityConflict = true;
          }
        }
      }
      if (request?.method === "thread/resume" && request.threadId === expected.threadId && exactRuntimeSocket && frame) {
        if (!matchesExactResumeResponse({
          socketId,
          expectedSocketId: socketId,
          request: { method: request.method, id: request.id, params: request.params },
          response: frame,
          threadId: expected.threadId,
        })) {
          state.error = new Error("exact thread/resume response did not match its original socket, request id, and thread");
          route.send(raw);
          return;
        }
        if (heldResumeRaw !== null || state.heldResume !== null) {
          state.error = new Error("the exact target thread produced more than one held resume response");
          route.send(raw);
          return;
        }
        const messages = resumePageMessages(frame);
        const resultThreadId = frame.result?.thread?.id ?? null;
        const socketRpcToken = url?.searchParams.get("token") ?? null;
        const bootstrapRpcToken = expected.bootstrap?.result?.rpcToken ?? null;
        const matchesBootstrapRpcToken = Boolean(bootstrapRpcToken && socketRpcToken === bootstrapRpcToken);
        heldResumeRaw = raw;
        heldResumeRequest = request;
        if (!matchesBootstrapRpcToken) {
          state.error = new Error("the held runtime resume socket did not use the RPC token from Mobile's actual session bootstrap");
          route.send(raw);
          return;
        }
        const actorRequest = `event-continuity-actor-${randomBytes(8).toString("hex")}`;
        actorRequestId = actorRequest;
        state.heldResume = {
          socketId,
          requestId: request.id,
          responseId: frame.id,
          responseIdMatched: Object.is(request.id, frame.id),
          resumeRequestThreadId: request.threadId,
          responseThreadId: resultThreadId,
          historyStatus: frame.result?.history?.status ?? null,
          pageContainsSeed: Array.isArray(messages) && messages.some(message => message?.role === "user" && String(message.content ?? "").includes(seedPrompt)),
          pageContainsActorPrompt: Array.isArray(messages) && messages.some(message => String(message.content ?? "").includes(expected.prompt)),
          pageTurnIds: Array.isArray(messages) ? messages.map(message => message?.turnId).filter(value => typeof value === "string") : [],
          pageContainsActorTurn: null,
          rawFrameSha256: rawFrameSha256(raw),
          rawForwardedUnchanged: false,
          releasedAtMs: null,
          cdpRequestId: null,
          runtimeSocketUrl: route.url(),
          runtimeSocketRouteMatches: exactRuntimeSocket,
          socketUrlProof: { matchesBootstrapRpcToken },
        };
        upstream.send(JSON.stringify({
          jsonrpc: "2.0",
          id: actorRequest,
          method: "turn/start",
          params: {
            threadId: expected.threadId,
            input: [{ type: "text", text: expected.prompt }],
            clientMessageId: expected.clientMessageId,
            permissionMode: "yolo",
          },
        }));
        state.actorTurnStartCount++;
        return;
      }

      if (request && ["thread/read", "thread/read/indexed"].includes(request.method) && request.threadId === expected.threadId && frame) {
        const messages = readPageMessages(frame);
        const evidence = summarizeAttemptPage(messages, state.actorAck, expected.prompt, finalBody);
        const responseSocket = state.sockets.find(candidate => candidate.socketId === socketId) ?? null;
        const matchesHeldResumeSocketAndScope = matchesExactHistoryReadResponse({
          socketId,
          expectedSocketId: state.heldResume?.socketId,
          socket: responseSocket,
          request: { method: request.method, id: request.id, params: request.params },
          response: frame,
          serverId: expected.serverId,
          workspace: expected.workspace,
          threadId: expected.threadId,
        });
        state.readResponses.push({
          socketId,
          requestId: request.id,
          responseId: frame.id,
          responseIdMatched: Object.is(request.id, frame.id),
          responseThreadId: frame.result?.thread?.id ?? null,
          serverId: responseSocket?.serverId ?? null,
          channel: responseSocket?.channel ?? null,
          workspace: responseSocket?.workspace ?? null,
          matchesHeldResumeSocketAndScope,
          method: request.method,
          receivedAtMs: performance.now(),
          messages,
          containsActorAttempt: Boolean(evidence),
          ...(evidence ?? {}),
        });
      }

      if (frame?.id === undefined && typeof frame?.method === "string") {
        const params = frame.params ?? {};
        const actorSocketId = state.heldResume?.socketId ?? null;
        const isExactHeldTurnStart = Boolean(actorTurnId && actorAttemptId &&
          socketId === actorSocketId &&
          isExactTurnStartNotification(frame, {
            threadId: expected.threadId,
            turnId: actorTurnId,
            attemptId: actorAttemptId,
            socketId,
            expectedSocketId: actorSocketId,
          }));
        let boundFromTurnStart = false;
        if (!socketProjection.notificationServerId && !socketProjection.notificationServerIdentityConflict && isExactHeldTurnStart) {
          socketProjection.notificationServerId = params.serverId;
          socketProjection.notificationServerIdSource = "exact-held-turn-start-attempt";
          boundFromTurnStart = true;
        }
        const matchesActorNotification = Boolean(actorTurnId && actorAttemptId && socketProjection.notificationServerId &&
          matchesExactTurnNotification(frame, {
            serverId: socketProjection.notificationServerId,
            threadId: expected.threadId,
            turnId: actorTurnId,
            attemptId: actorAttemptId,
            socketId,
            expectedSocketId: actorSocketId,
          }));
        if (state.notificationMetadata.length < 200) {
          state.notificationMetadata.push(projectNotificationMetadata(frame, {
            socketId,
            heldSocketId: actorSocketId,
            routeServerId: expected.serverId,
            notificationServerId: socketProjection.notificationServerId,
            threadId: expected.threadId,
            turnId: actorTurnId,
            attemptId: actorAttemptId,
            matchedActorTurn: matchesActorNotification,
            boundFromTurnStart,
            notificationServerIdSource: socketProjection.notificationServerIdSource,
            notificationServerIdentityConflict: socketProjection.notificationServerIdentityConflict,
          }));
        }
        if (matchesActorNotification) {
          state.notifications.push({ socketId, frame });
          const event = params.event;
          const item = params.item;
          const deltaText = typeof params.delta?.text === "string" ? params.delta.text : "";
          const actorEvent = {
            socketId,
            actorTurnId: params.turnId,
            method: frame.method,
            attemptId: params.attemptId ?? params.turn?.attemptId ?? null,
            eventType: typeof event?.type === "string" ? event.type : null,
            itemType: typeof item?.type === "string" ? item.type : null,
            itemId: typeof item?.id === "string" ? item.id : null,
            itemName: typeof item?.name === "string" ? item.name : null,
            itemStatus: typeof item?.status === "string" ? item.status : null,
            deltaText,
            wireSequence: Number.isSafeInteger(params.sequence) ? params.sequence : null,
            turnStatus: params.turn?.status ?? null,
            atMs: performance.now(),
          };
          state.actorEvents.push(actorEvent);
          if (isCompletedTurnNotification(frame, {
            serverId: socketProjection.notificationServerId,
            threadId: expected.threadId,
            turnId: actorTurnId,
            attemptId: actorAttemptId,
            socketId,
            expectedSocketId: actorSocketId,
          })) {
            actorTerminalSent = true;
            state.terminal = {
              socketId,
              receivedAtMs: actorEvent.atMs,
              forwardedAtMs: null,
              turnId: actorTurnId,
              attemptId: actorEvent.attemptId,
            };
          }
        }
      }

      route.send(raw);
      if (actorTerminalSent && state.terminal?.forwardedAtMs === null) {
        state.terminal.forwardedAtMs = performance.now();
        releaseOldResumeUnchanged();
      }
    });

    function releaseOldResumeUnchanged() {
      if (heldResumeRaw === null || !heldResumeRequest || state.heldResume?.releasedAtMs !== null) return false;
      // Playwright routeWebSocket forwards the original server frame as-is. Keep a
      // digest of the parsed raw text only; the response body and credentials stay in memory.
      const heldFrame = parseRpcFrame(heldResumeRaw);
      state.heldResume.rawForwardedUnchanged = Boolean(heldFrame &&
        Object.is(heldFrame.id, state.heldResume.responseId) &&
        rawFrameSha256(heldResumeRaw) === state.heldResume.rawFrameSha256);
      state.heldResume.releasedAtMs = performance.now();
      route.send(heldResumeRaw);
      return true;
    }
  });
}

function createBootstrapCapture(context, page, gateway) {
  const capture = { requestCount: 0, statuses: [], result: null, postedPairingTokenMatches: false };
  page.on("request", request => {
    let url;
    try { url = new URL(request.url()); } catch { return; }
    if (request.method() !== "POST" || url.pathname !== "/api/mobile/session") return;
    capture.requestCount++;
    let body;
    try { body = JSON.parse(request.postData() ?? "{}"); } catch { body = null; }
    capture.postedPairingTokenMatches = body?.token === gateway.authToken;
  });
  page.on("response", response => {
    let url;
    try { url = new URL(response.url()); } catch { return; }
    if (response.request().method() !== "POST" || url.pathname !== "/api/mobile/session") return;
    capture.statuses.push(response.status());
    if (response.status() !== 200) return;
    void response.json().then(payload => {
      const accessToken = payload?.accessToken;
      const rpcToken = payload?.rpcToken;
      if (typeof accessToken !== "string" || !accessToken || typeof rpcToken !== "string" || !rpcToken) return;
      context.registerSecret(accessToken);
      context.registerSecret(rpcToken);
      if (typeof payload.refreshToken === "string" && payload.refreshToken) context.registerSecret(payload.refreshToken);
      capture.result = {
        accessToken,
        rpcToken,
        authMode: payload.capabilities?.mobileRefreshV1 === true ? "device" : "legacy",
        deviceId: typeof payload.deviceId === "string" ? payload.deviceId : null,
        authorizationGeneration: typeof payload.authorizationGeneration === "string" ? payload.authorizationGeneration : null,
        capabilities: payload.capabilities ?? null,
      };
    }).catch(() => {});
  });
  return capture;
}

function installWebSocketHandshakeCapture(cdp) {
  const created = new Map();
  const handshakes = [];
  cdp.on("Network.webSocketCreated", event => {
    created.set(event.requestId, event.url);
  });
  cdp.on("Network.webSocketWillSendHandshakeRequest", event => {
    handshakes.push({
      requestId: event.requestId,
      url: created.get(event.requestId) ?? null,
      headers: event.request?.headers ?? {},
    });
  });
  return { created, handshakes };
}

function matchingAuthenticatedHandshake(capture, gateway, bootstrap, workspace, expectedSocketUrl) {
  if (typeof expectedSocketUrl !== "string" || !expectedSocketUrl) return null;
  let expectedUrl;
  try { expectedUrl = new URL(expectedSocketUrl); } catch { return null; }
  for (const row of capture.handshakes) {
    let url;
    try { url = new URL(row.url); } catch { continue; }
    const headers = lowerCaseHeaders(row.headers);
    const protocols = String(headers["sec-websocket-protocol"] ?? "").split(",").map(value => value.trim());
    const exactRoute = url.origin === gateway.baseUrl.replace(/^http:/, "ws:") &&
      url.pathname === "/rpc" && url.searchParams.get("token") === bootstrap.rpcToken &&
      url.searchParams.get("server") === "local" && url.searchParams.get("channel") === "runtime" &&
      url.searchParams.get("workspace") === workspace && url.href === expectedUrl.href;
    const exactAuth = headers.origin === gateway.baseUrl && protocols.includes("kcoder-studio") &&
      protocols.includes(`kcoder-session.${bootstrap.accessToken}`);
    if (exactRoute && exactAuth) {
      return {
        matches: true,
        requestId: row.requestId,
        channel: url.searchParams.get("channel"),
        serverId: url.searchParams.get("server"),
        workspace: url.searchParams.get("workspace"),
        originMatchesGateway: headers.origin === gateway.baseUrl,
        includesKcoderStudioProtocol: protocols.includes("kcoder-studio"),
        includesSessionProtocol: protocols.includes(`kcoder-session.${bootstrap.accessToken}`),
        rpcTokenMatchesMobileBootstrap: url.searchParams.get("token") === bootstrap.rpcToken,
      };
    }
  }
  return null;
}

async function connectAuthenticatedMobile(page, gateway, mobileEntryUrl) {
  const direct = page.getByTestId("welcome-direct-connection");
  await direct.waitFor({ state: "visible", timeout: 20_000 });
  await direct.click();
  await page.getByTestId("gateway-endpoint").fill(gateway.baseUrl);
  await page.getByTestId("gateway-token").fill(gateway.authToken);
  await Promise.all([
    page.waitForURL(url => url.pathname.startsWith(`${MOBILE_MOUNT}/h/`), { timeout: 30_000 }),
    page.getByTestId("gateway-connect").click(),
  ]);
  assert.equal(new URL(page.url()).origin, new URL(mobileEntryUrl).origin,
    "the authenticated Mobile connection must remain on the owned Gateway origin");
  await page.getByTestId("new-workspace").waitFor({ state: "visible", timeout: 20_000 });
}

async function verifyOwnedGatewayRuntime(context, gateway, gatewayLabel, binaryPath, expectedSha256, workspace) {
  const owner = context.processes.get(gatewayLabel);
  assert.ok(owner?.pid === gateway.child.pid && owner.pgid > 0,
    "the Gateway must retain its exact RunContext process owner");
  const processes = await findOwnedExecutableProcesses({ pgid: owner.pgid, executablePath: binaryPath });
  const runtime = processes.find(process => process.sha256 === expectedSha256);
  assert.ok(runtime, "the Gateway must own the exact caller-pinned Rust app-server executable bytes");
  assert.equal(await realpath(`/proc/${runtime.pid}/cwd`), workspace,
    "the owned Rust app-server runtime must use the exact fixture workspace");
  return {
    gatewayPid: gateway.child.pid,
    gatewayPgid: owner.pgid,
    appServerPid: runtime.pid,
    appServerSha256: runtime.sha256,
    appServerCwd: workspace,
    processCountForPinnedBinary: processes.length,
  };
}

async function readCurrentTranscript(page) {
  return page.evaluate(async () => {
    const databaseName = "kcoder-confirmed-transcripts-v1";
    if (typeof indexedDB === "undefined" || typeof indexedDB.databases !== "function") return { ready: false };
    const inventory = await indexedDB.databases();
    if (!inventory.some(row => row.name === databaseName)) return { ready: false };
    const db = await new Promise((resolveDb, reject) => {
      const request = indexedDB.open(databaseName);
      request.onupgradeneeded = () => request.transaction?.abort();
      request.onsuccess = () => resolveDb(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("transcript cache read-only open was blocked"));
    });
    try {
      const current = await new Promise((resolveRead, reject) => {
        let manifest;
        let rawEntry;
        const transaction = db.transaction(["manifest", "entries"], "readonly");
        transaction.objectStore("manifest").get("current").onsuccess = event => {
          const raw = event.target.result;
          if (typeof raw !== "string" || raw.length > 64 * 1024) return;
          try { manifest = JSON.parse(raw); } catch { return; }
          if (manifest?.schemaVersion !== 1 || typeof manifest.lastKey !== "string" || !Array.isArray(manifest.entries)) return;
          const row = manifest.entries.find(entry => entry?.key === manifest.lastKey);
          if (!row || !Number.isSafeInteger(row.slot) || !Number.isSafeInteger(row.dataRevision)) return;
          transaction.objectStore("entries").get(row.slot).onsuccess = entryEvent => {
            rawEntry = { manifest, row, record: entryEvent.target.result };
          };
        };
        transaction.oncomplete = () => resolveRead(rawEntry ?? null);
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error ?? new Error("transcript cache read-only transaction aborted"));
      });
      if (!current?.record || current.record.revision !== current.row.dataRevision || !(current.record.blob instanceof Blob) || current.record.blob.size > 512 * 1024) return { ready: false };
      const parsed = JSON.parse(await current.record.blob.text());
      return {
        ready: true,
        lastKey: current.manifest.lastKey,
        manifestRevision: current.manifest.revision,
        entry: {
          key: current.row.key,
          slot: current.row.slot,
          dataRevision: current.row.dataRevision,
          revision: current.record.revision,
        },
        scope: parsed?.scope ?? null,
        messages: Array.isArray(parsed?.messages) ? parsed.messages : [],
      };
    } finally {
      db.close();
    }
  });
}

function summarizeAttemptPage(messages, ack, prompt, expectedFinalBody) {
  if (!ack?.turnId || !ack?.attemptId) return null;
  const userRows = attemptMessages(messages, { turnId: ack.turnId, attemptId: ack.attemptId, role: "user" });
  const assistantRows = attemptMessages(messages, { turnId: ack.turnId, attemptId: ack.attemptId, role: "assistant" });
  if (userRows.length !== 1 || assistantRows.length !== 1 ||
      !String(userRows[0].content ?? "").includes(prompt) || assistantRows[0].content !== expectedFinalBody) return null;
  return {
    userMessageCount: userRows.length,
    assistantMessageCount: assistantRows.length,
    userId: userRows[0].id,
    assistantId: assistantRows[0].id,
    assistantContent: assistantRows[0].content,
    assistantStatus: assistantRows[0].status ?? null,
  };
}

function projectAttemptEvidence(messages, ack, prompt, expectedFinalBody) {
  return summarizeAttemptPage(messages, ack, prompt, expectedFinalBody);
}

async function captureActorUserVisibilityDiagnostics(page, {
  profileId,
  gatewayBaseUrl,
  authMode,
  deviceId,
  authorizationGeneration,
  workspace,
  threadId,
  serverId,
  heldSocketId,
  actorPrompt,
  finalBody,
  actorAck,
  authority,
}) {
  const dom = await page.evaluate(({ prompt, authoritativeUserId }) => {
    const list = document.querySelector('[data-testid="message-list"]');
    const collectRows = testId => Array.from(list?.querySelectorAll(`[data-testid="${testId}"]`) ?? []);
    const rowRange = (row, index) => {
      const rect = row.getBoundingClientRect();
      const text = row.textContent ?? "";
      return {
        index,
        mounted: row.isConnected,
        intersectsViewport: rect.bottom > 0 && rect.top < window.innerHeight,
        top: Math.round(rect.top),
        bottom: Math.round(rect.bottom),
        actorPromptMatches: text.includes(prompt),
      };
    };
    const users = collectRows("message-user");
    const assistants = collectRows("message-assistant");
    const authorityElement = typeof authoritativeUserId === "string" && authoritativeUserId
      ? document.getElementById(`message-${encodeURIComponent(authoritativeUserId)}`)
      : null;
    const authorityMessage = authorityElement?.querySelector('[data-testid="message-user"]') ?? null;
    const authorityText = authorityMessage?.textContent ?? "";
    const authorityRect = authorityMessage?.getBoundingClientRect();
    return {
      documentReady: document.readyState === "complete" || document.readyState === "interactive",
      messageListMounted: Boolean(list),
      messageListRange: list ? {
        scrollTop: Math.round(list.scrollTop),
        clientHeight: Math.round(list.clientHeight),
        scrollHeight: Math.round(list.scrollHeight),
        childCount: list.children.length,
      } : null,
      renderedMessageWrapperCount: list?.querySelectorAll('[id^="message-"]').length ?? 0,
      mountedUserRowCount: users.length,
      mountedAssistantRowCount: assistants.length,
      userRows: users.slice(0, 32).map(rowRange),
      assistantRows: assistants.slice(0, 32).map((row, index) => {
        const projected = rowRange(row, index);
        delete projected.actorPromptMatches;
        return projected;
      }),
      authorityUserRowMounted: Boolean(authorityMessage),
      authorityUserRowMatchesPrompt: Boolean(authorityMessage) && authorityText.includes(prompt),
      authorityUserRowRange: authorityRect ? {
        intersectsViewport: authorityRect.bottom > 0 && authorityRect.top < window.innerHeight,
        top: Math.round(authorityRect.top),
        bottom: Math.round(authorityRect.bottom),
      } : null,
    };
  }, { prompt: actorPrompt, authoritativeUserId: authority?.userId ?? null }).catch(() => null);

  const transcript = await readCurrentTranscript(page).catch(() => null);
  const messages = transcript?.ready && Array.isArray(transcript.messages) ? transcript.messages : [];
  const cachedUserRows = attemptMessages(messages, {
    turnId: actorAck?.turnId,
    attemptId: actorAck?.attemptId,
    role: "user",
  });
  const cachedAssistantRows = attemptMessages(messages, {
    turnId: actorAck?.turnId,
    attemptId: actorAck?.attemptId,
    role: "assistant",
  });
  const decodeTurnMessageStatus = await loadSharedTurnMessageStatusDecoder();
  const cachedAssistantStatus = cachedAssistantRows.length === 1
    ? decodeTurnMessageStatus(cachedAssistantRows[0]?.status)
    : null;
  const cachedScope = transcript?.scope ?? null;
  const cachedProfile = cachedScope?.profile ?? null;
  const cachedTarget = cachedScope?.target ?? null;
  let currentRoute = null;
  try { currentRoute = taskRoute(page.url()); } catch { /* Route summary stays fail-closed. */ }

  return {
    failurePoint: "waiting-for-visible-actor-user-row-after-exact-terminal-authority",
    routeProof: {
      taskRouteRecognized: Boolean(currentRoute),
      originMatchesGateway: (() => { try { return new URL(page.url()).origin === gatewayBaseUrl; } catch { return false; } })(),
      profileMatchesBootstrapRoute: currentRoute?.profileId === profileId,
      serverMatchesTarget: currentRoute?.serverId === serverId,
      threadMatchesTarget: currentRoute?.threadId === threadId,
      workspaceMatchesTarget: currentRoute?.cwd === workspace,
    },
    authorityProof: {
      responseIdMatched: authority?.responseIdMatched === true,
      heldSocketMatched: authority?.socketId === heldSocketId,
      serverMatchesTarget: authority?.serverId === serverId,
      runtimeChannelMatches: authority?.channel === "runtime",
      workspaceMatchesTarget: authority?.workspace === workspace,
      targetThreadMatched: authority?.responseThreadId === threadId,
      actorAttemptPresent: authority?.containsActorAttempt === true,
      authoritativeUserRowCount: authority?.userMessageCount ?? null,
      authoritativeUserRowIdentityPresent: typeof authority?.userId === "string" && authority.userId.length > 0,
    },
    dom: dom ?? { readable: false },
    currentIndexedDb: {
      readOnly: true,
      readable: transcript?.ready === true,
      currentManifestMatchesEntry: transcript?.ready === true && transcript.lastKey === transcript.entry?.key,
      profileMatchesBootstrap: cachedProfile?.id === profileId && cachedProfile?.baseUrl === gatewayBaseUrl &&
        cachedProfile?.authMode === authMode,
      deviceMatchesBootstrap: authMode !== "device" || cachedProfile?.deviceId === deviceId,
      authorizationGenerationMatchesBootstrap: authMode !== "device" ||
        cachedProfile?.authorizationGeneration === authorizationGeneration,
      targetMatchesRoute: cachedTarget?.id === serverId,
      workspaceMatchesRoute: cachedScope?.cwd === workspace,
      threadMatchesRoute: cachedScope?.threadId === threadId,
      connectionFingerprintCanonical: typeof cachedTarget?.connectionFingerprint === "string" &&
        /^[a-f0-9]{64}$/.test(cachedTarget.connectionFingerprint),
      cachedMessageCount: messages.length,
      actorUserAttemptRowCount: cachedUserRows.length,
      actorUserPromptMatches: cachedUserRows.length === 1 && String(cachedUserRows[0]?.content ?? "").includes(actorPrompt),
      actorAssistantAttemptRowCount: cachedAssistantRows.length,
      actorAssistantFinalBodyMatches: cachedAssistantRows.length === 1 && cachedAssistantRows[0]?.content === finalBody,
      actorAssistantDecodesCompleted: cachedAssistantStatus?.status === "done",
    },
  };
}

async function captureComposerSendStateDiagnostics(page, {
  phase,
  protocol,
  terminal,
  authority,
  expectedWorkspace,
  expectedThreadId,
}) {
  const ui = await page.evaluate(() => {
    const input = document.querySelector('[data-testid="message-input"]');
    const send = document.querySelector('[data-testid="send-message"]');
    const list = document.querySelector('[data-testid="message-list"]');
    const inputValue = input && "value" in input ? String(input.value ?? "") : null;
    return {
      messageInputMounted: Boolean(input),
      draftLength: inputValue?.length ?? null,
      draftEmpty: inputValue === "",
      sendButtonMounted: Boolean(send),
      sendButtonVisible: Boolean(send && send.getClientRects().length > 0),
      sendButtonEnabled: send ? !("disabled" in send && send.disabled) && send.getAttribute("aria-disabled") !== "true" : null,
      sendDisabledAttribute: send?.hasAttribute("disabled") ?? null,
      sendAriaDisabled: send?.getAttribute("aria-disabled") ?? null,
      stopTurnCount: document.querySelectorAll('[data-testid="stop-turn"]').length,
      queueButtonCount: document.querySelectorAll('[data-testid="queue-message"]').length,
      mountedUserRowCount: list?.querySelectorAll('[data-testid="message-user"]').length ?? 0,
      mountedAssistantRowCount: list?.querySelectorAll('[data-testid="message-assistant"]').length ?? 0,
    };
  }).catch(() => null);
  const route = (() => {
    try { return taskRoute(page.url()); } catch { return null; }
  })();
  const heldResume = protocol.heldResume;
  const readRequests = Array.isArray(protocol.browserRequests)
    ? protocol.browserRequests.filter(request => ["thread/read", "thread/read/indexed"].includes(request.method))
    : [];
  const postTerminalReadCount = typeof terminal?.receivedAtMs === "number"
    ? readRequests.filter(request => request.sentAtMs >= terminal.receivedAtMs).length
    : null;
  const eventMethods = Object.fromEntries(
    [...new Set((protocol.actorEvents ?? []).map(event => event.method))]
      .map(method => [method, protocol.actorEvents.filter(event => event.method === method).length]),
  );
  return {
    failurePhase: phase,
    ui: ui ?? { readable: false },
    routeProof: {
      taskRouteRecognized: Boolean(route),
      workspaceMatchesExpected: route?.cwd === expectedWorkspace,
      threadMatchesExpected: route?.threadId === expectedThreadId,
    },
    protocolStage: {
      bridgeErrorPresent: Boolean(protocol.error),
      heldResumeObserved: Boolean(heldResume),
      heldResumeResponseIdMatched: heldResume?.responseIdMatched === true,
      heldResumeReleased: typeof heldResume?.releasedAtMs === "number",
      terminalObserved: Boolean(terminal),
      terminalOnHeldSocket: Boolean(terminal && heldResume && terminal.socketId === heldResume.socketId),
      terminalForwardedBeforeResumeRelease: Boolean(terminal && heldResume &&
        terminal.forwardedAtMs < heldResume.releasedAtMs),
      actorAcknowledgementObserved: Boolean(protocol.actorAck),
      actorAcknowledgementOnHeldSocket: Boolean(protocol.actorAck && heldResume &&
        protocol.actorAck.socketId === heldResume.socketId),
      actorTurnStartCount: protocol.actorTurnStartCount,
      actorEventCount: protocol.actorEvents?.length ?? 0,
      actorEventMethods: eventMethods,
      transcriptReadCount: readRequests.length,
      postTerminalTranscriptReadCount: postTerminalReadCount,
      authorityResponseMatchesRequest: authority?.responseIdMatched === true,
      authorityContainsActorAttempt: authority?.containsActorAttempt === true,
      authorityOnHeldSocket: Boolean(authority && heldResume && authority.socketId === heldResume.socketId),
      authorityThreadMatchesExpected: authority?.responseThreadId === expectedThreadId,
      authorityUserRowCount: authority?.userMessageCount ?? null,
      authorityAssistantRowCount: authority?.assistantMessageCount ?? null,
    },
  };
}

function profileIdFromMobileRoute(rawUrl) {
  const url = new URL(rawUrl);
  const segments = url.pathname.slice(MOBILE_MOUNT.length).split("/").filter(Boolean).map(decodeURIComponent);
  assert.equal(segments[0], "h", "the actual Mobile bootstrap must enter a Gateway profile route");
  assert.ok(segments[1], "the Mobile profile route must expose a canonical profile id");
  return segments[1];
}

function taskRoute(rawUrl) {
  const url = new URL(rawUrl);
  assert.ok(url.pathname.startsWith(`${MOBILE_MOUNT}/`), "the task route must remain under production /mobile/");
  const segments = url.pathname.slice(MOBILE_MOUNT.length).split("/").filter(Boolean).map(decodeURIComponent);
  assert.equal(segments[0], "h", "the task route must identify its Gateway profile");
  assert.equal(segments[2], "task", "the actual URL must identify a Mobile task route");
  assert.ok(segments[1] && segments[3] && segments[4], "the task route must contain profile, server, and thread ids");
  const cwd = url.searchParams.get("cwd");
  assert.ok(cwd, "the resumed Mobile task route must carry its exact workspace path");
  return { profileId: segments[1], serverId: segments[3], threadId: segments[4], cwd };
}

function throwIfBridgeFailed(state) {
  if (state.error) throw state.error;
}

function projectNotificationMetadata(frame, {
  socketId,
  heldSocketId,
  routeServerId,
  notificationServerId,
  threadId,
  turnId,
  attemptId,
  matchedActorTurn,
  boundFromTurnStart,
  notificationServerIdSource,
  notificationServerIdentityConflict,
}) {
  const params = frame.params && typeof frame.params === "object" && !Array.isArray(frame.params)
    ? frame.params
    : {};
  return {
    socketMatchesHeldResume: socketId === heldSocketId,
    method: frame.method.slice(0, 96),
    jsonrpcVersionMatches: frame.jsonrpc === "2.0",
    hasId: frame.id !== undefined,
    serverIdPresent: typeof params.serverId === "string" && params.serverId.length > 0,
    serverIdMatchesGatewayRouteAlias: params.serverId === routeServerId,
    capturedServerIdentityPresent: typeof notificationServerId === "string" && notificationServerId.length > 0,
    serverIdMatchesCapturedIdentity: notificationServerId ? params.serverId === notificationServerId : null,
    notificationServerIdSource,
    notificationServerIdentityConflict,
    threadIdPresent: typeof params.threadId === "string" && params.threadId.length > 0,
    threadMatchesTarget: params.threadId === threadId,
    turnIdPresent: typeof params.turnId === "string" && params.turnId.length > 0,
    turnMatchesAcknowledgement: typeof turnId === "string" ? params.turnId === turnId : null,
    attemptIdPresent: typeof params.attemptId === "string" && params.attemptId.length > 0,
    attemptMatchesAcknowledgement: typeof attemptId === "string" && params.attemptId !== undefined
      ? params.attemptId === attemptId
      : null,
    nestedAttemptIdPresent: typeof params.turn?.attemptId === "string" && params.turn.attemptId.length > 0,
    nestedAttemptMatchesAcknowledgement: typeof attemptId === "string" && params.turn?.attemptId !== undefined
      ? params.turn.attemptId === attemptId
      : null,
    nestedTurnIdMatchesAcknowledgement: typeof turnId === "string" && params.turn?.id !== undefined
      ? params.turn.id === turnId
      : null,
    nestedTurnThreadMatchesTarget: typeof params.turn?.threadId === "string"
      ? params.turn.threadId === threadId
      : null,
    matchedActorTurn,
    boundFromTurnStart,
  };
}

function projectTerminalBarrierFailure(state, {
  pageUrl,
  bootstrap,
  serverId,
  workspace,
  threadId,
  browserErrorCount,
  seedPrompt,
  actorPrompt,
  modelRequests,
  fixtureAudit,
}) {
  const heldResume = state.heldResume;
  const actorAck = state.actorAck;
  const terminal = state.terminal;
  let pageRoute = null;
  try { pageRoute = taskRoute(pageUrl); } catch {}
  const knownBridgeErrors = new Map([
    ["the injected fixture actor did not receive a valid real turn/start acknowledgement", "invalid-actor-turn-start-ack"],
    ["exact thread/resume response did not match its original socket, request id, and thread", "resume-response-correlation-mismatch"],
    ["the exact target thread produced more than one held resume response", "duplicate-target-resume-response"],
    ["the held runtime resume socket did not use the RPC token from Mobile's actual session bootstrap", "resume-socket-rpc-token-mismatch"],
  ]);
  const relevantMethods = new Set([
    "thread/resume", "thread/read", "thread/read/indexed", "turn/start",
  ]);
  const projectedModelRequests = modelRequests.map(request => {
    const messages = Array.isArray(request.messages) ? request.messages : [];
    const serialized = JSON.stringify(messages);
    return {
      includesSeedPrompt: serialized.includes(seedPrompt),
      includesActorPrompt: serialized.includes(actorPrompt),
      roles: messages.map(message => message?.role ?? "unknown"),
      toolCallCount: messages.reduce((count, message) => count + (Array.isArray(message?.tool_calls) ? message.tool_calls.length : 0), 0),
      toolResultCount: messages.filter(message => message?.role === "tool").length,
    };
  });

  return {
    schemaVersion: 2,
    failurePoint: "waiting-for-actor-terminal-and-held-resume-release",
    waitTimeoutMs: CASE_TIMEOUT_MS,
    waitState: {
      terminalObserved: Boolean(terminal),
      heldResumeObserved: Boolean(heldResume),
      heldResumeReleased: Boolean(heldResume && heldResume.releasedAtMs !== null),
      predicateWouldResolve: Boolean(terminal && heldResume?.releasedAtMs !== null),
      bridgeErrorCode: state.error ? knownBridgeErrors.get(state.error.message) ?? "unclassified" : null,
    },
    pageRoute: {
      taskRouteRecognized: Boolean(pageRoute),
      serverMatches: pageRoute?.serverId === serverId,
      threadMatches: pageRoute?.threadId === threadId,
      workspaceMatches: pageRoute?.cwd === workspace,
    },
    bootstrap: {
      requestCount: bootstrap.requestCount,
      statuses: bootstrap.statuses,
      pairingTokenMatched: bootstrap.postedPairingTokenMatches,
      accessTokenCaptured: Boolean(bootstrap.result?.accessToken),
      rpcTokenCaptured: Boolean(bootstrap.result?.rpcToken),
    },
    browserMethodCounts: state.browserMethodCounts,
    browserErrorCount,
    fixture: {
      modelRequestCount: modelRequests.length,
      requests: projectedModelRequests,
      unexpectedRequestCount: fixtureAudit.unexpectedRequests.length,
      invalidToolResultCount: fixtureAudit.invalidToolResults,
    },
    sockets: state.sockets.map(socket => ({
      socketId: socket.socketId,
      rpcPath: typeof socket.pathname === "string" && socket.pathname.endsWith("/rpc"),
      serverMatches: socket.serverId === serverId,
      runtimeChannel: socket.channel === "runtime",
      workspaceMatches: socket.workspace === workspace,
      hasRpcToken: socket.hasRpcToken,
    })),
    relevantRequests: state.browserRequests
      .filter(request => relevantMethods.has(request.method))
      .map(request => ({
        socketId: request.socketId,
        method: request.method,
        threadMatches: request.threadId === threadId,
        serverMatches: request.serverId === serverId,
        runtimeChannel: request.channel === "runtime",
        workspaceMatches: request.workspace === workspace,
        hasRequestId: request.id !== undefined,
        sentAtMs: request.sentAtMs,
      })),
    heldResume: heldResume ? {
      socketId: heldResume.socketId,
      requestMatchesThread: heldResume.resumeRequestThreadId === threadId,
      responseMatchesThread: heldResume.responseThreadId === threadId,
      requestResponseIdMatched: heldResume.responseIdMatched,
      routeMatchesRuntimeScope: heldResume.runtimeSocketRouteMatches,
      rpcTokenMatchesBootstrap: heldResume.socketUrlProof?.matchesBootstrapRpcToken === true,
      historyStatus: heldResume.historyStatus,
      oldPageHasSeed: heldResume.pageContainsSeed,
      oldPageHasActorPrompt: heldResume.pageContainsActorPrompt,
      released: heldResume.releasedAtMs !== null,
    } : null,
    notificationServerIdentity: (() => {
      const socket = state.sockets.find(candidate => candidate.socketId === heldResume?.socketId);
      return socket ? {
        captured: Boolean(socket.notificationServerId),
        source: socket.notificationServerIdSource,
        distinctFromGatewayRouteAlias: socket.notificationServerId !== serverId,
        conflict: socket.notificationServerIdentityConflict === true,
      } : null;
    })(),
    notificationMetadata: state.notificationMetadata.slice(0, 200),
    actor: {
      turnStartCount: state.actorTurnStartCount,
      acknowledgementObserved: Boolean(actorAck),
      acknowledgementOnHeldSocket: Boolean(actorAck && actorAck.socketId === heldResume?.socketId),
      acknowledgementMatchesThread: actorAck?.threadId === threadId,
      acknowledgementStatus: actorAck?.status ?? null,
      hasTurnId: Boolean(actorAck?.turnId),
      hasAttemptId: Boolean(actorAck?.attemptId),
      events: state.actorEvents.slice(0, 100).map(event => ({
        socketMatchesHeldResume: event.socketId === heldResume?.socketId,
        turnMatchesAcknowledgement: event.actorTurnId === actorAck?.turnId,
        method: event.method,
        eventType: event.eventType,
        itemType: event.itemType,
        itemName: event.itemName,
        itemStatus: event.itemStatus,
        hasTextDelta: event.deltaText.length > 0,
        hasAttemptId: Boolean(event.attemptId),
        hasSequence: Number.isSafeInteger(event.wireSequence),
      })),
    },
    terminal: terminal ? {
      socketMatchesHeldResume: terminal.socketId === heldResume?.socketId,
      turnMatchesAcknowledgement: terminal.turnId === actorAck?.turnId,
      notificationAttemptIdPresent: terminal.attemptId !== null,
      notificationAttemptIdMatchesAcknowledgement: terminal.attemptId === null
        ? null
        : terminal.attemptId === actorAck?.attemptId,
      forwarded: terminal.forwardedAtMs !== null,
      releaseObserved: Boolean(heldResume && heldResume.releasedAtMs !== null),
    } : null,
    readResponses: state.readResponses.slice(0, 20).map(response => ({
      socketMatchesHeldResume: response.socketId === heldResume?.socketId,
      responseMatchesThread: response.responseThreadId === threadId,
      requestResponseIdMatched: response.responseIdMatched,
      containsActorAttempt: response.containsActorAttempt,
      receivedAtMs: response.receivedAtMs,
    })),
  };
}

function lowerCaseHeaders(headers) {
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value)]));
}

function countLiteralOccurrences(value, needle) {
  if (!needle) return 0;
  let count = 0;
  let offset = 0;
  while ((offset = value.indexOf(needle, offset)) !== -1) {
    count++;
    offset += needle.length;
  }
  return count;
}

function normalizeVisibleText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function requiredAbsolutePath(name) {
  const value = process.env[name];
  assert.ok(typeof value === "string" && value.length > 0, `${name} is a mandatory caller pin`);
  assert.equal(resolve(value), value, `${name} must be an absolute normalized path`);
  return value;
}

function requiredSha256(name) {
  const value = process.env[name];
  assert.match(value ?? "", /^[a-f0-9]{64}$/, `${name} is a mandatory lowercase SHA-256 caller pin`);
  return value;
}

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function rawFrameSha256(raw) {
  if (typeof raw === "string") return createHash("sha256").update(raw, "utf8").digest("hex");
  if (raw instanceof ArrayBuffer) return createHash("sha256").update(Buffer.from(raw)).digest("hex");
  if (ArrayBuffer.isView(raw)) {
    return createHash("sha256").update(Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength)).digest("hex");
  }
  return null;
}
