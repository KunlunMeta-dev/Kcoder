import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { startApprovalModelFixture } from "../harness/approval-model.mjs";
import { startChromium } from "../harness/chromium.mjs";
import { startGateway } from "../harness/gateway.mjs";
import { copyOfficialMobileStaticDist, inspectOfficialMobileStaticDist } from "../harness/mobile-static-dist-input.mjs";
import { reuseMobileWebExport } from "../harness/mobile-web-export-reuse.mjs";
import { hashExecutableFile } from "../harness/owned-executable-provenance.mjs";
import { createShortChromiumTemp } from "../harness/short-chromium-temp.mjs";
import { materializeWorkspace } from "../harness/workspace-fixture.mjs";
import { repoRoot, runE2E, waitFor } from "../harness/run-context.mjs";
import {
  CURRENT_ARCHIVED_BUNDLE_EVIDENCE,
  currentArchivedBundleRequested,
  inspectCurrentArchivedMobileWeb,
  validateCurrentArchivedGateway,
} from "../harness/current-mobile-web-archive.mjs";

const EXPECTED_SOURCE_COMMIT = "174d9f340ae6dfea8f7eab5c9c6c7f091d09cb4c";
const STATE_PREFIX = "kcoder-studio:mobile-workspace-state:v3";
const SERVER_ID = "local";
const SERVER_LABEL = "Send recovery fixture";
const SEED_PROMPT = "MOBILE_SEND_RECOVERY_174D_SEED";
const SUBMITTED_PROMPT = "MOBILE_SEND_RECOVERY_174D_ORIGINAL";
const REVISED_DRAFT = "MOBILE_SEND_RECOVERY_174D_NEW_REVISION";
const FIXTURE_REPLY = "MOBILE_SEND_RECOVERY_174D_FIXTURE_REPLY";
const WEB_FILE_COUNT = 37;
const MOBILE_STATIC_MANIFEST = "kcoder-mobile-web.json";
const MOBILE_STATIC_BASE_TOKEN = "/__kcoder_mobile_mount_v1__";
const ACCEPTED_SYNCING_FLAG = "--accepted-syncing";
const ACCEPTED_SYNCING_CONTRACT_FLAG = "--accepted-syncing-contract-check";
const OFFICIAL_MOBILE_DIST_ROOT_FLAG = "--official-mobile-dist-root";
const OFFICIAL_MOBILE_MANIFEST_SHA256_FLAG = "--official-mobile-manifest-sha256";
const ACCEPTED_SYNCING_EVIDENCE = "ACCEPTED_SYNCING_CHECK_ONLY_FUNCTIONAL";
const CURRENT_CHROMIUM = Object.freeze({
  path: "/opt/cft/chrome-linux64/chrome",
  sha256: "0b20b130e7edd9dd51873be867761295fe0cfad490c2b9a64f95bd3cfc08fa71",
  version: "151.0.7922.34",
  playwrightTestVersion: "1.62.0",
});
const runnerOptions = parseRunnerOptions(process.argv);
const useCurrentArchive = currentArchivedBundleRequested();
const useAcceptedSyncing = runnerOptions.acceptedSyncing;
assert.ok(!(useCurrentArchive && useAcceptedSyncing),
  "--current-archive and --accepted-syncing select different Mobile dist inputs");
const useCurrentGateway = useCurrentArchive || useAcceptedSyncing;

const MOBILE_SOURCE_PINS = {
  "apps/kcoder-studio/mobile/package.json": "563ea68d8e4e6e5b5af3d00f3981e7a5ae1cb271cc609275d491fd010c77bc5b",
  "apps/kcoder-studio/mobile/package-lock.json": "7c47b7ad5427ac56682f19c6fb7e46cff6e442ad8f52edee283665a38cd2e68b",
  "apps/kcoder-studio/mobile/src/features/task/useTaskSending.ts": "7a0e33be2aa1a0be92ac08f4f94c9b840e2ba7c83159251db990759c05191c21",
  "apps/kcoder-studio/mobile/src/features/task/useTaskAgentState.ts": "dab8b350b53d14b35ec5e4b0758e8a06d13162d529047ae3ce15167f289bbeb5",
  "apps/kcoder-studio/mobile/src/features/task/useTaskScreen.ts": "cebac0f1a8d86ece2b7c45cad19c77fae2a3faee84cc293b30ce6328824cfc34",
  "apps/kcoder-studio/mobile/src/features/task/TaskScreen.tsx": "b682aa82a93af5114b86cf5b89545578f3f74db0d840bdcf8986794d63a84561",
  "apps/kcoder-studio/mobile/src/features/task/TaskComposer.tsx": "b7a394ff370fb5e1356b4ae413e74162a92e3c9a40bec58e5ad6a38877dd0bff",
  "apps/kcoder-studio/mobile/src/storage/workspace-preferences.ts": "3878ea46964e662bdc27a5777e544f855a852f9a8363a748a8dd8d520cdc4771",
};

const ASYNC_STORAGE_PINS = {
  "apps/kcoder-studio/mobile/node_modules/@react-native-async-storage/async-storage/package.json": "6346a7c16602136ed46fc0aadd02c388ab160540dc32c1c5ad877d7152750d30",
  "apps/kcoder-studio/mobile/node_modules/@react-native-async-storage/async-storage/lib/module/AsyncStorage.js": "3b8afc3e15d9a4bdd5fd08e43ede4ff8252311681286fc440a7fdb1fd1cf7766",
};

const GATEWAY_SOURCE_PATHS = [
  "apps/kcoder-studio/dev-server.mjs",
  "apps/kcoder-studio/src/mobile-web-static.js",
  "apps/kcoder-studio/src/workspace-app-server-broker.js",
  "apps/kcoder-studio/src/retention-context.js",
  "apps/kcoder-studio/src/mobile-device-auth.js",
  "apps/kcoder-studio/src/mobile-device-private-storage.js",
  "apps/kcoder-studio/src/server-config.js",
  "apps/kcoder-studio/src/runtime-target-adapter.js",
  "apps/kcoder-studio/src/gateway-channel.js",
  "apps/kcoder-studio/src/request-load.js",
  "apps/kcoder-studio/src/broker-request-budget.js",
  "apps/kcoder-studio/src/workspace-broker-release.js",
];

