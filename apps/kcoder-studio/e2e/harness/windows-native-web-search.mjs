import assert from "node:assert/strict";
import {windowsManagedPacPayload} from "./windows-managed-pac-fixture.mjs";
import { createNativeWebModelFixture } from "./windows-native-web-model.mjs";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AppServerStdioClient } from "./app-server-stdio.mjs";

export const NATIVE_FIRST_SEARCH_QUERY =
  "Python asyncio official documentation docs.python.org";
export const NATIVE_FIRST_SEARCH_CALL = "owned-native-first-web-search";
export const NATIVE_FIRST_FETCH_CALL = "owned-native-first-web-fetch";
export const NATIVE_BUNDLED_SEARCH_CALL = "owned-native-bundled-parent-search";
export function controlledPacNativeCase(fixtureId) {
  const value=windowsManagedPacPayload(fixtureId);
  return {fixtureId:value.fixtureId,marker:value.marker,nativeQuery:value.nativeQuery,expectedSources:value.expectedSources.map(source=>source.url)};
}

function bundledScope(scope) {
  assert.ok(["default", "bundled-parent-route"].includes(scope));
  return scope === "bundled-parent-route";
}
function searchCall(scope) {
  return bundledScope(scope) ? NATIVE_BUNDLED_SEARCH_CALL : NATIVE_FIRST_SEARCH_CALL;
}
export const NATIVE_FIRST_FETCH_URL =
  "https://docs.python.org/3/library/asyncio.html";
export function requireNativeSearchGates(nativeConsent, externalConsent) {
  assert.equal(
    nativeConsent,
    "1",
    "Explicit native Windows consent is required",
  );
  assert.equal(externalConsent, "1", "Explicit public web consent is required");
}
export function parseNativeWorkerInput(text) {
  try {
    return JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    throw new Error("Owned native worker input is invalid JSON");
  }
}
export function validateNativePermissionDefaults(value) {
  assert.ok(value.persistedPermissionMode === null || value.persistedPermissionMode === "ask");
  assert.equal(value.effectivePermissionMode, "ask");
  assert.equal(value.cliPermissionModeOverride, null);
}
export function nativeToolCallObservations(history) {
  const known = (value, values) => values.includes(value) ? value : null;
  const statuses = ["success", "empty", "partial", "failed", "cancelled"];
  const failures = ["invalid_input", "policy_denied", "authentication", "rate_limited",
    "quota_exhausted", "network", "tls", "timeout", "challenge", "contract_invalid",
    "component_unavailable", "unsupported", "cancelled"];
  const calls = new Map();
  for (const frame of history) {
    const item = frame.params?.item;
    if (frame.method !== "item/completed" || item?.type !== "toolCall" ||
        ![NATIVE_FIRST_SEARCH_CALL, NATIVE_FIRST_FETCH_CALL, NATIVE_BUNDLED_SEARCH_CALL].includes(item.id)) continue;
    const source = item.webSources;
    const pages = Array.isArray(source?.sources) ? source.sources : [];
    const attempts = Array.isArray(source?.attempts) ? source.attempts : [];
    calls.set(item.id, {
      toolCallId: item.id,
      status: known(item.status, ["completed", "failed", "interrupted", "unknown"]),
      sourceStatus: known(source?.status, statuses),
      failure: known(source?.failure, failures),
      readStatuses: pages.slice(0, 64).map(page =>
        known(page?.readStatus, ["summary_only", "read", "partial", "unreadable"])),
      attempts: attempts.slice(0, 8).map(attempt => ({
        provider: known(attempt?.provider, ["exa-public", "searxng-bundled", "bing-html"]),
        status: known(attempt?.status, statuses),
        elapsedMs: Number.isSafeInteger(attempt?.elapsedMs) && attempt.elapsedMs >= 0 ? attempt.elapsedMs : null,
        error: known(attempt?.error, failures),
        requestSent: typeof attempt?.requestSent === "boolean" ? attempt.requestSent : null,
      })),
    });
  }
  return [...calls.values()];
}
export function nativeSearchCapabilities() {
  return {
    experimental: {
      studioWorkModesV1: true,
      approvalToolCallIdentityV1: true,
      interactionBindingV1: true,
    },
  };
}
export function nativeSearchSettings(endpoint, scope = "default") {
  const bundled = bundledScope(scope);
  const settings = {
    credential_store: "file",
    max_retries: 0,
    active_provider: "ownedNativeModel",
    model: "fixture",
    providers: {
      ownedNativeModel: {
        api_format: "openai_chat_completions",
        endpoint,
        default_model: "fixture",
        authentication: { mode: "none" },
        discover_models: false,
        context_window_tokens: 128000,
        max_output_tokens: 1024,
        output_headroom_tokens: 4096,
      },
    },
  };
  if (bundled) settings.web = {search:{mode:"pinned",preferredProvider:"searxng-bundled",fallbackScope:"none",
    providers:[{id:"searxng-bundled",kind:"searxng",enabled:true}]}};
  return settings;
}
export function validateNativeSearchReceipt(receipt, threadId, scope = "default") {
  assert.equal(receipt?.schemaVersion, 1);
  assert.equal(receipt.identity?.threadId, threadId);
  assert.equal(receipt.toolCallId, searchCall(scope));
  if (bundledScope(scope)) assert.equal(receipt.provider,"searxng-bundled");
  assert.equal(receipt.operation, "search");
  assert.ok(
    ["success", "partial"].includes(receipt.status),
    "The default source must return actual results",
  );
  assert.ok(
    Array.isArray(receipt.sources) && receipt.sources.length > 0,
    "Native source observations are required",
  );
  assert.ok(
    receipt.sources.every(
      (source) =>
        source.readStatus === "summary_only" && /^https?:\/\//.test(source.url),
    ),
  );
  return receipt;
}

