import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { startGateway, waitForGatewayRpcToken } from "../harness/gateway.mjs";
import { hashExecutableFile } from "../harness/owned-executable-provenance.mjs";
import { closeRpcAndWait, gatewayRpcUrl, openRpc } from "../harness/rpc.mjs";
import { repoRoot, requireExecutable, runE2E } from "../harness/run-context.mjs";

const protocolIdentityMode = process.argv.includes("--protocol-identity");
const rustBinary = resolve(repoRoot, process.env.KCODER_E2E_KCODER_BIN || "target/debug/kcoder");
const IDENTITY_TIMEOUT_MS = 60_000;

await runE2E(import.meta.url, {
  testId: "mobile-session-cache-gateway-auth-preflight",
  tier: "full-integration",
  modelPolicy: protocolIdentityMode
    ? "owned loopback Gateway and pinned Rust app-server using the Browser's full-turn scenario; no Browser, public endpoint, or external Provider"
    : "model-independent owned loopback Gateway login contract with a literal HTML root; no Expo export, Browser, Provider, or model call",
}, async context => {
  const identityDeadlineAt = protocolIdentityMode ? Date.now() + IDENTITY_TIMEOUT_MS : null;
  const identityAbort = protocolIdentityMode ? AbortSignal.timeout(IDENTITY_TIMEOUT_MS) : null;
  const binaryBefore = protocolIdentityMode ? await pinnedBinaryInput() : null;
  if (binaryBefore) {
    assert.equal(rustBinary, binaryBefore.path, "Gateway must execute the explicitly pinned old Rust binary");
  }

  const webRoot = context.pathInState("literal-web-root");
  const workspace = context.pathInState("workspace");
  await mkdir(webRoot, { recursive: true });
  await mkdir(workspace, { recursive: true });
  await writeFile(resolve(webRoot, "index.html"),
    "<!doctype html><html><head><meta charset=\"utf-8\"><title>Gateway auth preflight</title></head><body>Owned loopback auth preflight</body></html>\n",
    { mode: 0o600 });

  const gateway = await startGateway(context, {
    auth: true,
    label: "mobile-session-cache-auth-preflight-gateway",
    workspace,
    kcoderBin: binaryBefore?.path ?? rustBinary,
    startTimeoutMs: protocolIdentityMode
      ? Math.max(1, Math.min(15_000, identityDeadlineAt - Date.now()))
      : undefined,
    env: {
      ...(protocolIdentityMode ? { KCODER_STUDIO_SCENARIO: "full-turn" } : {}),
      KCODER_STUDIO_WEB_ROOT: webRoot,
    },
  });
  const base = new URL(gateway.baseUrl);
  const authFetch = (url, options) => protocolIdentityMode
    ? fetch(url, { ...options, signal: identityAbort })
    : fetch(url, options);

  const anonymous = await authFetch(base, {
    headers: { accept: "text/html" },
    redirect: "manual",
  });
  assert.equal(anonymous.status, 303, "anonymous HTML navigation must redirect to login");
  const anonymousLocation = new URL(anonymous.headers.get("location") || "", base);
  assert.equal(anonymousLocation.pathname, "/login", "anonymous navigation must target the login form");

  const loginPage = await authFetch(new URL("/login", base), {
    headers: { accept: "text/html" },
    redirect: "manual",
  });
  assert.equal(loginPage.status, 200, "the login form must be available without a session");
  const loginHtml = await loginPage.text();
  assert.match(loginHtml, /<form\b[^>]*method="post"[^>]*action="\/login"/i,
    "the login page must expose the real POST form");
  assert.match(loginHtml, /<input\b[^>]*name="token"/i,
    "the login form must accept the gateway access token");

  const loginPost = await authFetch(new URL("/login", base), {
    method: "POST",
    headers: {
      accept: "text/html",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ token: gateway.authToken }),
    redirect: "manual",
  });
  assert.equal(loginPost.status, 303, "a valid login form submission must issue a session redirect");
  assert.equal(new URL(loginPost.headers.get("location") || "", base).pathname, "/",
    "successful login must return to the owned web root");
  const setCookie = loginPost.headers.get("set-cookie");
  assert.ok(setCookie, "successful login must issue a session cookie");
  context.registerSecret(setCookie);
  const cookiePair = setCookie.split(";", 1)[0];
  context.registerSecret(cookiePair);
  const cookieSeparator = cookiePair.indexOf("=");
  assert.ok(cookieSeparator > 0, "session cookie must have a name and value");
  context.registerSecret(cookiePair.slice(cookieSeparator + 1));
  assert.equal(cookiePair.slice(0, cookieSeparator), "kcoder_studio_session",
    "login must issue the expected browser session cookie");
  assert.match(setCookie, /HttpOnly/i, "browser session cookie must be HttpOnly");
  assert.match(setCookie, /SameSite=Strict/i, "browser session cookie must be SameSite Strict");

  const authenticatedRoot = await authFetch(base, {
    headers: { accept: "text/html", cookie: cookiePair },
    redirect: "manual",
  });
  assert.equal(authenticatedRoot.status, 200, "the issued cookie must authorize the owned web root");
  const authenticatedHtml = await authenticatedRoot.text();
  const rpcToken = authenticatedHtml.match(/name="kcoder-rpc-token" content="([^"]+)"/)?.[1];
  assert.ok(rpcToken, "the authenticated root page must inject the RPC token meta tag");
  context.registerSecret(rpcToken);

  const evidence = {
    anonymousGet: { status: anonymous.status, redirectPath: anonymousLocation.pathname },
    loginForm: { status: loginPage.status, postAction: "/login", requiredInputPresent: true },
    loginPost: {
      status: loginPost.status,
      redirectPath: "/",
      sessionEstablished: true,
      httpOnly: true,
      sameSiteStrict: true,
      registeredBeforeAuthenticatedRequest: true,
    },
    authenticatedRoot: { status: authenticatedRoot.status, bootstrapMetaPresent: true, rawValuePersisted: false },
    boundary: protocolIdentityMode
      ? "owned loopback Gateway plus pinned Rust app-server with KCODER_STUDIO_SCENARIO=full-turn; no Browser, public endpoint, or external Provider"
      : "owned loopback Gateway plus literal RunContext index.html; no Expo export, Browser, Provider, or model call",
    providerCalls: protocolIdentityMode ? null : 0,
  };

  if (protocolIdentityMode) {
    const identity = await captureProtocolIdentity(context, gateway, cookiePair, rpcToken, identityDeadlineAt);
    let binaryAfter;
    let binaryPostflightError = null;
    try {
      binaryAfter = await pinnedBinaryInput();
      assert.deepEqual(binaryAfter, binaryBefore, "pinned Gateway binary inputs changed during preflight");
    } catch (error) {
      binaryPostflightError = error instanceof Error ? error : new Error(String(error));
    }
    evidence.protocolIdentity = identity;
    evidence.binaryInput = binaryBefore;
    evidence.binaryPostflight = binaryAfter ?? null;
    evidence.binaryPostflightVerified = binaryPostflightError === null;
    evidence.binaryPostflightFailureName = binaryPostflightError?.name ?? null;
    await context.writeArtifactJson("gateway-protocol-identity.json", evidence);

    if (binaryPostflightError) throw binaryPostflightError;
    assert.equal(identity?.status, "complete", "owned app-server identity preflight must complete");
  } else {
    await context.writeArtifactJson("gateway-auth-preflight.json", evidence);
  }
  return evidence;
});

