import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { startApprovalModelFixture } from "../../harness/approval-model.mjs";
import { startChromium } from "../../harness/chromium.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { runE2E } from "../../harness/run-context.mjs";
import { materializeWorkspace } from "../../harness/workspace-fixture.mjs";
import { assertRendererBuildFresh } from "../../harness/renderer-build.mjs";

const TARGET_A = "local";
const TARGET_B = "peer";
const PROJECT_A = "Attachment target A";
const PROJECT_B = "Attachment target B";
const PROMPT_A = "ATTACHMENT_COMPOSE_TARGET_A";
const PROMPT_B = "ATTACHMENT_COMPOSE_TARGET_B";
const REPLY_A = "ATTACHMENT_COMPOSE_ACK_A";
const REPLY_B = "ATTACHMENT_COMPOSE_ACK_B";
const IMAGE_NAME = "owned-target-a-image.png";
const REMOVED_TEXT_NAME = "removed-target-a-note.txt";
const INVALID_NAME = "server-reject<owned>.txt";
const TEXT_NAME = "owned-target-b-note.txt";
const TEXT_CONTENT = "TARGET_B_TEXT_CONTENT_SHA256_CHECK_7Q4M9K2P";
const HEALTH_CAPTURE_LIMIT = 128;
const SERVER_TEST_CAPTURE_LIMIT = 64;
const WORKSPACE_RPC_CAPTURE_LIMIT = 256;
const RUNTIME_DEBUG_CAPTURE_LIMIT = 128;
const CREATION_RPC_CAPTURE_LIMIT = 64;
const HEALTH_ONLINE_WAIT_MS = 45_000;
const FIRST_HEALTH_OBSERVATION_WAIT_MS = 15_000;
const RUNTIME_DEBUG_CONSOLE_PREFIX = "[KCODER_E2E_RUNTIME_DIAG] ";
const WORKSPACE_RPC_METHODS = new Set([
  "runtime.tasks.list",
  "runtime.workspaces.list",
  "runtime.worktrees.list",
]);
const CREATION_RPC_METHODS = new Set([
  "thread/start",
  "thread/creation/read",
  "thread/resume",
  "turn/start",
]);

const kcoderBin = process.env.KCODER_E2E_KCODER_BIN;
assert.ok(kcoderBin && isAbsolute(kcoderBin), "Set KCODER_E2E_KCODER_BIN to the frozen same-source CLI binary");
await assertRendererBuildFresh();

