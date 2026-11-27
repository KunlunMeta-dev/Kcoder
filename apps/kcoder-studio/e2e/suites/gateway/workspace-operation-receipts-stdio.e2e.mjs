import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, readFile, readdir, realpath, stat, unlink, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { relative, resolve, sep } from "node:path";
import {
  findOwnedExecutableProcesses,
  hashExecutableFile,
} from "../../harness/owned-executable-provenance.mjs";
import { runE2E, waitFor } from "../../harness/run-context.mjs";

const OPERATION_READ = "runtime.workspaces.operation/read";
const WORKSPACE_OPEN = "runtime.workspaces.open";
const WORKSPACE_PREPARE = "runtime.workspaces.prepare";
const RPC_TIMEOUT_MS = 15_000;
const RECEIPT_LIMIT_PER_WORKSPACE = 4096;
const LOW_NOFILE_LIMIT = 1024;

// This model-independent stdio suite talks to the explicitly supplied frozen
// Rust binary. It starts no Gateway, sends no turn/start, and never invokes a
// Provider. The harness can drop a successful mutation ACK before its caller
// sees it, then recover through the durable receipt on the real app-server.
async function runSuite() {
  await runE2E(import.meta.url, {
  testId: "workspace-operation-receipts-real-app-server-stdio",
  tier: "manual-live",
  modelPolicy: "model-independent real Rust app-server JSONL stdio, local workspace mutations only; no Gateway, turn, Provider request, or production session",
}, async context => {
  const configuredBinary = process.env.KCODER_E2E_WORKSPACE_OPERATION_RECEIPTS_BIN?.trim();
  const expectedSha256 = process.env.KCODER_E2E_WORKSPACE_OPERATION_RECEIPTS_SHA256?.trim().toLowerCase();
  assert.ok(configuredBinary, "UNMET_PREREQUISITE: set KCODER_E2E_WORKSPACE_OPERATION_RECEIPTS_BIN to the writer-designated frozen binary");
  assert.match(expectedSha256 || "", /^[0-9a-f]{64}$/, "UNMET_PREREQUISITE: set KCODER_E2E_WORKSPACE_OPERATION_RECEIPTS_SHA256 to that frozen binary's SHA-256");

  const binary = await hashExecutableFile(resolve(configuredBinary));
  await access(binary.path, constants.X_OK);
  assert.equal(binary.sha256, expectedSha256, "the app-server binary must match the writer-designated frozen SHA-256");

  const mainWorkspace = context.pathInState("workspaces", "main");
  const otherWorkspace = context.pathInState("workspaces", "other");
  const lowFdWorkspace = context.pathInState("workspaces", "low-fd");
  const quotaWorkspace = context.pathInState("workspaces", "quota");
  const openedWorkspace = resolve(mainWorkspace, "opened-existing");
  const createdWorkspace = resolve(mainWorkspace, "created-after-lost-ack");
  const unknownBlocker = resolve(mainWorkspace, "unknown-blocker");
  const unknownWorkspace = resolve(unknownBlocker, "would-be-created");
  const otherCreatedWorkspace = resolve(otherWorkspace, "created-under-other-workspace");
  await Promise.all([
    mkdir(openedWorkspace, { recursive: true }),
    mkdir(otherWorkspace, { recursive: true }),
    mkdir(lowFdWorkspace, { recursive: true }),
    mkdir(quotaWorkspace, { recursive: true }),
  ]);
  await writeFile(unknownBlocker, "stable blocker fixture\n", { flag: "wx", mode: 0o600 });
  const blockerBefore = await readFile(unknownBlocker);

  const primaryConfig = await createConfig(context, "primary");
  const separateOwnerConfig = await createConfig(context, "separate-client-storage-root");
  const clients = [];
  const processEvidence = [];
  const start = async (label, cwd, config, options = {}) => {
    const client = await startAppServer(context, {
      label,
      binary,
      cwd,
      configDir: config.dir,
      settingsFile: config.settingsFile,
      ...options,
    });
    clients.push(client);
    processEvidence.push(client.provenance);
    return client;
  };

  let primary = await start("workspace-receipts-main-1", mainWorkspace, primaryConfig);
  const initialized = await primary.request("initialize", {
    protocolVersion: "2026-07-27",
    clientInfo: { name: "workspace-operation-receipts-stdio", version: "1" },
  });
  assert.equal(initialized.error, undefined, JSON.stringify(initialized));
  assert.equal(
    initialized.result?.capabilities?.experimental?.workspaceOperationReceiptsV1,
    true,
    "the real app-server must advertise workspaceOperationReceiptsV1",
  );

  const openId = "stdio-open-stable-01";
  const openParams = {
    workspacePath: openedWorkspace,
    clientRequestId: openId,
    deviceId: "e2e-device",
    projectKey: "project:stdio-open",
    label: "Opened workspace",
    clientMetadata: {
      trace: { slot: 2, phase: "before" },
      flags: ["stable", true],
    },
  };
  const opened = await expectResult(primary, WORKSPACE_OPEN, openParams);
  assert.equal(opened.success, true);
  assert.equal(opened.workspacePath, openedWorkspace);
  const openReordered = await expectResult(primary, WORKSPACE_OPEN, {
    label: openParams.label,
    projectKey: openParams.projectKey,
    deviceId: openParams.deviceId,
    clientRequestId: openParams.clientRequestId,
    clientMetadata: {
      flags: ["stable", true],
      trace: { phase: "before", slot: 2 },
    },
    workspacePath: openParams.workspacePath,
  });
  assert.deepEqual(openReordered, opened, "same open ID and logical params must survive JSON object key reordering");
  const openConflict = await primary.request(WORKSPACE_OPEN, { ...openParams, label: "different label" });
  assertIdentityConflict(openConflict, "open ID reused with changed parameters");
  assertReceipt(await readReceipt(primary, openId), {
    clientRequestId: openId,
    method: WORKSPACE_OPEN,
    status: "ready",
    workspacePath: openedWorkspace,
  });

  const createId = "stdio-create-lost-ack-01";
  const createParams = {
    workspacePath: createdWorkspace,
    clientRequestId: createId,
    deviceId: "e2e-device",
    action: "create",
    projectId: 381,
    label: "Created once",
  };
  const droppedAck = await sendAndDropAcknowledgement(primary, WORKSPACE_PREPARE, createParams);
  assert.equal(droppedAck.acknowledgementDeliveredToCaller, false);
  assert.equal(await readReceipt(primary, createId).then(value => value.receipt?.status), "ready");
  assert.equal(await readReceipt(primary, createId).then(value => value.receipt?.workspacePath), createdWorkspace);
  await waitFor(
    () => primary.discardedResponseIds.includes(droppedAck.requestId),
    RPC_TIMEOUT_MS,
    "discarded create acknowledgement",
    20,
    context.abortSignal,
  );
  const acknowledgementResponseDiscarded = primary.discardedResponseIds.includes(droppedAck.requestId);
  assert.equal(acknowledgementResponseDiscarded, true, "the JSONL client must discard the create response before the caller receives it");
  assert.ok((await stat(createdWorkspace)).isDirectory(), "lost-ACK create must have made its workspace directory");
  const createReplayAfterDroppedAck = await expectResult(primary, WORKSPACE_PREPARE, createParams);

  const renameAfterCreate = await primary.request("runtime.workspaces.rename", {
    workspacePath: createdWorkspace,
    projectKey: "project:381",
    label: "Renamed after create",
    deviceId: "e2e-device",
  });
  assert.equal(renameAfterCreate.error, undefined, JSON.stringify(renameAfterCreate));
  assert.equal(renameAfterCreate.result?.success, true);

  const createConflict = await primary.request(WORKSPACE_PREPARE, { ...createParams, label: "different label" });
  assertIdentityConflict(createConflict, "create ID reused with changed parameters");

  const unknownId = "stdio-create-unknown-01";
  const unknownParams = {
    workspacePath: unknownWorkspace,
    clientRequestId: unknownId,
    deviceId: "e2e-device",
    action: "create",
    projectId: 382,
    label: "Unknown must not replay",
  };
  const failedBeforeSideEffect = await primary.request(WORKSPACE_PREPARE, unknownParams);
  assert.ok(failedBeforeSideEffect.error, "the blocker fixture must prevent the first create from completing");
  assert.equal(failedBeforeSideEffect.error.code, -32602);
  assert.match(failedBeforeSideEffect.error.message, /not a directory|file exists|cannot create directory/i);
  assertReceipt(await readReceipt(primary, unknownId), {
    clientRequestId: unknownId,
    method: WORKSPACE_PREPARE,
    status: "unknown",
    workspacePath: null,
  });
  assert.deepEqual(await readFile(unknownBlocker), blockerBefore, "the failed initial create must leave the blocker untouched");

  await primary.closeGracefully();
  primary = await start("workspace-receipts-main-2", mainWorkspace, primaryConfig);
  const reinitialized = await primary.request("initialize", {
    protocolVersion: "2026-07-27",
    clientInfo: { name: "workspace-operation-receipts-restart", version: "1" },
  });
  assert.equal(reinitialized.error, undefined, JSON.stringify(reinitialized));
  assert.equal(reinitialized.result?.capabilities?.experimental?.workspaceOperationReceiptsV1, true);

  assertReceipt(await readReceipt(primary, openId), {
    clientRequestId: openId,
    method: WORKSPACE_OPEN,
    status: "ready",
    workspacePath: openedWorkspace,
  });
  assertReceipt(await readReceipt(primary, createId), {
    clientRequestId: createId,
    method: WORKSPACE_PREPARE,
    status: "ready",
    workspacePath: createdWorkspace,
  });
  assertReceipt(await readReceipt(primary, unknownId), {
    clientRequestId: unknownId,
    method: WORKSPACE_PREPARE,
    status: "unknown",
    workspacePath: null,
  });

  const replayOpen = await expectResult(primary, WORKSPACE_OPEN, {
    label: openParams.label,
    projectKey: openParams.projectKey,
    deviceId: openParams.deviceId,
    clientRequestId: openParams.clientRequestId,
    clientMetadata: {
      flags: ["stable", true],
      trace: { phase: "before", slot: 2 },
    },
    workspacePath: openParams.workspacePath,
  });
  assert.deepEqual(replayOpen, opened, "open must return its stored result after restart");

  const reorderedCreateParams = {
    label: createParams.label,
    projectId: createParams.projectId,
    action: createParams.action,
    deviceId: createParams.deviceId,
    clientRequestId: createParams.clientRequestId,
    workspacePath: createParams.workspacePath,
  };
  const replayCreate = await expectResult(primary, WORKSPACE_PREPARE, reorderedCreateParams);
  assert.equal(
    sha256Json(replayCreate),
    sha256Json(createReplayAfterDroppedAck),
    "a dropped create ACK must replay the same stored result after restart",
  );
  const listedAfterReplay = await expectResult(primary, "runtime.workspaces.list", { deviceId: "e2e-device" });
  const createdRecord = listedAfterReplay.items?.find(item => item.workspacePath === createdWorkspace);
  assert.equal(createdRecord?.label, "Renamed after create", "replay must not repeat the registry side effect or overwrite a later rename");

  // If an unknown reservation were dispatched again, repairing the blocker
  // would now create the target. The durable unknown receipt must keep the
  // request closed across restart and a changed filesystem state.
  await unlink(unknownBlocker);
  const blockedUnknownReplay = await primary.request(WORKSPACE_PREPARE, unknownParams);
  assert.ok(blockedUnknownReplay.error, "unknown reservation must reject replay after restart");
  assert.equal(blockedUnknownReplay.error.code, -32602);
  assert.match(blockedUnknownReplay.error.message, /completion is unknown|reserved.*unknown/i);
  await assert.rejects(access(unknownWorkspace), { code: "ENOENT" }, "unknown replay must not create a workspace after the blocker is removed");
  assertReceipt(await readReceipt(primary, unknownId), {
    clientRequestId: unknownId,
    method: WORKSPACE_PREPARE,
    status: "unknown",
    workspacePath: null,
  });

  const separateOwner = await start("workspace-receipts-storage-owner", mainWorkspace, separateOwnerConfig);
  const separateOwnerInit = await separateOwner.request("initialize", {
    protocolVersion: "2026-07-27",
    clientInfo: { name: "workspace-operation-receipts-separate-storage", version: "1" },
  });
  assert.equal(separateOwnerInit.error, undefined, JSON.stringify(separateOwnerInit));
  assert.equal((await readReceipt(separateOwner, createId)).receipt, null, "a distinct client_storage_root must not see another root's receipt");
  const separateOwnerCreate = await expectResult(separateOwner, WORKSPACE_PREPARE, {
    ...createParams,
    label: "Separate storage root",
  });
  assert.equal(separateOwnerCreate.mapping.workspacePath, createdWorkspace);
  assertReceipt(await readReceipt(separateOwner, createId), {
    clientRequestId: createId,
    method: WORKSPACE_PREPARE,
    status: "ready",
    workspacePath: createdWorkspace,
  });

  const otherWorkspaceClient = await start("workspace-receipts-other-workspace", otherWorkspace, primaryConfig);
  const otherWorkspaceInit = await otherWorkspaceClient.request("initialize", {
    protocolVersion: "2026-07-27",
    clientInfo: { name: "workspace-operation-receipts-other-workspace", version: "1" },
  });
  assert.equal(otherWorkspaceInit.error, undefined, JSON.stringify(otherWorkspaceInit));
  assert.equal((await readReceipt(otherWorkspaceClient, createId)).receipt, null, "another engine workspace must not see the primary workspace receipt");
  const otherCreate = await expectResult(otherWorkspaceClient, WORKSPACE_PREPARE, {
    workspacePath: otherCreatedWorkspace,
    clientRequestId: createId,
    deviceId: "e2e-device",
    action: "create",
    projectId: 381,
    label: "Other workspace",
  });
  assert.equal(otherCreate.mapping.workspacePath, otherCreatedWorkspace);
  assertReceipt(await readReceipt(otherWorkspaceClient, createId), {
    clientRequestId: createId,
    method: WORKSPACE_PREPARE,
    status: "ready",
    workspacePath: otherCreatedWorkspace,
  });
  await Promise.all([
    primary.closeGracefully(),
    separateOwner.closeGracefully(),
    otherWorkspaceClient.closeGracefully(),
  ]);

  // Rebuild the legacy on-disk state without the new durable quota counter,
  // then exercise its bounded migration under a genuinely low NOFILE limit.
  // All seeded files stay inside this run's private config tree.
  assert.equal(process.platform, "linux", "the low-NOFILE boundary requires Linux prlimit and /proc evidence");
  const lowFdConfig = await createConfig(context, "low-fd-capacity");
  const lowFdSeedClient = await start("workspace-receipts-lowfd-seed", lowFdWorkspace, lowFdConfig);
  const lowFdSeedInit = await lowFdSeedClient.request("initialize", {
    protocolVersion: "2026-07-27",
    clientInfo: { name: "workspace-operation-receipts-lowfd-seed", version: "1" },
  });
  assert.equal(lowFdSeedInit.error, undefined, JSON.stringify(lowFdSeedInit));
  const lowFdSeedId = "lowfd-seed-0000";
  const lowFdSeedParams = {
    workspacePath: lowFdWorkspace,
    clientRequestId: lowFdSeedId,
    deviceId: "e2e-device",
    projectKey: "project:low-fd-capacity",
    label: "Low-FD original label",
  };
  const lowFdSeedResult = await expectResult(lowFdSeedClient, WORKSPACE_OPEN, lowFdSeedParams);
  await lowFdSeedClient.closeGracefully();

  const canonicalLowFdWorkspace = await realpath(lowFdWorkspace);
  assert.equal(lowFdSeedResult.workspacePath, canonicalLowFdWorkspace);
  const lowFdReceiptDirectory = await findPrivateReceiptDirectory(
    context.stateDir,
    lowFdConfig.dir,
    canonicalLowFdWorkspace,
  );
  const lowFdQuotaPath = resolve(lowFdReceiptDirectory, "quota");
  const quotaBeforeLegacyMigration = JSON.parse(await readFile(lowFdQuotaPath, "utf8"));
  assert.deepEqual(quotaBeforeLegacyMigration, {
    version: 1,
    workspace: canonicalLowFdWorkspace,
    reserved: 1,
  });
  const lowFdSeedDurationStart = Date.now();
  await seedLegacyReceiptRecords({
    receiptDirectory: lowFdReceiptDirectory,
    canonicalWorkspace: canonicalLowFdWorkspace,
    firstSeedIndex: 1,
    count: RECEIPT_LIMIT_PER_WORKSPACE - 1,
  });
  const lowFdSeedDurationMs = Date.now() - lowFdSeedDurationStart;
  const seededReceiptNames = (await readdir(lowFdReceiptDirectory)).filter(name => /^[0-9a-f]{64}\.json$/.test(name));
  assert.equal(seededReceiptNames.length, RECEIPT_LIMIT_PER_WORKSPACE, "legacy fixture must contain exactly 4096 valid receipt records");
  await unlink(lowFdQuotaPath);

  const lowFdClient = await start("workspace-receipts-lowfd-migration", lowFdWorkspace, lowFdConfig, {
    nofileLimit: LOW_NOFILE_LIMIT,
  });
  const lowFdInit = await lowFdClient.request("initialize", {
    protocolVersion: "2026-07-27",
    clientInfo: { name: "workspace-operation-receipts-lowfd-migration", version: "1" },
  });
  assert.equal(lowFdInit.error, undefined, JSON.stringify(lowFdInit));
  assert.equal(lowFdClient.provenance.nofileSoftLimit, LOW_NOFILE_LIMIT);
  assert.equal(lowFdClient.provenance.nofileHardLimit, LOW_NOFILE_LIMIT);
  const lowFdFirstReceipt = await readReceipt(lowFdClient, lowFdSeedId);
  assertReceipt(lowFdFirstReceipt, {
    clientRequestId: lowFdSeedId,
    method: WORKSPACE_OPEN,
    status: "ready",
    workspacePath: canonicalLowFdWorkspace,
  });
  const lowFdOverflow = await lowFdClient.request(WORKSPACE_OPEN, {
    ...lowFdSeedParams,
    clientRequestId: "lowfd-over-capacity-0001",
    label: "Must not be registered",
  });
  assert.ok(lowFdOverflow.error, "a legacy directory with 4096 receipts must reject the 4097th identity under low NOFILE");
  assert.equal(lowFdOverflow.error.code, -32602);
  assert.match(lowFdOverflow.error.message, /capacity reached|4096|quota/i);
  assert.equal(await access(lowFdQuotaPath).then(() => true, () => false), false, "failed legacy migration must not publish a quota counter");
  const lowFdList = await expectResult(lowFdClient, "runtime.workspaces.list", { deviceId: "e2e-device" });
  assert.equal(
    lowFdList.items?.find(item => item.workspacePath === canonicalLowFdWorkspace)?.label,
    "Low-FD original label",
    "the rejected 4097th ID must not repeat the workspace registry side effect",
  );
  await lowFdClient.closeGracefully();

  const quotaClient = await start("workspace-receipts-quota-1", quotaWorkspace, primaryConfig);
  const quotaInit = await quotaClient.request("initialize", {
    protocolVersion: "2026-07-27",
    clientInfo: { name: "workspace-operation-receipts-quota", version: "1" },
  });
  assert.equal(quotaInit.error, undefined, JSON.stringify(quotaInit));
  assert.equal(quotaInit.result?.capabilities?.experimental?.workspaceOperationReceiptsV1, true);
  const quotaFirstId = "quota-request-0000";
  const quotaFirstParams = {
    workspacePath: quotaWorkspace,
    clientRequestId: quotaFirstId,
    deviceId: "e2e-device",
    projectKey: "project:quota",
    label: "Quota original label",
  };
  let quotaFirstResult;
  const quotaStart = Date.now();
  for (let index = 0; index < RECEIPT_LIMIT_PER_WORKSPACE; index += 1) {
    const params = index === 0
      ? quotaFirstParams
      : {
          workspacePath: quotaWorkspace,
          clientRequestId: `quota-request-${String(index).padStart(4, "0")}`,
          deviceId: "e2e-device",
          projectKey: "project:quota",
          label: "Quota original label",
        };
    const result = await expectResult(quotaClient, WORKSPACE_OPEN, params);
    if (index === 0) quotaFirstResult = result;
  }
  const quotaFillDurationMs = Date.now() - quotaStart;
  assert.ok(quotaFirstResult, "the first quota-bound receipt must be retained for replay checks");

  const quotaRename = await quotaClient.request("runtime.workspaces.rename", {
    workspacePath: quotaWorkspace,
    projectKey: "project:quota",
    label: "Quota side-effect marker",
    deviceId: "e2e-device",
  });
  assert.equal(quotaRename.error, undefined, JSON.stringify(quotaRename));
  assert.equal(quotaRename.result?.success, true);

  const quotaOverflowId = "quota-request-over-limit";
  const quotaOverflowParams = { ...quotaFirstParams, clientRequestId: quotaOverflowId };
  const quotaOverflow = await quotaClient.request(WORKSPACE_OPEN, quotaOverflowParams);
  assert.ok(quotaOverflow.error, "a new receipt ID beyond the workspace quota must be refused");
  assert.equal(quotaOverflow.error.code, -32602);
  assert.match(quotaOverflow.error.message, /4096|quota|limit|capacity/i);
  const quotaListAtCapacity = await expectResult(quotaClient, "runtime.workspaces.list", { deviceId: "e2e-device" });
  assert.equal(
    quotaListAtCapacity.items?.find(item => item.workspacePath === quotaWorkspace)?.label,
    "Quota side-effect marker",
    "an over-capacity new ID must not repeat the open registry side effect",
  );
  assertReceipt(await readReceipt(quotaClient, quotaFirstId), {
    clientRequestId: quotaFirstId,
    method: WORKSPACE_OPEN,
    status: "ready",
    workspacePath: quotaWorkspace,
  });

  await quotaClient.closeGracefully();
  const quotaRestart = await start("workspace-receipts-quota-2", quotaWorkspace, primaryConfig);
  const quotaRestartInit = await quotaRestart.request("initialize", {
    protocolVersion: "2026-07-27",
    clientInfo: { name: "workspace-operation-receipts-quota-restart", version: "1" },
  });
  assert.equal(quotaRestartInit.error, undefined, JSON.stringify(quotaRestartInit));
  assertReceipt(await readReceipt(quotaRestart, quotaFirstId), {
    clientRequestId: quotaFirstId,
    method: WORKSPACE_OPEN,
    status: "ready",
    workspacePath: quotaWorkspace,
  });
  const quotaFirstReplay = await expectResult(quotaRestart, WORKSPACE_OPEN, quotaFirstParams);
  assert.deepEqual(quotaFirstReplay, quotaFirstResult, "an existing quota-bound ID must remain readable and replayable after restart");
  const quotaList = await expectResult(quotaRestart, "runtime.workspaces.list", { deviceId: "e2e-device" });
  assert.equal(
    quotaList.items?.find(item => item.workspacePath === quotaWorkspace)?.label,
    "Quota side-effect marker",
    "an existing ID replay at capacity must not repeat the open registry side effect",
  );
  const quotaOverflowAfterRestart = await quotaRestart.request(WORKSPACE_OPEN, quotaOverflowParams);
  assert.ok(quotaOverflowAfterRestart.error, "the full receipt quota must remain enforced after restart");
  assert.equal(quotaOverflowAfterRestart.error.code, -32602);
  assert.match(quotaOverflowAfterRestart.error.message, /4096|quota|limit|capacity/i);
  const quotaListAfterRestartOverflow = await expectResult(quotaRestart, "runtime.workspaces.list", { deviceId: "e2e-device" });
  assert.equal(
    quotaListAfterRestartOverflow.items?.find(item => item.workspacePath === quotaWorkspace)?.label,
    "Quota side-effect marker",
    "an over-capacity replay after restart must remain side-effect free",
  );

  await quotaRestart.closeGracefully();
  const turnStartRequestsSent = clients.reduce(
    (total, client) => total + client.methodsSent.filter(method => method === "turn/start").length,
    0,
  );
  assert.equal(turnStartRequestsSent, 0, "this stdio suite must never start a model turn");
  const binaryAfter = await hashExecutableFile(binary.path);
  assert.equal(binaryAfter.sha256, expectedSha256, "the frozen binary on disk must remain unchanged during the run");
  for (const client of clients) {
    const owned = context.processes.get(client.label);
    assert.equal(owned?.stopped, true, `${client.label} must be stopped and owned by this run`);
  }

  return {
    testRunRoot: context.runRoot,
    binary: {
      path: binary.path,
      sha256: binary.sha256,
      size: binary.size,
      mtime: binary.mtime,
      unchangedAfterRun: binaryAfter.sha256 === binary.sha256,
    },
    processes: processEvidence,
    cases: {
      capabilityAdvertised: true,
      openStableIdAndCanonicalParameterBinding: true,
      createLostAcknowledgementReadAndRestartReplay: {
        acknowledgementDeliveredToCaller: droppedAck.acknowledgementDeliveredToCaller,
        receiptReadAfterDrop: "ready",
        receiptReadAfterRestart: "ready",
        acknowledgementResponseDiscarded,
        replayResultSha256Matched: sha256Json(replayCreate) === sha256Json(createReplayAfterDroppedAck),
        registrySideEffectNotRepeated: createdRecord?.label === "Renamed after create",
      },
      changedParametersRejected: true,
      unknownReservationPersistsAndDoesNotReplayAfterFilesystemRepair: true,
      clientStorageRootReceiptIsolation: true,
      workspaceReceiptIsolation: true,
      lowFileDescriptorLegacyQuotaMigration: {
        nofileSoftLimit: lowFdClient.provenance.nofileSoftLimit,
        nofileHardLimit: lowFdClient.provenance.nofileHardLimit,
        legacyQuotaCounterRemovedBeforeRestart: true,
        validReceiptsAtCapacity: seededReceiptNames.length,
        seedDurationMs: lowFdSeedDurationMs,
        firstReceiptRemainedReadable: lowFdFirstReceipt.receipt?.status === "ready",
        newIdRejectedAtCapacity: true,
        rejectedCreateHadNoRegistrySideEffect: true,
      },
      quota: {
        limitPerWorkspace: RECEIPT_LIMIT_PER_WORKSPACE,
        distinctReceiptsCreated: RECEIPT_LIMIT_PER_WORKSPACE,
        fillDurationMs: quotaFillDurationMs,
        newIdRejectedAtCapacity: true,
        existingIdReadableAndReplayableAfterRestartAtCapacity: true,
        replayDidNotRepeatRegistrySideEffect: true,
      },
      noGatewayStarted: true,
      turnStartRequestsSent,
    },
  };
  });
}