export function validateNativeFetchReceipt(receipt, threadId) {
  assert.equal(receipt?.schemaVersion, 1);
  assert.equal(receipt.identity?.threadId, threadId);
  assert.equal(receipt.toolCallId, NATIVE_FIRST_FETCH_CALL);
  assert.equal(receipt.operation, "fetch");
  assert.ok(["success", "partial"].includes(receipt.status));
  assert.equal(receipt.sources?.length, 1);
  assert.equal(receipt.sources[0].url, NATIVE_FIRST_FETCH_URL);
  assert.ok(
    ["read", "partial"].includes(receipt.sources[0].readStatus),
    "A search summary is not a native page read",
  );
  return receipt;
}

export function nativeApprovalResponse(frame, threadId, turnId, scope = "default", controlledCase = null) {
  if(controlledCase){assert.equal(bundledScope(scope),true);assert.deepEqual(controlledCase,controlledPacNativeCase(controlledCase.fixtureId));}
  assert.equal(frame.method, "approval/request");
  const p = frame.params;
  assert.equal(p?.threadId, threadId);
  assert.equal(p?.turnId, turnId);
  assert.ok(p.approvalId);
  assert.ok(p.appServerEpoch, "Actual app-server lifetime is required");
  assert.equal(p.action?.type, "tool");
  const args = p.action.input ?? p.action.arguments;
  assert.notEqual(args, undefined, "Exact native approval input is required");
  const input = typeof args === "string" ? JSON.parse(args) : args;
  if (p.action.name === "WebSearch") {
    assert.equal(p.toolCallId, searchCall(scope));
    assert.deepEqual(input, {
      query: controlledCase?.nativeQuery ?? NATIVE_FIRST_SEARCH_QUERY,
      num_results: 3,
    });
  } else {
    assert.equal(bundledScope(scope),false,"The bundled lane cannot issue a page fetch");
    assert.equal(p.action.name, "WebFetch");
    assert.equal(p.toolCallId, NATIVE_FIRST_FETCH_CALL);
    assert.deepEqual(input, {
      url: NATIVE_FIRST_FETCH_URL,
      prompt: "Read the actual official asyncio documentation.",
    });
  }
  return {
    approvalId: p.approvalId,
    threadId: p.threadId,
    turnId: p.turnId,
    decision: "accept",
  };
}
export async function acceptPendingNativeApproval(rpc, threadId, turnId, seen = new Set(), scope = "default", controlledCase = null) {
  const pending = rpc.pendingServerRequests();
  if (!pending.length) return null;
  const frame = pending[0],
    response = nativeApprovalResponse(frame, threadId, turnId, scope, controlledCase);
  assert.ok(
    !seen.has(frame.params.toolCallId),
    "Only one authorization per fixed native call is allowed",
  );
  seen.add(frame.params.toolCallId);
  const resolved = rpc.waitForNotification(
    (value) =>
      value.method === "approval/resolved" &&
      value.params?.requestId === frame.id &&
      value.params?.approvalId === response.approvalId &&
      value.params?.threadId === threadId &&
      value.params?.turnId === turnId &&
      value.params?.decision === "accept" &&
      value.params?.appServerEpoch === frame.params.appServerEpoch,
    10000,
    "native approval resolved",
  );
  await Promise.all([rpc.respond(frame.id, response), resolved]);
  return {
    requestId: frame.id,
    tool: frame.params.action.name,
    toolCallId: frame.params.toolCallId,
    appServerEpoch: frame.params.appServerEpoch,
    ...response,
    resolved: true,
  };
}

