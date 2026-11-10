import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { startApprovalModelFixture } from "../../harness/approval-model.mjs";
import { startGateway, waitForGatewayRpcToken } from "../../harness/gateway.mjs";
import { login } from "../../harness/http.mjs";
import { closeRpcAndWait, gatewayRpcUrl, openRpc } from "../../harness/rpc.mjs";
import { requireExecutable, runE2E } from "../../harness/run-context.mjs";
import { materializeWorkspace } from "../../harness/workspace-fixture.mjs";

const SNAPSHOT_CAPABILITY = "threadTranscriptSnapshotV1";
const SNAPSHOT_MARKER = "SNAPSHOT_GATEWAY_LOCAL_FIXTURE";
const MAX_REFRESH_STEPS = 64;
const REFRESH_BUDGET_MS = 45_000;

await runE2E(import.meta.url, {
  testId: "gateway-rust-transcript-snapshot-per-client-opt-in",
  tier: "full-integration",
  modelPolicy: "model-independent actual Gateway-to-Rust protocol projection using an owned deterministic loopback model fixture; no external Provider",
}, async context => {
  const evidence = {
    classification: "local Gateway-to-Rust protocol acceptance; deterministic loopback fixture; no Browser, public endpoint, or external Provider",
    input: null,
    passes: [],
    providerRequestCount: null,
    failure: null,
  };
  let failure = null;
  let fixture = null;
  let stage = "binary-source-preflight";
  try {
    const binary = await pinnedBinaryInput();
    evidence.input = binary.evidence;
    await context.writeArtifactJson("binary-source-pin.json", binary.evidence);

    stage = "start-local-model-fixture";
    fixture = await startApprovalModelFixture(context, {
      textOnly: true,
      textOnlyResponse: SNAPSHOT_MARKER,
    });

    for (const order of ["legacy-first", "snapshot-first"]) {
      stage = `pass:${order}`;
      const passEvidence = { order, sameBackendProcess: false, historyRefresh: null, clients: [] };
      evidence.passes.push(passEvidence);
      await runOrderingPass(context, fixture, binary.path, order, passEvidence);
    }

    stage = "provider-fixture-request-count";
    assert.equal(fixture.requests.length, 4, "two local completed turns per fresh Gateway pass");
    evidence.providerRequestCount = fixture.requests.length;
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
    evidence.failure = { stage, name: failure.name };
    evidence.providerRequestCount = fixture?.requests?.length ?? null;
  }

  try {
    await context.writeArtifactJson("transcript-snapshot-projection.json", evidence);
  } catch (artifactError) {
    const cleanupFailure = artifactError instanceof Error ? artifactError : new Error(String(artifactError));
    failure = failure
      ? new AggregateError([failure, cleanupFailure], "Protocol assertion and evidence write both failed", { cause: failure })
      : cleanupFailure;
  }
  if (failure) throw failure;
  return evidence;
});

async function pinnedBinaryInput() {
  const binaryPath = requiredAbsolutePath("KCODER_E2E_KCODER_BIN");
  const binarySha256 = requiredSha256("KCODER_E2E_KCODER_BIN_SHA256");
  const sourceReceiptPath = requiredAbsolutePath("KCODER_E2E_KCODER_SOURCE_RECEIPT");
  const sourceReceiptSha256 = requiredSha256("KCODER_E2E_KCODER_SOURCE_RECEIPT_SHA256");

  const binaryStat = await lstat(binaryPath);
  assert.ok(binaryStat.isFile(), "pinned KCoder binary must be a regular file, not a symlink");
  await requireExecutable(binaryPath, "pinned KCoder app-server");
  const actualBinarySha256 = await sha256File(binaryPath);
  assert.equal(actualBinarySha256, binarySha256, "pinned KCoder binary SHA-256 mismatch");

  const receiptStat = await lstat(sourceReceiptPath);
  assert.ok(receiptStat.isFile() && receiptStat.size <= 1_048_576,
    "KCoder source receipt must be a regular JSON file no larger than 1 MiB");
  const receiptBytes = await readFile(sourceReceiptPath);
  JSON.parse(receiptBytes.toString("utf8"));
  const actualReceiptSha256 = createHash("sha256").update(receiptBytes).digest("hex");
  assert.equal(actualReceiptSha256, sourceReceiptSha256, "pinned KCoder source receipt SHA-256 mismatch");

  return {
    path: binaryPath,
    evidence: {
      binaryPath,
      binarySha256: actualBinarySha256,
      sourceReceiptPath,
      sourceReceiptSha256: actualReceiptSha256,
    },
  };
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

function sha256File(path) {
  return new Promise((resolveHash, rejectHash) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", chunk => hash.update(chunk));
    stream.once("error", rejectHash);
    stream.once("end", () => resolveHash(hash.digest("hex")));
  });
}