async function createConfig(context, name) {
  const dir = context.pathInState("config", name);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const settingsFile = await context.writeStateJson(`config/${name}/settings.json`, { hooks: {}, providers: {} });
  return { dir, settingsFile };
}

async function findPrivateReceiptDirectory(stateDir, configDir, canonicalWorkspace) {
  const projectsDir = resolve(configDir, "projects");
  const projectDirectories = (await readdir(projectsDir, { withFileTypes: true }))
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name);
  assert.equal(projectDirectories.length, 1, "the isolated config must contain only this fixture's project data");
  const expectedWorkspaceHash = sha256Text(canonicalWorkspace);
  const receiptDirectory = resolve(
    projectsDir,
    projectDirectories[0],
    "client-sessions",
    "workspace-operations",
    expectedWorkspaceHash,
  );
  const receiptStat = await stat(receiptDirectory);
  assert.ok(receiptStat.isDirectory(), "the real app-server must create a private workspace receipt directory");
  assert.equal(receiptStat.mode & 0o077, 0, "the receipt directory must not be accessible by group or other users");
  const realState = await realpath(stateDir);
  const realReceiptDirectory = await realpath(receiptDirectory);
  const relativeReceiptPath = relative(realState, realReceiptDirectory);
  assert.ok(
    relativeReceiptPath && relativeReceiptPath !== ".." && !relativeReceiptPath.startsWith(`..${sep}`),
    "the receipt fixture must stay inside this RunContext's private state tree",
  );
  return realReceiptDirectory;
}