await runE2E(import.meta.url, {
  testId: "attachment-compose-lifecycle",
  tier: "full-integration",
  modelPolicy: "synthetic provider; real Gateway, Native app-server, browser upload/read and composer lifecycle only",
  retainSuccessLogs: true,
}, async context => {
  const targetA = await materializeWorkspace(context, "minimal", { instanceId: "attachment-target-a" });
  const targetB = await materializeWorkspace(context, "minimal", { instanceId: "attachment-target-b" });
  const profile = context.pathInState("profile");
  const gatewayDataDirectory = context.pathInState("gateway-data");
  await mkdir(profile, { recursive: true, mode: 0o700 });

  const model = await startApprovalModelFixture(context, {
    textOnly: true,
    textOnlyResponse: ({ userText }) =>
      userText.includes(PROMPT_A) ? REPLY_A : userText.includes(PROMPT_B) ? REPLY_B : "UNEXPECTED_ATTACHMENT_FIXTURE_INPUT",
  });
  const provider = "attachment-compose-fixture";
  const apiKey = "synthetic-attachment-compose-only";
  context.registerSecret(apiKey);
  const settingsFile = await context.writeStateJson("profile/settings.json", {
    active_provider: provider,
    providers: {
      [provider]: {
        api_format: "openai_chat_completions",
        endpoint: model.baseUrl,
        default_model: "attachment-compose-fixture",
        context_window_tokens: 128_000,
        output_headroom_tokens: 8_192,
        max_output_tokens: 1_024,
        request_timeout_secs: 30,
        no_proxy: true,
        max_retries: 0,
      },
    },
  });
  await context.writeStateJson("profile/credentials.json", {
    [provider]: { type: "api", key: apiKey },
  });
  const serversFile = await context.writeStateJson("servers.json", [
    {
      id: TARGET_A,
      label: PROJECT_A,
      runtime: "kcoder",
      transport: "local",
      command: kcoderBin,
      workspace: targetA.path,
      settingsFile,
    },
    {
      id: TARGET_B,
      label: PROJECT_B,
      runtime: "kcoder",
      transport: "local",
      command: kcoderBin,
      workspace: targetB.path,
      settingsFile,
    },
  ]);
  let gateway;
  try {
    gateway = await startGateway(context, {
      label: "attachment-compose-gateway",
      startTimeoutMs: 300_000,
      workspace: targetA.path,
      serversFile,
      auth: true,
      env: {
        KCODER_CONFIG_DIR: profile,
        KCODER_STUDIO_DATA_DIR: gatewayDataDirectory,
      },
    });
  } catch (error) {
    await context.writeArtifactJson(
      "gateway-startup-failure.json",
      await inspectGatewayStartupFailure({ context, gatewayDataDirectory, error }),
    );
    throw error;
  }
  const chromium = await startChromium(context, { label: "attachment-compose-chromium" });
  const page = await chromium.newPage({ viewport: { width: 1280, height: 900 } });
  const pageCreatedAt = Date.now();
  await page.addInitScript(() => {
    try {
      localStorage.setItem("kcoder:debug-runtime", "1");
    } catch {
      // The owned Gateway origin will retry this on its first document.
    }
    const prefix = "[KCODER_E2E_RUNTIME_DIAG] ";
    const info = console.info.bind(console);
    const warn = console.warn.bind(console);
    const countSummary = summary => {
      if (!summary || typeof summary !== "object") return null;
      const projects = Array.isArray(summary.projects) ? summary.projects : [];
      const chats = Array.isArray(summary.chats) ? summary.chats : [];
      const projectTasks = projects.reduce(
        (total, project) => total + (Array.isArray(project?.taskIds) ? project.taskIds.length : 0),
        0,
      );
      const chatTasks = chats.reduce(
        (total, chat) => total + (Array.isArray(chat?.taskIds) ? chat.taskIds.length : 0),
        0,
      );
      return { projects: projects.length, chats: chats.length, tasks: projectTasks + chatTasks };
    };
    const safeDiagnostic = args => {
      const isState = args[0] === "[KCoder Studio] Runtime sidebar state";
      const isMismatch = args[0] === "[KCoder Studio] Runtime sidebar selected task is hidden";
      if (!isState && !isMismatch) return null;
      const details = args[1] && typeof args[1] === "object" ? args[1] : {};
      if (isMismatch) return { event: "selected-task-hidden" };
      const event = typeof details.event === "string" ? details.event : "unknown";
      if (event === "project-visible-items") {
        const all = Array.isArray(details.allTaskIds) ? details.allTaskIds.length : 0;
        const visible = Array.isArray(details.visibleTaskIds) ? details.visibleTaskIds.length : 0;
        const hidden = Array.isArray(details.hiddenTaskIds) ? details.hiddenTaskIds.length : 0;
        return {
          event,
          visibleLimit: Number.isFinite(details.visibleLimit) ? details.visibleLimit : null,
          allTasks: all,
          visibleTasks: visible,
          hiddenTasks: hidden,
        };
      }
      if (event === "refresh-resolved") {
        return {
          event,
          source: details.source === "executor" || details.source === "current-state" ? details.source : "other",
          executor: countSummary(details.executorTaskIds),
          visible: countSummary(details.visibleTaskIds),
        };
      }
      if (event === "reducer-lists-refreshed" || event === "reducer-runtime-work-refreshed") {
        return {
          event,
          incoming: countSummary(details.incomingTaskIds),
          previous: countSummary(details.previousTaskIds),
          merged: countSummary(details.mergedTaskIds),
        };
      }
      return null;
    };
    console.info = (...args) => {
      const safe = safeDiagnostic(args);
      return safe ? info(prefix + JSON.stringify(safe)) : info(...args);
    };
    console.warn = (...args) => {
      const safe = safeDiagnostic(args);
      return safe ? warn(prefix + JSON.stringify(safe)) : warn(...args);
    };
  });
  const turnStarts = [];
  const uploadRequests = new Map();
  const uploadReplies = [];
  const browserErrors = [];
  const targetHealthResponses = { items: [], dropped: 0 };
  const serverTestRequests = { items: [], dropped: 0 };
  const workspaceRpcObservations = { items: [], dropped: 0 };
  const runtimeDebugEvents = { items: [], dropped: 0 };
  const creationRpcObservations = { items: [], dropped: 0 };
  const healthRequestStartedAt = new WeakMap();
  const serverTestRequestRecords = new WeakMap();
  const pendingHealthCaptures = new Set();
  let runtimeDebugEnabled = null;
  let healthReadiness = null;
  let creationFailureDetails = null;
  let stage = "login";

  page.on("pageerror", error => browserErrors.push(context.redactText(error.message).slice(0, 500)));
  page.on("request", request => {
    try {
      const url = new URL(request.url());
      if (request.method() === "GET" && url.pathname === "/api/servers/status") {
        const startedAt = Date.now();
        healthRequestStartedAt.set(request, {
          startedAt,
          startedOffsetMs: Math.max(0, startedAt - pageCreatedAt),
        });
      }
      if (url.pathname === "/api/servers/test") {
        const startedOffsetMs = Math.max(0, Date.now() - pageCreatedAt);
        const record = {
          method: request.method(),
          startedOffsetMs,
          finishedOffsetMs: null,
          httpStatus: null,
          elapsedMs: null,
        };
        boundedAppend(serverTestRequests, record, SERVER_TEST_CAPTURE_LIMIT);
        serverTestRequestRecords.set(request, record);
      }
    } catch {
      // Ignore non-URL requests.
    }
  });
  page.on("response", response => {
    const request = response.request();
    const serverTestRecord = serverTestRequestRecords.get(request);
    if (serverTestRecord) {
      serverTestRecord.finishedOffsetMs = Math.max(0, Date.now() - pageCreatedAt);
      serverTestRecord.httpStatus = response.status();
      serverTestRecord.elapsedMs = Math.max(0, serverTestRecord.finishedOffsetMs - serverTestRecord.startedOffsetMs);
    }
    try {
      if (new URL(response.url()).pathname !== "/api/servers/status") return;
    } catch {
      return;
    }
    const timing = healthRequestStartedAt.get(request);
    const capture = (async () => {
      let body;
      let parseError = null;
      try {
        body = await response.json();
      } catch (error) {
        parseError = context.redactText(error instanceof Error ? error.message : String(error)).slice(0, 240);
      }
      const statuses = Array.isArray(body?.statuses) ? body.statuses : [];
      boundedAppend(targetHealthResponses, {
        httpStatus: response.status(),
        startedOffsetMs: timing?.startedOffsetMs ?? null,
        finishedOffsetMs: Math.max(0, Date.now() - pageCreatedAt),
        elapsedMs: timing === undefined ? null : Math.max(0, Date.now() - timing.startedAt),
        statuses: statuses.map(item => ({
          id: typeof item?.id === "string" ? context.redactText(item.id).slice(0, 96) : null,
          status: typeof item?.status === "string" ? item.status : null,
          latencyMs: Number.isFinite(item?.latencyMs) ? item.latencyMs : null,
          checkedAt: typeof item?.checkedAt === "number" && Number.isFinite(item.checkedAt)
            ? item.checkedAt
            : typeof item?.checkedAt === "string"
              ? redactDiagnosticText(item.checkedAt, context, [targetA.path, targetB.path, profile, gatewayDataDirectory], 120)
              : null,
          error: typeof item?.error === "string"
            ? redactDiagnosticText(item.error, context, [targetA.path, targetB.path, profile, gatewayDataDirectory, kcoderBin], 400)
            : null,
        })),
        ...(parseError ? { parseError } : {}),
      }, HEALTH_CAPTURE_LIMIT);
    })().catch(() => {
      boundedAppend(targetHealthResponses, {
        httpStatus: response.status(),
        startedOffsetMs: timing?.startedOffsetMs ?? null,
        finishedOffsetMs: Math.max(0, Date.now() - pageCreatedAt),
        elapsedMs: timing === undefined ? null : Math.max(0, Date.now() - timing.startedAt),
        statuses: [],
        parseError: "status response capture failed",
      }, HEALTH_CAPTURE_LIMIT);
    });
    pendingHealthCaptures.add(capture);
    void capture.finally(() => pendingHealthCaptures.delete(capture));
  });
  page.on("console", message => {
    const text = message.text();
    if (!text.startsWith(RUNTIME_DEBUG_CONSOLE_PREFIX)) return;
    try {
      boundedAppend(runtimeDebugEvents, JSON.parse(text.slice(RUNTIME_DEBUG_CONSOLE_PREFIX.length)), RUNTIME_DEBUG_CAPTURE_LIMIT);
    } catch {
      boundedAppend(runtimeDebugEvents, { event: "invalid-safe-diagnostic" }, RUNTIME_DEBUG_CAPTURE_LIMIT);
    }
  });
  page.on("websocket", socket => {
    const workspaceRequests = new Map();
    const creationRequests = new Map();
    let socketTargetId = null;
    try {
      const socketUrl = new URL(socket.url());
      const targetId = socketUrl.searchParams.get("server");
      if (targetId === TARGET_A || targetId === TARGET_B) socketTargetId = targetId;
    } catch {
      // The WebSocket URL may contain credentials; only its allowlisted target ID is retained.
    }
    socket.on("framesent", event => {
      try {
        const frame = JSON.parse(String(event.payload));
        if (CREATION_RPC_METHODS.has(frame.method)) {
          const record = {
            direction: "request",
            method: frame.method,
            id: safeRpcId(frame.id, context),
            targetId: socketTargetId,
            startedOffsetMs: Math.max(0, Date.now() - pageCreatedAt),
          };
          const clientRequestId = safeRuntimeIdentity(frame.params?.clientRequestId, context);
          const clientMessageId = safeRuntimeIdentity(frame.params?.clientMessageId, context);
          const threadId = safeRuntimeIdentity(frame.params?.threadId, context);
          if (clientRequestId) record.clientRequestId = clientRequestId;
          if (clientMessageId) record.clientMessageId = clientMessageId;
          if (threadId) record.threadId = threadId;
          if (frame.method === "turn/start") {
            record.attachmentCount = parseAttachmentManifest(collectInputText(frame.params?.input)).length;
          }
          boundedAppend(creationRpcObservations, record, CREATION_RPC_CAPTURE_LIMIT);
          if (frame.id !== undefined && frame.id !== null) {
            creationRequests.set(String(frame.id), {
              method: frame.method,
              id: record.id,
              targetId: socketTargetId,
              clientRequestId,
              clientMessageId,
              threadId,
              startedOffsetMs: record.startedOffsetMs,
            });
            while (creationRequests.size > CREATION_RPC_CAPTURE_LIMIT) {
              creationRequests.delete(creationRequests.keys().next().value);
            }
          }
        }
        if (WORKSPACE_RPC_METHODS.has(frame.method)) {
          const id = safeRpcId(frame.id, context);
          boundedAppend(workspaceRpcObservations, {
            direction: "request",
            method: frame.method,
            id,
          }, WORKSPACE_RPC_CAPTURE_LIMIT);
          if (frame.id !== undefined && frame.id !== null) {
            workspaceRequests.set(String(frame.id), frame.method);
            while (workspaceRequests.size > WORKSPACE_RPC_CAPTURE_LIMIT) {
              workspaceRequests.delete(workspaceRequests.keys().next().value);
            }
          }
        }
        if (frame.method === "attachment/upload/start") {
          uploadRequests.set(String(frame.id), {
            filename: frame.params?.filename,
            size: frame.params?.size,
          });
        }
        if (frame.method === "turn/start") {
          const inputText = collectInputText(frame.params?.input);
          turnStarts.push({
            threadId: frame.params?.threadId,
            inputText,
            attachments: parseAttachmentManifest(inputText),
          });
        }
      } catch {
        // Authentication and unrelated payloads are intentionally not retained.
      }
    });
    socket.on("framereceived", event => {
      try {
        const frame = JSON.parse(String(event.payload));
        const creationRequest = frame.id === undefined || frame.id === null
          ? null
          : creationRequests.get(String(frame.id));
        if (creationRequest) {
          creationRequests.delete(String(frame.id));
          const response = {
            direction: "response",
            method: creationRequest.method,
            id: creationRequest.id,
            targetId: creationRequest.targetId,
            elapsedMs: Math.max(0, Date.now() - pageCreatedAt - creationRequest.startedOffsetMs),
            ...(creationRequest.clientRequestId ? { clientRequestId: creationRequest.clientRequestId } : {}),
            ...(creationRequest.clientMessageId ? { clientMessageId: creationRequest.clientMessageId } : {}),
            ...(creationRequest.threadId ? { threadId: creationRequest.threadId } : {}),
          };
          if (frame.error) {
            response.error = {
              code: safeRpcCode(frame.error.code, context),
              message: redactCreationText(frame.error.message ?? "RPC failed", context, [
                targetA.path,
                targetB.path,
                profile,
                gatewayDataDirectory,
                kcoderBin,
              ]),
            };
          } else if (creationRequest.method === "thread/start" || creationRequest.method === "thread/resume") {
            response.threadId = safeRuntimeIdentity(frame.result?.thread?.id, context);
          } else if (creationRequest.method === "thread/creation/read") {
            const receipt = frame.result?.receipt;
            response.receiptStatus = typeof receipt?.status === "string" ? receipt.status : null;
            response.threadId = safeRuntimeIdentity(receipt?.threadId, context);
          } else if (creationRequest.method === "turn/start") {
            response.turnId = safeRuntimeIdentity(frame.result?.turn?.id, context);
            response.turnStatus = typeof frame.result?.turn?.status === "string"
              ? frame.result.turn.status
              : null;
            response.accepted = Boolean(response.turnId);
          }
          boundedAppend(creationRpcObservations, response, CREATION_RPC_CAPTURE_LIMIT);
        }
        const method = frame.id === undefined || frame.id === null ? null : workspaceRequests.get(String(frame.id));
        if (method) {
          workspaceRequests.delete(String(frame.id));
          const id = safeRpcId(frame.id, context);
          if (frame.error) {
            boundedAppend(workspaceRpcObservations, {
              direction: "response",
              method,
              id,
              error: {
                code: safeRpcCode(frame.error.code, context),
                message: context.redactText(String(frame.error.message ?? "RPC failed")).slice(0, 400),
              },
            }, WORKSPACE_RPC_CAPTURE_LIMIT);
          } else {
            const result = frame.result;
            const items = Array.isArray(result?.items) ? result.items : Array.isArray(result?.workspaces) ? result.workspaces : null;
            boundedAppend(workspaceRpcObservations, {
              direction: "response",
              method,
              id,
              itemsCount: items?.length ?? null,
            }, WORKSPACE_RPC_CAPTURE_LIMIT);
          }
        }
        const request = uploadRequests.get(String(frame.id));
        if (!request) return;
        uploadRequests.delete(String(frame.id));
        uploadReplies.push({
          ...request,
          error: context.redactText(String(frame.error?.message ?? frame.result?.error?.message ?? "")).slice(0, 400) || null,
        });
      } catch {
        // Retain only the bounded, redacted fields above.
      }
    });
  });

  const rpc = (method, params = {}) =>
    page.evaluate(
      ({ method, params }) =>
        window.__KCODER_STUDIO_E2E__.invokeRuntimeCommand("local_executor_request", { method, params }),
      { method, params },
    );
  const readAttachment = args =>
    page.evaluate(
      args => window.__KCODER_STUDIO_E2E__.invokeRuntimeCommand("read_local_attachment_file", args),
      args,
    );

  try {
    await login(page, gateway.baseUrl, gateway.authToken);
    await page.waitForFunction(
      () => typeof window.__KCODER_STUDIO_E2E__?.invokeRuntimeCommand === "function",
      undefined,
      { timeout: 30_000 },
    );
    runtimeDebugEnabled = await readRuntimeDebugPreference(page);
    stage = "register-owned-target-projects";
    await rpc("runtime.projects.upsert_local", {
      deviceId: TARGET_A,
      projectKey: "attachment-project-a",
      name: PROJECT_A,
      roots: [targetA.path],
    });
    await rpc("runtime.projects.upsert_local", {
      deviceId: TARGET_B,
      projectKey: "attachment-project-b",
      name: PROJECT_B,
      roots: [targetB.path],
    });

    stage = "target-a-add-preview-remove-send";
    await page.goto(gateway.baseUrl, { waitUntil: "domcontentloaded" });
    stage = "awaiting-gateway-health-online";
    healthReadiness = await waitForGatewayTargetsOnline(page, targetHealthResponses, [TARGET_A, TARGET_B]);
    if (healthReadiness.refreshedPage) {
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForFunction(
        () => typeof window.__KCODER_STUDIO_E2E__?.invokeRuntimeCommand === "function",
        undefined,
        { timeout: 30_000 },
      );
      runtimeDebugEnabled = await readRuntimeDebugPreference(page);
    }
    stage = "target-a-add-preview-remove-send";
    await startProjectConversation(page, PROJECT_A);
    const imageBytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );
    const removedTextBytes = Buffer.from("REMOVED_TARGET_A_TEXT_MUST_NOT_BE_SENT", "utf8");
    await page.getByTestId("attachment-file-input").setInputFiles([
      { name: IMAGE_NAME, mimeType: "image/png", buffer: imageBytes },
      { name: REMOVED_TEXT_NAME, mimeType: "text/plain", buffer: removedTextBytes },
    ]);
    await waitForUploads(page);
    assert.equal(await page.getByTestId("attachment-error-badge").count(), 0);
    assert.equal(await page.getByTestId("attachment-badge").count(), 2);
    const imageBadge = page.getByTestId("attachment-badge").filter({
      has: page.getByTestId("attachment-image-preview-button"),
    });
    const removedTextBadge = page.getByTestId("attachment-badge").filter({
      has: page.getByTestId("attachment-text-preview"),
    });
    const imagePreview = imageBadge.getByTestId("attachment-image-preview");
    await imagePreview.waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(await imagePreview.getAttribute("alt"), IMAGE_NAME);
    assert.equal(await page.getByTestId("attachment-image-preview-error").count(), 0);
    assert.equal(await removedTextBadge.getByTestId("attachment-text-preview").innerText(), removedTextBytes.toString("utf8"));
    await removedTextBadge.getByTestId("remove-attachment-button").click();
    await removedTextBadge.waitFor({ state: "detached", timeout: 10_000 });
    assert.equal(await page.getByTestId("attachment-badge").count(), 1);
    assert.equal(await page.getByText(REMOVED_TEXT_NAME, { exact: true }).count(), 0);
    await page.screenshot({ path: context.pathInArtifacts("target-a-image-only-composer.png") });
    await typePrompt(page, PROMPT_A);
    const beforeA = model.requests.length;
    await page.getByTestId("send-message-button").click();
    const taskIdA = await waitForTaskId(page, TARGET_A);
    await waitForAssistant(page, REPLY_A);
    const requestA = await waitForProviderRequest(model, PROMPT_A, beforeA);
    const turnA = await waitForTurnStart(turnStarts, PROMPT_A);
    assert.equal(turnA.attachments.length, 1);
    assert.equal(turnA.attachments[0].filename, IMAGE_NAME);
    assert.equal(turnA.attachments.some(item => item.filename === REMOVED_TEXT_NAME), false);
    assert.equal(taskIdA, `kcoder:${TARGET_A}:${turnA.threadId}`, "Target A task route must identify both the target and the Native thread that received the attachment");

    const imageRead = await readAttachment({
      deviceId: TARGET_A,
      workspacePath: targetA.path,
      threadId: turnA.threadId,
      path: turnA.attachments[0].path,
      mimeType: "image/png",
    });
    const persistedImage = Buffer.from(imageRead.contentBase64, "base64");
    assert.deepEqual(persistedImage, imageBytes, "The correct target/thread must return the exact uploaded PNG bytes");
    const modelImageBytes = extractFirstImageBytes(requestA);
    assert.deepEqual(modelImageBytes, imageBytes, "The actual synthetic provider request must contain the uploaded image bytes");
    const serializedA = JSON.stringify(requestA.messages);
    assert.ok(serializedA.includes(IMAGE_NAME));
    assert.equal(serializedA.includes(REMOVED_TEXT_NAME), false);
    assert.equal(serializedA.includes(removedTextBytes.toString("utf8")), false);

    stage = "target-b-draft-scope-and-server-error";
    await page.goto(gateway.baseUrl, { waitUntil: "domcontentloaded" });
    await startProjectConversation(page, PROJECT_B);
    assert.equal(await page.getByTestId("attachment-badge").count(), 0, "Target B's new draft must not inherit Target A's sent attachment");
    assert.equal(await page.getByTestId("attachment-error-badge").count(), 0);
    await typePrompt(page, PROMPT_B);
    await page.getByTestId("attachment-file-input").setInputFiles({
      name: INVALID_NAME,
      mimeType: "text/plain",
      buffer: Buffer.from("synthetic backend filename rejection"),
    });
    await page.getByTestId("attachment-error-badge").waitFor({ state: "visible", timeout: 30_000 });
    await waitForUploads(page);
    const errorBadge = page.getByTestId("attachment-error-badge");
    const errorText = await errorBadge.innerText();
    assert.ok(errorText.includes(INVALID_NAME), "Upload error must identify the selected filename");
    assert.match(errorText, /attachment filename is invalid/i, "Composer must show the actual app-server validation error");
    const rejectedUpload = uploadReplies.find(item =>
      item.filename === INVALID_NAME && /attachment filename is invalid/i.test(item.error ?? ""),
    );
    assert.ok(rejectedUpload, "The malformed synthetic filename must be rejected by the real app-server upload request");
    assert.equal(await page.getByTestId("send-message-button").isDisabled(), true, "A failed upload must keep this draft from being sent");
    await page.screenshot({ path: context.pathInArtifacts("target-b-server-upload-error.png") });
    await page.getByTestId("dismiss-attachment-error").click();
    await errorBadge.waitFor({ state: "detached", timeout: 10_000 });

    stage = "target-b-add-preview-send-and-readback";
    const textBytes = Buffer.from(TEXT_CONTENT, "utf8");
    await page.getByTestId("attachment-file-input").setInputFiles({
      name: TEXT_NAME,
      mimeType: "text/plain",
      buffer: textBytes,
    });
    await waitForUploads(page);
    assert.equal(await page.getByTestId("attachment-error-badge").count(), 0);
    assert.equal(await page.getByTestId("attachment-badge").count(), 1);
    const textBadge = page.getByTestId("attachment-badge").filter({
      has: page.getByTestId("attachment-text-preview"),
    });
    assert.equal(await textBadge.getByTestId("attachment-text-preview").innerText(), TEXT_CONTENT);
    const beforeB = model.requests.length;
    const failedCreationRows = page.locator('[data-testid^="runtime-task-creation-error-"]');
    const failedCreationRowIdsBeforeB = await failedCreationRows.evaluateAll(rows =>
      rows.map(row => row.getAttribute("data-testid")).filter(Boolean),
    );
    await page.getByTestId("send-message-button").click();
    const taskOutcomeB = await waitForTaskRouteOrFailedDraft(page, TARGET_B, failedCreationRowIdsBeforeB);
    if (taskOutcomeB.kind === "failed-draft") {
      creationFailureDetails = await captureFailedCreationDetails(
        page,
        failedCreationRowIdsBeforeB,
        context,
        [targetA.path, targetB.path, profile, gatewayDataDirectory, kcoderBin],
        creationRpcObservations,
      );
      await context.writeArtifactJson("target-b-create-failure-ui-diagnostic.json", {
        ...creationFailureDetails,
        creationRpcObservations,
      });
      await page.screenshot({
        path: context.pathInArtifacts("target-b-create-failure-ui.png"),
        fullPage: true,
      });
      throw new Error("Target B showed a failed task-creation draft; captured its expanded detail without retrying");
    }
    const taskIdB = taskOutcomeB.taskId;
    await waitForAssistant(page, REPLY_B);
    const requestB = await waitForProviderRequest(model, PROMPT_B, beforeB);
    const turnB = await waitForTurnStart(turnStarts, PROMPT_B);
    assert.equal(turnB.attachments.length, 1);
    assert.equal(turnB.attachments[0].filename, TEXT_NAME);
    assert.equal(taskIdB, `kcoder:${TARGET_B}:${turnB.threadId}`, "Target B task route must identify both the target and the Native thread that received the attachment");
    const serializedB = JSON.stringify(requestB.messages);
    assert.ok(serializedB.includes(TEXT_NAME), "Target B's model request must carry the selected attachment name");
    assert.equal(serializedB.includes(IMAGE_NAME), false, "Target B's request must not contain Target A's image");

    const textRead = await readAttachment({
      deviceId: TARGET_B,
      workspacePath: targetB.path,
      threadId: turnB.threadId,
      path: turnB.attachments[0].path,
      mimeType: "text/plain",
    });
    const persistedText = Buffer.from(textRead.contentBase64, "base64");
    assert.deepEqual(persistedText, textBytes, "The correct target/thread must return the exact uploaded TXT bytes");
    await assert.rejects(
      readAttachment({
        deviceId: TARGET_A,
        workspacePath: targetA.path,
        threadId: turnB.threadId,
        path: turnB.attachments[0].path,
        mimeType: "text/plain",
      }),
      /attachment|directory|thread|not found|missing/i,
      "Reading Target B's attachment through Target A must be rejected",
    );
    assert.deepEqual(browserErrors, []);

    const evidence = {
      targets: {
        targetA: { deviceId: TARGET_A, taskThreadAligned: true, imageFilename: IMAGE_NAME, imageBytes: imageBytes.length,
          imageSha256: sha256(imageBytes), exactTargetThreadReadback: true },
        targetB: { deviceId: TARGET_B, taskThreadAligned: true, textFilename: TEXT_NAME, textBytes: textBytes.length,
          textSha256: sha256(textBytes), exactTargetThreadReadback: true, wrongTargetReadRejected: true },
      },
      lifecycle: {
        targetAImagePreview: true,
        targetATextPreview: true,
        removedTextAbsentFromTurnAndProviderRequest: true,
        targetBNewDraftStartedWithoutTargetAAttachments: true,
        actualNativeFilenameRejection: { filename: INVALID_NAME, appServerError: rejectedUpload.error, shownInComposer: true },
        failedUploadBlockedSendUntilDismissed: true,
        providerRequests: model.requests.length,
      },
      diagnostics: {
        runtimeDebugEnabled,
        healthReadiness,
        healthTestConcurrency: summarizeHealthTestConcurrency(targetHealthResponses, serverTestRequests),
        targetHealthResponses,
        serverTestRequests,
        workspaceRpcObservations,
        runtimeDebugEvents,
        creationRpcObservations,
      },
    };
    await context.writeArtifactJson("attachment-compose-evidence.json", evidence);
    await page.screenshot({ path: context.pathInArtifacts("target-b-sent-attachment.png") });
    return evidence;
  } catch (error) {
    await Promise.allSettled([...pendingHealthCaptures]);
    runtimeDebugEnabled = await readRuntimeDebugPreference(page).catch(() => null);
    const localExecutorStatus = await readFailureLocalExecutorStatus(page, context);
    const runtimeTasksList = await readFailureRuntimeTasks(page, context);
    await context.writeArtifactJson("failure.json", {
      stage,
      error: context.redactText(error instanceof Error ? error.message : String(error)).slice(0, 1000),
      runtimeDebugEnabled,
      healthReadiness,
      healthTestConcurrency: summarizeHealthTestConcurrency(targetHealthResponses, serverTestRequests),
      targetHealthResponses,
      serverTestRequests,
      workspaceRpcObservations,
      runtimeDebugEvents,
      creationRpcObservations,
      creationFailureDetails,
      failureRuntimeSnapshot: { localExecutorStatus, runtimeTasksList },
      observedUploadReplies: uploadReplies,
      turnStartCount: turnStarts.length,
      providerRequestCount: model.requests.length,
      browserErrors,
    });
    await page.screenshot({ path: context.pathInArtifacts("failure.png") }).catch(() => {});
    throw error;
  }
});

