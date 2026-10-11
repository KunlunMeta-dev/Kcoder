import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import {
  findOwnedExecutableProcesses,
  hashExecutableFile,
} from "../../harness/owned-executable-provenance.mjs";
import { AppServerStdioClient, waitForStdioChildClose } from "../../harness/app-server-stdio.mjs";
import { repoRoot, runE2E, waitFor } from "../../harness/run-context.mjs";

const RPC_TIMEOUT_MS = 15_000;
const PROCESS_EXIT_TIMEOUT_MS = 10_000;
const PROTOCOL_VERSION = "2026-07-27";

// This model-independent suite exercises attachment ownership on the real
// Rust app-server JSONL transport. It never starts a Gateway or a model turn.
async function runSuite() {
  await runE2E(import.meta.url, {
    testId: "attachment-cleanup-real-app-server-stdio",
    tier: "manual-live",
    retainSuccessLogs: true,
    modelPolicy: "model-independent real Rust app-server JSONL stdio attachment lifecycle; no Gateway, turn, Provider request, or production session",
  }, async context => {
    assert.equal(process.platform, "linux", "this lifecycle fixture requires Linux /proc and flock process evidence");
    const configuredBinary = process.env.KCODER_E2E_ATTACHMENT_CLEANUP_BIN?.trim();
    const expectedSha256 = process.env.KCODER_E2E_ATTACHMENT_CLEANUP_SHA256?.trim().toLowerCase();
    assert.ok(configuredBinary, "UNMET_PREREQUISITE: set KCODER_E2E_ATTACHMENT_CLEANUP_BIN to the writer-designated frozen binary");
    assert.match(expectedSha256 || "", /^[0-9a-f]{64}$/, "UNMET_PREREQUISITE: set KCODER_E2E_ATTACHMENT_CLEANUP_SHA256 to that frozen binary's SHA-256");

    const binary = await hashExecutableFile(resolve(configuredBinary));
    await access(binary.path, constants.X_OK);
    assert.equal(binary.sha256, expectedSha256, "the app-server binary must match the writer-designated frozen SHA-256");

    const workspace = context.pathInState("workspace");
    const configDir = context.pathInState("config");
    const homeDir = context.pathInState("home");
    const tempRoot = context.pathInState("owned-temp");
    const unknownPath = context.pathInState("unclaimed", "unknown.txt");
    const materializedShapePath = context.pathInState(
      "materialized-shape-fixture",
      "thread-fixture",
      "attachments",
      "turn-fixture-digest",
      "00-materialized.txt",
    );
    await Promise.all([
      mkdir(workspace, { recursive: true, mode: 0o700 }),
      mkdir(configDir, { recursive: true, mode: 0o700 }),
      mkdir(homeDir, { recursive: true, mode: 0o700 }),
      mkdir(tempRoot, { recursive: true, mode: 0o700 }),
      mkdir(dirname(unknownPath), { recursive: true, mode: 0o700 }),
      mkdir(dirname(materializedShapePath), { recursive: true, mode: 0o700 }),
    ]);
    await context.writeStateJson("config/settings.json", { hooks: {}, providers: {} });
    const unknownBytes = Buffer.from("unclaimed attachment fixture\n");
    const materializedShapeBytes = Buffer.from("materialized-path-shaped fixture; no model turn was run\n");
    await Promise.all([
      writeFile(unknownPath, unknownBytes, { flag: "wx", mode: 0o600 }),
      writeFile(materializedShapePath, materializedShapeBytes, { flag: "wx", mode: 0o600 }),
    ]);

    const canonicalTempRoot = await realpath(tempRoot);
    assert.equal(canonicalTempRoot, tempRoot);
    const settingsFile = resolve(configDir, "settings.json");
    const clients = [];
    const processes = [];
    const cases = {};
    const evidenceRoot = await createPrivateEvidenceRoot();
    const evidence = {
      schemaVersion: 1,
      status: "running",
      testId: "attachment-cleanup-real-app-server-stdio",
      statusBasis: "suite assertions; RunContext result.json is authoritative for finalization status",
      runContextRoot: context.runRoot,
      privateEvidenceRoot: evidenceRoot,
      binary: {
        path: binary.path,
        sha256: binary.sha256,
        size: binary.size,
        mtime: binary.mtime,
      },
      isolation: {
        appServerCwd: workspace,
        configDir,
        tempRoot: canonicalTempRoot,
        childTempVariables: { TMPDIR: canonicalTempRoot, TMP: canonicalTempRoot, TEMP: canonicalTempRoot },
        gatewayStarted: false,
        turnStartRequestsSent: 0,
        providerRequestSent: false,
      },
      processes,
      cases,
    };
    context.addCleanup("persist private attachment lifecycle evidence", async () => {
      if (evidence.status === "running") evidence.status = "incomplete";
      const failedCleanupSteps = context.cleanupSteps.filter(step => step.status !== "completed");
      const allOwnedProcessesStopped = [...context.processes.values()].every(record => record.stopped);
      evidence.runContextCleanup = {
        allOwnedProcessesStopped,
        failedSteps: failedCleanupSteps,
        temporaryStateScheduledForRemovalByRunContext: true,
      };
      if (evidence.status === "passed" && (!allOwnedProcessesStopped || failedCleanupSteps.length > 0)) {
        evidence.status = "passed-with-cleanup-failure";
      }
      evidence.finishedAt = new Date().toISOString();
      await persistEvidence(context, evidenceRoot, evidence);
    });

    const start = async label => {
      const server = await startAppServer(context, {
        label,
        binary,
        cwd: workspace,
        configDir,
        settingsFile,
        homeDir,
        tempRoot: canonicalTempRoot,
      });
      clients.push(server);
      processes.push(server.provenance);
      const initialize = await server.client.request("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        clientInfo: { name: "attachment-cleanup-stdio", version: "1" },
      });
      assert.equal(initialize.error, undefined, `${label} initialize failed: ${JSON.stringify(initialize.error)}`);
      return server;
    };

    const first = await start("attachment-cleanup-owner-1");
    const retainedBytes = Buffer.from("claim remains owned after failed physical delete\n");
    const retryPath = await saveAttachment(first.client, "retry-after-obstruction.txt", retainedBytes);
    const retryOwner = attachmentOwnerPaths(retryPath, canonicalTempRoot);
    const retryItemDirectory = dirname(retryPath);
    const blockerBytes = Buffer.from("owned obstruction fixture\n");
    await rm(retryItemDirectory, { recursive: true, force: false });
    await writeFile(retryItemDirectory, blockerBytes, { flag: "wx", mode: 0o600 });
    const failedConsume = await first.client.request("attachment/delete", { path: retryPath });
    assertRpcFailure(failedConsume, "delete blocked by a regular-file parent");
    assert.match(failedConsume.error.message, /failed to remove staged attachment|not a directory|not directory/i);
    assert.deepEqual(await readFile(retryItemDirectory), blockerBytes, "the obstruction fixture must remain untouched after failed consume");
    await rm(retryItemDirectory, { force: false });
    await mkdir(retryItemDirectory, { mode: 0o700 });
    await writeFile(retryPath, retainedBytes, { flag: "wx", mode: 0o600 });
    const retryDelete = await expectResult(first.client, "attachment/delete", { path: retryPath });
    assert.deepEqual(retryDelete, { removed: true });
    await assertMissing(retryPath, "successful retry must remove the staged file");
    cases.failedConsumeKeepsClaimRetryable = {
      firstDeleteRejected: true,
      blockerPreserved: true,
      sameConnectionRetrySucceeded: true,
      stagedPathRemoved: true,
      ownerDirectory: retryOwner.directory,
      leasePath: retryOwner.leasePath,
    };

    const discardedAckBytes = Buffer.from("successful delete whose reply is intentionally ignored\n");
    const discardedAckPath = await saveAttachment(first.client, "discarded-delete-ack.txt", discardedAckBytes);
    const discardedAckOwner = attachmentOwnerPaths(discardedAckPath, canonicalTempRoot);
    const droppedDeleteId = await first.client.sendWithoutWaitingForResponse("attachment/delete", { path: discardedAckPath });
    const discardedResponse = await first.client.waitForDiscardedResponse(droppedDeleteId, RPC_TIMEOUT_MS);
    assert.deepEqual(discardedResponse.result, { removed: true }, "the real server must acknowledge the delete whose caller has no response waiter");
    assert.equal(first.client.discardedResponseIds.includes(droppedDeleteId), true, "the JSONL client must observe and discard the matching response ID");
    await assertMissing(discardedAckPath, "the first delete must have removed the attachment before replay");
    const replayedDelete = await expectResult(first.client, "attachment/delete", { path: discardedAckPath });
    assert.deepEqual(replayedDelete, { removed: true }, "same-connection tombstone replay must acknowledge the prior successful delete");
    await assertMissing(discardedAckPath, "same-connection replay must leave the attachment absent");
    cases.sameConnectionDeleteReplayAfterDiscardedAck = {
      responseId: droppedDeleteId,
      acknowledgementNotDeliveredToCaller: true,
      responseObservedAsUnmatchedAndDiscarded: true,
      pathAbsentBeforeReplay: true,
      replayReturnedRemoved: replayedDelete.removed,
      pathAbsentAfterReplay: true,
      ownerDirectory: discardedAckOwner.directory,
      leasePath: discardedAckOwner.leasePath,
    };
    await closeGracefully(context, first);

    const second = await start("attachment-cleanup-owner-2-fresh-process");
    await expectDenied(second.client, retryPath, "old staged path from a closed connection");
    await assertMissing(retryPath, "the old path is already absent after its explicit delete");
    await expectDenied(second.client, unknownPath, "existing unknown file");
    assert.deepEqual(await readFile(unknownPath), unknownBytes, "unknown file must not be removed by a fresh connection");
    await expectDenied(second.client, materializedShapePath, "materialized-path-shaped fixture");
    assert.deepEqual(await readFile(materializedShapePath), materializedShapeBytes, "materialized-shaped fixture must not be removed by attachment/delete");
    cases.freshProcessRejectsClosedUnknownAndMaterializedPaths = {
      oldPathFromClosedConnectionRejected: true,
      oldExplicitlyDeletedPathStillAbsent: true,
      existingUnknownPathRejectedAndPreserved: true,
      unknownFileSha256: sha256(unknownBytes),
      materializedShapePathRejectedAndPreserved: true,
      materializedShapeFileSha256: sha256(materializedShapeBytes),
      materializedShapeFixture: true,
      actualTurnMaterializationPerformed: false,
    };

    const blockedDropPath = await saveAttachment(second.client, "owner-drop-obstruction.txt", Buffer.from("owner directory cleanup fixture\n"));
    const blockedDropOwner = attachmentOwnerPaths(blockedDropPath, canonicalTempRoot);
    assert.ok((await stat(blockedDropOwner.directory)).isDirectory());
    await access(blockedDropOwner.leasePath);
    await rm(blockedDropOwner.directory, { recursive: true, force: false });
    const ownerBlocker = Buffer.from("regular-file obstruction for this test-owned owner directory\n");
    await writeFile(blockedDropOwner.directory, ownerBlocker, { flag: "wx", mode: 0o600 });
    await closeGracefully(context, second);
    const afterFailedDrop = await lstat(blockedDropOwner.directory);
    assert.ok(afterFailedDrop.isFile(), "the owner-directory obstruction must remain after connection Drop");
    assert.deepEqual(await readFile(blockedDropOwner.directory), ownerBlocker);
    await access(blockedDropOwner.leasePath);
    const dropLeaseUnlocked = await probeLease(context, blockedDropOwner.leasePath, workspace, canonicalTempRoot, "attachment-cleanup-drop-lease-probe");
    processes.push(dropLeaseUnlocked.provenance);
    assert.equal(dropLeaseUnlocked.exit.code, 0, "Drop must release and retain an unlocked lease after owner-directory cleanup fails");
    cases.failedOwnerDropRetainsUnlockedLease = {
      ownerDirectoryRemovalForcedByOwnedRegularFileObstruction: true,
      ownerDirectoryBlockerRemainedAfterDrop: true,
      leaseMarkerRetained: true,
      flockCouldAcquireAfterDrop: true,
      ownerPathStayedARegularFileFixtureAfterDrop: true,
      ownerDirectory: blockedDropOwner.directory,
      leasePath: blockedDropOwner.leasePath,
    };

    const crashOwner = await start("attachment-cleanup-owner-3-crash");
    const crashBytes = Buffer.from("staged upload survives owner process crash\n");
    const crashPath = await saveAttachment(crashOwner.client, "orphan-after-crash.txt", crashBytes);
    const crashLease = attachmentOwnerPaths(crashPath, canonicalTempRoot);
    assert.ok((await stat(crashLease.directory)).isDirectory());
    await access(crashLease.leasePath);
    const crashChild = crashOwner.client.child;
    assert.equal(crashChild.kill("SIGKILL"), true, "SIGKILL must target the exact RunContext-owned app-server child");
    const crashExit = await waitForStdioChildClose(crashChild, PROCESS_EXIT_TIMEOUT_MS, crashOwner.label);
    await context.stopOwned(crashOwner.label);
    crashOwner.client.closeReader();
    crashOwner.exit = crashExit;
    crashOwner.provenance.exit = crashExit;
    crashOwner.provenance.runContextStopped = context.processes.get(crashOwner.label)?.stopped === true;
    assert.equal(crashExit.signal, "SIGKILL");
    await waitFor(
      async () => (await findOwnedExecutableProcesses({ pgid: crashOwner.provenance.pgid, executablePath: binary.path })).length === 0,
      PROCESS_EXIT_TIMEOUT_MS,
      "crashed attachment owner process group exit",
      20,
      context.abortSignal,
    );
    assert.deepEqual(await readFile(crashPath), crashBytes, "SIGKILL must leave the exact crashed owner's staged bytes available for scavenging");
    assert.ok((await stat(crashLease.directory)).isDirectory(), "SIGKILL must leave only this test-owned owner directory for scavenging");
    await access(crashLease.leasePath);
    const crashLeaseUnlocked = await probeLease(context, crashLease.leasePath, workspace, canonicalTempRoot, "attachment-cleanup-crash-lease-probe");
    processes.push(crashLeaseUnlocked.provenance);
    assert.equal(crashLeaseUnlocked.exit.code, 0, "the crashed process must release its file lease for a later scavenger");
    cases.ownerCrashLeavesOwnedOrphanAndReleasesLease = {
      exactOwnerPid: crashOwner.provenance.pid,
      exactOwnerPgid: crashOwner.provenance.pgid,
      signal: crashExit.signal,
      processGroupExited: true,
      stagedFileRemained: true,
      ownerDirectoryRemained: true,
      leaseMarkerRemainedAndUnlocked: true,
      ownerDirectory: crashLease.directory,
      leasePath: crashLease.leasePath,
      stagedPath: crashPath,
    };

    const restarted = await start("attachment-cleanup-owner-4-restart");
    assert.deepEqual(await readFile(crashPath), crashBytes, "backend restart must not claim a fresh orphan is gone");
    await access(crashLease.leasePath);
    assert.ok((await stat(crashLease.directory)).isDirectory(), "startup sweep must leave this fresh owner directory present");
    assert.ok((await lstat(blockedDropOwner.directory)).isFile(), "startup sweep must not convert the owned Drop obstruction into a successful cleanup claim");
    await access(blockedDropOwner.leasePath);
    await expectDenied(restarted.client, crashPath, "staged path owned by a previous process");
    assert.deepEqual(await readFile(crashPath), crashBytes, "fresh process must not delete an orphaned staged path it does not own");
    await assertMissing(retryPath, "restart must preserve the old explicitly deleted path's absence");
    cases.freshProcessRejectsOldOwnerPath = {
      orphanRemainedAfterRestart: true,
      deleteRejected: true,
      fileStillPresentAfterRejectedDelete: true,
      path: crashPath,
      ownerDirectory: crashLease.directory,
      leasePath: crashLease.leasePath,
      periodicSweepClaim: "UNVERIFIED: no 10-minute timer was awaited; periodic interval and 512-entry bound are covered by injected-clock Rust unit tests",
    };
    await closeGracefully(context, restarted);

    assert.equal(
      clients.reduce((count, server) => count + server.client.methodsSent.filter(method => method === "turn/start").length, 0),
      0,
      "this suite must never invoke a Provider turn",
    );
    for (const record of context.processes.values()) {
      assert.equal(record.stopped, true, `${record.label} must be stopped and owned by this RunContext`);
    }
    const finalBinary = await hashExecutableFile(binary.path);
    assert.equal(finalBinary.sha256, expectedSha256, "the frozen app-server candidate must remain unchanged throughout the run");
    evidence.status = "passed";
    evidence.finishedAt = new Date().toISOString();
    evidence.binary.sha256AfterRun = finalBinary.sha256;
    evidence.binary.unchangedAfterRun = true;
    evidence.processes = processes;
    evidence.cases = cases;
    evidence.framework = {
      stdioConnections: clients.length,
      ownedHelperProcesses: [...context.processes.values()].filter(record => record.command === "flock").length,
      noGateway: true,
      noProvider: true,
      noProductionSession: true,
      noModelTurn: true,
      noHostTempRootScanned: true,
    };
    await context.writeArtifactJson("attachment-cleanup-stdio-evidence.json", evidence);
    return {
      evidencePath: resolve(evidenceRoot, "evidence.json"),
      runContextRoot: context.runRoot,
      binary: evidence.binary,
      processes,
      cases,
      noGateway: true,
      noProvider: true,
      noModelTurn: true,
    };
  });
}