async function pinnedBinaryInput() {
  const binaryPath = requiredAbsolutePath("KCODER_E2E_KCODER_BIN");
  const binaryStat = await lstat(binaryPath);
  assert.ok(binaryStat.isFile() && (binaryStat.mode & 0o111) !== 0,
    "pinned KCoder binary must be an executable regular file, not a symlink");
  await requireExecutable(binaryPath, "pinned old KCoder app-server");
  const actualBinarySha256 = (await hashExecutableFile(binaryPath)).sha256;
  assert.equal(actualBinarySha256, requiredSha256("KCODER_E2E_KCODER_BIN_SHA256"), "pinned KCoder binary SHA-256 mismatch");

  const sourceReceiptPath = requiredAbsolutePath("KCODER_E2E_KCODER_SOURCE_RECEIPT");
  const receiptStat = await lstat(sourceReceiptPath);
  assert.ok(receiptStat.isFile() && receiptStat.size <= 1_048_576,
    "KCoder source receipt must be a regular JSON file no larger than 1 MiB");
  const receiptBytes = await readFile(sourceReceiptPath);
  const actualReceiptSha256 = createHash("sha256").update(receiptBytes).digest("hex");
  assert.equal(actualReceiptSha256, requiredSha256("KCODER_E2E_KCODER_SOURCE_RECEIPT_SHA256"), "KCoder source receipt SHA-256 mismatch");
  const receipt = JSON.parse(receiptBytes.toString("utf8"));
  let sourceProof;
  if (typeof receipt.binary === "string" && receipt.schema === undefined) {
    assert.ok(isAbsolute(receipt.binary), "old build-reuse receipt must contain an absolute binary path");
    assert.equal(resolve(receipt.binary), binaryPath, "old source receipt must bind the runtime binary path");
    assert.equal(receipt.binarySha256, actualBinarySha256, "old source receipt must bind runtime binary bytes");
    assert.equal(receipt.builtFromCommit, "bb6dce2cf4bd2413c2f46b698bb29ea460aff305",
      "old source receipt must identify the Browser binary's source commit");
    sourceProof = { format: "build-reuse", builtFromCommit: receipt.builtFromCommit };
  } else if (receipt.schema === "kcoder-validated-binary-input-receipt-v1"
      && receipt.binary && typeof receipt.binary === "object" && !Array.isArray(receipt.binary)) {
    const artifactPath = receipt.binary.artifactPath;
    assert.ok(typeof artifactPath === "string" && artifactPath.length > 0 && !isAbsolute(artifactPath),
      "validated binary receipt must use a relative artifactPath");
    const receiptRoot = dirname(sourceReceiptPath);
    const artifactFullPath = resolve(receiptRoot, artifactPath);
    const artifactRelativePath = relative(receiptRoot, artifactFullPath);
    assert.ok(artifactRelativePath && artifactRelativePath !== ".."
      && !artifactRelativePath.startsWith(`..${sep}`) && !isAbsolute(artifactRelativePath),
    "binary artifactPath must stay inside its receipt directory");
    assert.equal(artifactFullPath, binaryPath, "validated receipt must bind the exact runtime binary path");
    assert.equal(receipt.binary.shaMatch, true, "validated receipt must report matching build and copied bytes");
    assert.equal(receipt.binary.buildSha256, actualBinarySha256, "build binary hash must match runtime bytes");
    assert.equal(receipt.binary.copiedSha256BeforeMode, actualBinarySha256, "pre-mode copied binary hash must match runtime bytes");
    assert.equal(receipt.binary.copiedSha256AfterMode, actualBinarySha256, "post-mode copied binary hash must match runtime bytes");
    assert.equal(receipt.binary.sizeBytes, binaryStat.size, "validated receipt binary size must match runtime file");

    const frozen = receipt.frozenRustManifest;
    assert.ok(frozen && isAbsolute(frozen.path) && /^[a-f0-9]{64}$/.test(frozen.sha256),
      "validated receipt must bind an absolute frozen Rust manifest path and SHA-256");
    let expectedSourceCount;
    let callerPinnedSourceCount = null;
    if (frozen.kind === "gateway-snapshot-rust-frozen-13") {
      expectedSourceCount = 13;
    } else if (frozen.kind === "history-attempt-provenance-rust-input") {
      callerPinnedSourceCount = requiredSourceCount("KCODER_E2E_KCODER_EXPECTED_SOURCE_COUNT");
      expectedSourceCount = callerPinnedSourceCount;
    } else {
      assert.fail("unsupported frozen Rust source manifest kind");
    }
    assert.equal(frozen.sourceCount, expectedSourceCount,
      "frozen Rust source count must match the caller-pinned count");
    const manifestStat = await lstat(frozen.path);
    assert.ok(manifestStat.isFile() && manifestStat.size <= 1_048_576,
      "frozen Rust manifest must be a regular file no larger than 1 MiB");
    const manifestBytes = await readFile(frozen.path);
    assert.equal(createHash("sha256").update(manifestBytes).digest("hex"), frozen.sha256,
      "frozen Rust manifest file SHA-256 mismatch");
    const manifest = JSON.parse(manifestBytes.toString("utf8"));
    assert.equal(manifest.kind, frozen.kind, "frozen Rust manifest kind does not match receipt");
    if (callerPinnedSourceCount !== null) {
      assert.ok(Array.isArray(manifest.files), "frozen Rust manifest must contain a files array");
    }
    assert.equal(manifest.files?.length, expectedSourceCount,
      "frozen Rust manifest actual file count must match the caller-pinned count");
    sourceProof = { format: receipt.schema, head: receipt.head,
      frozenRustManifest: callerPinnedSourceCount === null
        ? frozen
        : { ...frozen, callerPinnedSourceCount } };
  } else {
    assert.fail("unsupported KCoder binary source receipt format");
  }
  return { path: binaryPath, sha256: actualBinarySha256, receiptPath: sourceReceiptPath,
    receiptSha256: actualReceiptSha256, sourceProof };
}