async function runOrderingPass(context, fixture, binary, order, passEvidence) {
  const workspaceId = `transcript-snapshot-${order}`;
  const { path: workspace } = await materializeWorkspace(context, "minimal", { instanceId: workspaceId });
  const settingsPath = await context.writeStateJson(`profiles/${order}/settings.json`, {
    active_provider: "fixture",
    providers: {
      fixture: {
        api_format: "openai_chat_completions",
        authentication: { mode: "none" },
        endpoint: fixture.baseUrl,
        default_model: "fixture",
        context_window_tokens: 128_000,
        output_headroom_tokens: 8192,
        max_output_tokens: 8192,
        no_proxy: true,
      },
    },
  });
  const serversFile = await context.writeStateJson(`servers-${order}.json`, [{
    id: "local",
    label: "Owned transcript snapshot fixture",
    transport: "local",
    command: binary,
    workspace,
    settingsFile: settingsPath,
  }]);
  const webRoot = context.pathInState(`web-${order}`);
  await mkdir(webRoot, { recursive: true, mode: 0o700 });
  await writeFile(resolve(webRoot, "index.html"),
    "<!doctype html><html><head><title>Owned snapshot fixture</title></head><body>Gateway RPC fixture</body></html>\n",
    { flag: "wx", mode: 0o600 });
  const gatewayLabel = `snapshot-${order}`;
  const gateway = await startGateway(context, {
    label: gatewayLabel,
    auth: true,
    workspace,
    serversFile,
    kcoderBin: binary,
    env: {
      KCODER_CONFIG_DIR: dirname(settingsPath),
      KCODER_STUDIO_WEB_ROOT: webRoot,
    },
  });
  const cookie = await login(gateway.baseUrl, gateway.authToken);
  context.registerSecret(cookie);
  context.registerSecret(cookie.split("=", 2)[1]);
  const token = await waitForGatewayRpcToken(context, gateway, {
    headers: { cookie },
    expectedToken: "cookie-auth",
  });
  const rpcUrl = gatewayRpcUrl(gateway, "local", token);
  const orderPlan = order === "legacy-first"
    ? [{ label: "legacy", optedIn: false }, { label: "snapshot", optedIn: true }]
    : [{ label: "snapshot", optedIn: true }, { label: "legacy", optedIn: false }];
  const clients = [];
  let failure = null;

  try {
    for (const plan of orderPlan) {
      const client = await openClient(context, rpcUrl, order, plan, cookie, gateway.baseUrl);
      clients.push(client);
      passEvidence.clients.push(client.evidence);
    }

    const processIds = clients.map(client => client.processId);
    assert.ok(processIds.every(value => Number.isSafeInteger(value) && value > 0),
      `${order} clients must observe an actual Gateway app-server process identity`);
    assert.equal(processIds[0], processIds[1], `${order} clients must share the initialized app-server process`);
    passEvidence.sameBackendProcess = true;
    passEvidence.backendProcessId = processIds[0];

    for (const client of clients) await createCompletedTurn(client, order);
    passEvidence.historyRefresh = { method: "thread/history/refresh", steps: [] };
    await refreshHistoryIndex(clients[0].rpc, passEvidence.historyRefresh);

    for (const client of clients) {
      await inspectSnapshotMethods(client);
    }
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
    passEvidence.failure = { name: failure.name };
  }

  const cleanupErrors = [];
  for (const client of [...clients].reverse()) {
    try {
      await closeRpcAndWait(client.rpc, `${order} ${client.label} RPC`);
    } catch (error) {
      cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
    }
  }
  try {
    await context.stopOwned(gatewayLabel);
  } catch (error) {
    cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
  }

  if (failure && cleanupErrors.length > 0) {
    throw new AggregateError([failure, ...cleanupErrors], `${order} protocol flow and owned cleanup failed`, { cause: failure });
  }
  if (failure) throw failure;
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, `${order} owned cleanup failed`);
  }
  passEvidence.cleanup = "completed";
}