async function login(page, baseUrl, token) {
  const response = await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  assert.equal(response?.status(), 200);
  await page.locator('input[name="token"]').fill(token);
  await Promise.all([
    page.waitForURL(url => !url.pathname.startsWith("/login"), { timeout: 20_000 }),
    page.locator('button[type="submit"]').click(),
  ]);
  await page.getByTestId("desktop-sidebar").waitFor({ state: "visible", timeout: 30_000 });
}

async function startProjectConversation(page, projectName) {
  const project = page.getByTestId("project-item").filter({ hasText: projectName }).first();
  await project.waitFor({ state: "visible", timeout: 60_000 });
  await project.getByTestId("project-new-conversation-button").click();
  await page.getByTestId("chat-message-input").waitFor({ state: "visible", timeout: 30_000 });
}

async function waitForUploads(page) {
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="uploading-attachment-badge"]').length === 0,
    undefined,
    { timeout: 30_000 },
  );
}

async function typePrompt(page, prompt) {
  const composer = page.getByTestId("chat-message-input");
  await composer.click();
  await page.keyboard.insertText(prompt);
  assert.equal((await composer.innerText()).trim(), prompt);
}

async function waitForTaskId(page, deviceId) {
  const prefix = "kcoder:" + deviceId + ":";
  await page.waitForFunction(
    expectedPrefix => new URL(location.href).searchParams.get("taskId")?.startsWith(expectedPrefix),
    prefix,
    { timeout: 30_000 },
  );
  return new URL(page.url()).searchParams.get("taskId");
}