function requiredAbsolutePath(name) {
  const value = process.env[name];
  if (typeof value !== "string" || !isAbsolute(value)) {
    throw new Error(`${name} must name an explicit absolute input path; no default binary is used`);
  }
  return resolve(value);
}

function requiredSha256(name) {
  const value = process.env[name];
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${name} must be an explicit lowercase SHA-256 pin`);
  }
  return value;
}

function requiredSourceCount(name) {
  const value = process.env[name];
  assert.ok(typeof value === "string" && /^[1-9][0-9]{0,2}$/.test(value),
    `${name} must be an explicit positive decimal source count`);
  const count = Number(value);
  assert.ok(Number.isSafeInteger(count) && count >= 1 && count <= 256,
    `${name} must be between 1 and 256`);
  return count;
}

async function captureProtocolIdentity(context, gateway, cookie, bootstrapToken, deadlineAt) {
  const timeout = maxMs => {
    const remainingMs = deadlineAt - Date.now();
    assert.ok(remainingMs > 0, `protocol identity preflight exceeded ${IDENTITY_TIMEOUT_MS} ms`);
    return Math.min(maxMs, remainingMs);
  };
  const evidence = {
    status: "running",
    scenario: "full-turn",
    threadId: null,
    turnId: null,
    clientMessageId: `gateway-identity-${randomUUID()}`,
    historyReadMethod: null,
    historyRows: [],
    timingsMs: { websocketOpen: null, initialize: null },
    failureStage: null,
    failureName: null,
  };
  let rpc = null;
  let stage = "rpc-token";

  try {
    const verifiedToken = await waitForGatewayRpcToken(context, gateway, {
      headers: { cookie },
      expectedToken: bootstrapToken,
      timeoutMs: timeout(15_000),
    });
    assert.equal(verifiedToken, bootstrapToken, "Gateway RPC token must match the authenticated page bootstrap token");

    stage = "open-rpc";
    const openStarted = performance.now();
    try {
      rpc = await openRpc(gatewayRpcUrl(gateway, "local", verifiedToken), {
        headers: { Cookie: cookie, Origin: gateway.baseUrl },
        timeoutMs: timeout(10_000),
      });
    } finally {
      evidence.timingsMs.websocketOpen = performance.now() - openStarted;
    }
    context.addCleanup("close protocol-identity RPC", () => closeRpcAndWait(rpc, "protocol-identity RPC"));

    stage = "initialize";
    const initializeStarted = performance.now();
    let initialized;
    try {
      initialized = await rpc.request("initialize", {
        protocolVersion: "2026-07-27",
        clientInfo: { name: "mobile-session-cache-identity-preflight", version: "1" },
      }, timeout(10_000));
    } finally {
      evidence.timingsMs.initialize = performance.now() - initializeStarted;
    }
    evidence.capabilities = {
      indexedPagesAdvertised: initialized?.capabilities?.experimental?.threadIndexedPagesV1 === true,
      resumeHistoryPageAdvertised: initialized?.capabilities?.experimental?.threadResumeHistoryPageV1 === true,
    };
    stage = "thread-start";
    const startedThread = await rpc.request("thread/start", {}, timeout(10_000));
    evidence.threadId = startedThread?.thread?.id ?? null;
    assert.ok(typeof evidence.threadId === "string" && evidence.threadId, "thread/start must return an owned thread");

    stage = "turn-start";
    const startedTurn = await rpc.request("turn/start", {
      threadId: evidence.threadId,
      clientMessageId: evidence.clientMessageId,
      input: [{ type: "text", text: `SESSION_CACHE_PROMPT_${randomUUID()}` }],
    }, timeout(15_000));
    evidence.turnStartResult = projectTurnStartResult(startedTurn);
    evidence.turnId = evidence.turnStartResult.turnId;
    assert.ok(typeof evidence.turnId === "string" && evidence.turnId, "turn/start must return an owned turn");

    stage = "turn-completed";
    const completion = await rpc.waitFor(message =>
      message.method === "turn/completed"
        && message.params?.threadId === evidence.threadId
        && message.params?.turnId === evidence.turnId,
      timeout(30_000), "owned full-turn completion");
    assert.equal(completion.params?.turn?.status, "completed", "owned full-turn must complete");

    stage = "thread-resume";
    const resumed = await rpc.request("thread/resume", {
      threadId: evidence.threadId,
      ...(evidence.capabilities.resumeHistoryPageAdvertised ? {
        history: { limit: 50, indexed: evidence.capabilities.indexedPagesAdvertised },
      } : {}),
    }, timeout(15_000));
    assert.equal(resumed?.thread?.id, evidence.threadId, "thread/resume must return the owned thread");

    evidence.historyReadMethod = "thread/resume";
    let historyMessages = null;
    if (evidence.capabilities.resumeHistoryPageAdvertised && resumed?.history?.status === "ready") {
      historyMessages = resumed.history.page?.messages;
      assert.ok(Array.isArray(historyMessages), "ready inline history must contain a messages page");
    } else if (evidence.capabilities.resumeHistoryPageAdvertised) {
      assert.ok(resumed?.history?.status === "unavailable"
        && ["readFailed", "responseBudgetExceeded"].includes(resumed.history.code),
      "advertised inline history must be ready or explicitly unavailable");
    }
    if (!historyMessages) {
      const method = evidence.capabilities.indexedPagesAdvertised ? "thread/read/indexed" : "thread/read";
      stage = method;
      const read = await rpc.request(method, { threadId: evidence.threadId, limit: 50 }, timeout(15_000));
      if (read?.thread?.id) assert.equal(read.thread.id, evidence.threadId, "history read must retain thread ownership");
      evidence.historyReadMethod = method;
      historyMessages = read?.messages;
    }
    assert.ok(Array.isArray(historyMessages), "history page must return messages");
    assert.ok(historyMessages.length <= 50, "history identity capture is bounded to the requested 50-row page");
    evidence.historyRows = historyMessages.map(message => ({
      id: typeof message.id === "string" ? message.id : null,
      role: typeof message.role === "string" ? message.role : null,
      turnId: typeof message.turnId === "string" ? message.turnId : null,
      attemptId: typeof message.attemptId === "string" ? message.attemptId : null,
      clientMessageId: typeof message.clientMessageId === "string" ? message.clientMessageId : null,
    }));
    evidence.matchingTurnRows = evidence.historyRows.filter(row => row.turnId === evidence.turnId).length;
    evidence.matchingClientMessageIdRows = evidence.historyRows.filter(row => row.clientMessageId === evidence.clientMessageId).length;
    const lifecycleNotifications = rpc.messages()
      .map(message => projectTurnLifecycleNotification(message, evidence.threadId, evidence.turnId))
      .filter(Boolean);
    const startedNotifications = lifecycleNotifications.filter(event => event.method === "turn/started");
    const completedNotifications = lifecycleNotifications.filter(event => event.method === "turn/completed");
    const startAttemptId = evidence.turnStartResult.attemptId;
    evidence.lifecycleNotifications = {
      totalOwned: lifecycleNotifications.length,
      truncated: lifecycleNotifications.length > 8,
      events: lifecycleNotifications.slice(0, 8),
    };
    evidence.attemptCorrelations = {
      turnStartAttemptIdPresent: startAttemptId !== null,
      startedNotificationCount: startedNotifications.length,
      startedAttemptIdFieldPresentCount: startedNotifications.filter(event => event.attemptIdFieldPresent).length,
      startedAttemptIdMatchesTurnStartCount: startedNotifications.filter(event =>
        startAttemptId !== null && event.attemptId === startAttemptId).length,
      completedNotificationCount: completedNotifications.length,
      completedAttemptIdFieldPresentCount: completedNotifications.filter(event => event.attemptIdFieldPresent).length,
      completedAttemptIdMatchesTurnStartCount: completedNotifications.filter(event =>
        startAttemptId !== null && event.attemptId === startAttemptId).length,
      historyRowsWithAttemptIdCount: evidence.historyRows.filter(row => row.attemptId !== null).length,
      historyRowsMatchingTurnAndAttemptCount: evidence.historyRows.filter(row =>
        row.turnId === evidence.turnId && startAttemptId !== null && row.attemptId === startAttemptId).length,
    };
    evidence.completionCount = rpc.messages().filter(message => message.method === "turn/completed"
      && message.params?.threadId === evidence.threadId && message.params?.turnId === evidence.turnId).length;
    assert.equal(evidence.completionCount, 1, "owned turn must emit exactly one completion");
    assert.ok(evidence.historyRows.some(row => row.role === "user") && evidence.historyRows.some(row => row.role === "assistant"),
      "history page must contain user and assistant identities");
    evidence.status = "complete";
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    evidence.status = "failed";
    evidence.failureStage = stage;
    evidence.failureName = failure.name;
  } finally {
    if (rpc) {
      try {
        await closeRpcAndWait(rpc, "protocol-identity RPC");
      } catch (error) {
        evidence.cleanup = error instanceof Error ? error.name : "Error";
        evidence.status = "failed";
        evidence.failureStage ??= "rpc-cleanup";
        evidence.failureName ??= evidence.cleanup;
      }
    }
    evidence.cleanup ??= "completed";
  }
  return evidence;
}

function projectTurnStartResult(result) {
  const turn = result?.turn;
  return {
    threadId: typeof turn?.threadId === "string" ? turn.threadId : null,
    turnId: typeof turn?.id === "string" ? turn.id : null,
    attemptId: typeof turn?.attemptId === "string" ? turn.attemptId : null,
    attemptIdFieldPresent: Boolean(turn && Object.hasOwn(turn, "attemptId")),
    status: typeof turn?.status === "string" ? turn.status : null,
  };
}

function projectTurnLifecycleNotification(message, expectedThreadId, expectedTurnId) {
  if (message?.method !== "turn/started" && message?.method !== "turn/completed") return null;
  const params = message.params;
  const turn = params?.turn;
  const threadIds = [params?.threadId, turn?.threadId].filter(value => typeof value === "string");
  const turnIds = [params?.turnId, turn?.id].filter(value => typeof value === "string");
  if (!threadIds.length || !turnIds.length
      || threadIds.some(value => value !== expectedThreadId)
      || turnIds.some(value => value !== expectedTurnId)) return null;
  const attemptIdFieldPresent = Boolean(params && Object.hasOwn(params, "attemptId"))
    || Boolean(turn && Object.hasOwn(turn, "attemptId"));
  const attemptId = typeof params?.attemptId === "string"
    ? params.attemptId
    : typeof turn?.attemptId === "string" ? turn.attemptId : null;
  return {
    method: message.method,
    threadId: expectedThreadId,
    turnId: expectedTurnId,
    attemptId,
    attemptIdFieldPresent,
    status: typeof turn?.status === "string" ? turn.status
      : typeof params?.status === "string" ? params.status : null,
    sequence: Number.isSafeInteger(params?.sequence) ? params.sequence : null,
  };
}