async function openClient(context, rpcUrl, order, plan, cookie, origin) {
  const rpc = await openRpc(rpcUrl, { headers: { Cookie: cookie, Origin: origin } });
  const cleanupLabel = `${order}-${plan.label}-rpc`;
  context.addCleanup(`close ${cleanupLabel}`, () => closeRpcAndWait(rpc, cleanupLabel));
  const initialized = await rpc.request("initialize", {
    protocolVersion: "2026-07-27",
    clientInfo: { name: `snapshot-${order}-${plan.label}`, version: "1" },
    capabilities: plan.optedIn ? { experimental: { [SNAPSHOT_CAPABILITY]: true } } : {},
  }, 15_000);
  assert.equal(initialized?.capabilities?.experimental?.[SNAPSHOT_CAPABILITY], true,
    `${order} ${plan.label} client must receive the Gateway's advertised snapshot support`);
  assert.equal(initialized?.capabilities?.experimental?.threadResumeHistoryPageV1, true,
    `${order} ${plan.label} client requires advertised resume history page support`);
  assert.equal(initialized?.capabilities?.experimental?.threadIndexedPagesV1, true,
    `${order} ${plan.label} client requires advertised indexed page support`);
  const resources = await rpc.request("server/resources/read", {}, 10_000);
  assert.ok(Number.isSafeInteger(resources?.processId) && resources.processId > 0,
    `${order} ${plan.label} must read the actual shared backend identity`);
  return {
    rpc,
    label: plan.label,
    optedIn: plan.optedIn,
    processId: resources.processId,
    evidence: { label: plan.label, offeredSnapshotCapability: plan.optedIn, serverAdvertisedSnapshotCapability: true, methods: [] },
  };
}

async function createCompletedTurn(client, order) {
  const startedThread = await client.rpc.request("thread/start", {}, 10_000);
  const threadId = startedThread?.thread?.id;
  assert.ok(typeof threadId === "string" && threadId.length > 0, `${order} ${client.label} thread/start`);
  client.threadId = threadId;

  const startedTurn = await client.rpc.request("turn/start", {
    threadId,
    input: [{ type: "text", text: `Complete one local transcript turn for ${order}/${client.label}` }],
  }, 15_000);
  const turnId = startedTurn?.turn?.id;
  assert.ok(typeof turnId === "string" && turnId.length > 0, `${order} ${client.label} turn/start`);
  const completion = await client.rpc.waitFor(message =>
    message.method === "turn/completed"
      && message.params?.threadId === threadId
      && message.params?.turnId === turnId,
  30_000, `${order} ${client.label} completed fixture turn`);
  assert.equal(completion.params?.turn?.status, "completed", `${order} ${client.label} fixture turn status`);
}

async function refreshHistoryIndex(rpc, evidence) {
  const deadline = Date.now() + REFRESH_BUDGET_MS;
  let response = await rpc.request("thread/history/refresh", { acknowledgeExternalWriters: true }, 5_000);
  let steps = 1;
  recordRefreshStep(evidence, response, steps);
  while (response.status === "building" && steps < MAX_REFRESH_STEPS) {
    const cursor = response.nextCursor;
    assert.ok(typeof cursor === "string" && cursor.length > 0, "building history refresh must return its continuation cursor");
    const remaining = deadline - Date.now();
    assert.ok(remaining > 0, "history refresh exceeded its bounded 45-second budget");
    response = await rpc.request("thread/history/refresh", { cursor }, Math.min(5_000, remaining));
    steps += 1;
    recordRefreshStep(evidence, response, steps);
  }
  assert.equal(response.status, "ready", "actual history refresh must finish ready for indexed transcript reads");
  assert.equal(response.issueCount, 0, "fixture history refresh must not report skipped entries");
  evidence.status = response.status;
  evidence.stepsCompleted = steps;
}