async function waitForTaskRouteOrFailedDraft(page, deviceId, previousFailedRowIds) {
  const prefix = `kcoder:${deviceId}:`;
  await page.waitForFunction(
    ({ expectedPrefix, previousIds }) => {
      const taskId = new URL(location.href).searchParams.get("taskId");
      if (taskId?.startsWith(expectedPrefix)) return true;
      return Array.from(document.querySelectorAll('[data-testid^="runtime-task-creation-error-"]'))
        .some(row => !previousIds.includes(row.getAttribute("data-testid")));
    },
    { expectedPrefix: prefix, previousIds: previousFailedRowIds },
    { timeout: 30_000 },
  );
  const taskId = new URL(page.url()).searchParams.get("taskId");
  return taskId?.startsWith(prefix)
    ? { kind: "route", taskId }
    : { kind: "failed-draft" };
}

async function captureFailedCreationDetails(page, previousFailedRowIds, context, hiddenPaths, rpcObservations) {
  const rows = page.locator('[data-testid^="runtime-task-creation-error-"]');
  const count = await rows.count();
  let failedRow = null;
  let failedTestId = null;
  for (let index = 0; index < count; index++) {
    const row = rows.nth(index);
    const testId = await row.getAttribute("data-testid");
    if (testId && !previousFailedRowIds.includes(testId)) {
      failedRow = row;
      failedTestId = testId;
      break;
    }
  }
  assert.ok(failedRow, "The newly displayed task-creation failure row must remain visible for diagnosis");
  const failedTaskId = safeRuntimeIdentity(
    failedTestId.slice("runtime-task-creation-error-".length),
    context,
  );
  const errorText = await failedRow.locator("details p").textContent();
  const evidence = {
    targetId: TARGET_B,
    taskIdentity: failedTaskId,
    error: redactCreationText(errorText ?? "", context, hiddenPaths),
  };
  await context.writeArtifactJson("target-b-create-failure-details.json", {
    ...evidence,
    creationRpcObservations: rpcObservations,
    uiDiagnostic: { summaryClickAttempted: false },
  });

  const summary = failedRow.locator("details > summary");
  const details = failedRow.locator("details");
  const summaryDomState = await summary.evaluate(element => {
    const ancestors = [];
    for (let node = element; node; node = node.parentElement) {
      ancestors.push({
        tag: node.tagName.toLowerCase(),
        ariaDisabled: node.getAttribute("aria-disabled"),
        disabled: "disabled" in node ? Boolean(node.disabled) : null,
        disabledAttribute: node.hasAttribute("disabled"),
      });
    }
    return {
      tag: element.tagName.toLowerCase(),
      ariaDisabled: element.getAttribute("aria-disabled"),
      disabled: "disabled" in element ? Boolean(element.disabled) : null,
      disabledAttribute: element.hasAttribute("disabled"),
      disabledPseudoClass: element.matches(":disabled"),
      tabIndex: element.tabIndex,
      ancestors,
    };
  });
  const playwrightEnabled = await summary.isEnabled().catch(() => null);
  let clickError = null;
  let clickSucceeded = false;
  try {
    await summary.click({ timeout: 1_500 });
    clickSucceeded = true;
  } catch (error) {
    clickError = redactCreationText(
      error instanceof Error ? error.message : String(error),
      context,
      hiddenPaths,
    );
  }
  const detailsExpanded = await details.evaluate(element => element.open).catch(() => false);
  return {
    ...evidence,
    uiDiagnostic: {
      summaryDomState,
      playwrightEnabled,
      clickSucceeded,
      clickError,
      detailsExpanded,
    },
  };
}

