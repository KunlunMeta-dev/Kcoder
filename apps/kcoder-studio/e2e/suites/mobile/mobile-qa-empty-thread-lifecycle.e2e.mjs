import assert from "node:assert/strict";
import { access, mkdir, readdir, writeFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { startGateway, waitForGatewayRpcToken } from "../../harness/gateway.mjs";
import { gatewayRpcUrl, initializeRpc, openRpc } from "../../harness/rpc.mjs";
import { findOwnedExecutableProcesses, hashExecutableFile } from "../../harness/owned-executable-provenance.mjs";
import { runE2E, waitFor } from "../../harness/run-context.mjs";

const EXPECTED_BACKEND_SHA256 = "4a2521addc98dfb11ab021a3bd680f5fdbf01d20a38ec8bfa4837e29e430f03b";

// Model-independent protocol/lifecycle coverage: thread/start, resident list/read,
// early empty-turn validation, idle delete, and owned sidecar cleanup. The empty
// turn is rejected before Engine execution; training mode also disables background
// Provider prewarm. No model behavior or Provider request is under test.
await runE2E(import.meta.url, {
  testId: "mobile-qa-empty-thread-lifecycle",
  tier: "model-independent",
  modelPolicy: "model-independent real Gateway and Rust app-server lifecycle; no Provider turn or model-quality claim",
  retainSuccessLogs: true,
}, async context => {
  const configuredBinary = process.env.KCODER_E2E_KCODER_BIN;
  assert.ok(configuredBinary, "UNMET_PREREQUISITE: set KCODER_E2E_KCODER_BIN to the fixed 4a backend copy");
  const backendBinary = resolve(configuredBinary);
  await access(backendBinary);
  const configuredBefore = await hashExecutableFile(backendBinary);
  assert.equal(configuredBefore.sha256, EXPECTED_BACKEND_SHA256, "suite must use the root-designated fixed 4a backend binary");

  const workspace = context.pathInState("empty-workspace");
  const configDir = context.pathInState("private-config");
  const webRoot = context.pathInState("minimal-web-root");
  await Promise.all([
    mkdir(workspace, { recursive: true }),
    mkdir(configDir, { recursive: true, mode: 0o700 }),
    mkdir(webRoot, { recursive: true }),
  ]);
  // An empty user hook registry plus a workspace with no .kcoder directory makes
  // startup-hook absence explicit. KCODER_TRAINING_MODE prevents provider prewarm.
  await context.writeStateJson("private-config/settings.json", { hooks: {} });
  await context.writeStateJson("private-config/credentials.json", {});
  const webIndex = resolve(webRoot, "index.html");
  await writeFile(webIndex, "<!doctype html><html><head><meta charset=\"utf-8\"></head><body></body></html>\n", { mode: 0o600, flag: "wx" });
  const projectHooks = resolve(workspace, ".kcoder");
  await assert.rejects(access(projectHooks));

  const serversFile = await context.writeStateJson("servers.json", [{
    id: "local",
    label: "Isolated empty-thread lifecycle fixture",
    runtime: "kcoder",
    transport: "local",
    command: backendBinary,
    workspace,
    settingsFile: resolve(configDir, "settings.json"),
  }]);
  const gatewayLabel = "mobile-empty-thread-lifecycle-gateway";
  const gateway = await startGateway(context, {
    label: gatewayLabel,
    workspace,
    serversFile,
    kcoderBin: backendBinary,
    env: {
      KCODER_CONFIG_DIR: configDir,
      KCODER_TRAINING_MODE: "true",
      KCODER_STUDIO_WEB_ROOT: webRoot,
    },
  });
  const rpcToken = await waitForGatewayRpcToken(context, gateway);
  const rpc = await openRpc(gatewayRpcUrl(gateway, "local", rpcToken));
  context.addCleanup("close empty-thread lifecycle RPC", async () => {
    rpc.close();
    await waitFor(() => rpc.socket.readyState === rpc.socket.constructor.CLOSED, 5_000, "empty-thread RPC close");
  });
  const initialized = await initializeRpc(rpc, "mobile-empty-thread-lifecycle");
  assert.equal(initialized.capabilities?.experimental?.residentThreads, true, "real app-server must advertise resident thread support");

  const threadStartParams = {};
  const started = await rpc.request("thread/start", threadStartParams);
  const threadId = started.thread?.id;
  assert.equal(typeof threadId, "string");
  assert.ok(threadId.length > 0);

  const ownedProcessGroup = context.processes.get(gatewayLabel)?.pgid ?? gateway.child.pid;
  const binaryProcessBeforeDelete = await waitFor(
    async () => {
      const matches = await findOwnedExecutableProcesses({ pgid: ownedProcessGroup, executablePath: backendBinary });
      return matches.length ? matches : null;
    },
    10_000,
    "fixed backend executable inside the owned Gateway process group",
    50,
    context.abortSignal,
  );
  assert.ok(binaryProcessBeforeDelete.length > 0, "thread/start must activate the configured backend process");

  const listBeforeDelete = await rpc.request("thread/list", { allowPartial: true });
  assert.ok(listBeforeDelete.threads?.some(thread => thread.id === threadId), "an empty resident thread is visible in thread/list while its runtime is alive");
  const transcriptBeforeDelete = await rpc.request("thread/read", { threadId, limit: 20 });
  assert.equal(transcriptBeforeDelete.thread?.id, threadId);
  assert.deepEqual(transcriptBeforeDelete.messages, [], "new thread has no transcript messages");

  const threadPathsBeforeDelete = await collectThreadPaths(resolve(configDir, "projects"), context.stateDir, threadId);
  const historyBeforeDelete = threadPathsBeforeDelete.filter(path => path.endsWith(`${threadId}.jsonl`));
  assert.deepEqual(historyBeforeDelete, [], "thread/start without clientRequestId must not materialize an empty transcript file");
  const sessionSidecarsBeforeDelete = threadPathsBeforeDelete.filter(path => path.endsWith("/state.json"));
  assert.ok(sessionSidecarsBeforeDelete.length > 0, "resident activation must materialize its session state sidecar in the isolated config tree");

  const eventOffsetBeforeEmptyTurn = rpc.messages().length;
  await assert.rejects(
    rpc.request("turn/start", { threadId, input: [] }, 5_000),
    /turn\/start requires non-empty prompt/,
  );
  const emptyTurnFrames = rpc.messages().slice(eventOffsetBeforeEmptyTurn);
  const emptyTurnError = emptyTurnFrames.find(frame => frame.error && frame.id !== undefined);
  assert.equal(emptyTurnError?.error?.code, -32602, "empty input is rejected by typed RPC validation");
  assert.match(emptyTurnError?.error?.message ?? "", /non-empty prompt/);
  assert.equal(emptyTurnFrames.some(frame => frame.method === "turn/started" || frame.method === "turn/completed"), false,
    "empty input must fail before a turn lifecycle or Provider request starts");
  const afterRejectedTurn = await rpc.request("thread/read", { threadId, limit: 20 });
  assert.deepEqual(afterRejectedTurn.messages, [], "preflight rejection leaves the resident thread empty");

  const deletion = await rpc.request("thread/delete", { threadId });
  assert.equal(deletion.deleted, true, "an idle empty resident thread can be deleted");
  const listAfterDelete = await rpc.request("thread/list", { allowPartial: true });
  assert.equal(listAfterDelete.threads?.some(thread => thread.id === threadId), false, "deleted thread is removed from resident/history list");
  const readAfterDelete = await expectRemoteError(rpc, "thread/read", { threadId, limit: 20 });
  const resumeAfterDelete = await expectRemoteError(rpc, "thread/resume", { threadId });

  const threadPathsAfterDelete = await collectThreadPaths(resolve(configDir, "projects"), context.stateDir, threadId);
  const sessionSidecarsAfterDelete = threadPathsAfterDelete.filter(path => path.endsWith("/state.json"));
  assert.deepEqual(sessionSidecarsAfterDelete, [], "delete removes the activated thread's persisted session state sidecar");
  const historyFilesAfterDelete = threadPathsAfterDelete.filter(path => path.endsWith(`${threadId}.jsonl`));
  assert.deepEqual(historyFilesAfterDelete, [], "delete leaves no transcript file");
  const deletedHistoryTombstones = threadPathsAfterDelete.filter(path => path.endsWith(`${threadId}.hctl/source.json`));
  assert.equal(deletedHistoryTombstones.length, 1, "history source deletion tombstone is retained to prevent stale resurrection");
  const deletedHistoryControlDirectories = threadPathsAfterDelete.filter(path => path.endsWith(`${threadId}.hctl`));
  assert.equal(deletedHistoryControlDirectories.length, 1, "history control directory is retained with its deletion tombstone");
  const retainedHistoryLeaseFiles = threadPathsAfterDelete.filter(path => path.endsWith(`${threadId}.lease`));
  assert.equal(retainedHistoryLeaseFiles.length, 1, "stable history lease file is retained after deletion");
  const retainedLifecycleLocks = threadPathsAfterDelete.filter(path => path.endsWith(`/.thread-lifecycle-locks/${threadId}.lock`));
  assert.equal(retainedLifecycleLocks.length, 1, "stable thread lifecycle lock is retained after deletion");
  const expectedRemnants = new Set([
    ...deletedHistoryTombstones,
    ...deletedHistoryControlDirectories,
    ...retainedHistoryLeaseFiles,
    ...retainedLifecycleLocks,
  ]);
  const unexpectedThreadArtifactsAfterDelete = threadPathsAfterDelete.filter(path => !expectedRemnants.has(path));
  assert.deepEqual(unexpectedThreadArtifactsAfterDelete, [], "all other thread-scoped state/client artifacts are removed");

  rpc.close();
  await waitFor(() => rpc.socket.readyState === rpc.socket.constructor.CLOSED, 5_000, "empty-thread RPC close before process cleanup");
  await context.stopOwned(gatewayLabel);
  const backendProcessesAfterStop = await findOwnedExecutableProcesses({ pgid: ownedProcessGroup, executablePath: backendBinary });
  assert.deepEqual(backendProcessesAfterStop, [], "the fixed backend process must exit with this run's Gateway process group");
  const configuredAfter = await hashExecutableFile(backendBinary);
  assert.equal(configuredAfter.sha256, EXPECTED_BACKEND_SHA256, "fixed backend binary remains unchanged");

  await context.writeArtifactJson("empty-thread-lifecycle.json", {
    threadId,
    threadStartParams,
    startupHooks: { userHookRegistryEvents: [], projectHookDirectoryPresent: false },
    trainingMode: true,
    providerRequestPathEntered: false,
    residentVisibleBeforeDelete: true,
    historyMessagesBeforeDelete: transcriptBeforeDelete.messages.length,
    historyFilesBeforeDelete: historyBeforeDelete,
    sessionSidecarsBeforeDelete,
    emptyTurn: { errorCode: emptyTurnError.error.code, startedOrCompletedNotification: false },
    deletion: {
      deleted: deletion.deleted,
      deletedFiles: deletion.deletedFiles,
      absentFromList: true,
      readErrorCode: readAfterDelete.code,
      resumeErrorCode: resumeAfterDelete.code,
      sessionSidecarsAfterDelete,
      historyFilesAfterDelete,
      deletedHistoryTombstones,
      deletedHistoryControlDirectories,
      retainedHistoryLeaseFiles,
      retainedLifecycleLocks,
      unexpectedThreadArtifactsAfterDelete,
    },
    processProvenance: {
      sourceCommit: "UNVERIFIED",
      configuredBefore,
      processGroupId: ownedProcessGroup,
      ownedProcessesBeforeDelete: binaryProcessBeforeDelete,
      ownedProcessesAfterStop: backendProcessesAfterStop,
      configuredAfter,
    },
  });
  return {
    threadStartWithoutClientRequestId: true,
    residentListAndEmptyRead: true,
    emptyTurnRejectedBeforeExecution: true,
    idleDeleteAndPostDeleteReadResumeErrors: true,
    sessionSidecarCleanup: true,
    providerRequestPathEntered: false,
    backendSha256: configuredAfter.sha256,
    backendProcessesAfterStop: backendProcessesAfterStop.length,
  };
});

async function expectRemoteError(rpc, method, params) {
  const offset = rpc.messages().length;
  await assert.rejects(rpc.request(method, params, 5_000));
  const frame = rpc.messages().slice(offset).find(value => value.error && value.id !== undefined);
  assert.ok(frame?.error, `${method} must return a JSON-RPC error after deletion`);
  return { code: frame.error.code };
}

async function collectThreadPaths(root, stateRoot, threadId) {
  const found = [];
  async function walk(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const path = resolve(directory, entry.name);
      const relativePath = relative(stateRoot, path).split(sep).join("/");
      const components = relativePath.split("/");
      if (components.some(component => component === threadId || component.startsWith(`${threadId}.`))) {
        found.push(relativePath);
      }
      if (entry.isDirectory()) await walk(path);
    }
  }
  await walk(root);
  return found.sort();
}