async function seedLegacyReceiptRecords({ receiptDirectory, canonicalWorkspace, firstSeedIndex, count }) {
  for (let offset = 0; offset < count; offset += 1) {
    const index = firstSeedIndex + offset;
    const clientRequestId = `lowfd-seed-${String(index).padStart(4, "0")}`;
    const params = {
      workspacePath: canonicalWorkspace,
      clientRequestId,
      deviceId: "e2e-device",
      projectKey: "project:low-fd-capacity",
      label: "Low-FD seeded unknown reservation",
    };
    const record = {
      version: 1,
      workspace: canonicalWorkspace,
      request_id: clientRequestId,
      method: WORKSPACE_OPEN,
      params_hash: sha256Json([WORKSPACE_OPEN, params]),
      result: null,
    };
    await writeFile(
      resolve(receiptDirectory, `${sha256Text(clientRequestId)}.json`),
      JSON.stringify(record),
      { flag: "wx", mode: 0o600 },
    );
  }
}

async function startAppServer(context, { label, binary, cwd, configDir, settingsFile, nofileLimit }) {
  const args = ["--settings-file", settingsFile, "--cwd", cwd, "app-server", "--training-mode"];
  const env = context.isolatedEnvironment({
    XDG_CONFIG_HOME: configDir,
    KCODER_CONFIG_DIR: configDir,
  });
  let command = binary.path;
  let launchArgs = args;
  if (nofileLimit !== undefined) {
    assert.equal(process.platform, "linux", "prlimit launch is supported only on Linux");
    const prlimit = "/usr/bin/prlimit";
    await access(prlimit, constants.X_OK);
    command = prlimit;
    launchArgs = [`--nofile=${nofileLimit}:${nofileLimit}`, "--", binary.path, ...args];
  }
  const child = context.spawnOwned(label, command, launchArgs, { cwd, env, stdin: "pipe" });
  assert.ok(child.stdin, `${label} must expose app-server stdin`);
  assert.ok(child.stdout, `${label} must expose app-server stdout`);
  const owned = context.processes.get(label);
  assert.ok(owned?.pid > 0 && owned?.pgid > 0, `${label} must be registered under RunContext with PID and process group`);
  const client = new JsonlStdioClient(label, child, context);
  const runningImage = await waitFor(async () => {
    const matches = await findOwnedExecutableProcesses({ pgid: owned.pgid, executablePath: binary.path });
    return matches.find(match => match.pid === child.pid);
  }, 10_000, `${label} exact running executable`, 50, context.abortSignal);
  assert.equal(runningImage.sha256, binary.sha256, `${label} must execute the hashed frozen binary`);
  const actualCwd = process.platform === "linux" ? await realpath(`/proc/${child.pid}/cwd`) : cwd;
  assert.equal(actualCwd, cwd, `${label} must run in its isolated workspace cwd`);
  let nofileSoftLimit;
  let nofileHardLimit;
  if (nofileLimit !== undefined) {
    const limits = await readFile(`/proc/${child.pid}/limits`, "utf8");
    const nofile = /^Max open files\s+(\d+)\s+(\d+)/m.exec(limits);
    assert.ok(nofile, `${label} must expose its process NOFILE limit through /proc`);
    nofileSoftLimit = Number(nofile[1]);
    nofileHardLimit = Number(nofile[2]);
    assert.equal(nofileSoftLimit, nofileLimit);
    assert.equal(nofileHardLimit, nofileLimit);
  }
  client.provenance = {
    label,
    pid: child.pid,
    pgid: owned.pgid,
    cwd,
    actualCwd,
    configDir,
    executablePath: binary.path,
    executableSha256: runningImage.sha256,
    executableHashVerifiedFromProc: true,
    ...(nofileLimit === undefined ? {} : { nofileSoftLimit, nofileHardLimit }),
  };
  return client;
}