async function waitForAssistant(page, reply) {
  await page.getByTestId("message-assistant").filter({ hasText: reply }).last().waitFor({
    state: "visible",
    timeout: 45_000,
  });
}

async function waitForProviderRequest(model, marker, previousCount) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const request = [...model.requests].reverse().find(item =>
      JSON.stringify(item.messages ?? []).includes(marker),
    );
    if (request) {
      assert.ok(model.requests.length > previousCount);
      return request;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error("Synthetic provider did not receive the expected attachment turn");
}

async function waitForTurnStart(turnStarts, marker) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const turn = [...turnStarts].reverse().find(item => item.inputText.includes(marker));
    if (turn) {
      assert.ok(turn.threadId);
      return turn;
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error("Browser RPC did not expose the expected turn/start attachment manifest");
}

function collectInputText(input) {
  if (typeof input === "string") return input;
  if (!Array.isArray(input)) return "";
  return input.map(item => typeof item === "string" ? item : typeof item?.text === "string" ? item.text : "").join("\n");
}

function parseAttachmentManifest(text) {
  const match = text.match(/<kcoder_attachments version="1">\s*([\s\S]*?)\s*<\/kcoder_attachments>/);
  if (!match) return [];
  return match[1].split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
}

function extractFirstImageBytes(request) {
  const values = [];
  const visit = value => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!value || typeof value !== "object") return;
    if (value.type === "image_url") values.push(value.image_url?.url);
    if (value.type === "input_image") values.push(value.image_url);
    for (const [key, child] of Object.entries(value)) {
      if (key !== "image_url" || !["image_url", "input_image"].includes(value.type)) visit(child);
    }
  };
  visit(request.messages);
  const dataUrl = values.find(value => typeof value === "string" && /^data:image\/[^;]+;base64,/.test(value));
  assert.ok(dataUrl, "Provider request must include a structured image data URL");
  const match = dataUrl.match(/^data:image\/[^;]+;base64,([A-Za-z0-9+/=]+)$/);
  assert.ok(match);
  return Buffer.from(match[1], "base64");
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function boundedAppend(bucket, value, limit) {
  if (bucket.items.length >= limit) {
    bucket.items.shift();
    bucket.dropped++;
  }
  bucket.items.push(value);
}