if (runnerOptions.contractCheck) {
  const valid = "a".repeat(64);
  assert.deepEqual(parseRunnerOptions([
    "node", "runner.mjs", ACCEPTED_SYNCING_FLAG,
    `${OFFICIAL_MOBILE_DIST_ROOT_FLAG}=/private/b0ec/mobile-web-bundle`,
    `${OFFICIAL_MOBILE_MANIFEST_SHA256_FLAG}=${valid}`,
  ]), {
    acceptedSyncing: true,
    contractCheck: false,
    officialMobileDistRoot: "/private/b0ec/mobile-web-bundle",
    officialMobileManifestSha256: valid,
  });
  assert.throws(() => parseRunnerOptions(["node", "runner.mjs", ACCEPTED_SYNCING_FLAG]), /requires both/);
  assert.throws(() => parseRunnerOptions([
    "node", "runner.mjs", ACCEPTED_SYNCING_FLAG,
    `${OFFICIAL_MOBILE_DIST_ROOT_FLAG}=/private/b0ec/mobile-web-bundle`,
    `${OFFICIAL_MOBILE_MANIFEST_SHA256_FLAG}=not-a-sha`,
  ]), /64 lowercase hexadecimal/);
  assert.throws(() => parseRunnerOptions([
    "node", "runner.mjs", ACCEPTED_SYNCING_FLAG, ACCEPTED_SYNCING_FLAG,
    `${OFFICIAL_MOBILE_DIST_ROOT_FLAG}=/private/b0ec/mobile-web-bundle`,
    `${OFFICIAL_MOBILE_MANIFEST_SHA256_FLAG}=${valid}`,
  ]), /may only appear once/);
} else await runE2E(import.meta.url, {
  testId: useAcceptedSyncing
    ? "mobile-send-accepted-syncing-reload-check-only"
    : useCurrentArchive
      ? "mobile-send-recovery-asyncstorage-current-archived-bundle"
      : "mobile-send-recovery-asyncstorage-web-174d-once",
  tier: "full-integration",
  modelPolicy: useAcceptedSyncing
    ? "ACCEPTED_SYNCING_CHECK_ONLY_FUNCTIONAL: explicit official Mobile static dist, frozen local Gateway/app-server, loopback deterministic Provider; accepted receipt/history recovery only, no transport-loss or external Provider claim"
    : useCurrentArchive
      ? "CURRENT_ARCHIVED_BUNDLE_FUNCTIONAL: mounted archived Mobile Web, frozen local Gateway/app-server, loopback deterministic Provider; not full current Git source provenance or external Provider evidence"
      : "mounted Mobile Web, real local Gateway/app-server, loopback deterministic Provider; no external Provider or model-quality claim",
  processSignalTimeoutMs: 5_000,
}, async context => {
  const processTempDir = context.pathInState("process-tmp");
  await mkdir(processTempDir, { recursive: false, mode: 0o700 });
  context.registerTemporaryDirectory("private process temp", processTempDir);
  for (const name of ["TMPDIR", "TMP", "TEMP"]) process.env[name] = processTempDir;

  const currentArchive = useCurrentArchive ? await inspectCurrentArchivedMobileWeb() : null;
  const currentGatewayRuntime = useCurrentGateway ? await validateCurrentArchivedGateway() : null;
  const pins = useCurrentGateway ? null : readRequiredPins();
  const inputEvidence = useAcceptedSyncing
    ? await verifyAcceptedSyncingInputs(runnerOptions, currentGatewayRuntime)
    : useCurrentArchive
      ? await verifyCurrentArchivedInputs(currentArchive, currentGatewayRuntime)
      : await verifyPinnedInputs(pins);
  inputEvidence.privateProcessTempDirectory = "state/process-tmp";
  if (!useCurrentArchive && !useAcceptedSyncing) await context.writeArtifactJson("input-preflight.json", inputEvidence);

  const binary = useCurrentGateway
    ? { path: currentGatewayRuntime.binaryPath, sha256: currentGatewayRuntime.binarySha256 }
    : await hashExecutableFile(pins.kcoderBinary);
  if (!useCurrentGateway)
    assert.equal(binary.sha256, pins.kcoderSha256, "the local app-server binary must match its explicit immutable pin");
  const mobileWeb = useAcceptedSyncing
    ? await materializeExplicitOfficialMobileWeb(context, runnerOptions)
    : useCurrentArchive
      ? await materializeCurrentArchivedMobileWeb(context, currentArchive)
      : await materializeLegacyMobileWeb(context, pins);
  const staticManifest = mobileWeb.staticManifest;
  if (useCurrentArchive || useAcceptedSyncing) {
    inputEvidence.ownedMobileDist = useAcceptedSyncing
      ? await verifyExplicitOwnedMobileDist(mobileWeb, runnerOptions.officialMobileManifestSha256)
      : await verifyCurrentOwnedMobileDist(mobileWeb, currentArchive);
    await context.writeArtifactJson("input-preflight.json", inputEvidence);
  }

  const workspace = (await materializeWorkspace(context, "git-history", {
    instanceId: "send-recovery-174d-workspace",
  })).path;
  const configDir = context.pathInState("private-config");
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  const model = await startApprovalModelFixture(context, {
    textOnly: true,
    textOnlyResponse: FIXTURE_REPLY,
  });
  const providerKey = "send-recovery-174d-loopback-key";
  context.registerSecret(providerKey);
  const settingsFile = await context.writeStateJson("provider-settings.json", {
    active_provider: "send-recovery-174d-loopback",
    permission_mode: "yolo",
    hooks: {},
    providers: {
      "send-recovery-174d-loopback": {
        api_format: "openai_chat_completions",
        endpoint: model.baseUrl,
        default_model: "send-recovery-174d-loopback-model",
        context_window_tokens: 128_000,
        output_headroom_tokens: 8_192,
        max_output_tokens: 256,
        request_timeout_secs: 30,
        no_proxy: true,
        extra_body: {},
      },
    },
  });
  await context.writeStateJson("private-config/settings.json", {});
  await context.writeStateJson("private-config/credentials.json", {
    "send-recovery-174d-loopback": { type: "api", key: providerKey },
  });
  const serversFile = await context.writeStateJson("servers.json", [{
    id: SERVER_ID,
    label: SERVER_LABEL,
    runtime: "kcoder",
    transport: "local",
    workspacePath: workspace,
    command: binary.path,
    settingsFile,
  }]);
  const gatewayOptions = {
    auth: true,
    label: useCurrentGateway ? "send-recovery-current-archive-gateway" : "send-recovery-174d-gateway",
    workspace,
    serversFile,
    kcoderBin: binary.path,
    env: {
      KCODER_CONFIG_DIR: configDir,
      KCODER_STUDIO_WEB_ROOT: "",
      KCODER_STUDIO_MOBILE_WEB_ROOT: mobileWeb.path,
    },
  };
  if (useCurrentGateway) {
    gatewayOptions.gatewayRoot = currentGatewayRuntime.root;
    gatewayOptions.cwd = currentGatewayRuntime.root;
  }
  const gateway = await startGateway(context, gatewayOptions);
  const chromiumTemp = await createShortChromiumTemp(context);
  const chromium = await startChromium(context, {
    label: useCurrentGateway ? "send-recovery-current-archive-chromium" : "send-recovery-174d-chromium",
    ...(useCurrentGateway ? { executablePath: CURRENT_CHROMIUM.path } : {}),
    env: {
      TMPDIR: chromiumTemp.path,
      TMP: chromiumTemp.path,
      TEMP: chromiumTemp.path,
    },
  });
  if (useCurrentGateway)
    assert.equal(await chromium.browser.version(), CURRENT_CHROMIUM.version, "the current archive run must use the pinned CFT build");
  const browserContext = await chromium.browser.newContext({ viewport: { width: 390, height: 844 }, locale: "zh-CN" });
  const page = await browserContext.newPage();
  const trace = installRpcTrace(page, workspace);
  const storageGate = await installRecoveryWriteGate(page);

  let result;
  try {
    const profileId = await connectMobile(page, gateway);
    await openNewWorkspaceForm(page, gateway, profileId, workspace, trace, context);
    await page.getByTestId("new-workspace-prompt").fill(SEED_PROMPT);
    await page.getByTestId("create-workspace").click();
    await page.getByTestId("message-user").filter({ hasText: SEED_PROMPT })
      .waitFor({ state: "visible", timeout: 30_000 });
    const threadId = taskIdFromUrl(page.url());
    assert.ok(threadId, "the mounted New Task flow must enter a real task route");
    await waitFor(() => trace.notifications.some(row => row.method === "turn/completed" && row.threadId === threadId),
      45_000, "the deterministic seed turn to complete on the actual app-server", 25, context.abortSignal);

    const composer = page.getByTestId("message-input");
    await composer.waitFor({ state: "visible", timeout: 30_000 });
    await composer.fill(SUBMITTED_PROMPT);
    const stateKey = await waitFor(
      () => readThreadState(page, { profileId, threadId, expectedDraft: SUBMITTED_PROMPT }),
      15_000,
      "the original draft to reach the real scoped AsyncStorage Web key before submit",
      25,
      context.abortSignal,
    );
    await storageGate.arm({ profileId, serverId: SERVER_ID, threadId, content: SUBMITTED_PROMPT });
    const startCountBeforeSubmit = trace.turnStarts.length;
    await page.getByTestId("send-message").click();

    await waitFor(() => storageGate.calls === 1 ? true : null, 15_000,
      "the first exact recovery-row workspace-state write to reach the AsyncStorage gate", 10,
      context.abortSignal);
    assert.equal(storageGate.key, stateKey.key, "recovery write must use the current task's exact scoped workspace key");
    assert.equal(storageGate.calls, 1, "exactly one first recovery write must be held");
    assert.match(storageGate.clientMessageId, /^[A-Za-z0-9._:-]{1,160}$/,
      "the held durable row must contain the stable composer message ID");

    const pendingCard = page.getByTestId("failed-submission").filter({ hasText: SUBMITTED_PROMPT });
    await pendingCard.waitFor({ state: "visible", timeout: 5_000 });
    assert.equal(await pendingCard.getByTestId("failed-submission-content").innerText(), SUBMITTED_PROMPT,
      "the original text must remain visible in the preparing recovery card");
    assert.equal(await pendingCard.getByTestId("retry-failed-submission").isDisabled(), true,
      "a preparing recovery item must not be manually dispatched while its durable write is held");
    assert.equal(await page.evaluate(() => window.__e2eRecoveryWriteGate.isPending()), true,
      "the mounted AsyncStorage-backed write promise must still be pending");
    const preReleaseState = await readStoredState(page, storageGate.key, SUBMITTED_PROMPT, storageGate.clientMessageId);
    assert.equal(preReleaseState.originalDraftStillStored, true,
      "the prior draft remains durable until the recovery write commits");
    assert.equal(preReleaseState.recoveryRowAlreadyStored, false,
      "the matching recovery row must not appear in the underlying synchronous localStorage before release");
    assert.equal(trace.turnStarts.length, startCountBeforeSubmit,
      "no turn/start may be sent before the held recovery write succeeds");

    await composer.fill(REVISED_DRAFT);
    await page.waitForTimeout(400);
    assert.equal(await composer.inputValue(), REVISED_DRAFT,
      "a newer composer revision typed during the pending recovery write must remain visible");
    assert.equal(await page.evaluate(() => window.__e2eRecoveryWriteGate.isPending()), true,
      "editing the composer must not release the original recovery write");
    assert.equal(trace.turnStarts.length, startCountBeforeSubmit,
      "the newer draft must not cause a premature or second turn/start");

    storageGate.release();
    await waitFor(() => trace.turnStarts.some(row => row.clientMessageId === storageGate.clientMessageId),
      30_000, "the exact stable-ID turn/start after the recovery write is released", 25,
      context.abortSignal);
    const matchingStarts = trace.turnStarts.filter(row => row.clientMessageId === storageGate.clientMessageId);
    assert.equal(matchingStarts.length, 1, "the held recovery ID must be dispatched exactly once");
    assert.equal(matchingStarts[0].threadId, threadId, "the recovered message must remain owned by the mounted task");
    assert.equal(matchingStarts[0].textSha256, sha256(SUBMITTED_PROMPT),
      "the released turn/start must carry the original submitted text");
    await waitFor(() => matchingStarts[0].responseStatus === "success" && matchingStarts[0].turnId
      ? true : null, 15_000,
    "the exact turn/start response to provide its authoritative turn ID", 10, context.abortSignal);
    assert.equal(trace.turnStarts.length, startCountBeforeSubmit + 1,
      "the send must add exactly one turn/start to the actual task runtime");
    await waitFor(() => trace.notifications.filter(row => row.method === "turn/completed" && row.threadId === threadId).length >= 2,
      45_000, "the actual app-server to complete the released send", 25, context.abortSignal);
    assert.equal(await composer.inputValue(), REVISED_DRAFT,
      "send completion must preserve the newer composer revision");
    await waitFor(
      async () => (await readStoredState(page, stateKey.key, REVISED_DRAFT, storageGate.clientMessageId)).newDraftStored,
      15_000,
      "the newer composer revision to persist after the held write is released",
      25,
      context.abortSignal,
    );
    assert.equal(await page.evaluate(() => window.__e2eRecoveryWriteGate.isSettled()), true,
      "the real storage write must finish after release");

    const acceptedSyncingEvidence = useAcceptedSyncing
      ? await runAcceptedSyncingReloadCheck(page, {
        trace,
        profileId,
        threadId,
        stateKey: stateKey.key,
        clientMessageId: storageGate.clientMessageId,
        content: SUBMITTED_PROMPT,
        expectedTurnId: matchingStarts[0].turnId,
        expectedAttemptId: matchingStarts[0].attemptId,
        initialMatchingTurnStartCount: trace.turnStarts.filter(row =>
          row.threadId === threadId && row.clientMessageId === storageGate.clientMessageId).length,
        context,
      })
      : null;

    result = {
      status: "PASS",
      ...(useAcceptedSyncing ? { evidenceClass: ACCEPTED_SYNCING_EVIDENCE } : {}),
      ...(useCurrentArchive ? { evidenceClass: CURRENT_ARCHIVED_BUNDLE_EVIDENCE } : {}),
      ...(useAcceptedSyncing || useCurrentArchive ? {} : { sourceCommit: EXPECTED_SOURCE_COMMIT }),
      ...(useAcceptedSyncing ? {
        officialMobileResourceTableSha256: mobileWeb.resourceTableSha256,
        officialMobileDistRoot: relative(repoRoot, runnerOptions.officialMobileDistRoot),
        acceptedSyncing: acceptedSyncingEvidence,
      } : {
        bundleSha256: mobileWeb.bundleSha256,
        bundleSourceTreeSha256: mobileWeb.sourceTreeSha256,
      }),
      bundleFileCount: mobileWeb.bundleFileCount,
      officialStaticManifestSha256: mobileWeb.staticManifestSha256,
      officialStaticManifestBytes: staticManifest.bytes.length,
      gatewayMountedPhysicalFileCount: mobileWeb.bundleFileCount + 1,
      threadIdSha256: sha256(threadId),
      workspaceStateKeySha256: sha256(storageGate.key),
      recoveryMessageIdSha256: sha256(storageGate.clientMessageId),
      submittedTextSha256: sha256(SUBMITTED_PROMPT),
      revisedDraftSha256: sha256(REVISED_DRAFT),
      preparingCardVisibleWhileAsyncStoragePending: true,
      originalTextRetainedBeforeRelease: true,
      zeroTurnStartBeforeRelease: true,
      stableRecoveryIdDispatchedOnce: true,
      newerComposerRevisionPreservedAndSaved: true,
      storageMode: "real mounted AsyncStorage Web 2.2.0 over window.localStorage; one exact recovery-row write held at the underlying Storage boundary",
      providerBoundary: "loopback deterministic fixture only",
      ...(useCurrentGateway ? {
        ...(useCurrentArchive ? { sourceClaim: currentArchive.sourceClaim, noFullCurrentGitSourceClaim: true } : {
          sourceClaim: "explicit official Mobile static dist selected by CLI root and manifest SHA; this runner does not assert source or export receipt provenance",
          noFullCurrentGitSourceClaim: true,
        }),
        gatewayRuntimeManifestSha256: currentGatewayRuntime.manifestSha256,
        gatewayRuntimeSourceSha256: currentGatewayRuntime.sourceTreeSha256,
        gatewayRuntimeDependencySha256: currentGatewayRuntime.dependencyTreeSha256,
        gatewayBinarySha256: binary.sha256,
        rustBinaryExecuted: true,
      } : {}),
    };
    if (!useCurrentArchive && !useAcceptedSyncing) {
      await context.writeArtifactJson("mounted-send-recovery-result.json", result);
      return result;
    }
  } finally {
    trace.releaseHeldHistoryResponses();
    storageGate.release();
    await browserContext.close();
  }
  if (useCurrentArchive) {
    const archiveAfter = await inspectCurrentArchivedMobileWeb();
    const inputsAfter = await verifyCurrentArchivedInputs(
      archiveAfter,
      await validateCurrentArchivedGateway(),
    );
    inputsAfter.privateProcessTempDirectory = "state/process-tmp";
    inputsAfter.ownedMobileDist = await verifyCurrentOwnedMobileDist(mobileWeb, archiveAfter);
    assert.deepEqual(inputsAfter, inputEvidence, "frozen Mobile archive, AsyncStorage, Gateway, and executable inputs changed during the run");
    await context.writeArtifactJson("input-postflight.json", inputsAfter);
    await context.writeArtifactJson("mounted-send-recovery-result.json", result);
    return result;
  } else if (useAcceptedSyncing) {
    const inputsAfter = await verifyAcceptedSyncingInputs(runnerOptions, await validateCurrentArchivedGateway());
    inputsAfter.privateProcessTempDirectory = "state/process-tmp";
    inputsAfter.ownedMobileDist = await verifyExplicitOwnedMobileDist(
      mobileWeb,
      runnerOptions.officialMobileManifestSha256,
    );
    assert.deepEqual(inputsAfter, inputEvidence,
      "explicit official Mobile dist, AsyncStorage, frozen Gateway, and executable inputs changed during the run");
    await context.writeArtifactJson("input-postflight.json", inputsAfter);
    await context.writeArtifactJson("mounted-send-recovery-result.json", result);
    return result;
  }
});