async function createPrivateEvidenceRoot() {
  const privateBase = resolve(repoRoot, "target/private-attachment-cleanup-stdio");
  await mkdir(privateBase, { recursive: true, mode: 0o700 });
  return mkdtemp(resolve(privateBase, "run-"));
}

async function persistEvidence(context, evidenceRoot, evidence) {
  const filePath = resolve(evidenceRoot, "evidence.json");
  await writeFile(filePath, `${JSON.stringify(context.redactValue(evidence), null, 2)}\n`, { flag: "w", mode: 0o600 });
  return filePath;
}

async function startAppServer(context, { label, binary, cwd, configDir, settingsFile, homeDir, tempRoot }) {
  const args = ["--settings-file", settingsFile, "--cwd", cwd, "app-server", "--training-mode"];
  const env = context.isolatedEnvironment({
    HOME: homeDir,
    USERPROFILE: homeDir,
    XDG_CONFIG_HOME: configDir,
    KCODER_CONFIG_DIR: configDir,
    TMPDIR: tempRoot,
    TMP: tempRoot,
    TEMP: tempRoot,
  });
  const child = context.spawnOwned(label, binary.path, args, { cwd, env, stdin: "pipe" });
  assert.ok(child.stdin, `${label} must expose app-server stdin`);
  assert.ok(child.stdout, `${label} must expose app-server stdout`);
  const owned = context.processes.get(label);
  assert.ok(owned?.pid > 0 && owned?.pgid > 0, `${label} must be registered with an exact PID and process group`);
  const client = new AppServerStdioClient(label, child, { defaultTimeoutMs: RPC_TIMEOUT_MS });
  const runningImage = await waitFor(async () => {
    const matches = await findOwnedExecutableProcesses({ pgid: owned.pgid, executablePath: binary.path });
    return matches.find(match => match.pid === child.pid);
  }, PROCESS_EXIT_TIMEOUT_MS, `${label} exact running executable`, 50, context.abortSignal);
  assert.equal(runningImage.sha256, binary.sha256, `${label} must execute the hashed frozen app-server image`);
  const actualCwd = await realpath(`/proc/${child.pid}/cwd`);
  assert.equal(actualCwd, cwd, `${label} must run in the owned workspace cwd`);
  const processEnv = parseEnvironment(await readFile(`/proc/${child.pid}/environ`));
  for (const name of ["TMPDIR", "TMP", "TEMP"]) {
    assert.equal(processEnv[name], tempRoot, `${label} ${name} must point to this RunContext's isolated temp root`);
  }
  const provenance = {
    label,
    pid: child.pid,
    pgid: owned.pgid,
    cwd,
    actualCwd,
    configDir,
    tempRoot,
    executablePath: binary.path,
    executableSha256: runningImage.sha256,
    executableHashVerifiedFromProc: true,
    childTempVariablesVerifiedFromProc: true,
  };
  return { label, child, client, provenance, exit: null };
}