function redactDiagnosticText(value, context, hiddenPaths = [], limit = 400) {
  let text = context.redactText(String(value));
  for (const path of hiddenPaths) {
    if (typeof path === "string" && path) text = text.replaceAll(path, "[OWNED_PATH]");
  }
  return text.slice(0, limit);
}

function redactCreationText(value, context, hiddenPaths = []) {
  let text = redactDiagnosticText(value, context, hiddenPaths, 1_000);
  for (const syntheticValue of [PROMPT_A, PROMPT_B, REPLY_A, REPLY_B, TEXT_CONTENT]) {
    text = text.replaceAll(syntheticValue, "[SYNTHETIC_INPUT]");
  }
  return text.slice(0, 400);
}

function targetsOnline(statuses, targetIds) {
  return targetIds.every(id => statuses.some(status => status.id === id && status.status === "online"));
}

async function waitForGatewayTargetsOnline(page, capturedResponses, targetIds) {
  const startedAt = Date.now();
  const deadline = startedAt + HEALTH_ONLINE_WAIT_MS;
  const firstResponseDeadline = Math.min(deadline, startedAt + FIRST_HEALTH_OBSERVATION_WAIT_MS);
  while (capturedResponses.items.length === 0 && Date.now() < firstResponseDeadline) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  const latestPageResponse = capturedResponses.items.at(-1);
  const initialStatuses = latestPageResponse?.statuses ?? [];
  if (latestPageResponse?.httpStatus === 200 && targetsOnline(initialStatuses, targetIds)) {
    return {
      ready: true,
      source: "page-health-response",
      refreshedPage: false,
      waitedMs: Math.max(0, Date.now() - startedAt),
      initialStatuses: initialStatuses.map(({ id, status }) => ({ id, status })),
      pollCount: 0,
    };
  }

  let pollCount = 0;
  let lastProbeError = null;
  while (Date.now() < deadline) {
    pollCount++;
    const snapshot = await page.evaluate(async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      try {
        const response = await fetch("/api/servers/status", {
          cache: "no-store",
          signal: controller.signal,
        });
        const payload = await response.json();
        const statuses = Array.isArray(payload?.statuses) ? payload.statuses : [];
        return {
          httpStatus: response.status,
          statuses: statuses.map(item => ({
            id: typeof item?.id === "string" ? item.id : null,
            status: typeof item?.status === "string" ? item.status : null,
          })),
        };
      } catch (error) {
        return {
          httpStatus: null,
          statuses: [],
          error: error instanceof Error ? error.message : String(error),
        };
      } finally {
        clearTimeout(timer);
      }
    });
    if (snapshot.httpStatus === 200 && targetsOnline(snapshot.statuses, targetIds)) {
      return {
        ready: true,
        source: "bounded-api-probe",
        refreshedPage: true,
        waitedMs: Math.max(0, Date.now() - startedAt),
        initialStatuses: initialStatuses.map(({ id, status }) => ({ id, status })),
        onlineStatuses: snapshot.statuses,
        pollCount,
      };
    }
    if (snapshot.error) lastProbeError = snapshot.error;
    await new Promise(resolve => setTimeout(resolve, 750));
  }

  const safeError = lastProbeError ? `; last probe error: ${lastProbeError}` : "";
  throw new Error(
    `Gateway health did not report all owned targets online within ${HEALTH_ONLINE_WAIT_MS}ms${safeError}`,
  );
}