function parseRunnerOptions(argv) {
  const args = argv.slice(2);
  const countFlag = flag => args.filter(value => value === flag).length;
  const acceptedCount = countFlag(ACCEPTED_SYNCING_FLAG);
  const contractCount = countFlag(ACCEPTED_SYNCING_CONTRACT_FLAG);
  assert.ok(acceptedCount <= 1, `${ACCEPTED_SYNCING_FLAG} may only appear once`);
  assert.ok(contractCount <= 1, `${ACCEPTED_SYNCING_CONTRACT_FLAG} may only appear once`);

  const readValue = flag => {
    const matches = [];
    for (let index = 0; index < args.length; index += 1) {
      const value = args[index];
      if (value === flag) {
        const next = args[index + 1];
        assert.ok(typeof next === "string" && next.length > 0 && !next.startsWith("--"),
          `${flag} requires a value`);
        matches.push(next);
      } else if (typeof value === "string" && value.startsWith(`${flag}=`)) {
        matches.push(value.slice(flag.length + 1));
      }
    }
    assert.ok(matches.length <= 1, `${flag} may only appear once`);
    return matches[0] ?? null;
  };

  const officialMobileDistRoot = readValue(OFFICIAL_MOBILE_DIST_ROOT_FLAG);
  const officialMobileManifestSha256 = readValue(OFFICIAL_MOBILE_MANIFEST_SHA256_FLAG);
  const acceptedSyncing = acceptedCount === 1;
  assert.equal(acceptedSyncing, officialMobileDistRoot !== null && officialMobileManifestSha256 !== null,
    `${ACCEPTED_SYNCING_FLAG} requires both explicit official Mobile dist inputs`);
  if (acceptedSyncing) {
    assert.equal(resolve(officialMobileDistRoot), officialMobileDistRoot,
      `${OFFICIAL_MOBILE_DIST_ROOT_FLAG} must be a normalized absolute path`);
    assert.match(officialMobileManifestSha256, /^[a-f0-9]{64}$/,
      `${OFFICIAL_MOBILE_MANIFEST_SHA256_FLAG} must be 64 lowercase hexadecimal characters`);
  }
  assert.ok(contractCount === 0 || (!acceptedSyncing && officialMobileDistRoot === null),
    `${ACCEPTED_SYNCING_CONTRACT_FLAG} cannot be combined with run inputs`);
  return {
    acceptedSyncing,
    contractCheck: contractCount === 1,
    officialMobileDistRoot,
    officialMobileManifestSha256,
  };
}

async function verifyAcceptedSyncingInputs(options, gatewayRuntime) {
  const officialDist = await inspectOfficialMobileStaticDist({
    distRoot: options.officialMobileDistRoot,
    expectedManifestSha256: options.officialMobileManifestSha256,
  });
  const asyncStorageSource = await hashFiles(ASYNC_STORAGE_PINS);
  const packageJson = JSON.parse(await readFile(resolve(repoRoot,
    "apps/kcoder-studio/mobile/node_modules/@react-native-async-storage/async-storage/package.json"), "utf8"));
  const chromium = await hashExecutableFile(CURRENT_CHROMIUM.path);
  const playwrightPackage = JSON.parse(await readFile(resolve(repoRoot,
    "apps/kcoder-studio/renderer/node_modules/@playwright/test/package.json"), "utf8"));
  assert.equal(asyncStorageSource.allMatch, true,
    "installed AsyncStorage Web implementation changed from its explicit pins");
  assert.equal(packageJson.version, "2.2.0", "the actual AsyncStorage Web implementation must remain version 2.2.0");
  assert.equal(chromium.sha256, CURRENT_CHROMIUM.sha256, "the pinned CFT executable changed");
  assert.equal(playwrightPackage.version, CURRENT_CHROMIUM.playwrightTestVersion,
    "the Playwright runner version changed");
  return {
    status: "PASS",
    evidenceClass: ACCEPTED_SYNCING_EVIDENCE,
    mobileDist: {
      root: relative(repoRoot, officialDist.distRoot),
      manifestSha256: officialDist.manifestSha256,
      manifestSize: officialDist.manifestSize,
      resourceCount: officialDist.resourceCount,
      resourceTableSha256: officialDist.resourceTableSha256,
    },
    asyncStorage: { version: packageJson.version, files: asyncStorageSource.files },
    chromium: {
      path: relative(repoRoot, CURRENT_CHROMIUM.path),
      sha256: chromium.sha256,
      version: CURRENT_CHROMIUM.version,
      playwrightTestVersion: playwrightPackage.version,
    },
    gateway: {
      root: relative(repoRoot, gatewayRuntime.root),
      manifestSha256: gatewayRuntime.manifestSha256,
      sourceTreeSha256: gatewayRuntime.sourceTreeSha256,
      dependencyTreeSha256: gatewayRuntime.dependencyTreeSha256,
      binarySha256: gatewayRuntime.binarySha256,
      nodeVersion: gatewayRuntime.nodeVersion,
      mock: false,
      rustBinaryExecuted: true,
      providerBoundary: "loopback deterministic fixture only",
    },
  };
}

async function materializeExplicitOfficialMobileWeb(context, options) {
  const copied = await copyOfficialMobileStaticDist(context, {
    distRoot: options.officialMobileDistRoot,
    expectedManifestSha256: options.officialMobileManifestSha256,
    outputName: "accepted-syncing-official-mobile-static-dist",
  });
  assert.equal(copied.resourceCount, WEB_FILE_COUNT);
  assert.equal(copied.ownedCopyVerified, true);
  assert.equal(copied.sourceStableDuringCopy, true);
  const mountedManifestBytes = await readFile(copied.ownedManifestPath);
  assert.equal(sha256(mountedManifestBytes), options.officialMobileManifestSha256,
    "the copied official Mobile manifest must retain its explicit CLI pin");
  return {
    path: copied.ownedRoot,
    bundleFileCount: copied.resourceCount,
    staticManifest: { bytes: mountedManifestBytes },
    staticManifestSha256: copied.manifestSha256,
    resourceTableSha256: copied.resourceTableSha256,
    archiveCopy: copied,
  };
}

async function verifyExplicitOwnedMobileDist(mobileWeb, expectedManifestSha256) {
  const owned = await inspectOfficialMobileStaticDist({
    distRoot: mobileWeb.path,
    expectedManifestSha256,
  });
  assert.equal(owned.resourceCount, WEB_FILE_COUNT);
  assert.equal(owned.resourceTableSha256, mobileWeb.resourceTableSha256);
  assert.equal(mobileWeb.archiveCopy.sourceStableDuringCopy, true);
  assert.equal(mobileWeb.archiveCopy.ownedCopyVerified, true);
  return {
    ownedRoot: relative(repoRoot, mobileWeb.path),
    manifestSha256: owned.manifestSha256,
    resourceCount: owned.resourceCount,
    resourceTableSha256: owned.resourceTableSha256,
    sourceStableDuringCopy: mobileWeb.archiveCopy.sourceStableDuringCopy,
    ownedCopyVerified: mobileWeb.archiveCopy.ownedCopyVerified,
  };
}

async function materializeCurrentArchivedMobileWeb(context, archive) {
  const pins = {
    webStaticManifestPath: archive.manifestPath,
    webStaticManifestSha256: archive.officialManifestSha256,
  };
  const staticManifest = await verifyOfficialMobileStaticManifest(pins, archive.bundleFiles);
  const copied = await copyOfficialMobileStaticDist(context, {
    distRoot: archive.distRoot,
    expectedManifestSha256: archive.officialManifestSha256,
    outputName: "current-archived-mobile-static-dist",
  });
  assert.equal(copied.resourceCount, WEB_FILE_COUNT);
  assert.equal(copied.resourceTableSha256, archive.resourceTableSha256);
  assert.equal(copied.sourceStableDuringCopy, true);
  assert.equal(copied.ownedCopyVerified, true);
  const mountedManifestBytes = await readFile(copied.ownedManifestPath);
  assert.equal(sha256(mountedManifestBytes), archive.officialManifestSha256,
    "the exact archived official Gateway manifest bytes must be present in the owned mounted root");
  return {
    path: copied.ownedRoot,
    bundleSha256: archive.bundleSha256,
    sourceTreeSha256: archive.sourceTreeSha256,
    bundleFileCount: archive.resourceCount,
    bundleFiles: archive.bundleFiles,
    staticManifest,
    staticManifestSha256: archive.officialManifestSha256,
    archiveCopy: copied,
  };
}

async function materializeLegacyMobileWeb(context, pins) {
  const mobileWeb = await reuseMobileWebExport(context, {
    bundleRoot: pins.webBundleRoot,
    manifestPath: pins.webManifestPath,
    expectedSourceTreeSha256: pins.webSourceTreeSha256,
    expectedManifestSha256: pins.webManifestSha256,
    expectedBundleSha256: pins.webBundleSha256,
    expectedBundleFileCount: WEB_FILE_COUNT,
    label: "send-recovery-174d-mobile-web",
    outputName: "send-recovery-174d-mobile-web-owned",
  });
  const exportManifest = JSON.parse(await readFile(mobileWeb.sourceManifestPath, "utf8"));
  assert.equal(exportManifest.sourceCommit, EXPECTED_SOURCE_COMMIT,
    "mounted bundle must come from the exact 174d source commit, not an older export");
  const staticManifest = await verifyOfficialMobileStaticManifest(pins, mobileWeb.bundleFiles);
  const mountedManifestPath = resolve(mobileWeb.path, MOBILE_STATIC_MANIFEST);
  await writeFile(mountedManifestPath, staticManifest.bytes, { flag: "wx", mode: 0o600 });
  const mountedManifestBytes = await readFile(mountedManifestPath);
  assert.equal(sha256(mountedManifestBytes), pins.webStaticManifestSha256,
    "the exact official Gateway manifest bytes must be present in the owned mounted root");
  return { ...mobileWeb, staticManifest, staticManifestSha256: pins.webStaticManifestSha256 };
}