class JsonlStdioClient {
  constructor(label, child, context) {
    this.label = label;
    this.child = child;
    this.context = context;
    this.sequence = 0;
    this.pending = new Map();
    this.methodsSent = [];
    this.discardedResponseIds = [];
    this.protocolFailure = null;
    this.exit = null;
    this.reader = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.reader.on("line", line => this.onLine(line));
    child.once("error", error => this.failPending(error));
    child.once("close", (code, signal) => {
      this.exit = { code, signal };
      this.failPending(new Error(`${label} exited before its JSON-RPC response arrived (code=${code}, signal=${signal})`));
    });
  }

  onLine(line) {
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      this.protocolFailure = new Error(`${this.label} wrote a non-JSON frame to stdout`);
      this.failPending(this.protocolFailure);
      return;
    }
    const pending = this.pending.get(frame?.id);
    if (pending) {
      this.pending.delete(frame.id);
      clearTimeout(pending.timer);
      pending.resolve(frame);
      return;
    }
    if (frame?.id !== undefined) this.discardedResponseIds.push(frame.id);
  }

  sendWithoutWaitingForResponse(method, params = {}) {
    if (this.protocolFailure) return Promise.reject(this.protocolFailure);
    if (this.exit) return Promise.reject(new Error(`${this.label} is already closed`));
    const id = `${this.label}-${++this.sequence}`;
    this.methodsSent.push(method);
    const frame = `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
    return new Promise((resolveWrite, rejectWrite) => {
      this.child.stdin.write(frame, error => {
        if (error) {
          rejectWrite(error);
          return;
        }
        resolveWrite(id);
      });
    });
  }

  request(method, params = {}, timeoutMs = RPC_TIMEOUT_MS) {
    if (this.protocolFailure) return Promise.reject(this.protocolFailure);
    if (this.exit) return Promise.reject(new Error(`${this.label} is already closed`));
    const id = `${this.label}-${++this.sequence}`;
    this.methodsSent.push(method);
    const frame = `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
    return new Promise((resolveResponse, rejectResponse) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectResponse(new Error(`${this.label} ${method} response timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolveResponse, reject: rejectResponse, timer });
      this.child.stdin.write(frame, error => {
        if (!error) return;
        this.pending.delete(id);
        clearTimeout(timer);
        rejectResponse(error);
      });
    });
  }

  failPending(error) {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }

  async closeGracefully() {
    if (!this.child.stdin.destroyed && !this.child.stdin.writableEnded) this.child.stdin.end();
    const result = await waitForChildClose(this.child, 10_000, this.label);
    await this.context.stopOwned(this.label);
    assert.equal(result.code, 0, `${this.label} must exit cleanly on JSONL stdin EOF`);
    return result;
  }
}

async function waitForChildClose(child, timeoutMs, label) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  return new Promise((resolveClose, rejectClose) => {
    const timer = setTimeout(() => {
      child.removeListener("close", onClose);
      rejectClose(new Error(`${label} did not close after stdin EOF within ${timeoutMs}ms`));
    }, timeoutMs);
    const onClose = (code, signal) => {
      clearTimeout(timer);
      resolveClose({ code, signal });
    };
    child.once("close", onClose);
  });
}

async function expectResult(client, method, params) {
  const response = await client.request(method, params);
  assert.equal(response.error, undefined, `${method} failed: ${JSON.stringify(response.error)}`);
  assert.ok(Object.hasOwn(response, "result"), `${method} response omitted result`);
  return response.result;
}

async function readReceipt(client, clientRequestId) {
  const result = await expectResult(client, OPERATION_READ, { clientRequestId });
  assert.ok(Object.hasOwn(result, "receipt"), "operation/read response must include receipt");
  return result;
}

function assertReceipt(result, expected) {
  assert.deepEqual(result.receipt, expected);
}

function assertIdentityConflict(response, label) {
  assert.ok(response.error, `${label} must fail`);
  assert.equal(response.error.code, -32602, `${label} must be a typed invalid-params error`);
  assert.match(response.error.message, /identity reused with different parameters/i, `${label} must explain the identity binding conflict`);
}

async function sendAndDropAcknowledgement(client, method, params) {
  const requestId = await client.sendWithoutWaitingForResponse(method, params);
  return {
    acknowledgementDeliveredToCaller: false,
    requestId,
  };
}

function sha256Json(value) {
  return createHash("sha256").update(JSON.stringify(sortJsonObjectKeys(value))).digest("hex");
}

function sha256Text(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sortJsonObjectKeys(value) {
  if (Array.isArray(value)) return value.map(sortJsonObjectKeys);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortJsonObjectKeys(value[key])]));
}

await runSuite();