function summarizeHealthTestConcurrency(healthResponses, serverTestRequests) {
  const health = healthResponses.items.filter(item =>
    Number.isFinite(item.startedOffsetMs) && Number.isFinite(item.finishedOffsetMs),
  );
  const tests = serverTestRequests.items;
  const overlaps = [];
  for (const test of tests) {
    const testEnd = Number.isFinite(test.finishedOffsetMs)
      ? test.finishedOffsetMs
      : Math.max(test.startedOffsetMs, ...health.map(item => item.finishedOffsetMs), 0);
    for (const response of health) {
      if (test.startedOffsetMs <= response.finishedOffsetMs && response.startedOffsetMs <= testEnd) {
        overlaps.push({
          testMethod: test.method,
          testStartedOffsetMs: test.startedOffsetMs,
          testFinishedOffsetMs: Number.isFinite(test.finishedOffsetMs) ? test.finishedOffsetMs : null,
          healthStartedOffsetMs: response.startedOffsetMs,
          healthFinishedOffsetMs: response.finishedOffsetMs,
        });
        if (overlaps.length >= 32) break;
      }
    }
    if (overlaps.length >= 32) break;
  }
  return {
    serverTestRequestCount: tests.length + serverTestRequests.dropped,
    capturedServerTestRequestCount: tests.length,
    droppedServerTestRequestCount: serverTestRequests.dropped,
    overlappingHealthTestPairs: overlaps.length,
    overlapWindows: overlaps,
  };
}

function safeRpcId(value, context) {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string") return context.redactText(value).slice(0, 120);
  return null;
}

function safeRuntimeIdentity(value, context) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) return null;
  return context.redactText(value).slice(0, 128);
}

function safeRpcCode(value, context) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") return context.redactText(value).slice(0, 120);
  return null;
}