async function closeGracefully(context, server) {
  if (!server.child.stdin.destroyed && !server.child.stdin.writableEnded) server.child.stdin.end();
  const exit = await waitForStdioChildClose(server.child, PROCESS_EXIT_TIMEOUT_MS, server.label);
    await context.stopOwned(server.label);
    server.client.closeReader();
    assert.equal(exit.code, 0, `${server.label} must exit cleanly on JSONL stdin EOF`);
    server.exit = exit;
    server.provenance.exit = exit;
    server.provenance.runContextStopped = context.processes.get(server.label)?.stopped === true;
  return exit;
}

async function probeLease(context, leasePath, cwd, tempRoot, label) {
  const flockPath = "/usr/bin/flock";
  const sleepPath = "/usr/bin/sleep";
  await access(flockPath, constants.X_OK);
  await access(sleepPath, constants.X_OK);
  const launchedExecutable = await hashExecutableFile(flockPath);
  const child = context.spawnOwned(label, flockPath, ["-n", leasePath, sleepPath, "0.2"], {
    cwd,
    env: context.isolatedEnvironment({ TMPDIR: tempRoot, TMP: tempRoot, TEMP: tempRoot }),
  });
  const owned = context.processes.get(label);
  const actualCwd = await realpath(`/proc/${child.pid}/cwd`);
  assert.equal(actualCwd, cwd, `${label} must run in the owned workspace cwd`);
  const actualExecutable = await realpath(`/proc/${child.pid}/exe`);
  const provenance = {
    label,
    pid: child.pid,
    pgid: owned?.pgid,
    cwd,
    actualCwd,
    launchedExecutable: flockPath,
    launchedExecutableSha256: launchedExecutable.sha256,
    actualExecutable,
    leasePath,
  };
  const exit = await waitForStdioChildClose(child, 5_000, label);
  await context.stopOwned(label);
  provenance.exit = exit;
  provenance.runContextStopped = context.processes.get(label)?.stopped === true;
  return { exit, provenance };
}