async function verifyCurrentArchivedInputs(archive, gatewayRuntime) {
  assert.equal(archive.evidenceClass, CURRENT_ARCHIVED_BUNDLE_EVIDENCE);
  assert.equal(archive.builderCommitIsNotCurrentSourceClaim, true);
  const asyncStorageSource = await hashFiles(ASYNC_STORAGE_PINS);
  const packageJson = JSON.parse(await readFile(resolve(repoRoot,
    "apps/kcoder-studio/mobile/node_modules/@react-native-async-storage/async-storage/package.json"), "utf8"));
  const chromium = await hashExecutableFile(CURRENT_CHROMIUM.path);
  const playwrightPackage = JSON.parse(await readFile(resolve(repoRoot,
    "apps/kcoder-studio/renderer/node_modules/@playwright/test/package.json"), "utf8"));
  assert.equal(asyncStorageSource.allMatch, true, "installed AsyncStorage Web implementation changed from its explicit pins");
  assert.equal(packageJson.version, "2.2.0", "the actual AsyncStorage Web implementation must remain version 2.2.0");
  assert.equal(chromium.sha256, CURRENT_CHROMIUM.sha256, "the current archive run Chromium executable changed");
  assert.equal(playwrightPackage.version, CURRENT_CHROMIUM.playwrightTestVersion, "the Playwright runner version changed");
  return {
    status: "PASS",
    evidenceClass: archive.evidenceClass,
    sourceClaim: archive.sourceClaim,
    runnerSha256: sha256(await readFile(new URL(import.meta.url))),
    mobile: {
      sourceTreeSha256: archive.sourceTreeSha256,
      sourceRoots: archive.sourceRoots,
      dependencies: archive.dependencies,
      productPins: archive.productPins,
      archivedBuilderCommit: archive.archivedBuilderCommit,
      builderCommitIsNotCurrentSourceClaim: true,
    },
    web: {
      archiveRoot: archive.archiveRelativeRoot,
      receiptSha256: archive.receiptSha256,
      promotionSha256: archive.promotionSha256,
      exporterManifestSha256: archive.exporterManifestSha256,
      sourceBeforeAfterSha256: archive.sourceBeforeAfterSha256,
      bundleSha256: archive.bundleSha256,
      officialManifestSha256: archive.officialManifestSha256,
      resourceCount: archive.resourceCount,
      resourceTableSha256: archive.resourceTableSha256,
    },
    asyncStorage: { version: packageJson.version, files: asyncStorageSource.files },
    chromium: {
      path: relative(repoRoot, CURRENT_CHROMIUM.path),
      sha256: chromium.sha256,
      version: CURRENT_CHROMIUM.version,
      playwrightTestVersion: playwrightPackage.version,
    },
    gateway: {
      root: relative(repoRoot, gatewayRuntime.root),
      manifestSha256: gatewayRuntime.manifestSha256,
      sourceTreeSha256: gatewayRuntime.sourceTreeSha256,
      dependencyTreeSha256: gatewayRuntime.dependencyTreeSha256,
      binarySha256: gatewayRuntime.binarySha256,
      nodeVersion: gatewayRuntime.nodeVersion,
      mock: false,
      rustBinaryExecuted: true,
      providerBoundary: "loopback deterministic fixture only",
    },
  };
}

async function verifyCurrentOwnedMobileDist(mobileWeb, archive) {
  const owned = await inspectOfficialMobileStaticDist({
    distRoot: mobileWeb.path,
    expectedManifestSha256: archive.officialManifestSha256,
  });
  assert.equal(owned.resourceCount, WEB_FILE_COUNT);
  assert.equal(owned.resourceTableSha256, archive.resourceTableSha256);
  assert.equal(mobileWeb.archiveCopy.sourceStableDuringCopy, true);
  assert.equal(mobileWeb.archiveCopy.ownedCopyVerified, true);
  return {
    ownedRoot: relative(repoRoot, mobileWeb.path),
    manifestSha256: owned.manifestSha256,
    resourceCount: owned.resourceCount,
    resourceTableSha256: owned.resourceTableSha256,
    sourceStableDuringCopy: mobileWeb.archiveCopy.sourceStableDuringCopy,
    ownedCopyVerified: mobileWeb.archiveCopy.ownedCopyVerified,
  };
}

async function verifyPinnedInputs(pins) {
  const mobileSource = hashGitCommitFiles(MOBILE_SOURCE_PINS, EXPECTED_SOURCE_COMMIT);
  const asyncStorageSource = await hashFiles(ASYNC_STORAGE_PINS);
  const packageJson = JSON.parse(await readFile(resolve(repoRoot, "apps/kcoder-studio/mobile/node_modules/@react-native-async-storage/async-storage/package.json"), "utf8"));
  const mobileManifestBytes = await readFile(pins.webManifestPath);
  const mobileManifest = JSON.parse(mobileManifestBytes.toString("utf8"));
  const staticEvidence = await verifyOfficialMobileStaticManifest(pins, mobileManifest.files);
  const gatewaySources = await hashGatewaySources();
  assert.equal(mobileSource.allMatch, true, "174d Mobile source files changed from the reviewed pins");
  assert.equal(asyncStorageSource.allMatch, true, "installed AsyncStorage Web SDK changed from the reviewed pins");
  assert.equal(packageJson.version, "2.2.0", "the actual AsyncStorage Web implementation must remain version 2.2.0");
  assert.equal(mobileManifest.sourceCommit, EXPECTED_SOURCE_COMMIT,
    "the new bundle manifest must identify the exact 174d source commit");
  assert.equal(mobileManifest.sourceTreeSha256, pins.webSourceTreeSha256,
    "the new bundle manifest source digest must match its explicit pin");
  assert.equal(mobileManifest.bundleSha256, pins.webBundleSha256,
    "the new bundle manifest output digest must match its explicit pin");
  assert.equal(mobileManifest.bundleFileCount, WEB_FILE_COUNT,
    "the new bundle manifest must contain the pinned public resource count");
  assert.equal(sha256(mobileManifestBytes), pins.webManifestSha256,
    "the new bundle manifest must match its explicit SHA-256 pin");
  assert.equal(gatewaySources.aggregateSha256, pins.gatewaySourceSetSha256,
    "the local Gateway source set must match its explicit pin");
  return {
    status: "PASS",
    sourceCommit: EXPECTED_SOURCE_COMMIT,
    mobileSourceFiles: mobileSource.files,
    asyncStorage: { version: packageJson.version, files: asyncStorageSource.files },
    gatewaySourceCount: gatewaySources.files.length,
    gatewaySourceSetSha256: gatewaySources.aggregateSha256,
    webManifestSha256: pins.webManifestSha256,
    webBundleSha256: pins.webBundleSha256,
    webStaticManifestSha256: pins.webStaticManifestSha256,
    webSourceTreeSha256: pins.webSourceTreeSha256,
    webBundleFileCount: mobileManifest.bundleFileCount,
    webStaticManifest: {
      path: pins.webStaticManifestPath,
      sha256: staticEvidence.sha256,
      size: staticEvidence.size,
      version: staticEvidence.version,
      baseToken: staticEvidence.baseToken,
      fileCount: staticEvidence.fileCount,
      matchesE2eBundleTable: true,
    },
    oldBundleReusable: false,
  };
}

async function verifyOfficialMobileStaticManifest(pins, expectedBundleFiles) {
  const infoBefore = await lstat(pins.webStaticManifestPath);
  assert.ok(infoBefore.isFile() && !infoBefore.isSymbolicLink(),
    "official Gateway Mobile static manifest must be a regular file");
  assert.ok(infoBefore.size > 0 && infoBefore.size <= 4 * 1024 * 1024,
    "official Gateway Mobile static manifest must be within its 4 MiB limit");
  assert.equal(await realpath(pins.webStaticManifestPath), pins.webStaticManifestPath,
    "official Gateway Mobile static manifest path must not traverse a symlink");
  const bytes = await readFile(pins.webStaticManifestPath);
  const infoAfter = await lstat(pins.webStaticManifestPath);
  assert.ok(infoAfter.isFile() && !infoAfter.isSymbolicLink(),
    "official Gateway Mobile static manifest must remain a regular file");
  assert.equal(infoAfter.dev, infoBefore.dev, "official Gateway Mobile static manifest device changed while reading");
  assert.equal(infoAfter.ino, infoBefore.ino, "official Gateway Mobile static manifest identity changed while reading");
  assert.equal(infoAfter.size, infoBefore.size, "official Gateway Mobile static manifest size changed while reading");
  assert.equal(bytes.length, infoBefore.size, "official Gateway Mobile static manifest changed while reading");
  const digest = sha256(bytes);
  assert.equal(digest, pins.webStaticManifestSha256,
    "official Gateway Mobile static manifest must match its explicit SHA-256 pin");

  let manifest;
  try {
    manifest = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("official Gateway Mobile static manifest is not valid JSON");
  }
  assert.ok(manifest && typeof manifest === "object" && !Array.isArray(manifest),
    "official Gateway Mobile static manifest must be an object");
  assert.equal(manifest.version, 1, "official Gateway Mobile static manifest version must be 1");
  assert.equal(manifest.baseToken, MOBILE_STATIC_BASE_TOKEN,
    "official Gateway Mobile static manifest must use the mounted base token");
  assert.ok(Array.isArray(manifest.files) && manifest.files.length === WEB_FILE_COUNT,
    `official Gateway Mobile static manifest must list exactly ${WEB_FILE_COUNT} resources`);
  const officialRows = manifest.files.map(row => {
    assert.ok(row && typeof row === "object" && !Array.isArray(row),
      "official Gateway Mobile resource row must be an object");
    assert.ok(typeof row.path === "string" && row.path.length > 0 && !row.path.startsWith("/")
      && !row.path.includes("\\") && !row.path.split("/").some(part => !part || part === "." || part === ".."),
    "official Gateway Mobile resource path must be normalized and relative");
    assert.ok(Number.isSafeInteger(row.size) && row.size >= 0,
      "official Gateway Mobile resource size must be a non-negative safe integer");
    assert.match(row.sha256, /^[a-f0-9]{64}$/,
      "official Gateway Mobile resource digest must be a SHA-256 hex string");
    assert.equal(typeof row.text, "boolean", "official Gateway Mobile resource text flag must be boolean");
    assert.ok(Number.isSafeInteger(row.replacements) && row.replacements >= 0,
      "official Gateway Mobile base-token replacement count must be a non-negative integer");
    assert.ok(row.text || row.replacements === 0,
      "binary official Gateway resources cannot require base-token replacements");
    return { path: row.path, size: row.size, sha256: row.sha256 };
  });
  assert.equal(new Set(officialRows.map(row => row.path)).size, officialRows.length,
    "official Gateway resource table cannot contain duplicate paths");
  const sortByPath = rows => [...rows].sort((left, right) => left.path.localeCompare(right.path));
  assert.deepEqual(sortByPath(officialRows), sortByPath(expectedBundleFiles),
    "official Gateway manifest resource rows must exactly match the retained E2E bundle table");
  assert.ok(manifest.files.some(row => row.path === "index.html"),
    "official Gateway Mobile static manifest must include index.html");
  assert.ok(manifest.files.some(row => row.replacements > 0),
    "official Gateway Mobile static manifest must record base-token replacements");

  return {
    bytes,
    sha256: digest,
    size: bytes.length,
    version: manifest.version,
    baseToken: manifest.baseToken,
    fileCount: manifest.files.length,
  };
}

function readRequiredPins() {
  const pins = {
    kcoderBinary: requiredPath("KCODER_E2E_KCODER_BIN"),
    kcoderSha256: requiredSha256("KCODER_E2E_EXPECTED_KCODER_SHA256"),
    webBundleRoot: requiredPath("KCODER_E2E_SEND_RECOVERY_WEB_BUNDLE_ROOT"),
    webManifestPath: requiredPath("KCODER_E2E_SEND_RECOVERY_WEB_MANIFEST"),
    webStaticManifestPath: requiredPath("KCODER_E2E_SEND_RECOVERY_MOBILE_STATIC_MANIFEST"),
    webSourceTreeSha256: requiredSha256("KCODER_E2E_SEND_RECOVERY_WEB_SOURCE_TREE_SHA256"),
    webManifestSha256: requiredSha256("KCODER_E2E_SEND_RECOVERY_WEB_MANIFEST_SHA256"),
    webBundleSha256: requiredSha256("KCODER_E2E_SEND_RECOVERY_WEB_BUNDLE_SHA256"),
    webStaticManifestSha256: requiredSha256("KCODER_E2E_SEND_RECOVERY_MOBILE_STATIC_MANIFEST_SHA256"),
    gatewaySourceSetSha256: requiredSha256("KCODER_E2E_SEND_RECOVERY_GATEWAY_SOURCE_SET_SHA256"),
  };
  const missing = Object.entries(pins).filter(([, value]) => !value).map(([name]) => name);
  if (missing.length) throw new Error(`UNMET_PREREQUISITE: missing exact 174d/mobile SDK input pins: ${missing.join(", ")}`);
  if (resolve(pins.webBundleRoot) !== pins.webBundleRoot || resolve(pins.webManifestPath) !== pins.webManifestPath
      || resolve(pins.webStaticManifestPath) !== pins.webStaticManifestPath)
    throw new Error("UNMET_PREREQUISITE: Mobile Web bundle and manifest paths must be normalized absolute paths");
  return pins;
}