async function readRuntimeDebugPreference(page) {
  return page.evaluate(() => {
    try {
      return localStorage.getItem("kcoder:debug-runtime") === "1";
    } catch {
      return false;
    }
  });
}

async function readFailureLocalExecutorStatus(page, context) {
  let result;
  try {
    result = await page.evaluate(async () => {
      const invoke = window.__KCODER_STUDIO_E2E__?.invokeRuntimeCommand;
      if (typeof invoke !== "function") {
        return { diagnosticError: { code: null, message: "E2E runtime bridge unavailable" } };
      }
      try {
        const status = await invoke("local_executor_status");
        return {
          deviceId: typeof status?.deviceId === "string" ? status.deviceId : null,
          running: typeof status?.running === "boolean" ? status.running : null,
          ready: typeof status?.ready === "boolean" ? status.ready : null,
        };
      } catch (error) {
        return {
          diagnosticError: {
            code: typeof error?.code === "number" || typeof error?.code === "string" ? error.code : null,
            message: error instanceof Error ? error.message : String(error),
          },
        };
      }
    });
  } catch (error) {
    result = { diagnosticError: { code: null, message: error instanceof Error ? error.message : String(error) } };
  }
  if (!result?.diagnosticError) return result;
  return { error: redactDiagnosticError(result.diagnosticError, context) };
}

async function readFailureRuntimeTasks(page, context) {
  let result;
  try {
    result = await page.evaluate(async () => {
      const invoke = window.__KCODER_STUDIO_E2E__?.invokeRuntimeCommand;
      if (typeof invoke !== "function") {
        return { diagnosticError: { code: null, message: "E2E runtime bridge unavailable" } };
      }
      try {
        const listing = await invoke("local_executor_request", {
          method: "runtime.tasks.list",
          params: {},
        });
        const workspaces = Array.isArray(listing?.workspaces) ? listing.workspaces : [];
        return {
          workspaces: workspaces.map(workspace => ({
            deviceId: typeof workspace?.deviceId === "string" ? workspace.deviceId : null,
            deviceStatus: typeof workspace?.deviceStatus === "string" ? workspace.deviceStatus : null,
            available: typeof workspace?.available === "boolean" ? workspace.available : null,
            error: typeof workspace?.error === "string" ? workspace.error : null,
            projectKey: typeof workspace?.projectKey === "string" ? workspace.projectKey : null,
          })),
        };
      } catch (error) {
        return {
          diagnosticError: {
            code: typeof error?.code === "number" || typeof error?.code === "string" ? error.code : null,
            message: error instanceof Error ? error.message : String(error),
          },
        };
      }
    });
  } catch (error) {
    result = { diagnosticError: { code: null, message: error instanceof Error ? error.message : String(error) } };
  }
  if (result?.diagnosticError) return { error: redactDiagnosticError(result.diagnosticError, context) };
  return {
    workspaces: (result?.workspaces ?? []).map(workspace => ({
      ...workspace,
      deviceId: typeof workspace.deviceId === "string" ? context.redactText(workspace.deviceId).slice(0, 120) : null,
      deviceStatus: typeof workspace.deviceStatus === "string" ? context.redactText(workspace.deviceStatus).slice(0, 120) : null,
      error: typeof workspace.error === "string" ? context.redactText(workspace.error).slice(0, 400) : null,
      projectKey: typeof workspace.projectKey === "string" ? context.redactText(workspace.projectKey).slice(0, 160) : null,
    })),
  };
}

function redactDiagnosticError(error, context) {
  return {
    code: safeRpcCode(error?.code, context),
    message: context.redactText(String(error?.message ?? "Runtime diagnostic failed")).slice(0, 400),
  };
}

async function inspectGatewayStartupFailure({ context, gatewayDataDirectory, error }) {
  const logPath = join(context.logsDir, "attachment-compose-gateway.log");
  const log = await readFile(logPath, "utf8").catch(() => "");
  const mobileAuthLockFailure = log.includes("Device authorization local store lock unavailable");
  const browserSessionsElapsedMs = Number(
    log.match(/"phase":"browser_sessions","status":"failed","elapsedMs":(\d+)/)?.[1] ?? NaN,
  );
  const diagnostic = {
    failure: context.redactText(error instanceof Error ? error.message : String(error)).slice(0, 1000),
    mobileAuthLockFailure,
    browserSessionsElapsedMs: Number.isFinite(browserSessionsElapsedMs) ? browserSessionsElapsedMs : null,
  };
  if (!mobileAuthLockFailure) return diagnostic;

  const storePath = join(gatewayDataDirectory, "mobile-device-auth");
  const info = await lstat(storePath).catch(() => null);
  if (!info?.isDirectory()) {
    diagnostic.store = { directoryPresent: false };
    diagnostic.lockPortProbe = { attempted: false, reason: "private auth store directory was not present" };
    return diagnostic;
  }

  const storageIdentity = `local-file:${info.dev}:${info.ino}`;
  const identityHashPrefix = createHash("sha256").update(storageIdentity).digest("hex").slice(0, 8);
  const lockPort = 49152 + (parseInt(identityHashPrefix, 16) % 16384);
  diagnostic.store = {
    directoryPresent: true,
    device: String(info.dev),
    inode: String(info.ino),
  };
  diagnostic.lockPort = lockPort;
  diagnostic.eaddrinuseEvidence = {
    directlyCaptured: false,
    inferredFromRetryDeadline: browserSessionsElapsedMs >= 4900 && browserSessionsElapsedMs < 10_000,
    basis: "The source retries only EADDRINUSE until its five-second deadline; this public error omits the underlying errno.",
  };

  try {
    const output = execFileSync("ss", ["-H", "-ltnp", `sport = :${lockPort}`], {
      encoding: "utf8",
      timeout: 2000,
      maxBuffer: 16 * 1024,
    });
    const lines = output.split(/\r?\n/).filter(Boolean);
    diagnostic.lockPortProbe = {
      attempted: true,
      listenerPresent: lines.length > 0,
      listeners: lines.map(line => ({
        processName: line.match(/users:\(\(\"([^\"]+)/)?.[1] ?? null,
        pid: Number(line.match(/pid=(\d+)/)?.[1] ?? NaN) || null,
      })),
    };
  } catch (probeError) {
    diagnostic.lockPortProbe = {
      attempted: true,
      listenerPresent: null,
      errorCode: typeof probeError?.code === "string" ? probeError.code : "ss_failed",
    };
  }
  return diagnostic;
}