function attachmentOwnerPaths(stagedPath, tempRoot) {
  const itemDirectory = dirname(stagedPath);
  const directory = dirname(itemDirectory);
  const ownerName = directory.slice(directory.lastIndexOf(sep) + 1);
  const relativeOwnerPath = relative(tempRoot, directory);
  assert.ok(relativeOwnerPath && !relativeOwnerPath.startsWith(`..${sep}`) && relativeOwnerPath !== "..", "attachment owner directory must remain inside this RunContext temp root");
  assert.match(ownerName, /^kcoder-studio-attachment-owner-[a-f0-9]{24}$/);
  assert.equal(dirname(directory), tempRoot, "each attachment owner must be a direct child of the isolated temp root");
  return { directory, leasePath: `${directory}.lease` };
}

async function saveAttachment(client, filename, bytes) {
  const result = await expectResult(client, "attachment/save", {
    filename,
    content_base64: Buffer.from(bytes).toString("base64"),
  });
  assert.equal(typeof result.path, "string", "attachment/save must return its staged path");
  assert.deepEqual(await readFile(result.path), bytes, "the real app-server must persist the exact attachment bytes");
  return result.path;
}

async function expectResult(client, method, params) {
  const response = await client.request(method, params);
  assert.equal(response.error, undefined, `${method} failed: ${JSON.stringify(response.error)}`);
  assert.ok(Object.hasOwn(response, "result"), `${method} response omitted result`);
  return response.result;
}

async function expectDenied(client, path, label) {
  const response = await client.request("attachment/delete", { path });
  assertRpcFailure(response, label);
  assert.equal(response.error.code, -32602, `${label} must be rejected as invalid attachment params`);
  assert.match(response.error.message, /not staged|not belong|connection/i, `${label} must explain that this connection does not own the path`);
  return response.error;
}

function assertRpcFailure(response, label) {
  assert.ok(response.error, `${label} must fail`);
  assert.equal(response.result, undefined, `${label} must not also return a success result`);
}

async function assertMissing(path, message) {
  await assert.rejects(access(path), { code: "ENOENT" }, message);
}

function parseEnvironment(bytes) {
  return Object.fromEntries(bytes.toString("utf8").split("\0").filter(Boolean).map(entry => {
    const separator = entry.indexOf("=");
    return [entry.slice(0, separator), entry.slice(separator + 1)];
  }));
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

runSuite().catch(error => {
  process.stderr.write(`attachment cleanup stdio suite failed: ${String(error?.stack || error)}\n`);
  process.exitCode = 1;
});