function recordRefreshStep(evidence, response, step) {
  evidence.steps.push({
    step,
    status: response.status ?? "unknown",
    indexedSessions: response.indexedSessions ?? null,
    examinedEntries: response.examinedEntries ?? null,
    issueCount: response.issueCount ?? null,
    hasContinuation: typeof response.nextCursor === "string" && response.nextCursor.length > 0,
  });
}

async function inspectSnapshotMethods(client) {
  const threadId = client.threadId;
  const methodEvidence = client.evidence.methods;
  const resume = await client.rpc.request("thread/resume", {
    threadId,
    history: { limit: 50, indexed: true },
  }, 15_000);
  methodEvidence.push(methodSummary("thread/resume", resume?.history?.page, resume?.history?.status));
  assert.equal(resume?.thread?.id, threadId, `${client.label} thread/resume identity`);
  assert.equal(resume?.history?.status, "ready", `${client.label} inline resume history status`);
  const resumePage = resume.history.page;

  const indexed = await client.rpc.request("thread/read/indexed", { threadId, limit: 50 }, 15_000);
  methodEvidence.push(methodSummary("thread/read/indexed", indexed));
  const legacy = await client.rpc.request("thread/read", { threadId, limit: 50 }, 15_000);
  methodEvidence.push(methodSummary("thread/read", legacy));
  for (const [method, page] of [
    ["thread/resume", resumePage],
    ["thread/read/indexed", indexed],
    ["thread/read", legacy],
  ]) {
    assert.ok(Array.isArray(page?.messages) && page.messages.length >= 2,
      `${client.label} ${method} must return the completed real transcript rows`);
    assert.ok(page.messages.some(message => message.role === "assistant" && message.content.includes(SNAPSHOT_MARKER)),
      `${client.label} ${method} must include the local completed assistant response`);
  }

  const snapshots = {
    resume: resumePage.transcriptSnapshotV1,
    indexed: indexed.transcriptSnapshotV1,
    read: legacy.transcriptSnapshotV1,
  };
  if (client.optedIn) {
    assertAvailableSnapshot(snapshots.resume, `${client.label} thread/resume`);
    assertAvailableSnapshot(snapshots.indexed, `${client.label} thread/read/indexed`);
    assert.deepEqual(snapshots.indexed, snapshots.resume,
      `${client.label} resume and indexed read must project the same proven page identity`);
    assert.deepEqual(snapshots.read, { status: "unavailable", code: "legacyReader" },
      `${client.label} ordinary read must preserve its legacyReader outcome`);
  } else {
    for (const [method, snapshot] of Object.entries(snapshots)) {
      assert.equal(snapshot, undefined, `${client.label} opted-out ${method} response must omit snapshot metadata`);
    }
  }

}

function methodSummary(method, page, status = null) {
  return {
    method,
    historyStatus: status,
    snapshot: snapshotSummary(page?.transcriptSnapshotV1),
    transcriptRows: Array.isArray(page?.messages) ? page.messages.length : null,
    fixtureAssistantPresent: Array.isArray(page?.messages)
      ? page.messages.some(message => message.role === "assistant" && message.content.includes(SNAPSHOT_MARKER))
      : false,
  };
}

function assertAvailableSnapshot(snapshot, label) {
  assert.equal(snapshot?.status, "available", `${label} must return a proven available snapshot`);
  assert.match(snapshot.snapshotId, /^[a-f0-9]{64}$/, `${label} snapshotId shape`);
  assert.match(snapshot.viewKey, /^[a-f0-9]{64}$/, `${label} viewKey shape`);
}

function snapshotSummary(snapshot) {
  if (snapshot === undefined) return { present: false };
  if (snapshot?.status === "available") return {
    present: true,
    status: "available",
    snapshotIdValid: /^[a-f0-9]{64}$/.test(snapshot.snapshotId),
    viewKeyValid: /^[a-f0-9]{64}$/.test(snapshot.viewKey),
  };
  return { present: true, status: snapshot?.status ?? "unknown", code: snapshot?.code ?? null };
}