async function hashFiles(expected) {
  const files = [];
  let allMatch = true;
  for (const [relativePath, expectedSha256] of Object.entries(expected)) {
    const path = resolve(repoRoot, relativePath);
    const bytes = await readFile(path);
    const actualSha256 = sha256(bytes);
    allMatch &&= actualSha256 === expectedSha256;
    files.push({ path: relativePath, sha256: actualSha256, expectedSha256, size: bytes.length });
  }
  return { allMatch, files };
}

function hashGitCommitFiles(expected, commit) {
  const resolvedCommit = execFileSync("git", ["rev-parse", `${commit}^{commit}`], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  assert.equal(resolvedCommit, commit, "the exact frozen Mobile source commit must be available in the local Git object database");
  const files = [];
  let allMatch = true;
  for (const [relativePath, expectedSha256] of Object.entries(expected)) {
    const bytes = execFileSync("git", ["show", `${commit}:${relativePath}`], {
      cwd: repoRoot,
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const actualSha256 = sha256(bytes);
    allMatch &&= actualSha256 === expectedSha256;
    files.push({ path: relativePath, sourceCommit: commit, sha256: actualSha256, expectedSha256, size: bytes.length });
  }
  return { sourceCommit: commit, allMatch, files };
}

async function hashGatewaySources() {
  const files = [];
  for (const relativePath of GATEWAY_SOURCE_PATHS) {
    const bytes = await readFile(resolve(repoRoot, relativePath));
    files.push({ path: relativePath, sha256: sha256(bytes), size: bytes.length });
  }
  return {
    files,
    aggregateSha256: sha256(files.map(file => `${file.path}\0${file.sha256}\n`).join("")),
  };
}

function requiredPath(name) {
  const value = process.env[name]?.trim();
  return value && resolve(value) === value ? value : null;
}

function requiredSha256(name) {
  const value = process.env[name]?.trim();
  return value && /^[a-f0-9]{64}$/.test(value) ? value : null;
}

async function connectMobile(page, gateway) {
  const mobileUrl = new URL("/mobile/", gateway.baseUrl);
  const entryResponse = await fetch(new URL("/mobile-entry", gateway.baseUrl), {
    headers: { accept: "application/json" },
  });
  assert.equal(entryResponse.status, 200, "the official Gateway Mobile entry must be available");
  const entry = await entryResponse.json();
  assert.equal(entry.available, true, "the Gateway must load its verified Mobile static manifest");
  assert.equal(entry.version, 1, "the official Gateway Mobile entry contract must be version 1");
  assert.equal(entry.mobileUrl, mobileUrl.toString(), "the Gateway must advertise the official /mobile/ mount");
  assert.equal(entry.gatewayUrl, gateway.baseUrl, "the Mobile entry must advertise this exact owned Gateway origin");
  const navigation = await page.goto(mobileUrl.toString(), { waitUntil: "domcontentloaded" });
  assert.equal(navigation?.status(), 200, "the official Gateway /mobile/ mount must serve the exported app");
  assert.equal(new URL(page.url()).pathname, "/mobile/", "the mounted app must start at the Gateway's official Mobile path");
  await page.waitForSelector('[data-testid="welcome-direct-connection"]', { state: "visible", timeout: 30_000 });
  await page.getByTestId("welcome-direct-connection").click();
  await page.getByTestId("gateway-endpoint").fill(gateway.baseUrl);
  await page.getByTestId("gateway-token").fill(gateway.authToken);
  await page.getByTestId("gateway-connect").click();
  await page.getByTestId("new-workspace").waitFor({ state: "visible", timeout: 30_000 });
  const match = new URL(page.url()).pathname.match(/^\/mobile\/h\/([^/]+)/);
  assert.ok(match?.[1], "pairing must end on the actual authenticated Gateway profile route");
  return decodeURIComponent(match[1]);
}

async function captureOpenProjectSubmitDiagnostics(page, trace, workspace, context) {
  const safeCopy = value => context.redactText(String(value ?? ""))
    .replaceAll(resolve(workspace), "<run-owned-workspace>")
    .slice(0, 500);
  const visibleText = async locator => {
    try {
      if (!await locator.isVisible()) return null;
      return safeCopy(await locator.innerText());
    } catch {
      return null;
    }
  };
  const describeChoice = async locator => {
    try {
      const count = await locator.count();
      if (count !== 1) return { count };
      return await locator.evaluate(element => {
        const target = element.closest("button, [role='button']") ?? element.parentElement;
        const style = target ? getComputedStyle(target) : null;
        const classNames = [];
        for (let current = target, depth = 0; current && depth < 3; current = current.parentElement, depth += 1) {
          if (typeof current.className === "string" && current.className)
            classNames.push(current.className.slice(0, 240));
        }
        return {
          visible: element.getClientRects().length > 0,
          label: element.textContent?.trim().slice(0, 120) ?? null,
          targetTag: target?.tagName ?? null,
          ariaPressed: target?.getAttribute("aria-pressed") ?? null,
          ariaSelected: target?.getAttribute("aria-selected") ?? null,
          ariaDisabled: target?.getAttribute("aria-disabled") ?? null,
          classNames,
          backgroundColor: style?.backgroundColor ?? null,
          borderColor: style?.borderColor ?? null,
        };
      });
    } catch {
      return { visible: false };
    }
  };
  const directory = page.getByLabel("目录");
  let directoryState = { visible: false, editable: false, nonEmpty: false, matchesRunOwnedWorkspace: false };
  try {
    if (await directory.isVisible()) {
      const value = await directory.inputValue();
      directoryState = {
        visible: true,
        editable: await directory.isEditable(),
        nonEmpty: value.trim().length > 0,
        matchesRunOwnedWorkspace: value.trim().length > 0 && resolve(value) === resolve(workspace),
      };
    }
  } catch {}
  const submit = page.getByRole("button", { name: "打开项目", exact: true });
  let submitState = { visible: false, enabled: false, ariaDisabled: null };
  try {
    if (await submit.isVisible()) {
      submitState = {
        visible: true,
        enabled: await submit.isEnabled(),
        ariaDisabled: await submit.getAttribute("aria-disabled"),
      };
    }
  } catch {}
  const modeLabels = ["选择现有目录", "新建目录", "新建 Git worktree"];
  const modes = [];
  for (const label of modeLabels)
    modes.push(await describeChoice(page.getByText(label, { exact: true })));

  return {
    status: "open-project-submit-not-ready",
    pathname: new URL(page.url()).pathname,
    routeVisible: await page.getByTestId("open-project-route").isVisible().catch(() => false),
    submit: submitState,
    directory: directoryState,
    selectedServer: await describeChoice(page.getByText(SERVER_LABEL, { exact: true })),
    modes,
    readinessCopy: {
      openProjectError: await visibleText(page.getByTestId("open-project-error")),
      deliveryError: await visibleText(page.getByTestId("workspace-open-delivery-error")),
      catalogRetry: await visibleText(page.getByTestId("retry-open-project-catalogs")),
      switchingGateway: await visibleText(page.getByText("正在切换 Gateway…", { exact: true })),
      registeredProjectsHeader: await visibleText(page.getByText("已登记项目", { exact: true })),
      emptyRegisteredProjects: await visibleText(page.getByText("此服务器还没有登记项目，可直接输入目录。", { exact: true })),
      progressbarVisible: await page.getByRole("progressbar").isVisible().catch(() => false),
    },
    rpcEvents: trace.rpcDiagnostics.slice(-250),
    rpcEventsTruncated: trace.rpcDiagnostics.length > 250,
  };
}

async function openNewWorkspaceForm(page, gateway, profileId, workspace, trace, context) {
  const expectedWorkspace = resolve(workspace);
  const url = new URL("open-project", new URL("/mobile/", gateway.baseUrl));
  url.searchParams.set("profileId", profileId);
  await page.goto(url.toString(), { waitUntil: "domcontentloaded" });
  await page.getByTestId("open-project-route").waitFor({ state: "visible", timeout: 30_000 });
  await page.getByText(SERVER_LABEL, { exact: true }).click();
  const path = page.getByLabel("目录");
  await path.waitFor({ state: "visible", timeout: 30_000 });
  await path.fill(workspace);
  assert.equal(resolve(await path.inputValue()), expectedWorkspace,
    "the open-project form must submit the exact run-owned workspace path");
  const openButton = page.getByRole("button", { name: "打开项目", exact: true });
  try {
    await waitFor(() => openButton.isEnabled().then(enabled => enabled ? true : null), 30_000,
      "the Open Project action to become enabled after catalog and delivery state settle", 25, context.abortSignal);
    await openButton.click();
  } catch (error) {
    try {
      await context.writeArtifactJson("open-project-submit-diagnostics.json",
        await captureOpenProjectSubmitDiagnostics(page, trace, workspace, context));
    } catch (diagnosticError) {
      if (error instanceof Error)
        error.message += `; diagnostic capture failed: ${context.redactText(String(diagnosticError?.message ?? diagnosticError))}`;
    }
    throw error;
  }
  const workspacePath = page.getByTestId("workspace-path");
  const capture = async () => {
    const routeUrl = new URL(page.url());
    let visible = false;
    let editable = false;
    let value = null;
    try {
      visible = await workspacePath.isVisible();
      if (visible) {
        editable = await workspacePath.isEditable();
        value = await workspacePath.inputValue();
      }
    } catch {}
    const query = routeUrl.searchParams;
    const routedProfile = query.get("profileId");
    const routedServer = query.get("serverId");
    const routedCwd = query.get("cwd");
    const routedReceipt = query.get("operationReceiptId");
    const openRequest = trace.workspaceOperations.find(item =>
      item.direction === "request" && item.method === "runtime.workspaces.openV2");
    return {
      routePath: routeUrl.pathname,
      routeScopeSha256: sha256(JSON.stringify([profileId, SERVER_ID, expectedWorkspace])),
      expectedWorkspacePathSha256: sha256(expectedWorkspace),
      profileIdSha256: sha256(profileId),
      serverIdSha256: sha256(SERVER_ID),
      routeProfileMatches: routedProfile === profileId,
      routeServerMatches: routedServer === SERVER_ID,
      routeCwdMatchesOwnedWorkspace: routedCwd !== null && resolve(routedCwd) === expectedWorkspace,
      routeCwdSha256: routedCwd === null ? null : sha256(routedCwd),
      operationReceiptVersion: query.get("operationReceiptVersion"),
      operationKind: query.get("operationKind"),
      operationSourceMatchesOwnedWorkspace: query.get("operationSourcePath") !== null
        && resolve(query.get("operationSourcePath")) === expectedWorkspace,
      routeReceiptMatchesOpenRequest: Boolean(openRequest?.clientRequestIdSha256
        && routedReceipt && sha256(routedReceipt) === openRequest.clientRequestIdSha256),
      routeReceiptSha256: routedReceipt === null ? null : sha256(routedReceipt),
      workspaceFieldVisible: visible,
      workspaceFieldEditable: editable,
      workspaceFieldMatchesOwnedWorkspace: typeof value === "string" && resolve(value) === expectedWorkspace,
      workspaceFieldValueSha256: typeof value === "string" ? sha256(value) : null,
    };
  };
  let readiness = null;
  try {
    readiness = await waitFor(async () => {
      const current = await capture();
      return current.routePath === "/mobile/new"
        && current.routeProfileMatches
        && current.routeServerMatches
        && current.routeCwdMatchesOwnedWorkspace
        && current.operationReceiptVersion === "2"
        && current.operationKind === "open"
        && current.operationSourceMatchesOwnedWorkspace
        && current.routeReceiptMatchesOpenRequest
        && current.workspaceFieldVisible
        && current.workspaceFieldEditable
        && current.workspaceFieldMatchesOwnedWorkspace
        ? current
        : null;
    }, 45_000, "the New Task route and editable workspace field to hydrate from the confirmed V2 receipt", 50,
    context.abortSignal);
  } catch (error) {
    await context.writeArtifactJson("workspace-route-handoff.json", {
      status: "not-ready",
      expectedWorkspacePathSha256: sha256(expectedWorkspace),
      expectedScopeSha256: sha256(JSON.stringify([profileId, SERVER_ID, expectedWorkspace])),
      lastVisibleState: await capture(),
      workspaceOperationTrace: trace.workspaceOperations,
    });
    throw error;
  }

  const openRequests = trace.workspaceOperations.filter(item =>
    item.direction === "request" && item.method === "runtime.workspaces.openV2");
  const openResponses = trace.workspaceOperations.filter(item =>
    item.direction === "response" && item.method === "runtime.workspaces.openV2");
  await context.writeArtifactJson("workspace-route-handoff.json", {
    status: "ready",
    readiness,
    expectedWorkspacePathSha256: sha256(expectedWorkspace),
    expectedScopeSha256: sha256(JSON.stringify([profileId, SERVER_ID, expectedWorkspace])),
    openRequestCount: openRequests.length,
    openResponseCount: openResponses.length,
    openRequestPathMatchesOwnedWorkspace: openRequests[0]?.workspacePathMatchesOwnedWorkspace === true,
    openResponseReceiptPathMatchesOwnedWorkspace: openResponses[0]?.receiptPathMatchesOwnedWorkspace === true,
    openResponseResultPathMatchesOwnedWorkspace: openResponses[0]?.resultPathMatchesOwnedWorkspace === true,
    openResponseReceiptMatchesRequest: openResponses[0]?.receiptClientRequestIdMatchesRequest === true,
    workspaceOperationTrace: trace.workspaceOperations,
  });
  assert.equal(openRequests.length, 1, "the form handoff must issue exactly one app-server V2 open request");
  assert.equal(openResponses.length, 1, "the form handoff must receive exactly one app-server V2 open response");
  assert.equal(openRequests[0].workspacePathMatchesOwnedWorkspace, true,
    "the V2 open request must carry this run's exact workspace path");
  assert.equal(openResponses[0].receiptPathMatchesOwnedWorkspace, true,
    "the authoritative V2 receipt must return this run's exact workspace path");
  assert.equal(openResponses[0].resultPathMatchesOwnedWorkspace, true,
    "the V2 operation result must return this run's exact workspace path");
  assert.equal(openResponses[0].receiptClientRequestIdMatchesRequest, true,
    "the V2 receipt must bind to the one open request ID");
}

async function readThreadState(page, { profileId, threadId, expectedDraft }) {
  return page.evaluate(({ prefix, expectedProfile, serverId, expectedThread, expectedDraftValue }) => {
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (!key || !key.startsWith(`${prefix}:`)) continue;
      const parts = key.slice(prefix.length + 1).split(":");
      if (parts.length < 5 || parts[3] !== "scope") continue;
      let route;
      try { route = parts.slice(0, 3).map(decodeURIComponent); } catch { continue; }
      if (route[0] !== expectedProfile || route[1] !== serverId || route[2] !== expectedThread) continue;
      try {
        const value = JSON.parse(window.localStorage.getItem(key) ?? "null");
        if (value?.composerDraft === expectedDraftValue) return { key, draftMatches: true };
      } catch {}
    }
    return null;
  }, {
    prefix: STATE_PREFIX,
    expectedProfile: profileId,
    serverId: SERVER_ID,
    expectedThread: threadId,
    expectedDraftValue: expectedDraft,
  });
}

async function readStoredState(page, key, original, recoveryId) {
  return page.evaluate(({ stateKey, submitted, messageId, revised }) => {
    try {
      const value = JSON.parse(window.localStorage.getItem(stateKey) ?? "null");
      const rows = Array.isArray(value?.failedSubmissions) ? value.failedSubmissions : [];
      return {
        originalDraftStillStored: value?.composerDraft === submitted,
        recoveryRowAlreadyStored: rows.some(row => row?.id === messageId && row?.content === submitted),
        newDraftStored: value?.composerDraft === revised,
      };
    } catch {
      return { originalDraftStillStored: false, recoveryRowAlreadyStored: false, newDraftStored: false };
    }
  }, { stateKey: key, submitted: original, messageId: recoveryId, revised: REVISED_DRAFT });
}

async function addUnknownRecoveryFixture(page, {
  stateKey, profileId, serverId, threadId, clientMessageId, content, expectedDraft = REVISED_DRAFT,
}) {
  return page.evaluate(({ key, prefix, expectedProfile, expectedServer, expectedThreadId, id, message, draft }) => {
    try {
      if (!key.startsWith(`${prefix}:`)) return { stateFound: false };
      const parts = key.slice(prefix.length + 1).split(":");
      let route;
      try { route = parts.slice(0, 3).map(decodeURIComponent); } catch { return { stateFound: false }; }
      const scopedKeyMatches = parts.length >= 5 && parts[3] === "scope" &&
        route[0] === expectedProfile && route[1] === expectedServer && route[2] === expectedThreadId;
      const state = JSON.parse(window.localStorage.getItem(key) ?? "null");
      if (!state || typeof state !== "object" || Array.isArray(state)) return { stateFound: false, scopedKeyMatches };
      const rows = Array.isArray(state.failedSubmissions) ? state.failedSubmissions : [];
      if (rows.some(row => row?.id === id)) return { stateFound: true, scopedKeyMatches, duplicateId: true };
      const fixtureRow = {
        id,
        content: message,
        attachments: [],
        createdAt: Date.now(),
        outcome: "unknown",
      };
      state.failedSubmissions = [...rows, fixtureRow];
      window.localStorage.setItem(key, JSON.stringify(state));
      const written = JSON.parse(window.localStorage.getItem(key) ?? "null");
      const observedRows = Array.isArray(written?.failedSubmissions) ? written.failedSubmissions : [];
      const observed = observedRows.find(row => row?.id === id);
      return {
        stateFound: true,
        scopedKeyMatches,
        duplicateId: false,
        idMatches: observed?.id === id,
        contentMatches: observed?.content === message,
        outcomeIsUnknown: observed?.outcome === "unknown",
        acceptedTurnWasNotSeeded: !Object.hasOwn(observed ?? {}, "acceptedTurn"),
        attachmentsAreEmpty: Array.isArray(observed?.attachments) && observed.attachments.length === 0,
        composerDraftPreserved: written?.composerDraft === draft,
      };
    } catch {
      return { stateFound: false };
    }
  }, {
    key: stateKey,
    prefix: STATE_PREFIX,
    expectedProfile: profileId,
    expectedServer: serverId,
    expectedThreadId: threadId,
    id: clientMessageId,
    message: content,
    draft: expectedDraft,
  });
}

async function readRecoveryRowProjection(page, {
  stateKey, clientMessageId, content, threadId, turnId, attemptId, expectedDraft = REVISED_DRAFT,
}) {
  return page.evaluate(({ key, id, message, expectedThread, expectedTurn, expectedAttempt, draft }) => {
    try {
      const state = JSON.parse(window.localStorage.getItem(key) ?? "null");
      const rows = Array.isArray(state?.failedSubmissions) ? state.failedSubmissions : [];
      const row = rows.find(value => value?.id === id);
      const accepted = row?.acceptedTurn && typeof row.acceptedTurn === "object" ? row.acceptedTurn : null;
      const acceptedTurnMatches = Boolean(accepted && accepted.threadId === expectedThread &&
        accepted.turnId === expectedTurn &&
        (expectedAttempt === null || expectedAttempt === undefined || accepted.attemptId === expectedAttempt));
      return {
        rowFound: Boolean(row),
        rowIdMatches: row?.id === id,
        contentMatches: row?.content === message,
        outcome: row?.outcome ?? null,
        acceptedTurnPresent: accepted !== null,
        acceptedTurnMatches,
        acceptedTurnWasAbsent: row ? !Object.hasOwn(row, "acceptedTurn") : false,
        composerDraftPreserved: state?.composerDraft === draft,
      };
    } catch {
      return { rowFound: false, stateReadable: false };
    }
  }, {
    key: stateKey,
    id: clientMessageId,
    message: content,
    expectedThread: threadId,
    expectedTurn: turnId,
    expectedAttempt: attemptId,
    draft: expectedDraft,
  });
}

async function runAcceptedSyncingReloadCheck(page, {
  trace,
  profileId,
  threadId,
  stateKey,
  clientMessageId,
  content,
  expectedTurnId,
  expectedAttemptId,
  initialMatchingTurnStartCount,
  context,
}) {
  const matchingTurnStartCount = () => trace.turnStarts.filter(row =>
    row.threadId === threadId && row.clientMessageId === clientMessageId).length;
  assert.equal(initialMatchingTurnStartCount, 1,
    "the reload checks must start from the one confirmed real turn/start for this exact thread and client message");
  assert.equal(matchingTurnStartCount(), initialMatchingTurnStartCount,
    "the confirmed same-thread/client turn-start baseline must remain intact before reload checks");
  assert.ok(typeof expectedTurnId === "string" && expectedTurnId.length > 0,
    "the real turn/start result must provide a turn ID before accepted-state setup");
  const exactUserRow = page.getByTestId("message-user").filter({ hasText: content });
  await exactUserRow.waitFor({ state: "visible", timeout: 15_000 });
  assert.equal(await exactUserRow.count(), 1, "the actual submitted message must be visible exactly once before fixture setup");

  const fixture = await addUnknownRecoveryFixture(page, {
    stateKey, profileId, serverId: SERVER_ID, threadId, clientMessageId, content,
  });
  assert.deepEqual(fixture, {
    stateFound: true,
    scopedKeyMatches: true,
    duplicateId: false,
    idMatches: true,
    contentMatches: true,
    outcomeIsUnknown: true,
    acceptedTurnWasNotSeeded: true,
    attachmentsAreEmpty: true,
    composerDraftPreserved: true,
  }, "the test-only unknown row must use the real sent ID and must not preseed acceptedTurn");

  const beforeUnknownReloadTurnStartCount = matchingTurnStartCount();
  assert.equal(beforeUnknownReloadTurnStartCount, initialMatchingTurnStartCount);
  await page.reload({ waitUntil: "domcontentloaded" });
  assert.equal(taskIdFromUrl(page.url()), threadId, "reload must remain on the same task route");
  const card = page.getByTestId("failed-submission").filter({ hasText: content });
  await card.waitFor({ state: "visible", timeout: 20_000 });
  const unknownState = await readRecoveryRowProjection(page, {
    stateKey, clientMessageId, content, threadId, turnId: expectedTurnId, attemptId: expectedAttemptId,
  });
  assert.equal(unknownState.rowFound, true, "the unknown fixture row must hydrate from scoped AsyncStorage after reload");
  assert.equal(unknownState.outcome, "unknown");
  assert.equal(unknownState.acceptedTurnWasAbsent, true, "the initial fixture must still have no acceptedTurn");
  assert.equal(unknownState.composerDraftPreserved, true, "fixture setup must preserve the current composer draft");
  const restoredUserRow = page.getByTestId("message-user").filter({ hasText: content });
  await restoredUserRow.waitFor({ state: "visible", timeout: 10_000 });
  assert.equal(await restoredUserRow.count(), 1, "the real sent message must restore exactly once before checking");
  assert.equal(await card.getByTestId("verify-failed-submission").count(), 1,
    "unknown recovery must expose exactly one check-only control");
  assert.equal(await card.getByTestId("retry-failed-submission").count(), 0,
    "unknown recovery must not expose a resend control");
  await waitFor(() => card.getByTestId("verify-failed-submission").isEnabled()
    .then(enabled => enabled ? true : null), 15_000,
  "the restored check-only control to become enabled on the connected task", 10, context.abortSignal);
  await waitFor(() => trace.pendingTrackedRequestCount() === 0 ? true : null, 15_000,
    "tracked task restoration RPCs to settle before measuring the check-only action", 10, context.abortSignal);
  assert.equal(matchingTurnStartCount(), beforeUnknownReloadTurnStartCount,
    "hydrating the unknown row after reload must not auto-send this same thread/client message");

  const setupReceiptCount = trace.receiptReads.length;
  const setupHistoryCount = trace.historyReads.length;
  const setupTurnStartCount = trace.turnStarts.length;
  const setupHold = trace.armHistoryHoldAfterReceipt({ threadId, clientMessageId });
  await card.getByTestId("verify-failed-submission").click();
  const setupReceipt = await waitFor(() => trace.receiptReads.find((row, index) =>
    index >= setupReceiptCount && row.threadId === threadId && row.clientMessageId === clientMessageId &&
    row.responseStatus === "success") ?? null,
  15_000, "the real receipt response for the exact sent message", 10, context.abortSignal);
  assert.ok(setupReceipt.rpcId !== null && Number.isSafeInteger(setupReceipt.socketId),
    "the receipt result must correlate to a request ID on an owned Browser WebSocket");
  assert.equal(setupReceipt.receiptThreadId, threadId, "receipt response must belong to the mounted task");
  assert.equal(setupReceipt.receiptTurnId, expectedTurnId, "receipt must identify the actual successful turn/start");
  if (expectedAttemptId) assert.equal(setupReceipt.receiptAttemptId, expectedAttemptId,
    "receipt attempt ID must match the actual turn/start response");

  const heldHistory = await waitFor(() => trace.historyReads.find(row =>
    row.heldAfterMatchingReceipt && row.responseStatus === "success") ?? null,
  15_000, "the successful real history response to be held after the matching receipt", 10, context.abortSignal);
  const heldHistorySignal = await setupHold.reached;
  assert.equal(setupHold.responseHeld, true, "the Browser-facing history response must be held by its bound WebSocket route");
  assert.equal(heldHistory.socketId, setupReceipt.socketId,
    "receipt and held history request must be observed on the same WebSocket");
  assert.ok(heldHistory.rpcId !== null, "the held history response must correlate to its exact request ID");
  assert.equal(heldHistorySignal.socketId, setupReceipt.socketId);
  assert.equal(heldHistory.threadId, threadId);
  assert.equal(heldHistory.limit, 50, "the setup reconciliation must use one bounded history page");
  assert.equal(heldHistory.beforeCursorSha256, null, "the setup reconciliation must use the first bounded page");
  assert.equal(heldHistory.responseStatus, "success");
  assert.notEqual(heldHistory.responseThreadMatchesRequest, false,
    "a returned history thread, when present, must match the request thread");
  assert.equal(trace.receiptReads.length, setupReceiptCount + 1,
    "the initial accepted-state setup must issue exactly one receipt read");
  assert.equal(trace.historyReads.length, setupHistoryCount + 1,
    "the initial accepted-state setup must issue exactly one bounded history page");

  const persistedWhileHistoryHeld = await readRecoveryRowProjection(page, {
    stateKey, clientMessageId, content, threadId, turnId: expectedTurnId, attemptId: setupReceipt.receiptAttemptId,
  });
  assert.equal(persistedWhileHistoryHeld.rowFound, true);
  assert.equal(persistedWhileHistoryHeld.outcome, "unknown");
  assert.equal(persistedWhileHistoryHeld.acceptedTurnPresent, true);
  assert.equal(persistedWhileHistoryHeld.acceptedTurnMatches, true,
    "the product must persist the actual receipt before history I/O completes");
  await card.getByText("消息已接收，正在同步记录", { exact: true }).waitFor({ state: "visible", timeout: 5_000 });

  const beforeAcceptedReloadTurnStartCount = matchingTurnStartCount();
  assert.equal(beforeAcceptedReloadTurnStartCount, initialMatchingTurnStartCount);
  await page.reload({ waitUntil: "domcontentloaded" });
  await waitFor(() => setupHold.socketClosedWhileHeld ? true : null, 10_000,
    "reload to close the exact socket whose real history response was held", 10, context.abortSignal);
  assert.equal(taskIdFromUrl(page.url()), threadId, "accepted-state reload must remain on the same task route");
  const acceptedCard = page.getByTestId("failed-submission").filter({ hasText: content });
  await acceptedCard.waitFor({ state: "visible", timeout: 20_000 });
  await acceptedCard.getByText("消息已接收，正在同步记录", { exact: true })
    .waitFor({ state: "visible", timeout: 5_000 });
  await acceptedCard.getByText("仅核对记录，不会重新发送", { exact: false })
    .waitFor({ state: "visible", timeout: 5_000 });
  assert.equal(await acceptedCard.getByTestId("verify-failed-submission").count(), 1,
    "rehydrated accepted state must expose exactly one check-only control");
  assert.equal(await acceptedCard.getByTestId("retry-failed-submission").count(), 0,
    "rehydrated accepted state must not expose a resend control");
  await waitFor(() => acceptedCard.getByTestId("verify-failed-submission").isEnabled()
    .then(enabled => enabled ? true : null), 15_000,
  "the rehydrated check-only control to become enabled on the connected task", 10, context.abortSignal);
  const acceptedAfterReload = await readRecoveryRowProjection(page, {
    stateKey, clientMessageId, content, threadId, turnId: expectedTurnId, attemptId: setupReceipt.receiptAttemptId,
  });
  assert.equal(acceptedAfterReload.rowFound, true);
  assert.equal(acceptedAfterReload.outcome, "unknown");
  assert.equal(acceptedAfterReload.acceptedTurnMatches, true,
    "the acceptedTurn written by the product must survive the real reload");
  const visibleUserRow = page.getByTestId("message-user").filter({ hasText: content });
  await visibleUserRow.waitFor({ state: "visible", timeout: 10_000 });
  assert.equal(await visibleUserRow.count(), 1,
    "the actual sent message must remain visible exactly once after reload");
  await waitFor(() => trace.pendingTrackedRequestCount() === 0 ? true : null, 15_000,
    "tracked post-reload task restoration RPCs to settle before counting the explicit check", 10, context.abortSignal);
  assert.equal(matchingTurnStartCount(), beforeAcceptedReloadTurnStartCount,
    "rehydrating accepted state after reload must not auto-send this same thread/client message");

  const postReloadReceiptCount = trace.receiptReads.length;
  const postReloadHistoryCount = trace.historyReads.length;
  const postReloadTurnStartCount = trace.turnStarts.length;
  await acceptedCard.getByTestId("verify-failed-submission").click();
  const postReloadReceipt = await waitFor(() => trace.receiptReads.find((row, index) =>
    index >= postReloadReceiptCount && row.threadId === threadId && row.clientMessageId === clientMessageId &&
    row.responseStatus === "success") ?? null,
  15_000, "one real check-only receipt read after rehydrating accepted state", 10, context.abortSignal);
  assert.equal(postReloadReceipt.receiptThreadId, threadId);
  assert.equal(postReloadReceipt.receiptTurnId, expectedTurnId);
  assert.ok(postReloadReceipt.rpcId !== null && Number.isSafeInteger(postReloadReceipt.socketId));
  if (setupReceipt.receiptAttemptId)
    assert.equal(postReloadReceipt.receiptAttemptId, setupReceipt.receiptAttemptId);
  const postReloadHistory = await waitFor(() => trace.historyReads.find((row, index) =>
    index >= postReloadHistoryCount && row.threadId === threadId && row.limit === 50 &&
    row.responseStatus === "success") ?? null,
  15_000, "one successful bounded history page after the reloaded check-only action", 10, context.abortSignal);
  assert.equal(postReloadHistory.method === "thread/read" || postReloadHistory.method === "thread/read/indexed", true);
  assert.equal(postReloadHistory.beforeCursorSha256, null, "the post-reload check must use one first page, not paginate");
  assert.notEqual(postReloadHistory.responseThreadMatchesRequest, false,
    "when the history response includes thread identity it must match the request");
  assert.equal(postReloadHistory.socketId, postReloadReceipt.socketId,
    "the post-reload receipt and bounded history read must share the active Browser WebSocket");
  assert.ok(postReloadHistory.rpcId !== null, "the post-reload history response must correlate to its exact request ID");
  assert.equal(trace.receiptReads.length, postReloadReceiptCount + 1,
    "the reloaded check-only action must add exactly one receipt request");
  assert.equal(trace.historyReads.length, postReloadHistoryCount + 1,
    "the reloaded check-only action must add exactly one history request");
  assert.equal(trace.turnStarts.length, postReloadTurnStartCount,
    "accepted recovery must never resend the already accepted message");
  await acceptedCard.waitFor({ state: "detached", timeout: 10_000 });
  await visibleUserRow.waitFor({ state: "visible", timeout: 10_000 });
  assert.equal(await visibleUserRow.count(), 1,
    "successful reconciliation must keep one visible copy of the real user message");
  const finalState = await waitFor(
    async () => {
      const state = await readRecoveryRowProjection(page, {
        stateKey, clientMessageId, content, threadId, turnId: expectedTurnId, attemptId: setupReceipt.receiptAttemptId,
      });
      return state.rowFound ? null : state;
    },
    10_000,
    "the reconciled recovery row to be removed from the scoped AsyncStorage state",
    10,
    context.abortSignal,
  );
  assert.equal(finalState.rowFound, false);

  return {
    fixture: "test-only unknown row added to this run's scoped AsyncStorage after a real successful send; acceptedTurn intentionally omitted",
    realTurnStartAndReceiptMatched: true,
    acceptedTurnPersistedBeforeHeldHistory: true,
    acceptedTurnSurvivedReload: true,
    heldHistoryResponseWasReceivedThenSocketClosedByReload: true,
    acceptedTitleVisibleAfterReload: true,
    checkOnlyControlVisibleAfterReload: true,
    retryControlAbsentAfterReload: true,
    postReloadReceiptReadCount: 1,
    postReloadBoundedHistoryReadCount: 1,
    postReloadHistoryLimit: 50,
    postReloadTurnStartDelta: 0,
    realUserMessageVisibleExactlyOnce: true,
    recoveryRowRemovedAfterHistoryReconciliation: true,
    providerBoundary: "loopback deterministic fixture only",
  };
}

async function installRecoveryWriteGate(page) {
  const held = deferred();
  const reached = deferred();
  const state = { key: null, clientMessageId: null, calls: 0, releaseRequested: false };
  await page.exposeFunction("__e2eAwaitRecoveryWorkspaceWrite", async receipt => {
    state.calls += 1;
    state.key = String(receipt?.key ?? "");
    state.clientMessageId = String(receipt?.clientMessageId ?? "");
    reached.resolve(true);
    await held.promise;
  });
  await page.addInitScript(({ prefix }) => {
    const nativeSetItem = Storage.prototype.setItem;
    let target = null;
    let consumed = false;
    let heldWrite = null;
    let settled = false;
    Object.defineProperty(window, "__e2eRecoveryWriteGate", {
      configurable: false,
      enumerable: false,
      value: Object.freeze({
        arm: value => { target = value; },
        isPending: () => heldWrite !== null && !settled,
        isSettled: () => settled,
      }),
    });
    Storage.prototype.setItem = function (key, value) {
      if (!target || consumed || window.top !== window || this !== window.localStorage || typeof key !== "string" || !key.startsWith(`${prefix}:`))
        return nativeSetItem.call(this, key, value);
      const parts = key.slice(prefix.length + 1).split(":");
      if (parts.length < 5 || parts[3] !== "scope") return nativeSetItem.call(this, key, value);
      let route;
      try { route = parts.slice(0, 3).map(decodeURIComponent); } catch { return nativeSetItem.call(this, key, value); }
      if (route[0] !== target.profileId || route[1] !== target.serverId || route[2] !== target.threadId)
        return nativeSetItem.call(this, key, value);
      let state;
      try { state = JSON.parse(String(value)); } catch { return nativeSetItem.call(this, key, value); }
      const row = Array.isArray(state?.failedSubmissions)
        ? state.failedSubmissions.find(item => item?.content === target.content && item?.outcome === "failed"
          && typeof item?.id === "string" && /^[A-Za-z0-9._:-]{1,160}$/.test(item.id))
        : null;
      if (!row) return nativeSetItem.call(this, key, value);
      consumed = true;
      heldWrite = window.__e2eAwaitRecoveryWorkspaceWrite({ key, clientMessageId: row.id })
        .then(() => nativeSetItem.call(this, key, value));
      heldWrite.then(() => { settled = true; }, () => { settled = true; });
      return heldWrite;
    };
  }, { prefix: STATE_PREFIX });
  return {
    get key() { return state.key; },
    get clientMessageId() { return state.clientMessageId; },
    get calls() { return state.calls; },
    waitReached: () => reached.promise,
    arm: target => page.evaluate(value => window.__e2eRecoveryWriteGate.arm(value), target),
    release: () => {
      if (state.releaseRequested) return;
      state.releaseRequested = true;
      held.resolve();
    },
  };
}

function installRpcTrace(page, expectedWorkspace) {
  const expectedWorkspacePath = resolve(expectedWorkspace);
  const trace = {
    turnStarts: [],
    receiptReads: [],
    historyReads: [],
    notifications: [],
    workspaceOperations: [],
    rpcDiagnostics: [],
  };
  const socketStates = new Set();
  let nextSocketId = 0;
  let historyHold = null;
  trace.pendingTrackedRequestCount = () => [...socketStates]
    .filter(state => !state.closed)
    .reduce((total, state) => total + state.pending.size, 0);
  trace.armHistoryHoldAfterReceipt = ({ threadId, clientMessageId }) => {
    assert.equal(historyHold, null, "only one accepted-history response may be held at a time");
    const reached = deferred();
    const release = deferred();
    historyHold = {
      threadId,
      clientMessageId,
      receiptSocketId: null,
      socketId: null,
      rpcId: null,
      method: null,
      limit: null,
      reached,
      release,
      responseHeld: false,
      socketClosedWhileHeld: false,
    };
    return {
      reached: reached.promise,
      release: () => release.resolve(),
      get responseHeld() { return historyHold?.responseHeld === true; },
      get socketClosedWhileHeld() { return historyHold?.socketClosedWhileHeld === true; },
    };
  };
  trace.releaseHeldHistoryResponses = () => {
    historyHold?.release.resolve();
  };
  page.routeWebSocket("**/rpc*", socket => {
    const upstream = socket.connectToServer();
    const socketId = ++nextSocketId;
    const pending = new Map();
    const diagnosticPending = new Map();
    const socketState = { socketId, pending, closed: false };
    socketStates.add(socketState);
    let closing = false;
    const closePeer = () => {
      if (closing) return;
      closing = true;
      socketState.closed = true;
      if (historyHold?.socketId === socketId) {
        historyHold.socketClosedWhileHeld = historyHold.responseHeld;
        historyHold.release.resolve();
      }
      void upstream.close().catch(() => {});
    };
    socket.onClose(closePeer);
    upstream.onClose(() => {
      if (closing) return;
      closing = true;
      socketState.closed = true;
      if (historyHold?.socketId === socketId) {
        historyHold.socketClosedWhileHeld = historyHold.responseHeld;
        historyHold.release.resolve();
      }
      void socket.close().catch(() => {});
    });
    socket.onMessage(raw => {
      let frame;
      try { frame = JSON.parse(String(raw)); } catch { upstream.send(raw); return; }
      if (typeof frame?.method === "string") {
        const rpcId = frame.id === undefined ? null : String(frame.id);
        if (rpcId !== null) diagnosticPending.set(rpcId, frame.method);
        if (trace.rpcDiagnostics.length < 500)
          trace.rpcDiagnostics.push({ direction: "request", socketId, method: frame.method, rpcId });
      }
      if (["runtime.workspaces.operation/scopeV2", "runtime.workspaces.operation/readV2", "runtime.workspaces.openV2"].includes(frame?.method)) {
        const params = frame.params && typeof frame.params === "object" ? frame.params : {};
        const request = {
          direction: "request",
          method: frame.method,
          rpcIdSha256: frame.id === undefined ? null : sha256(String(frame.id)),
          clientRequestIdSha256: typeof params.clientRequestId === "string" ? sha256(params.clientRequestId) : null,
          scopeIdSha256: typeof params.scopeId === "string" ? sha256(params.scopeId) : null,
          workspacePathMatchesOwnedWorkspace: typeof params.workspacePath === "string"
            && resolve(params.workspacePath) === expectedWorkspacePath,
          workspacePathSha256: typeof params.workspacePath === "string" ? sha256(params.workspacePath) : null,
        };
        trace.workspaceOperations.push(request);
        if (frame.id !== undefined) pending.set(String(frame.id), { kind: "workspace", request });
      }
      if (frame?.method === "turn/start") {
        const params = frame.params ?? {};
        const text = Array.isArray(params.input)
          ? params.input.filter(item => item?.type === "text").map(item => String(item.text ?? "")).join("\n")
          : "";
        const request = {
          socketId,
          rpcId: frame.id === undefined ? null : String(frame.id),
          threadId: stringOrNull(params.threadId),
          clientMessageId: stringOrNull(params.clientMessageId),
          textSha256: sha256(text),
          responseStatus: null,
          errorCode: null,
          turnId: null,
          attemptId: null,
        };
        trace.turnStarts.push(request);
        if (frame.id !== undefined) pending.set(String(frame.id), { kind: "turn-start", request });
      }
      if (frame?.method === "turn/receipt/read") {
        const params = frame.params ?? {};
        const request = {
          socketId,
          rpcId: frame.id === undefined ? null : String(frame.id),
          threadId: stringOrNull(params.threadId),
          clientMessageId: stringOrNull(params.clientMessageId),
          responseStatus: null,
          errorCode: null,
          receiptThreadId: null,
          receiptTurnId: null,
          receiptAttemptId: null,
          receiptStatus: null,
        };
        trace.receiptReads.push(request);
        if (frame.id !== undefined) pending.set(String(frame.id), { kind: "receipt-read", request });
      }
      if (["thread/read", "thread/read/indexed"].includes(frame?.method)) {
        const params = frame.params ?? {};
        const request = {
          socketId,
          rpcId: frame.id === undefined ? null : String(frame.id),
          method: frame.method,
          threadId: stringOrNull(params.threadId),
          limit: Number.isSafeInteger(params.limit) ? params.limit : null,
          beforeCursorSha256: typeof params.beforeCursor === "string" ? sha256(params.beforeCursor) : null,
          responseStatus: null,
          errorCode: null,
          responseThreadMatchesRequest: null,
          responseMessageCount: null,
          heldAfterMatchingReceipt: false,
        };
        trace.historyReads.push(request);
        if (frame.id !== undefined) {
          pending.set(String(frame.id), { kind: "history-read", request });
          if (historyHold && historyHold.receiptSocketId === socketId &&
              historyHold.threadId === request.threadId && request.limit === 50 &&
              historyHold.socketId === null) {
            historyHold.socketId = socketId;
            historyHold.rpcId = String(frame.id);
            historyHold.method = frame.method;
            historyHold.limit = request.limit;
            request.heldAfterMatchingReceipt = true;
          }
        }
      }
      upstream.send(raw);
    });
    upstream.onMessage(async raw => {
      let frame;
      try { frame = JSON.parse(String(raw)); } catch { socket.send(raw); return; }
      if (frame?.id !== undefined && diagnosticPending.has(String(frame.id))) {
        const rpcId = String(frame.id);
        const method = diagnosticPending.get(rpcId);
        diagnosticPending.delete(rpcId);
        if (trace.rpcDiagnostics.length < 500)
          trace.rpcDiagnostics.push({
            direction: "response",
            socketId,
            method,
            rpcId,
            status: frame.error ? "error" : "success",
            errorCode: typeof frame.error?.code === "number" ? frame.error.code : null,
          });
      }
      if (frame?.id !== undefined && pending.has(String(frame.id))) {
        const pendingRequest = pending.get(String(frame.id));
        pending.delete(String(frame.id));
        const request = pendingRequest.request;
        const result = frame.result && typeof frame.result === "object" ? frame.result : {};
        const receipt = result.receipt && typeof result.receipt === "object" ? result.receipt : {};
        if (pendingRequest.kind === "turn-start") {
          request.responseStatus = frame.error ? "error" : "success";
          request.errorCode = typeof frame.error?.code === "number" ? frame.error.code : null;
          request.turnId = stringOrNull(result.turn?.id);
          request.attemptId = stringOrNull(result.turn?.attemptId);
        } else if (pendingRequest.kind === "receipt-read") {
          request.responseStatus = frame.error ? "error" : "success";
          request.errorCode = typeof frame.error?.code === "number" ? frame.error.code : null;
          request.receiptThreadId = stringOrNull(receipt.threadId);
          request.receiptTurnId = stringOrNull(receipt.turnId);
          request.receiptAttemptId = stringOrNull(receipt.attemptId);
          request.receiptStatus = stringOrNull(receipt.status);
          if (!frame.error && historyHold && historyHold.threadId === request.threadId &&
              historyHold.clientMessageId === request.clientMessageId) {
            historyHold.receiptSocketId = socketId;
          }
        } else if (pendingRequest.kind === "history-read") {
          request.responseStatus = frame.error ? "error" : "success";
          request.errorCode = typeof frame.error?.code === "number" ? frame.error.code : null;
          const thread = result.thread && typeof result.thread === "object" ? result.thread : {};
          const responseThreadId = stringOrNull(thread.id);
          request.responseThreadMatchesRequest = responseThreadId === null
            ? null : responseThreadId === request.threadId;
          request.responseMessageCount = Array.isArray(result.messages) ? result.messages.length : null;
          if (historyHold?.socketId === socketId && historyHold.rpcId === String(frame.id) && !frame.error) {
            historyHold.responseHeld = true;
            historyHold.reached.resolve({
              socketId,
              method: request.method,
              threadMatchesRequest: request.responseThreadMatchesRequest,
              limit: request.limit,
              messageCount: request.responseMessageCount,
            });
            await historyHold.release.promise;
          }
        } else if (pendingRequest.kind === "workspace") {
        const responseResult = result.result && typeof result.result === "object" ? result.result : {};
        const responsePath = typeof responseResult.workspacePath === "string"
          ? responseResult.workspacePath
          : typeof responseResult.mapping?.workspacePath === "string" ? responseResult.mapping.workspacePath : null;
        const scope = typeof result.rootId === "string"
          ? result
          : result.scope && typeof result.scope === "object" ? result.scope : {};
        const response = {
          direction: "response",
          method: request.method,
          socketId,
          rpcIdSha256: request.rpcIdSha256,
          status: frame.error ? "error" : "success",
          errorCode: typeof frame.error?.code === "number" ? frame.error.code : null,
          clientRequestIdSha256: request.clientRequestIdSha256,
          receiptClientRequestIdMatchesRequest: typeof receipt.clientRequestId === "string"
            && sha256(receipt.clientRequestId) === request.clientRequestIdSha256,
          receiptStatus: typeof receipt.status === "string" ? receipt.status : null,
          receiptPathMatchesOwnedWorkspace: typeof receipt.workspacePath === "string"
            && resolve(receipt.workspacePath) === expectedWorkspacePath,
          receiptPathSha256: typeof receipt.workspacePath === "string" ? sha256(receipt.workspacePath) : null,
          resultPathMatchesOwnedWorkspace: responsePath !== null && resolve(responsePath) === expectedWorkspacePath,
          resultPathSha256: responsePath === null ? null : sha256(responsePath),
          scopeIdentitySha256: [scope.rootId, scope.scopeId, scope.familyId].every(value => typeof value === "string")
            ? sha256(JSON.stringify([scope.rootId, scope.scopeId, scope.familyId])) : null,
          scopeIdMatchesRequest: typeof scope.scopeId === "string" && request.scopeIdSha256 === sha256(scope.scopeId),
        };
        trace.workspaceOperations.push(response);
        }
      }
      if (frame?.method === "turn/completed" && frame.id === undefined) {
        trace.notifications.push({ method: frame.method, threadId: stringOrNull(frame.params?.threadId) });
      }
      if (!closing) socket.send(raw);
    });
  });
  return trace;
}

function taskIdFromUrl(url) {
  const segments = new URL(url).pathname.split("/").filter(Boolean);
  return segments.length ? decodeURIComponent(segments.at(-1)) : null;
}

function stringOrNull(value) {
  return typeof value === "string" ? value : null;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function deferred() {
  let resolvePromise;
  const promise = new Promise(resolve => { resolvePromise = resolve; });
  return { promise, resolve: resolvePromise };
}