/** Run inside the existing owned Windows Job or isolated installer desktop. */
export async function runInstalledNativeWebSearch({
  binary,
  directory,
  environment,
  expectedCommit,
  expectedCliSha256,
  nativeConsent,
  externalConsent,
  scope = "default",
  controlledCase = null,
}) {
  requireNativeSearchGates(nativeConsent, externalConsent);
  const bundled = bundledScope(scope);
  if(controlledCase){assert.equal(bundled,true);assert.deepEqual(controlledCase,controlledPacNativeCase(controlledCase.fixtureId));}
  const query=controlledCase?.nativeQuery ?? NATIVE_FIRST_SEARCH_QUERY;
  const toolCalls = bundled ? 1 : 2;
  const requestLimit = toolCalls + 1;
  const searchCallId = searchCall(scope);
  const profile = join(directory, "native-web-profile"),
    workspace = join(directory, "native-web-workspace");
  await mkdir(profile, { recursive: true });
  await mkdir(workspace, { recursive: true });
  let phase = "setup";
  const fixture = createNativeWebModelFixture({bundled,query,searchCallId,fetchCallId:NATIVE_FIRST_FETCH_CALL,fetchUrl:NATIVE_FIRST_FETCH_URL});
  const server=fixture.server;
  await new Promise((accept) => server.listen(0, "127.0.0.1", accept));
  const settings = nativeSearchSettings(
    `http://127.0.0.1:${server.address().port}/v1`, scope,
  );
  assert.equal(Object.hasOwn(settings, "web"), bundled);
  assert.equal(Object.hasOwn(settings, "mcp_servers"), false);
  await writeFile(join(profile, "settings.json"), JSON.stringify(settings));
  const env = { ...environment, KCODER_CONFIG_DIR: profile };
  const child = spawn(binary, ["app-server"], {
    cwd: workspace,
    env,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (data) => {
    stderr = (stderr + data).slice(-8192);
  });
  const rpc = new AppServerStdioClient("installed native first search", child, {
    defaultTimeoutMs: 120000,
    notificationHistoryLimit: 128,
  });
  const call = async (method, params) => {
    const frame = await rpc.request(method, params);
    assert.ok(!frame.error, `Native ${method} rejected`);
    return frame.result;
  };
  const approvedTools = new Set();
  let completedResult, failedError;
  let approvals = [],
    approvalTimer,
    approvalBusy = false,
    approvalFailure;
  try {
    phase = "initialize";
    const initialized = await call("initialize", {
      protocolVersion: "2026-07-27",
      clientInfo: { name: "owned-native-default-search", version: "1" },
      capabilities: nativeSearchCapabilities(),
    });
    assert.equal(initialized.capabilities?.approvals, true);
    for (const key of ["approvalToolCallIdentityV1", "interactionBindingV1"])
      assert.equal(initialized.capabilities?.experimental?.[key], true);
    phase = "permission-defaults";
    const permissions = await call("settings/execution-defaults/read", {});
    validateNativePermissionDefaults(permissions);
    phase = "thread-start";
    const started = await call("thread/start", { cwd: workspace });
    const threadId = started.thread.id;
    const observed = rpc.waitForNotification(
      (frame) =>
        frame.method === "item/completed" &&
        frame.params?.item?.type === "toolCall" &&
        frame.params.item.id === searchCallId,
      120000,
      "native WebSearch receipt",
    );
    const fetched = bundled ? Promise.resolve(null) : rpc.waitForNotification(
      (frame) =>
        frame.method === "item/completed" &&
        frame.params?.item?.type === "toolCall" &&
        frame.params.item.id === NATIVE_FIRST_FETCH_CALL,
      120000,
      "native WebFetch receipt",
    );
    const completed = rpc.waitForNotification(
      (frame) =>
        frame.method === "turn/completed" &&
        frame.params?.threadId === threadId,
      120000,
      "native first search completion",
    );
    phase = "native-turn";
    const turnStarted = await call("turn/start", {
      threadId,
      input: [
        {
          type: "text",
          text: controlledCase ? "Run the owned controlled-PAC managed query exactly once." : bundled ? "Search the official Python asyncio documentation once using the explicitly selected bundled source." : "Search the official Python asyncio documentation once using the default native source, then read the official HTTPS page.",
        },
      ],
    });
    const turnId = turnStarted.turn?.id ?? turnStarted.turnId;
    assert.ok(turnId, "Actual turn identity is required");
    approvalTimer = setInterval(async () => {
      if (approvalBusy || approvalFailure) return;
      approvalBusy = true;
      try {
        const receipt = await acceptPendingNativeApproval(
          rpc,
          threadId,
          turnId,
          approvedTools, scope, controlledCase,
        );
        if (receipt) approvals.push(receipt);
      } catch (error) {
        approvalFailure = error;
      } finally {
        approvalBusy = false;
      }
    }, 25);
    phase = "await-native-receipts";
    const [item, fetchItem, turn] = await Promise.all([
      observed,
      fetched,
      completed,
    ]);
    if (approvalFailure) throw approvalFailure;
    if (fixture.failure) throw fixture.failure;
    assert.ok(
      !turn.params.error,
      "The real default-source turn must complete successfully",
    );
    phase = "validate-search";
    const receipt = validateNativeSearchReceipt(
      item.params.item.webSources,
      threadId, scope,
    );
    if(controlledCase){assert.equal(receipt.sources.length,3);assert.deepEqual(receipt.sources.map(source=>source.url).sort(),[...controlledCase.expectedSources].sort());}
    phase = "validate-fetch";
    const page = bundled ? null : validateNativeFetchReceipt(
      fetchItem.params.item.webSources,
      threadId,
    );
    assert.equal(fixture.requests, requestLimit);
    assert.equal(approvals.length, toolCalls);
    assert.deepEqual(approvedTools, new Set(bundled ? [searchCallId] : [searchCallId, NATIVE_FIRST_FETCH_CALL]));
    // Doctor observes the installed bytes, never a source-tree substitute.
    phase = "doctor";
    const doctor = spawn(binary, ["doctor"], {
      cwd: workspace,
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    doctor.stdout.on("data", (data) => {
      output += data;
      assert.ok(output.length <= 256 * 1024);
    });
    doctor.stderr.resume();
    const code = await new Promise((accept, reject) => {
      const timer = setTimeout(() => {
        doctor.kill();
        reject(Error("Installed doctor timed out"));
      }, 30000);
      doctor.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      doctor.once("close", (code) => {
        clearTimeout(timer);
        accept(code);
      });
    });
    assert.equal(code, 0);
    const buildIdentity = {
      build_commit: /^build commit: (.+)$/m.exec(output)?.[1]?.trim(),
      build_dirty: /^build dirty: (.+)$/m.exec(output)?.[1]?.trim() === "true",
      executable_sha256: /^executable sha256: (.+)$/m.exec(output)?.[1]?.trim(),
    };
    assert.match(output, /^build dirty: false\r?$/m);
    assert.equal(buildIdentity.build_commit, expectedCommit);
    assert.equal(buildIdentity.build_dirty, false);
    assert.equal(buildIdentity.executable_sha256, expectedCliSha256);
    completedResult = {
      passed: true,
      scope: controlledCase ? "actual-native-managed-source-under-owned-controlled-pac" : bundled ? "actual-native-bundled-source-under-system-automatic-proxy" : "actual-native-default-web-search-and-https-read",
      buildIdentity,
      approvals,
      permissionMode: permissions.effectivePermissionMode,
      controlledProviderRequests: fixture.requests,
      controlledHttpRequests: fixture.observations,
      externalModelCalls: 0,
      searchConfigurationWritten: bundled,
      mcpConfigurationWritten: false,
      query,
      ...(controlledCase ? {controlledPacFixtureId:controlledCase.fixtureId,realDefaultPublicAcceptance:false} : {}),
      receipt,
      ...(page ? {page} : {}),
    };
    return completedResult;
  } catch (error) {
    failedError=error;
    error.nativeWebPhase = phase;
    error.controlledProviderRequests = fixture.requests;
    error.controlledHttpRequests = fixture.observations;
    error.approvalCount = approvals.length;
    error.nativeCalls = nativeToolCallObservations(rpc.notificationHistory);
    throw error;
  } finally {
    if (approvalTimer) clearInterval(approvalTimer);
    let forcedKill = false;
    child.stdin.end();
    await new Promise((accept) => {
      if (child.exitCode !== null) return accept();
      const timer = setTimeout(() => { forcedKill = true; child.kill(); }, 5000);
      child.once("close", () => {
        clearTimeout(timer);
        accept();
      });
    });
    if (completedResult) completedResult.nativeEof = {forcedKill,exitCode:child.exitCode};
    if (failedError) failedError.nativeEof = {forcedKill,exitCode:child.exitCode};
    rpc.closeReader();
    server.closeAllConnections();
    await new Promise((accept) => server.close(accept));
    if (bundled && completedResult && (forcedKill || child.exitCode !== 0)) {
      const failure = Error("Bundled app-server did not settle through successful owner EOF");
      failure.nativeWebPhase = "native-eof";
      failure.controlledProviderRequests = fixture.requests;
      failure.controlledHttpRequests = fixture.observations;
      failure.approvalCount = approvals.length;
      failure.nativeCalls = nativeToolCallObservations(rpc.notificationHistory);
      throw failure;
    }
    // Diagnostics stay in the private owned directory and never echo proxy data.
    await writeFile(
      join(directory, "native-web-stderr-observation.json"),
      JSON.stringify({
        phase,
        controlledProviderRequests: fixture.requests,
      controlledHttpRequests: fixture.observations,
        bytes: Buffer.byteLength(stderr),
        rawPersisted: false,
      }),
    );
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  assert.equal(process.platform, "win32");
  const environment = Object.fromEntries(
    [
      "SystemRoot",
      "WINDIR",
      "PATH",
      "USERPROFILE",
      "APPDATA",
      "LOCALAPPDATA",
      "TEMP",
      "TMP",
      "SSL_CERT_FILE",
    ]
      .filter((key) => process.env[key])
      .map((key) => [key, process.env[key]]),
  );
  try {
    const input = parseNativeWorkerInput(await readFile(process.argv[2], "utf8"));
    const result = await runInstalledNativeWebSearch({
      binary: join(input.installDirectory, "resources/bin/kcoder.exe"),
      directory: join(input.runRoot, input.action === "nativeBundledSearch" ? "native-bundled-parent-route" : "native-default-web"),
      scope: input.action === "nativeBundledSearch" ? "bundled-parent-route" : "default",
      environment,
      expectedCommit: input.expectedCommit,
      expectedCliSha256: input.expectedCliSha256,
      nativeConsent: input.nativeConsent,
      externalConsent: input.externalConsent,
    });
    console.log(JSON.stringify(result));
  } catch (error) {
    const message = String(error.message)
      .slice(0, 2048)
      .replace(/https?:\/\/[^\s)]+/gi, "[URL]")
      .replace(/(?:sk-[A-Za-z0-9_-]+|password\s*[:=]\s*\S+)/gi, "[REDACTED]");
    console.log(
      JSON.stringify({
        passed: false,
        phase: error.nativeWebPhase || "worker-bootstrap",
        errorType: error.name,
        errorCode: error.code || null,
        errorMessage: message,
        controlledProviderRequests: error.controlledProviderRequests ?? null,
        controlledHttpRequests: error.controlledHttpRequests ?? [],
        approvalCount: error.approvalCount ?? null,
        nativeCalls: error.nativeCalls ?? [],
        nativeEof: error.nativeEof ?? null,
        publicDispatchKnown: false,
        rawStderrPersisted: false,
      }),
    );
    process.exitCode = 1;
  }
}
