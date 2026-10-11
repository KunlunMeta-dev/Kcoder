import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import {
  access,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  writeFile,
} from "node:fs/promises";
import net from "node:net";
import tls from "node:tls";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { startChromium } from "../../harness/chromium.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import {
  prepareIsolatedRealModelConfig,
  realModelPreflight,
} from "../../harness/real-model.mjs";
import {
  repoRoot,
  runE2E,
  waitFor,
} from "../../harness/run-context.mjs";
import { materializeWorkspace } from "../../harness/workspace-fixture.mjs";
import { reuseMobileWebExport } from "../../harness/mobile-web-export-reuse.mjs";
import {
  captureRedactedMobileHistoryFailure,
  connectMobileWithGatewayAuth,
  expandReadResult,
  isMobileNewWorkspaceRoute,
  parseMobileProfileHomeRoute,
  parseMobileTaskRoute,
  returnHomeAndReenterTaskFromSessions,
  safeMobileProfileHomeRoute,
  safeTaskRoute,
  writeProviderBudgetFinalLedger,
} from "./real-provider-history-assertions.mjs";
import { loadApprovedProviderEnvironment } from "./real-provider-env.mjs";
import { startProviderBudgetProxy } from "./real-provider-budget-proxy.mjs";

const expectedKcoderBin = resolve(
  repoRoot,
  "target/test/coordination/mobile-eight-hour-audit/20260930-162836.000Z/final-app-server-idgate-20260930-221900Z/kcoder",
);
const expectedKcoderSha256 =
  "2a792be7e0033140dc93bf78d07567371c1f077653f1361985419791f917667c";
const expectedKcoderBinarySize = 406236048;
const expectedKcoderBinaryProvenanceRelativePath =
  "target/test/coordination/mobile-eight-hour-audit/20260930-162836.000Z/final-app-server-idgate-20260930-221900Z/binary-provenance.json";
const expectedKcoderBinaryProvenanceSha256 =
  "4fe27367f70221fa1d6b90e85eca666916b52e512e9523b1845831d999c1d9f3";
const mobileSourceSnapshotRelativeRoot =
  "target/test/coordination/mobile-source-freezes/20260930-220022Z-22b165";
const expectedMobileSourceSnapshotId = "20260930-220022Z-22b165";
const expectedMobileSourceSnapshotManifestSha256 =
  "2431bcacc3b186aa6e2caaee070432ca6f62aa54ff0104198cf6266b288ccbcc";
const expectedMobileSharedSourceManifestSha256 =
  "34ba61980d7ee005d4ebdf5eb332ac823837c4279c67a9e52fac3161fe4caf38";
const expectedMobileSourceTreeSha256 =
  "22b16584df407b80b3a235a964042b6f04103f6ea52237ad90e02a75a182c5ca";
const expectedMobileSourceFileCount = 239;
const expectedMobileBundleSha256 =
  "ef8c83319b30298a538179bba0e537af2d73bdfb54f922d9cb7466309e558eb4";
const expectedMobileBundleFileCount = 37;
const expectedMobileIndexHtmlSha256 =
  "5b1625c8050c28b68b1ba1b1a4276cf49bb4f942886899973e104c2b7bd2daf4";
const expectedRetainedMobileExportManifestRelativePath =
  "target/test/apps/kcoder-studio/e2e/harness/mobile-web-export.test.mjs/20260930-222401.761Z/artifacts/mobile-web-reuse-manifest.json";
const expectedRetainedMobileExportManifestSha256 =
  "00f69db155c8979f8e7fb294a53bed7e1d98cfc56ad14403fd20b9510f7a1ef2";
const retainedMobileExportManifestEnv =
  "KCODER_E2E_RETAINED_MOBILE_EXPORT_MANIFEST";
const previousProviderRunIds = [
  "20260930-212141.862Z",
  "20260930-215023.196Z",
];
const previousRunCumulativeUpstreamUpperBound = 4;
const previousRunObservedTransportAttempts = 3;
const cumulativeProviderRequestBudget = 7;
const maxProviderRequests = 3;
const maxOutputTokens = 1024;
const maxCaseMs = 4 * 60_000;
const execFileAsync = promisify(execFile);

await runE2E(
  import.meta.url,
  {
    testId: "mobile-real-provider-tool-history-order-context",
    tier: "credentialed-integration",
    modelPolicy:
      "real-model-required; MiniMax-M3; two Mobile Web turns; at most three new upstream Provider requests after reserving previous-run cumulative upper bound four across runs 20260930-212141.862Z and 20260930-215023.196Z; cumulative upstream budget at most seven; 1024 output tokens per request; zero retries; provider prerequisites never fall back to fixtures",
    retainSuccessLogs: false,
  },
  async (context) => {
    let caseStartedAt = null;
    let deadline = null;
    let caseDeadlineTimer = null;
    let currentStage = "preflight";
    let evidencePage = null;
    let providerBudgetProxy = null;
    try {
    const requiredRuntimeFlags = {
      chromiumNoSandbox:
        process.env.KCODER_E2E_CHROMIUM_NO_SANDBOX === "1",
      approvedInsecureRemote:
        process.env.KCODER_E2E_ALLOW_INSECURE_REMOTE === "1",
    };
    await context.writeArtifactJson(
      "real-provider-runtime-flag-preflight.json",
      {
        ...requiredRuntimeFlags,
        modelRequestsBeforeInteraction: 0,
        checkedAtUtc: new Date().toISOString(),
      },
    );
    assert.equal(
      requiredRuntimeFlags.chromiumNoSandbox,
      true,
      "UNMET_PREREQUISITE: isolated VM Chromium run requires KCODER_E2E_CHROMIUM_NO_SANDBOX=1",
    );
    assert.equal(
      requiredRuntimeFlags.approvedInsecureRemote,
      true,
      "UNMET_PREREQUISITE: isolated remote Provider test requires KCODER_E2E_ALLOW_INSECURE_REMOTE=1",
    );
    const configuredKcoderBin = resolve(
      process.env.KCODER_E2E_KCODER_BIN || expectedKcoderBin,
    );
    const binarySha256 = createHash("sha256")
      .update(await readFile(configuredKcoderBin))
      .digest("hex");
    const binaryStat = await lstat(configuredKcoderBin);
    const binaryRoot = dirname(configuredKcoderBin);
    const binaryRootStat = await lstat(binaryRoot);
    const binaryProvenancePath = resolve(
      repoRoot,
      expectedKcoderBinaryProvenanceRelativePath,
    );
    const binaryProvenanceStat = await lstat(binaryProvenancePath);
    const binaryProvenanceBytes = await readFile(binaryProvenancePath);
    const binaryProvenanceSha256 = createHash("sha256")
      .update(binaryProvenanceBytes)
      .digest("hex");
    const binaryProvenance = JSON.parse(binaryProvenanceBytes.toString("utf8"));
    await context.writeArtifactJson("real-provider-binary-preflight.json", {
      expectedPath: expectedKcoderBin,
      configuredPath: configuredKcoderBin,
      expectedSha256: expectedKcoderSha256,
      actualSha256: binarySha256,
      exactBinary: configuredKcoderBin === expectedKcoderBin,
      expectedSize: expectedKcoderBinarySize,
      actualSize: binaryStat.size,
      mode: binaryStat.mode & 0o777,
      ownerUid: binaryStat.uid,
      ownerGid: binaryStat.gid,
      rootOwnerUid: binaryRootStat.uid,
      rootOwnerGid: binaryRootStat.gid,
      provenancePath: expectedKcoderBinaryProvenanceRelativePath,
      provenanceSha256: binaryProvenanceSha256,
      provenanceMode: binaryProvenanceStat.mode & 0o777,
      provenanceOwnerUid: binaryProvenanceStat.uid,
      provenanceOwnerGid: binaryProvenanceStat.gid,
      sourceCommit: binaryProvenance.sourceCommit,
      ownedSourceSha256: binaryProvenance.ownedSourceSha256,
      independentReviewerBinarySha256:
        binaryProvenance.independentReviewerBinarySha256,
      provenanceLimitations: binaryProvenance.limitations,
      provenanceBinaryPath: binaryProvenance.immutableCopiedBinaryPath,
      provenanceBinarySha256: binaryProvenance.binarySha256,
      binaryScope:
        "source-built typed app-server candidate; focused ID-gate stdio review only; full workspace tests not run",
    });
    assert.equal(
      configuredKcoderBin,
      expectedKcoderBin,
      "UNMET_PREREQUISITE: suite must use the exact reviewed source-built app-server candidate",
    );
    assert.equal(
      binarySha256,
      expectedKcoderSha256,
      "UNMET_PREREQUISITE: reviewed source-built app-server candidate hash changed",
    );
    assert.ok(binaryStat.isFile());
    assert.equal(binaryStat.size, expectedKcoderBinarySize);
    assert.equal(binaryStat.uid, 0);
    assert.equal(binaryStat.gid, 0);
    assert.equal(
      binaryStat.mode & 0o777,
      0o555,
      "UNMET_PREREQUISITE: source-built app-server candidate mode changed",
    );
    assert.ok(binaryRootStat.isDirectory());
    assert.equal(binaryRootStat.uid, 0);
    assert.equal(binaryRootStat.gid, 0);
    assert.equal(binaryRootStat.mode & 0o777, 0o555);
    assert.ok(binaryProvenanceStat.isFile());
    assert.equal(binaryProvenanceStat.uid, 0);
    assert.equal(binaryProvenanceStat.gid, 0);
    assert.equal(binaryProvenanceStat.mode & 0o777, 0o444);
    assert.equal(
      binaryProvenanceSha256,
      expectedKcoderBinaryProvenanceSha256,
      "UNMET_PREREQUISITE: app-server candidate provenance manifest changed",
    );
    assert.equal(binaryProvenance.binarySha256, expectedKcoderSha256);
    assert.equal(binaryProvenance.size, expectedKcoderBinarySize);
    assert.equal(
      binaryProvenance.immutableCopiedBinaryPath,
      expectedKcoderBin,
      "UNMET_PREREQUISITE: source-built candidate provenance points at a different executable",
    );

    const approvedConfigDir = resolve(repoRoot, "target/kcoder-relay/config");
    const sourceConfigDir = resolve(
      process.env.KCODER_E2E_SOURCE_CONFIG_DIR ||
        process.env.KCODER_CONFIG_DIR ||
        approvedConfigDir,
    );
    assert.equal(
      sourceConfigDir,
      approvedConfigDir,
      "UNMET_PREREQUISITE: only the approved Relay Provider settings source is selected",
    );
    const selectedProfile =
      process.env.KCODER_E2E_MODEL_PROFILE || "kunlunmeta";
    assert.equal(
      selectedProfile,
      "kunlunmeta",
      "UNMET_PREREQUISITE: this suite explicitly selects the approved kunlunmeta profile",
    );
    const providerEnvironment = await loadApprovedProviderEnvironment(
      resolve(repoRoot, ".env"),
      process.env,
    );
    for (const name of [
      "KUNLUNMETA_BASE_API_KEY",
      "KUNLUNMETA_BASE_URL",
      "KUNLUNMETA_BASE_MODEL",
    ]) {
      assert.ok(
        providerEnvironment.values[name],
        `UNMET_PREREQUISITE: approved Provider field ${name} is missing`,
      );
      assert.equal(
        providerEnvironment.sourceRoles[name],
        "repo-root-dotenv",
        `UNMET_PREREQUISITE: approved Provider field ${name} did not come from the selected repository dotenv`,
      );
    }
    context.registerSecret(
      providerEnvironment.values.KUNLUNMETA_BASE_API_KEY,
    );
    context.registerSecret(providerEnvironment.values.KUNLUNMETA_BASE_URL);
    const sourceSettingsFile = resolve(approvedConfigDir, "settings.json");
    const sourceSettingsStat = await lstat(sourceSettingsFile).catch(() => null);
    assert.ok(
      sourceSettingsStat?.isFile(),
      "UNMET_PREREQUISITE: approved Relay settings must be a regular file",
    );
    const sourceSettings = await readFile(sourceSettingsFile);
    const sourceSettingsSha256 = createHash("sha256")
      .update(sourceSettings)
      .digest("hex");
    const preflightConfigDir = context.pathInState("provider-preflight-config");
    const preflightCwd = context.pathInState("provider-preflight-cwd");
    const preflightHome = context.pathInState("provider-preflight-home");
    await Promise.all([
      mkdir(preflightConfigDir, { recursive: true, mode: 0o700 }),
      mkdir(preflightCwd, { recursive: true, mode: 0o700 }),
      mkdir(preflightHome, { recursive: true, mode: 0o700 }),
    ]);
    await writeFile(
      resolve(preflightConfigDir, "settings.json"),
      sourceSettings,
      { mode: 0o600, flag: "wx" },
    );
    const realModelEnv = context.isolatedEnvironment({
      KCODER_CONFIG_DIR: preflightConfigDir,
      KCODER_E2E_KCODER_BIN: expectedKcoderBin,
      KCODER_E2E_REAL_MODEL: "1",
      KCODER_E2E_MODEL_PROFILE: selectedProfile,
      HOME: preflightHome,
      USERPROFILE: preflightHome,
      ...providerEnvironment.values,
      ...(process.env.KCODER_E2E_ALLOW_INSECURE_REMOTE === "1"
        ? { KCODER_E2E_ALLOW_INSECURE_REMOTE: "1" }
        : {}),
    });
    const model = await realModelPreflight(
      selectedProfile,
      { env: realModelEnv, cwd: preflightCwd },
    );
    const effectiveEndpoint = await configGet(
      configuredKcoderBin,
      preflightCwd,
      realModelEnv,
      "base_url",
      selectedProfile,
    );
    const effectiveModel = await configGet(
      configuredKcoderBin,
      preflightCwd,
      realModelEnv,
      "model",
      selectedProfile,
    );
    const effectiveApiFormat = await configGet(
      configuredKcoderBin,
      preflightCwd,
      realModelEnv,
      "api_format",
      selectedProfile,
    );
    const configActiveProvider = await configGet(
      configuredKcoderBin,
      preflightCwd,
      realModelEnv,
      "active_provider",
    );
    assert.ok(
      effectiveEndpoint === providerEnvironment.values.KUNLUNMETA_BASE_URL,
      "UNMET_PREREQUISITE: typed Provider endpoint resolution differs from the selected dotenv value",
    );
    assert.equal(
      effectiveModel,
      providerEnvironment.values.KUNLUNMETA_BASE_MODEL,
      "UNMET_PREREQUISITE: typed Provider model resolution differs from the selected dotenv value",
    );
    assert.equal(
      effectiveModel,
      "MiniMax-M3",
      "UNMET_PREREQUISITE: this suite only validates the configured MiniMax-M3 profile",
    );
    assert.equal(
      effectiveApiFormat,
      "anthropic_messages",
      "UNMET_PREREQUISITE: MiniMax-M3 resolved to an unexpected wire format",
    );
    assert.equal(
      model.providerConfig.api_format,
      effectiveApiFormat,
      "UNMET_PREREQUISITE: the resolved Provider transport differs from its configured profile",
    );
    model.providerConfig = {
      ...model.providerConfig,
      endpoint: effectiveEndpoint,
      default_model: effectiveModel,
      api_format: effectiveApiFormat,
    };
    model.model = effectiveModel;
    const endpoint = describeEndpoint(effectiveEndpoint);
    assert.ok(endpoint.hostname, "UNMET_PREREQUISITE: configured Provider endpoint is invalid");
    const selectionDigest = createHash("sha256")
      .update(
        JSON.stringify({
          profile: model.profile,
          model: effectiveModel,
          apiFormat: effectiveApiFormat,
          endpoint: effectiveEndpoint,
        }),
      )
      .digest("hex");
    const prerequisiteOnly =
      process.env.KCODER_E2E_REAL_MODEL_PREREQUISITE_ONLY === "1";
    if (
      !prerequisiteOnly &&
      endpoint.protocol === "http:" &&
      !new Set(["127.0.0.1", "localhost", "::1"]).has(endpoint.hostname) &&
      process.env.KCODER_E2E_ALLOW_INSECURE_REMOTE !== "1"
    ) {
      assert.fail(
        "UNMET_PREREQUISITE: remote plaintext Provider requests require the explicit insecure-remote switch",
      );
    }
    const endpointReachable = await probeEndpoint(
      effectiveEndpoint,
      1_500,
    );
    await context.writeArtifactJson("real-provider-prerequisites.json", {
      providerProfile: model.profile,
      profileSelection: "explicit-test-profile",
      sourceConfigRole: "target-relay-config",
      sourceSettingsSha256,
      configuredActiveProvider: configActiveProvider || null,
      selectedProfileIsConfiguredActiveProvider:
        configActiveProvider === model.profile,
      model: model.model,
      apiFormat: model.providerConfig.api_format,
      endpoint,
      endpointSourceRole:
        providerEnvironment.sourceRoles.KUNLUNMETA_BASE_URL,
      modelSourceRole:
        providerEnvironment.sourceRoles.KUNLUNMETA_BASE_MODEL,
      authSourceRole:
        providerEnvironment.sourceRoles.KUNLUNMETA_BASE_API_KEY,
      providerEnvironmentPresence: {
        endpoint: Boolean(providerEnvironment.values.KUNLUNMETA_BASE_URL),
        model: Boolean(providerEnvironment.values.KUNLUNMETA_BASE_MODEL),
        auth: Boolean(
          providerEnvironment.values.KUNLUNMETA_BASE_API_KEY,
        ),
      },
      selectionDigest,
      providerAuthConfigured: true,
      endpointReachable,
      modelRequestsBeforeInteraction: 0,
      providerBudgetAccounting: {
        previousRunIds: previousProviderRunIds,
        previousRunCumulativeUpstreamUpperBound,
        previousRunObservedTransportAttempts,
        currentRunForwardCap: maxProviderRequests,
        cumulativeUpstreamMaximum: cumulativeProviderRequestBudget,
        maxOutputTokensPerRequest: maxOutputTokens,
        retries: 0,
      },
      prerequisiteOnly,
      realInteractionStatus:
        prerequisiteOnly || !endpointReachable ? "UNVERIFIED" : "not-started",
      progressBeforeToolOrdering:
        prerequisiteOnly || !endpointReachable ? "UNVERIFIED" : "not-started",
      refreshAndReentryHistory:
        prerequisiteOnly || !endpointReachable ? "UNVERIFIED" : "not-started",
      reason: endpointReachable
        ? null
        : "selected configured endpoint did not accept a TCP/TLS connection; no model request was made",
      inspectedAtUtc: new Date().toISOString(),
    });
    if (prerequisiteOnly) {
      assert.fail(
        endpointReachable
          ? "UNMET_PREREQUISITE: prerequisite-only run stopped because the endpoint is reachable; wait for runtime freeze before any model request"
          : "UNMET_PREREQUISITE: prerequisite-only run stopped at the unreachable configured endpoint; no model request was made",
      );
    }
    assert.ok(
      endpointReachable,
      "UNMET_PREREQUISITE: configured MiniMax-M3 endpoint is unreachable; no model request was made",
    );

    const mobileSourceSnapshot = await verifyPinnedMobileSourceSnapshot(context);
    const retainedManifestInput =
      process.env[retainedMobileExportManifestEnv] || null;
    assert.equal(
      retainedManifestInput,
      resolve(repoRoot, expectedRetainedMobileExportManifestRelativePath),
      `UNMET_PREREQUISITE: ${retainedMobileExportManifestEnv} must select the reviewed retained bundle; this run does not export Mobile Web`,
    );
    let web;
    let exportPerformed = false;
    let webManifestPath;
    let reuseProvenancePath = null;
    assert.ok(
      isAbsolute(retainedManifestInput),
      `UNMET_PREREQUISITE: ${retainedMobileExportManifestEnv} must be an absolute path`,
    );
    const retainedManifestPath = resolve(retainedManifestInput);
    assert.equal(
      retainedManifestPath,
      retainedManifestInput,
      `UNMET_PREREQUISITE: ${retainedMobileExportManifestEnv} must be normalized`,
    );
    assert.equal(
      retainedManifestPath,
      resolve(repoRoot, expectedRetainedMobileExportManifestRelativePath),
      "UNMET_PREREQUISITE: retained Mobile Web manifest must be the reviewed run-owned artifact",
    );
    const retainedManifestBytes = await readFile(retainedManifestPath);
    const retainedManifestSha256 = createHash("sha256")
      .update(retainedManifestBytes)
      .digest("hex");
    assert.equal(
      retainedManifestSha256,
      expectedRetainedMobileExportManifestSha256,
      "UNMET_PREREQUISITE: retained Mobile Web manifest digest changed",
    );
    const retainedManifest = JSON.parse(retainedManifestBytes.toString("utf8"));
    assert.equal(
      retainedManifest.sourceTreeSha256,
      expectedMobileSourceTreeSha256,
      "UNMET_PREREQUISITE: retained Mobile Web bundle is not from the pinned immutable source snapshot",
    );
    assert.equal(
      retainedManifest.bundleSha256,
      expectedMobileBundleSha256,
      "UNMET_PREREQUISITE: retained Mobile Web bundle digest differs from the reviewed 37-file export",
    );
    assert.equal(
      retainedManifest.bundleFileCount,
      expectedMobileBundleFileCount,
      "UNMET_PREREQUISITE: retained Mobile Web bundle must contain exactly 37 files",
    );
    assert.equal(
      retainedManifest.indexHtmlSha256,
      expectedMobileIndexHtmlSha256,
      "UNMET_PREREQUISITE: retained Mobile Web index digest differs from the reviewed export",
    );
    const bundleRoot = resolve(
      dirname(dirname(retainedManifestPath)),
      retainedManifest.directory,
    );
    web = await reuseMobileWebExport(context, {
      bundleRoot,
      manifestPath: retainedManifestPath,
      expectedSourceTreeSha256: mobileSourceSnapshot.sourceTreeSha256,
      expectedManifestSha256: expectedRetainedMobileExportManifestSha256,
      expectedBundleSha256: expectedMobileBundleSha256,
      label: "mobile-real-provider-history-web-reuse",
      outputName: "mobile-web-export",
    });
    assert.equal(
      web.sourceManifestSha256,
      expectedRetainedMobileExportManifestSha256,
      "retained Mobile Web manifest must remain unchanged while it is copied",
    );
    exportPerformed = web.exportPerformed;
    webManifestPath = web.sourceManifestPath;
    reuseProvenancePath = web.provenancePath;
    assert.equal(
      exportPerformed,
      false,
      "retained Mobile Web bundle reuse must not run Expo export",
    );
    assert.equal(
      web.sourceTreeSha256,
      expectedMobileSourceTreeSha256,
      "Mobile Web bundle source must match the pinned immutable 239-file snapshot",
    );
    assert.equal(
      web.bundleSha256,
      expectedMobileBundleSha256,
      "Mobile Web bundle must match the reviewed 37-file export digest",
    );
    assert.equal(
      web.bundleFileCount,
      expectedMobileBundleFileCount,
      "Mobile Web bundle must contain exactly 37 files",
    );
    assert.equal(
      web.indexHtmlSha256,
      expectedMobileIndexHtmlSha256,
      "Mobile Web index must match the reviewed export digest",
    );
    await context.writeArtifactJson("mobile-web-input-selection.json", {
      inputMode: exportPerformed
        ? "export-from-pinned-immutable-source-snapshot"
        : "reuse-retained-public-mobile-web-export",
      exportPerformed,
      sourceSnapshotId: mobileSourceSnapshot.snapshotId,
      sourceSnapshotPath: mobileSourceSnapshot.relativeRoot,
      sourceSnapshotManifestPath: mobileSourceSnapshot.manifestRelativePath,
      sourceSnapshotManifestSha256:
        mobileSourceSnapshot.manifestSha256,
      sourceTreeSha256: web.sourceTreeSha256,
      sourceFileCount: expectedMobileSourceFileCount,
      bundleSha256: web.bundleSha256,
      bundleFileCount: web.bundleFileCount,
      indexHtmlSha256: web.indexHtmlSha256,
      inputManifestPath: relative(repoRoot, webManifestPath),
      inputManifestSha256: web.sourceManifestSha256 || null,
      reuseProvenancePath: reuseProvenancePath
        ? relative(context.runRoot, reuseProvenancePath)
        : null,
    });
    await access(resolve(web.path, "index.html"));
    const { path: workspace } = await materializeWorkspace(
      context,
      "minimal",
      { instanceId: "mobile-real-provider-history" },
    );
    const nonce = randomBytes(12).toString("hex");
    const note = "NOTE_" + randomBytes(8).toString("hex");
    const progressMarker = "MOBILE_PROGRESS_" + randomBytes(6).toString("hex");
    const finalMarker = "MOBILE_FINAL_" + randomBytes(6).toString("hex");
    const secondPromptMarker = "MOBILE_SECOND_PROMPT_" + randomBytes(6).toString("hex");
    const secondAnswerMarker = "MOBILE_SECOND_ANSWER_" + randomBytes(6).toString("hex");
    for (const secret of [
      nonce,
      note,
      progressMarker,
      finalMarker,
      secondPromptMarker,
      secondAnswerMarker,
    ])
      context.registerSecret(secret);

    const nonceRelativePath = "src/mobile-provider-history.txt";
    const nonceFile = resolve(workspace, nonceRelativePath);
    await mkdir(dirname(nonceFile), { recursive: true, mode: 0o700 });
    await writeFile(nonceFile, "nonce=" + nonce + "\nnote=" + note + "\n", {
      mode: 0o600,
      flag: "wx",
    });
    const isolated = await prepareIsolatedRealModelConfig(
      context,
      model,
      { env: realModelEnv },
    );
    const attemptObserver = createProviderAttemptObserver();
    context.addCleanup(
      "verify real Provider budget proxy has no in-flight requests",
      async () => {
        if (providerBudgetProxy) {
          assert.equal(
            providerBudgetProxy.snapshot().inFlightRequests,
            0,
            "run cleanup must leave no upstream Provider stream active",
          );
        }
      },
    );
    context.addCleanup(
      "record cumulative real Provider request budget accounting",
      async () => {
        if (!providerBudgetProxy) return;
        attemptObserver.flush();
        const counters = providerBudgetProxy.snapshot();
        const observedAttempts = attemptObserver.snapshot().attempts;
        await writeProviderBudgetFinalLedger(context, {
          previousRunIds: previousProviderRunIds,
          previousRunCumulativeUpperBound:
            previousRunCumulativeUpstreamUpperBound,
          previousRunProxyCounterPersisted: false,
          previousRunObservedTransportAttempts,
          currentRunMaxForwardedRequests: maxProviderRequests,
          cumulativeMaximum: cumulativeProviderRequestBudget,
          counters,
          observedAttempts,
        });
      },
    );
    providerBudgetProxy = await startProviderBudgetProxy(context, {
      upstreamEndpoint: effectiveEndpoint,
      maxForwardedRequests: maxProviderRequests,
      label: "mobile-real-provider-history-budget-proxy",
    });
    await context.writeArtifactJson("provider-budget-proxy-selection.json", {
      selectedUpstream: {
        profile: model.profile,
        model: effectiveModel,
        apiFormat: effectiveApiFormat,
        safeOrigin: endpoint,
        sourceRole: providerEnvironment.sourceRoles.KUNLUNMETA_BASE_URL,
        selectionDigest,
      },
      gatewayHarnessEndpoint: providerBudgetProxy.endpoint,
      gatewayEndpointIsOwnedLoopback: true,
      budgetAccounting: {
        previousRunIds: previousProviderRunIds,
        previousRunCumulativeUpstreamUpperBound,
        previousRunObservedTransportAttempts,
        currentRunForwardCap: maxProviderRequests,
        cumulativeUpstreamMaximum: cumulativeProviderRequestBudget,
      },
      enforcement: "first three upstream requests forwarded; later requests receive local 429",
      redirects: "upstream 3xx responses become local 502 without Location",
      streaming: "request and response bodies are piped without buffering",
    });
    const settingsFile = await context.writeStateJson(
      "real-model-config/mobile-provider-history-settings.jsonc",
      {
        active_provider: model.provider,
        permission_mode: "yolo",
        tdd_gate: "off",
        max_retries: 0,
        max_tokens: maxOutputTokens,
        auto_memory_enabled: false,
        auto_tool_memory_enabled: false,
        tools: {
          profile: "nano",
          disabled: [
            "CtxInspect",
            "write",
            "edit",
            "apply_patch",
            "glob",
            "grep",
            "TodoWrite",
            "Sleep",
            "bash",
            "PowerShell",
            "Config",
            "Wiki*",
          ],
        },
        providers: {
          [model.provider]: {
            ...model.providerConfig,
            max_output_tokens: maxOutputTokens,
            max_retries: 0,
            request_timeout_secs: 25,
          },
        },
      },
      0o400,
    );
    const serversFile = await context.writeStateJson("servers.json", [
      {
        id: "local",
        label: "Run-owned Mobile real Provider workspace",
        transport: "local",
        command: expectedKcoderBin,
        workspace,
        settingsFile,
        profile: model.profile,
      },
    ]);
    let appServerPid = null;
    context.addCleanup(
      "verify run-owned app-server exited after Gateway cleanup",
      async () => {
        if (appServerPid && (await procEntryExists(appServerPid))) {
          throw new Error(
            "run-owned app-server process remained after its Gateway owner exited",
          );
        }
      },
    );
    let gateway = null;
    const onGatewayStderr = (chunk) => attemptObserver.consume(chunk);
    context.addCleanup(
      "detach numeric Provider attempt observer",
      () => {
        if (gateway) gateway.child.stderr.off("data", onGatewayStderr);
      },
    );
    gateway = await startGateway(context, {
      auth: true,
      label: "mobile-real-provider-history-gateway",
      workspace,
      serversFile,
      kcoderBin: expectedKcoderBin,
      env: {
        KCODER_CONFIG_DIR: isolated.configDir,
        KCODER_STUDIO_WEB_ROOT: web.path,
        KCODER_TRAINING_MODE: "true",
        KCODER_MAX_TOKENS: String(maxOutputTokens),
        KCODER_MAX_RETRIES: "0",
        KCODER_MAX_DURATION_SECS: "120",
        RUST_LOG: "warn,kcoder::transport_metrics=debug",
        ...providerEnvironment.values,
        KUNLUNMETA_BASE_URL: providerBudgetProxy.endpoint,
      },
    });
    gateway.child.stderr.on("data", onGatewayStderr);

    const chromium = await startChromium(context, {
      label: "mobile-real-provider-history-chromium",
    });
    const page = await chromium.newPage({
      viewport: { width: 390, height: 844 },
    });
    evidencePage = page;
    context.addCleanup("close Mobile real Provider page", () => page.close());
    page.setDefaultTimeout(20_000);

    let progressVisibleAt = null;
    const networkRequests = [];
    const diagnostics = {
      pageErrors: 0,
      consoleErrors: 0,
      clientMessageIdEnumErrorSeen: false,
    };
    const runtime = createRuntimeObserver({
      progressMarker,
      finalMarker,
      secondAnswerMarker,
      diagnostics,
    });
    runtime.attach(page);
    page.on("pageerror", () => {
      diagnostics.pageErrors += 1;
    });
    page.on("console", (message) => {
      if (message.type() !== "error") return;
      diagnostics.consoleErrors += 1;
      if (isClientMessageIdEnumError(message.text()))
        diagnostics.clientMessageIdEnumErrorSeen = true;
    });
    page.on("request", (request) => {
      if (networkRequests.length >= 500) return;
      try {
        const url = new URL(request.url());
        if (url.origin !== gateway.baseUrl) return;
        networkRequests.push({
          method: request.method(),
          path: url.pathname,
          resourceType: request.resourceType(),
        });
      } catch {
        // Keep no raw URL, query parameter, or request body.
      }
    });
    page.on("response", (response) => {
      const request = response.request();
      try {
        const url = new URL(request.url());
        if (url.origin !== gateway.baseUrl) return;
        runtime.httpResponses.push({ path: url.pathname, status: response.status() });
      } catch {
        // Keep no raw URL or response body.
      }
    });
    await connectMobile(page, gateway, context);
    const connectedHomePath = new URL(page.url()).pathname;
    const connectedProfileHome = parseMobileProfileHomeRoute(connectedHomePath);
    assert.ok(
      connectedProfileHome,
      "direct Gateway connection must land on the active profile Home route",
    );
    const profileId = connectedProfileHome.profileId;
    context.registerSecret(profileId);
    currentStage = "open-new-workspace";
    await page.getByTestId("new-workspace").click();
    await page.waitForURL(
      (url) => isMobileNewWorkspaceRoute(url.pathname),
      { timeout: 20_000 },
    );
    const newWorkspacePath = new URL(page.url()).pathname;
    assert.ok(
      isMobileNewWorkspaceRoute(newWorkspacePath),
      "Mobile must route from its profile home to the known New Workspace route before prompt submission",
    );
    const newWorkspaceProfileHome = parseMobileProfileHomeRoute(
      newWorkspacePath.replace(/\/new$/, ""),
    );
    assert.deepEqual(
      newWorkspaceProfileHome,
      connectedProfileHome,
      "New Workspace must remain under the connected profile Home route",
    );
    await page.getByTestId("server-option-local").click();
    const workspacePathInput = page.getByTestId("workspace-path");
    await workspacePathInput.waitFor({ state: "visible", timeout: 30_000 });
    await workspacePathInput.fill(workspace);
    await page.getByTestId("workspace-isolation-local").click();
    const firstPromptInput = page.getByTestId("new-workspace-prompt");
    await firstPromptInput.waitFor({ state: "visible", timeout: 20_000 });
    const firstPrompt =
      "手机端真实 Provider 顺序与恢复验证。请严格执行：先单独输出一行简短进度提示，并包含标记 " +
      progressMarker +
      "；然后只调用一次 read 工具读取文件 " +
      nonceRelativePath +
      "；收到工具结果后，用正文归纳其中的 nonce 与 note，并包含标记 " +
      finalMarker +
      "。不要调用其他工具，不要猜文件内容。";
    await firstPromptInput.fill(firstPrompt);
    const createWorkspaceButton = page.getByTestId("create-workspace");
    await createWorkspaceButton.waitFor({ state: "visible", timeout: 20_000 });
    assert.equal(
      await workspacePathInput.inputValue(),
      workspace,
      "the visible Mobile New Workspace form must retain this run's private workspace path",
    );
    await waitFor(
      () => createWorkspaceButton.isEnabled(),
      20_000,
      "Mobile New Workspace form readiness",
      100,
      context.abortSignal,
    );
    assert.equal(
      runtime.turnStarts.length,
      0,
      "no task turn may start before the explicit New Workspace submit action",
    );
    const completionCountBeforeFirst = runtime.completedTurns.length;
    caseStartedAt = Date.now();
    deadline = caseStartedAt + maxCaseMs;
    currentStage = "first-turn";
    caseDeadlineTimer = setTimeout(() => {
      void context.requestAbort(
        new Error("Mobile real Provider interaction reached its four-minute hard limit"),
      );
    }, maxCaseMs);
    caseDeadlineTimer.unref();
    await createWorkspaceButton.click();
    await page
      .getByTestId("message-input-root")
      .waitFor({ state: "visible", timeout: 30_000 });
    const routeBeforeRefresh = new URL(page.url()).pathname;
    const taskRoute = parseMobileTaskRoute(routeBeforeRefresh);
    assert.ok(
      taskRoute,
      "Mobile task must use /task/:server/:thread or /h/:profile/task/:server/:thread",
    );
    const { threadId, serverId } = taskRoute;
    assert.ok(threadId && serverId === "local");
    assert.equal(taskRoute.profileId, profileId);
    context.registerSecret(threadId);
    const progressWait = page
      .locator('[data-testid="message-assistant"]')
      .getByText(progressMarker, { exact: false })
      .first()
      .waitFor({ state: "visible", timeout: remaining(deadline, 100_000) })
      .then(() => {
        progressVisibleAt = Date.now();
        return true;
      })
      .catch(() => false);
    await waitFor(
      () =>
        runtime.completedTurns
          .slice(completionCountBeforeFirst)
          .some((turn) => turn.threadId === threadId),
      remaining(deadline, 130_000),
      "first real-provider Mobile turn completion",
      50,
      context.abortSignal,
    );
    const progressWasVisible = await progressWait;
    await page
      .locator('[data-testid="message-assistant"]')
      .getByText(finalMarker, { exact: false })
      .waitFor({ state: "visible", timeout: remaining(deadline, 20_000) });
    const readToolId = runtime.readToolId;
    assert.ok(readToolId, "real app-server item/started must identify the actual read tool call");
    const readToolTestId = "tool-call-" + encodeURIComponent(readToolId);
    await expandReadResult(page, readToolTestId);
    const firstAssistantBody = await assistantBodyTranscript(page);
    assert.ok(firstAssistantBody.includes(finalMarker), "first assistant body must include its final-summary marker");
    assert.ok(firstAssistantBody.includes(nonce), "first assistant body must summarize the actual read result nonce");
    assert.ok(firstAssistantBody.includes(note), "first assistant body must summarize the actual read result note");
    const readCard = page.getByTestId(readToolTestId);
    await readCard.waitFor({ state: "visible", timeout: 15_000 });
    const readCardText = await readCard.innerText();
    assert.ok(readCardText.includes(nonce) && readCardText.includes(note), "visible read tool result must contain the run-owned file content");

    const firstAttemptCount = attemptObserver.snapshot().attempts.length;
    assert.ok(firstAttemptCount >= 2, "first real tool cycle must have observable real Provider attempts");
    assert.ok(firstAttemptCount <= 2, "first turn exceeded the request budget reserved for the second turn");
    const firstTurnId = runtime.completedTurns
      .slice(completionCountBeforeFirst)
      .find((turn) => turn.threadId === threadId)?.turnId;
    assert.ok(firstTurnId, "first app-server completion must expose its real turn ID");
    const firstEventOrder = eventOrder(runtime.timeline, 1);
    const firstDomOrder = await inspectVisibleOrder(page, {
      progressMarker,
      finalMarker,
      secondMarker: secondAnswerMarker,
      readToolTestId,
      includeSecond: false,
    });
    const progressPattern =
      firstEventOrder.indexOf("progress") >= 0 &&
      firstEventOrder.indexOf("read_tool") >= 0 &&
      firstEventOrder.indexOf("progress") < firstEventOrder.indexOf("read_tool") &&
      progressWasVisible &&
      runtime.firstReadStartAt !== null &&
      progressVisibleAt !== null &&
      progressVisibleAt < runtime.firstReadStartAt
        ? "PASS"
        : "UNVERIFIED";
    const firstEventVisibleOrder = firstEventOrder.filter((kind) =>
      ["progress", "read_tool", "first_final"].includes(kind),
    );
    const observedFirstOrderMatchesEvents =
      JSON.stringify(firstDomOrder.order) ===
      JSON.stringify(firstEventVisibleOrder);
    const visibleOrderMatchesRealEvents =
      progressPattern === "PASS"
        ? observedFirstOrderMatchesEvents
          ? "PASS"
          : "FAIL"
        : "UNVERIFIED";
    if (progressPattern === "PASS") {
      assert.equal(
        observedFirstOrderMatchesEvents,
        true,
        "visible first-turn text/tool order must match real app-server event order",
      );
    }
    assert.equal(
      runtime.timeline.filter(
        (event) => event.turnOrdinal === 1 && event.kind === "read_tool_start",
      ).length,
      1,
      "the first real turn must invoke the read tool exactly once",
    );
    currentStage = "first-turn-complete";
    await context.writeArtifactJson("mobile-real-provider-history-first-turn.json", {
      stage: currentStage,
      routeKind: taskRoute.routeKind,
      taskRoute: safeTaskRoute(routeBeforeRefresh),
      providerPostRequests: providerBudgetProxy.snapshot().forwardedPostRequests,
      assertions: {
        realReadToolCallCount: 1,
        visibleReadResultContainsFixture: readCardText.includes(nonce) && readCardText.includes(note),
        assistantSummaryContainsFixture:
          firstAssistantBody.includes(nonce) && firstAssistantBody.includes(note),
        finalMarkerVisible: firstAssistantBody.includes(finalMarker),
        progressMarkerVisible: progressWasVisible,
        progressBeforeToolOrdering: progressPattern,
        visibleOrderMatchesRealEvents,
      },
      serverEventOrder: firstEventOrder,
      visibleOrder: firstDomOrder.order,
      recordedAtUtc: new Date().toISOString(),
    });

    const secondPrompt =
      "基于刚才同一任务中 read 工具返回的结果，不要调用工具。请说明那个 nonce 和 note，并在你的回答中包含 " +
      secondAnswerMarker +
      "。当前用户消息标记是 " +
      secondPromptMarker +
      "。";
    const completionCountBeforeSecond = runtime.completedTurns.length;
    currentStage = "second-turn";
    await page.getByTestId("message-input").fill(secondPrompt);
    await page.getByTestId("send-message").click();
    await waitFor(
      () =>
        runtime.completedTurns
          .slice(completionCountBeforeSecond)
          .some((turn) => turn.threadId === threadId),
      remaining(deadline, 100_000),
      "second real-provider Mobile turn completion",
      50,
      context.abortSignal,
    );
    await page
      .locator('[data-testid="message-assistant"]')
      .getByText(secondAnswerMarker, { exact: false })
      .waitFor({ state: "visible", timeout: remaining(deadline, 15_000) });
    const secondAssistantBody = await assistantBodyTranscript(page);
    assert.ok(secondAssistantBody.includes(secondAnswerMarker));
    assert.ok(secondAssistantBody.includes(nonce), "second real-model turn must recall the first tool result nonce");
    assert.ok(secondAssistantBody.includes(note), "second real-model turn must recall the first tool result note");
    assert.equal(
      runtime.timeline.filter(
        (event) => event.turnOrdinal === 2 && event.kind === "read_tool_start",
      ).length,
      0,
      "the second turn must use prior context without rereading the file",
    );
    const secondEventOrder = eventOrder(runtime.timeline, 2);
    assert.deepEqual(secondEventOrder, ["second_answer"]);
    const initialCompletedTurns = runtime.completedTurns.slice(
      completionCountBeforeFirst,
    );
    assert.equal(initialCompletedTurns.length, 2);
    assert.equal(
      new Set(initialCompletedTurns.map((turn) => turn.turnId)).size,
      2,
      "the two user messages must complete as two distinct real turns",
    );
    assert.ok(
      initialCompletedTurns.every((turn) => turn.status === "completed"),
      "both real-provider turns must report completed status",
    );
    const secondAttemptCount = attemptObserver.snapshot().attempts.length;
    assert.ok(
      secondAttemptCount <= maxProviderRequests,
      "real Provider attempt count exceeded this run's remaining three-request budget",
    );
    assert.equal(
      diagnostics.clientMessageIdEnumErrorSeen,
      false,
      "second turn must not surface a clientMessageId enum error",
    );
    assert.equal(runtime.turnStarts[1]?.clientMessageIdPresent, true);
    assert.equal(runtime.turnStarts[1]?.clientMessageIdType, "string");
    currentStage = "second-turn-complete";
    await context.writeArtifactJson("mobile-real-provider-history-second-turn.json", {
      stage: currentStage,
      providerPostRequests: providerBudgetProxy.snapshot().forwardedPostRequests,
      assertions: {
        twoDistinctCompletedTurns: initialCompletedTurns.length === 2,
        secondAnswerContainsPriorReadResult:
          secondAssistantBody.includes(nonce) && secondAssistantBody.includes(note),
        secondTurnReadToolCalls: runtime.timeline.filter(
          (event) => event.turnOrdinal === 2 && event.kind === "read_tool_start",
        ).length,
        clientMessageIdType: runtime.turnStarts[1]?.clientMessageIdType || null,
        clientMessageIdEnumErrorSeen:
          diagnostics.clientMessageIdEnumErrorSeen,
      },
      serverEventOrder: secondEventOrder,
      recordedAtUtc: new Date().toISOString(),
    });

    const activeRoute = new URL(page.url()).pathname;
    currentStage = "refresh-history";
    await page.reload({ waitUntil: "domcontentloaded" });
    await page
      .locator('[data-testid="message-assistant"]')
      .getByText(secondAnswerMarker, { exact: false })
      .waitFor({ state: "visible", timeout: remaining(deadline, 30_000) });
    await expandReadResult(page, readToolTestId);
    const afterRefresh = await inspectHistory(page, {
      progressMarker,
      finalMarker,
      secondAnswerMarker,
      firstPromptMarker: progressMarker,
      secondPromptMarker,
      nonce,
      threadId,
      readToolTestId,
    });
    assert.equal(afterRefresh.assistantCounts.firstFinal, 1);
    assert.equal(afterRefresh.assistantCounts.secondAnswer, 1);
    assert.ok(afterRefresh.assistantCounts.nonce >= 3);
    assert.ok(afterRefresh.assistantBodyNonceMentions >= 2);
    assert.equal(afterRefresh.userCounts.firstPrompt, 1);
    assert.equal(afterRefresh.userCounts.secondPrompt, 1);
    assert.equal(afterRefresh.readToolCards, 1);
    assert.equal(afterRefresh.routeMatchesThread, true);
    const fullVisibleOrder = [...firstDomOrder.order, "second_answer"];
    assert.deepEqual(afterRefresh.order, fullVisibleOrder);
    currentStage = "refresh-history-complete";
    await context.writeArtifactJson("mobile-real-provider-history-refresh.json", {
      stage: currentStage,
      route: safeTaskRoute(new URL(page.url()).pathname),
      providerPostRequests: providerBudgetProxy.snapshot().forwardedPostRequests,
      assertions: {
        firstAndSecondAssistantEachAppearOnce:
          afterRefresh.assistantCounts.firstFinal === 1 &&
          afterRefresh.assistantCounts.secondAnswer === 1,
        eachUserPromptAppearsOnce:
          afterRefresh.userCounts.firstPrompt === 1 &&
          afterRefresh.userCounts.secondPrompt === 1,
        readToolCards: afterRefresh.readToolCards,
        assistantBodyNonceMentions: afterRefresh.assistantBodyNonceMentions,
        routeMatchesThread: afterRefresh.routeMatchesThread,
        visibleOrderMatchesExpected:
          JSON.stringify(afterRefresh.order) === JSON.stringify(fullVisibleOrder),
      },
      visibleOrder: afterRefresh.order,
      recordedAtUtc: new Date().toISOString(),
    });

    currentStage = "return-home-and-open-history";
    const navigation = await returnHomeAndReenterTaskFromSessions(page, {
      profileId,
      threadId,
      expectedTaskPath: activeRoute,
      timeoutMs: remaining(deadline, 20_000),
    });
    const routeAfterReentry = new URL(page.url()).pathname;
    assert.equal(routeAfterReentry, activeRoute, "re-entry must restore the same task route");
    await page
      .locator('[data-testid="message-assistant"]')
      .getByText(secondAnswerMarker, { exact: false })
      .waitFor({ state: "visible", timeout: remaining(deadline, 15_000) });
    await expandReadResult(page, readToolTestId);
    const afterReentry = await inspectHistory(page, {
      progressMarker,
      finalMarker,
      secondAnswerMarker,
      firstPromptMarker: progressMarker,
      secondPromptMarker,
      nonce,
      threadId,
      readToolTestId,
    });
    assert.equal(afterReentry.assistantCounts.firstFinal, 1);
    assert.equal(afterReentry.assistantCounts.secondAnswer, 1);
    assert.ok(afterReentry.assistantCounts.nonce >= 3);
    assert.ok(afterReentry.assistantBodyNonceMentions >= 2);
    assert.equal(
      afterReentry.assistantCounts.nonce,
      afterRefresh.assistantCounts.nonce,
      "re-entry must not duplicate or lose nonce-bearing assistant content",
    );
    assert.equal(
      afterReentry.assistantBodyNonceMentions,
      afterRefresh.assistantBodyNonceMentions,
      "re-entry must preserve the same assistant body content",
    );
    assert.equal(afterReentry.userCounts.firstPrompt, 1);
    assert.equal(afterReentry.userCounts.secondPrompt, 1);
    assert.equal(afterReentry.readToolCards, 1);
    assert.equal(afterReentry.routeMatchesThread, true);
    assert.deepEqual(afterReentry.order, fullVisibleOrder);
    assert.equal(runtime.turnStarts.length, 2, "refresh/re-entry must not resubmit either user message");
    assert.equal(diagnostics.clientMessageIdEnumErrorSeen, false);
    currentStage = "history-reentry-complete";
    await context.writeArtifactJson("mobile-real-provider-history-reentry.json", {
      stage: currentStage,
      navigation,
      route: safeTaskRoute(routeAfterReentry),
      providerPostRequests: providerBudgetProxy.snapshot().forwardedPostRequests,
      assertions: {
        firstAndSecondAssistantEachAppearOnce:
          afterReentry.assistantCounts.firstFinal === 1 &&
          afterReentry.assistantCounts.secondAnswer === 1,
        eachUserPromptAppearsOnce:
          afterReentry.userCounts.firstPrompt === 1 &&
          afterReentry.userCounts.secondPrompt === 1,
        readToolCards: afterReentry.readToolCards,
        assistantBodyNonceMentions: afterReentry.assistantBodyNonceMentions,
        noDuplicateTurnStarts: runtime.turnStarts.length === 2,
        clientMessageIdEnumErrorSeen:
          diagnostics.clientMessageIdEnumErrorSeen,
      },
      visibleOrder: afterReentry.order,
      recordedAtUtc: new Date().toISOString(),
    });

    const processOwners = await ownedProcessSnapshot(
      gateway.child.pid,
      chromium.child.pid,
      expectedKcoderBin,
    );
    const appServers = processOwners.descendants.filter(
      (process) => process.executable === expectedKcoderBin,
    );
    assert.equal(appServers.length, 1, "the run-owned Gateway must own exactly one assigned app-server binary");
    appServerPid = appServers[0].pid;
    const attempts = attemptObserver.snapshot().attempts;
    const providerProxyStats = providerBudgetProxy.snapshot();
    assert.ok(attempts.length >= 3, "real Provider transport attempts must be observable");
    assert.ok(
      attempts.length <= maxProviderRequests,
      "real Provider request cap exceeded this run's remaining three-request budget",
    );
    assert.equal(
      attempts.length,
      providerProxyStats.forwardedPostRequests,
      "Gateway-observed Provider POST attempts must reconcile with requests forwarded by the owned proxy",
    );
    assert.ok(
      providerProxyStats.forwardedRequests <= maxProviderRequests,
      "owned Provider proxy must not forward more than this run's remaining three upstream requests",
    );
    assert.equal(
      providerProxyStats.locallyRejectedRequests,
      0,
      "the real-model interaction must finish without exhausting its upstream request budget",
    );
    assert.equal(providerProxyStats.inFlightRequests, 0);

    const report = {
      provider: {
        profile: model.profile,
        model: model.model,
        apiFormat: model.providerConfig.api_format,
        endpoint,
        gatewayHarnessEndpoint: providerBudgetProxy.endpoint,
        transport: "owned-loopback-transparent-provider-proxy",
      },
      budgets: {
        maximumProviderRequests: maxProviderRequests,
        previousRunCumulativeUpstreamUpperBound,
        previousRunObservedTransportAttempts,
        cumulativeProviderRequestBudget,
        cumulativeObservedUpstreamRequestUpperBound:
          previousRunCumulativeUpstreamUpperBound + providerProxyStats.forwardedRequests,
        observedProviderRequests: attempts.length,
        proxyForwardedRequests: providerProxyStats.forwardedRequests,
        proxyForwardedPostRequests: providerProxyStats.forwardedPostRequests,
        proxyLocallyRejectedRequests: providerProxyStats.locallyRejectedRequests,
        proxyBlockedRedirectResponses: providerProxyStats.blockedRedirectResponses,
        proxyInFlightRequestsAtEnd: providerProxyStats.inFlightRequests,
        observerMatchesProxyForwardedPosts:
          attempts.length === providerProxyStats.forwardedPostRequests,
        maxOutputTokensPerRequest: maxOutputTokens,
        retries: 0,
        caseLimitMs: maxCaseMs,
        elapsedMs: Date.now() - caseStartedAt,
      },
      mobileBundle: {
        inputMode: exportPerformed
          ? "export-from-pinned-immutable-source-snapshot"
          : "reuse-retained-public-mobile-web-export",
        exportPerformed,
        sourceSnapshotId: mobileSourceSnapshot.snapshotId,
        sourceSnapshotPath: mobileSourceSnapshot.relativeRoot,
        sourceSnapshotManifestPath: mobileSourceSnapshot.manifestRelativePath,
        sourceSnapshotManifestSha256:
          mobileSourceSnapshot.manifestSha256,
        sourceTreeSha256: web.sourceTreeSha256,
        bundleSha256: web.bundleSha256,
        bundleFileCount: web.bundleFileCount,
        indexHtmlSha256: web.indexHtmlSha256,
        bundleManifest: relative(repoRoot, webManifestPath),
        reuseProvenance: reuseProvenancePath
          ? relative(context.runRoot, reuseProvenancePath)
          : null,
        sourceManifestSha256: web.sourceManifestSha256 || null,
        sourceHashStartedAtUtc: web.sourceHashStartedAtUtc || null,
        exportCompletedAtUtc: web.exportCompletedAtUtc || null,
        sourceHashEndCompletedAtUtc:
          web.sourceHashEndCompletedAtUtc || null,
      },
      interaction: {
        viewport: { width: 390, height: 844 },
        taskRouteKind: taskRoute.routeKind,
        routeBeforeRefresh: safeTaskRoute(routeBeforeRefresh),
        routeAfterRefresh: safeTaskRoute(activeRoute),
        routeAfterReentry: safeTaskRoute(routeAfterReentry),
        threadIdSha256Prefix: hashPrefix(threadId),
        firstTurnIdSha256Prefix: hashPrefix(firstTurnId || ""),
        progressBeforeToolOrdering: progressPattern,
        firstTurnServerEventOrder: firstEventOrder,
        secondTurnServerEventOrder: secondEventOrder,
        firstTurnVisibleOrder: firstDomOrder.order,
        visibleOrderMatchesRealEvents,
        refreshHistory: afterRefresh,
        reentryHistory: afterReentry,
        turnStartCountAfterRecovery: runtime.turnStarts.length,
        secondTurnClientMessageIdType:
          runtime.turnStarts[1]?.clientMessageIdType || null,
        clientMessageIdEnumErrorSeen:
          diagnostics.clientMessageIdEnumErrorSeen,
      },
      providerAttempts: attempts,
      network: {
        requests: networkRequests,
        httpResponses: runtime.httpResponses.slice(0, 500),
        rpcMethodCounts: runtime.rpcMethodCounts(),
      },
      browserDiagnostics: diagnostics,
      processOwners: {
        gatewayPid: gateway.child.pid,
        chromiumPid: chromium.child.pid,
        appServerPid,
        gatewayPort: gateway.port,
        chromiumCdpPort: chromium.cdpPort,
        appServerExecutable: appServers[0].executable,
        descendants: processOwners.descendants,
      },
      nonceFileSha256: createHash("sha256")
        .update("nonce=" + nonce + "\nnote=" + note + "\n")
        .digest("hex"),
      assertions: {
        actualReadToolCall: true,
        firstSummaryUsedReadOutput: true,
        secondTurnRecalledPriorReadOutput: true,
        visibleOrderMatchesRealEvents,
        refreshAndReentryNoLossOrDuplicate: true,
        secondTurnClientMessageIdEnumError: false,
      },
      completedAtUtc: new Date().toISOString(),
    };
    assert.ok(Date.now() < deadline, "Mobile real Provider case must finish within four minutes");
    await context.writeArtifactJson("mobile-real-provider-history.json", report);
    return report;
    } catch (error) {
      if (evidencePage) {
        await captureRedactedMobileHistoryFailure(evidencePage, context, {
          stage: currentStage,
          error,
          providerCounters: providerBudgetProxy?.snapshot() || null,
        }).catch(() => undefined);
      }
      throw error;
    } finally {
      if (caseDeadlineTimer) clearTimeout(caseDeadlineTimer);
    }
  },
);

function describeEndpoint(endpoint) {
  try {
    const url = new URL(endpoint);
    return {
      protocol: url.protocol,
      hostname: url.hostname,
      port: Number(url.port || (url.protocol === "https:" ? 443 : 80)),
    };
  } catch {
    return { protocol: null, hostname: null, port: null };
  }
}

async function verifyPinnedMobileSourceSnapshot(context) {
  const snapshotRoot = resolve(repoRoot, mobileSourceSnapshotRelativeRoot);
  const manifestPath = resolve(snapshotRoot, "source-snapshot-manifest.json");
  const snapshotRootStat = await lstat(snapshotRoot);
  assert.ok(
    snapshotRootStat.isDirectory(),
    "UNMET_PREREQUISITE: pinned Mobile source snapshot root must be a real directory",
  );
  assert.equal(
    snapshotRootStat.uid,
    0,
    "UNMET_PREREQUISITE: pinned Mobile source snapshot directory must remain root-owned",
  );
  assert.equal(
    snapshotRootStat.mode & 0o777,
    0o555,
    "UNMET_PREREQUISITE: pinned Mobile source snapshot directory must remain read-only",
  );
  const manifestStat = await lstat(manifestPath);
  assert.ok(
    manifestStat.isFile(),
    "UNMET_PREREQUISITE: pinned Mobile source snapshot manifest must be a regular file",
  );
  assert.equal(
    manifestStat.uid,
    0,
    "UNMET_PREREQUISITE: pinned Mobile source snapshot manifest must remain root-owned",
  );
  assert.equal(
    manifestStat.mode & 0o777,
    0o444,
    "UNMET_PREREQUISITE: pinned Mobile source snapshot manifest must remain read-only",
  );
  const manifestBytes = await readFile(manifestPath);
  const manifestSha256 = createHash("sha256")
    .update(manifestBytes)
    .digest("hex");
  assert.equal(
    manifestSha256,
    expectedMobileSourceSnapshotManifestSha256,
    "UNMET_PREREQUISITE: pinned Mobile source snapshot manifest digest changed",
  );
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.snapshotId, expectedMobileSourceSnapshotId);
  const expectedMobileSharedSourceManifestRelativePath =
    `${mobileSourceSnapshotRelativeRoot}/mobile-shared-source-manifest.json`;
  assert.equal(
    manifest.source.mobileSharedSourceManifestPath,
    expectedMobileSharedSourceManifestRelativePath,
  );
  assert.equal(
    manifest.source.mobileSharedSourceManifestSha256,
    expectedMobileSharedSourceManifestSha256,
  );
  const sharedManifestPath = resolve(
    repoRoot,
    expectedMobileSharedSourceManifestRelativePath,
  );
  const sharedManifestStat = await lstat(sharedManifestPath);
  assert.ok(
    sharedManifestStat.isFile(),
    "UNMET_PREREQUISITE: frozen Mobile/shared source manifest must be a regular file",
  );
  assert.equal(sharedManifestStat.uid, 0);
  assert.equal(sharedManifestStat.mode & 0o777, 0o444);
  const sharedManifestBytes = await readFile(sharedManifestPath);
  const sharedManifestSha256 = createHash("sha256")
    .update(sharedManifestBytes)
    .digest("hex");
  assert.equal(
    sharedManifestSha256,
    expectedMobileSharedSourceManifestSha256,
    "UNMET_PREREQUISITE: frozen Mobile/shared source manifest digest changed",
  );
  const sharedManifest = JSON.parse(sharedManifestBytes.toString("utf8"));
  assert.equal(sharedManifest.schemaVersion, 1);
  assert.equal(sharedManifest.snapshotId, expectedMobileSourceSnapshotId);
  assert.equal(sharedManifest.fileCount, expectedMobileSourceFileCount);
  assert.equal(
    sharedManifest.current.sourceTreeSha256,
    expectedMobileSourceTreeSha256,
  );
  assert.deepEqual(
    sharedManifest.current.roots.map(({ name, destination, sha256, fileCount }) => ({
      name,
      destination,
      sha256,
      fileCount,
    })),
    [
      {
        name: "mobile",
        destination: "apps/kcoder-studio/mobile",
        sha256:
          "f118da42150892ea9ba421dc60dcd9e288f69bd82e93e1e69d9ba2bb21a017ef",
        fileCount: 230,
      },
      {
        name: "studio-shared",
        destination: "apps/kcoder-studio/shared",
        sha256:
          "0f524a2080981948914acfb668efb0e4a0e88619e65e5fc23d5260160834f745",
        fileCount: 9,
      },
    ],
  );
  assert.equal(sharedManifest.files.length, manifest.files.length);
  for (let index = 0; index < manifest.files.length; index += 1) {
    const sourceEntry = manifest.files[index];
    const sharedEntry = sharedManifest.files[index];
    assert.equal(sourceEntry.destinationPath, sharedEntry.destinationPath);
    assert.equal(sourceEntry.size, sharedEntry.size);
    assert.equal(sourceEntry.destinationSha256, sharedEntry.destinationSha256);
  }
  assert.equal(manifest.source.sourceTreeSha256, expectedMobileSourceTreeSha256);
  assert.equal(manifest.source.fileCount, expectedMobileSourceFileCount);
  assert.equal(manifest.destination.relativePath, mobileSourceSnapshotRelativeRoot);
  assert.equal(
    manifest.destination.sourceTreeSha256,
    expectedMobileSourceTreeSha256,
  );
  assert.equal(
    manifest.destination.destinationTreeSha256,
    expectedMobileSourceTreeSha256,
  );
  assert.equal(manifest.destination.fileCount, expectedMobileSourceFileCount);
  assert.equal(manifest.destination.directoriesReadOnlyMode, "0555");
  assert.equal(manifest.destination.filesReadOnlyMode, "0444");
  assert.equal(manifest.destination.unixOwnerAfterFreeze, "root:root");
  assert.deepEqual(manifest.sensitiveManifestPaths, []);
  assert.equal(manifest.files.length, expectedMobileSourceFileCount);

  const expectedRoots = [
    {
      name: "mobile",
      destination: "apps/kcoder-studio/mobile",
      fileCount: 230,
      sha256: "f118da42150892ea9ba421dc60dcd9e288f69bd82e93e1e69d9ba2bb21a017ef",
    },
    {
      name: "studio-shared",
      destination: "apps/kcoder-studio/shared",
      fileCount: 9,
      sha256: "0f524a2080981948914acfb668efb0e4a0e88619e65e5fc23d5260160834f745",
    },
  ];
  assert.equal(manifest.roots.length, expectedRoots.length);
  for (let index = 0; index < expectedRoots.length; index += 1) {
    const actual = manifest.roots[index];
    const expected = expectedRoots[index];
    assert.equal(actual.name, expected.name);
    assert.equal(actual.destination, expected.destination);
    assert.equal(actual.fileCount, expected.fileCount);
    assert.equal(actual.expectedSha256, expected.sha256);
    assert.equal(actual.sourceRecomputedSha256, expected.sha256);
    assert.equal(actual.destinationRecomputedSha256, expected.sha256);
  }

  const verifiedDirectories = new Set([snapshotRoot]);
  const seenFiles = new Set();
  for (const entry of manifest.files) {
    assert.ok(entry && typeof entry === "object" && !Array.isArray(entry));
    assert.ok(
      entry.root === "mobile" || entry.root === "studio-shared",
      "UNMET_PREREQUISITE: source snapshot contains an unknown root",
    );
    assert.ok(
      typeof entry.destinationPath === "string" &&
        !isAbsolute(entry.destinationPath),
      "UNMET_PREREQUISITE: source snapshot destination path must be relative",
    );
    const filePath = resolve(snapshotRoot, entry.destinationPath);
    const fileRelativePath = relative(snapshotRoot, filePath);
    assert.ok(
      fileRelativePath &&
        fileRelativePath !== ".." &&
        !fileRelativePath.startsWith(`..${sep}`) &&
        !isAbsolute(fileRelativePath),
      "UNMET_PREREQUISITE: source snapshot destination escaped its immutable root",
    );
    assert.equal(
      resolve(snapshotRoot, fileRelativePath),
      filePath,
      "UNMET_PREREQUISITE: source snapshot path must be normalized",
    );
    const expectedPrefix =
      entry.root === "mobile"
        ? "apps/kcoder-studio/mobile/"
        : "apps/kcoder-studio/shared/";
    assert.ok(
      fileRelativePath.startsWith(expectedPrefix),
      "UNMET_PREREQUISITE: source snapshot file is outside its declared root",
    );
    assert.ok(!seenFiles.has(fileRelativePath));
    seenFiles.add(fileRelativePath);
    assert.ok(Number.isSafeInteger(entry.size) && entry.size >= 0);
    assert.match(entry.destinationSha256, /^[a-f0-9]{64}$/);
    assert.equal(entry.destinationSha256, entry.sourceSha256);

    const directoryParts = relative(snapshotRoot, dirname(filePath))
      .split(sep)
      .filter(Boolean);
    let currentDirectory = snapshotRoot;
    for (const part of directoryParts) {
      currentDirectory = resolve(currentDirectory, part);
      if (verifiedDirectories.has(currentDirectory)) continue;
      const directoryStat = await lstat(currentDirectory);
      assert.ok(
        directoryStat.isDirectory(),
        "UNMET_PREREQUISITE: source snapshot path contains a non-directory ancestor",
      );
      assert.equal(
        directoryStat.uid,
        0,
        "UNMET_PREREQUISITE: source snapshot subdirectories must remain root-owned",
      );
      assert.equal(
        directoryStat.mode & 0o777,
        0o555,
        "UNMET_PREREQUISITE: source snapshot subdirectories must remain read-only",
      );
      verifiedDirectories.add(currentDirectory);
    }

    const fileStat = await lstat(filePath);
    assert.ok(
      fileStat.isFile(),
      "UNMET_PREREQUISITE: source snapshot entry must be a regular file",
    );
    assert.equal(
      fileStat.uid,
      0,
      "UNMET_PREREQUISITE: source snapshot files must remain root-owned",
    );
    assert.equal(
      fileStat.mode & 0o777,
      0o444,
      "UNMET_PREREQUISITE: source snapshot files must remain read-only",
    );
    const contents = await readFile(filePath);
    assert.equal(contents.byteLength, entry.size);
    assert.equal(
      createHash("sha256").update(contents).digest("hex"),
      entry.destinationSha256,
      "UNMET_PREREQUISITE: source snapshot file digest differs from the pinned manifest",
    );
  }
  assert.equal(seenFiles.size, expectedMobileSourceFileCount);
  const frozenBuildInputPins = [
    {
      path: "apps/kcoder-studio/mobile/package.json",
      size: 2387,
      sha256: "71846aa500d5eaed120bb963f17bd9c3600b21395cbba10534fc0770a78814c0",
    },
    {
      path: "apps/kcoder-studio/mobile/package-lock.json",
      size: 457167,
      sha256: "848076f520f165128b601b27d96d4d32cf25e8929ee54b672f198b9a4c224e26",
    },
  ];
  for (const expected of frozenBuildInputPins) {
    const actual = manifest.files.find(
      (entry) => entry.destinationPath === expected.path,
    );
    assert.ok(actual, `UNMET_PREREQUISITE: missing frozen build input ${expected.path}`);
    assert.equal(actual.size, expected.size);
    assert.equal(actual.destinationSha256, expected.sha256);
  }

  const verification = {
    status: "verified",
    snapshotId: expectedMobileSourceSnapshotId,
    snapshotPath: mobileSourceSnapshotRelativeRoot,
    manifestPath: relative(repoRoot, manifestPath),
    manifestSha256,
    sourceTreeSha256: expectedMobileSourceTreeSha256,
    fileCount: expectedMobileSourceFileCount,
    verifiedFileCount: seenFiles.size,
    sharedManifestPath: expectedMobileSharedSourceManifestRelativePath,
    sharedManifestSha256,
    frozenBuildInputPins,
    rootOwned: true,
    immutableModesVerified: true,
    sensitiveManifestPaths: 0,
    inspectedAtUtc: new Date().toISOString(),
  };
  const artifactPath = await context.writeArtifactJson(
    "mobile-source-freeze-verification.json",
    verification,
  );
  return {
    root: snapshotRoot,
    relativeRoot: mobileSourceSnapshotRelativeRoot,
    snapshotId: expectedMobileSourceSnapshotId,
    manifestPath,
    manifestRelativePath: relative(repoRoot, manifestPath),
    manifestSha256,
    sourceTreeSha256: expectedMobileSourceTreeSha256,
    sharedManifestPath,
    sharedManifestSha256,
    verificationArtifactPath: artifactPath,
  };
}

async function configGet(kcoderBin, cwd, env, key, profile) {
  const args = ["--cwd", cwd];
  if (profile) args.push("--profile", profile);
  args.push("config", "get", key);
  try {
    const result = await execFileAsync(kcoderBin, args, {
      cwd,
      env,
      encoding: "utf8",
      timeout: 15_000,
      maxBuffer: 64 * 1024,
    });
    return String(result.stdout).trim();
  } catch {
    throw new Error(
      `UNMET_PREREQUISITE: typed Provider setting '${key}' could not be resolved`,
    );
  }
}

function probeEndpoint(endpoint, timeoutMs) {
  return new Promise((resolveResult) => {
    let url;
    try {
      url = new URL(endpoint);
    } catch {
      resolveResult(false);
      return;
    }
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
    const finish = (reachable) => resolveResult(reachable);
    const socket =
      url.protocol === "https:"
        ? tls.connect(
            {
              host: hostname,
              port,
              servername: hostname,
              timeout: timeoutMs,
              rejectUnauthorized: true,
            },
            () => {
              socket.end();
              finish(true);
            },
          )
        : net.connect({ host: hostname, port, timeout: timeoutMs }, () => {
            socket.end();
            finish(true);
          });
    socket.once("error", () => finish(false));
    socket.once("timeout", () => {
      socket.destroy();
      finish(false);
    });
  });
}

function createProviderAttemptObserver() {
  let pending = "";
  const attempts = [];
  return {
    consume(chunk) {
      pending += String(chunk);
      const lines = pending.split("\n");
      pending = lines.pop().slice(-65_536);
      for (const line of lines) {
        if (!line.includes("kcoder::transport_metrics: provider transport attempt"))
          continue;
        const number = (field) => {
          const match = line.match(new RegExp("\\b" + field + "=(?:Some\\()?([0-9]+)"));
          return match ? Number(match[1]) : null;
        };
        const protocol = line.match(/\bprotocol="(chat|responses|anthropic)"/)?.[1] || null;
        const outcome = line.match(/\boutcome=Some\((\w+)\)/)?.[1] || null;
        if (attempts.length < 8)
          attempts.push({
            protocol,
            outcome,
            status: number("status"),
            elapsedUs: number("elapsed_us"),
            inputTokens: number("input_tokens"),
            outputTokens: number("output_tokens"),
          });
      }
    },
    flush() {
      if (pending) this.consume("\n");
    },
    snapshot() {
      return { attempts: attempts.map((attempt) => ({ ...attempt })) };
    },
  };
}

function createRuntimeObserver({ progressMarker, finalMarker, secondAnswerMarker, diagnostics }) {
  const timeline = [];
  const turnStarts = [];
  const completedTurns = [];
  const httpResponses = [];
  const requestById = new Map();
  const ordinalByTurnId = new Map();
  const streamedTextByTurn = new Map();
  const seenMarkerEvents = new Set();
  const rpcCounts = new Map();
  let sequence = 0;
  let firstReadStartAt = null;
  let readToolId = null;
  return {
    timeline,
    turnStarts,
    completedTurns,
    httpResponses,
    get firstReadStartAt() {
      return firstReadStartAt;
    },
    get readToolId() {
      return readToolId;
    },
    rpcMethodCounts() {
      return Object.fromEntries([...rpcCounts.entries()].sort(([a], [b]) => a.localeCompare(b)));
    },
    attach(page) {
      page.on("websocket", (socket) => {
        socket.on("framesent", ({ payload }) => {
          const frame = parseFrame(payload);
          if (!frame || typeof frame.method !== "string") return;
          rpcCounts.set(frame.method, (rpcCounts.get(frame.method) || 0) + 1);
          if (frame.method === "turn/start") {
            const ordinal = turnStarts.length + 1;
            const row = {
              ordinal,
              clientMessageIdPresent: Object.hasOwn(frame.params || {}, "clientMessageId"),
              clientMessageIdType:
                frame.params?.clientMessageId === null
                  ? "null"
                  : typeof frame.params?.clientMessageId,
              enumError: false,
            };
            turnStarts.push(row);
            if (frame.id !== undefined)
              requestById.set(String(frame.id), { method: frame.method, ordinal });
          } else if (frame.id !== undefined) {
            requestById.set(String(frame.id), { method: frame.method, ordinal: null });
          }
        });
        socket.on("framereceived", ({ payload }) => {
          const frame = parseFrame(payload);
          if (!frame) return;
          if (frame.id !== undefined) {
            const request = requestById.get(String(frame.id));
            if (request && frame.error) {
              const message = String(frame.error.message || "");
              if (isClientMessageIdEnumError(message)) {
                diagnostics.clientMessageIdEnumErrorSeen = true;
                if (request.method === "turn/start" && request.ordinal)
                  turnStarts[request.ordinal - 1].enumError = true;
              }
            }
            const acceptedTurnId = frame.result?.turn?.id;
            if (
              request?.method === "turn/start" &&
              request.ordinal &&
              typeof acceptedTurnId === "string"
            ) {
              ordinalByTurnId.set(acceptedTurnId, request.ordinal);
              turnStarts[request.ordinal - 1].serverTurnId = acceptedTurnId;
            }
            requestById.delete(String(frame.id));
          }
          if (typeof frame.method !== "string") return;
          const params = frame.params || {};
          const turnId = typeof params.turnId === "string" ? params.turnId : null;
          let turnOrdinal = turnId ? ordinalByTurnId.get(turnId) || null : null;
          if (frame.method === "turn/started" && turnId && !turnOrdinal) {
            turnOrdinal = turnStarts.length;
            ordinalByTurnId.set(turnId, turnOrdinal);
          }
          if (frame.method === "turn/completed") {
            if (turnId && !turnOrdinal) turnOrdinal = ordinalByTurnId.get(turnId) || null;
            completedTurns.push({
              threadId: typeof params.threadId === "string" ? params.threadId : null,
              turnId,
              turnOrdinal,
              status: params.turn?.status || params.status || null,
            });
            pushTimeline(timeline, () => sequence++, turnOrdinal, "turn_completed");
            return;
          }
          if (frame.method === "item/delta") {
            const text = deltaText(params.delta);
            const priorText = streamedTextByTurn.get(turnOrdinal) || "";
            const accumulatedText = priorText + text;
            streamedTextByTurn.set(turnOrdinal, accumulatedText);
            for (const [marker, kind] of [
              [progressMarker, "progress"],
              [finalMarker, "first_final"],
              [secondAnswerMarker, "second_answer"],
            ]) {
              if (
                seenMarkerEvents.has(kind) ||
                !accumulatedText.includes(marker)
              )
                continue;
              seenMarkerEvents.add(kind);
              const event = {
                sequence: sequence++,
                turnOrdinal,
                kind,
              };
              timeline.push(event);
            }
            return;
          }
          const item = params.item || {};
          const name = String(
            item.name || item.toolName || item.tool?.name || item.toolCall?.name || "",
          );
          const isTool = String(item.type || "").toLowerCase().includes("tool");
          if (isTool && frame.method === "item/started") {
            const kind = name.toLowerCase() === "read" ? "read_tool_start" : "other_tool_start";
            const at = Date.now();
            if (kind === "read_tool_start" && firstReadStartAt === null) {
              firstReadStartAt = at;
              if (typeof item.id === "string") readToolId = item.id;
            }
            pushTimeline(timeline, () => sequence++, turnOrdinal, kind);
          } else if (isTool && frame.method === "item/completed") {
            pushTimeline(
              timeline,
              () => sequence++,
              turnOrdinal,
              name.toLowerCase() === "read" ? "read_tool_complete" : "other_tool_complete",
            );
          }
        });
      });
    },
  };
}

function pushTimeline(timeline, nextSequence, turnOrdinal, kind) {
  timeline.push({ sequence: nextSequence(), turnOrdinal, kind });
}

function eventOrder(timeline, turnOrdinal) {
  const order = [];
  const map = {
    progress: "progress",
    read_tool_start: "read_tool",
    read_tool_complete: "read_tool_complete",
    first_final: "first_final",
    second_answer: "second_answer",
  };
  for (const event of timeline) {
    if (event.turnOrdinal !== turnOrdinal || !map[event.kind]) continue;
    const kind = map[event.kind];
    if (kind === "read_tool_complete") continue;
    if (order.at(-1) !== kind) order.push(kind);
  }
  return order;
}

async function connectMobile(page, gateway, context) {
  let stage = "open-gateway-login";
  try {
    await connectMobileWithGatewayAuth(page, gateway, {
      onStage: (value) => {
        stage = value;
      },
    });
  } catch (error) {
    await captureSafeMobileBootstrapFailure(page, context, stage);
    throw error;
  }
}

async function captureSafeMobileBootstrapFailure(page, context, stage) {
  const dom = await page
    .evaluate(() => {
      const isVisible = (element) => element.getClientRects().length > 0;
      const visibleTestIds = Array.from(
        document.querySelectorAll("[data-testid]"),
      )
        .filter(isVisible)
        .map((element) => element.getAttribute("data-testid"))
        .filter((value) =>
          typeof value === "string" && /^[A-Za-z0-9._-]{1,100}$/.test(value),
        )
        .slice(0, 100);
      const secretInputFields = [
        ...document.querySelectorAll(
          'input[name="token"], input[data-testid="gateway-token"], [data-testid="gateway-token"] input',
        ),
      ].map((element) => ({
        selector:
          element.getAttribute("name") === "token"
            ? 'input[name="token"]'
            : element.matches('input[data-testid="gateway-token"]')
              ? 'input[data-testid="gateway-token"]'
              : '[data-testid="gateway-token"] input',
        type: element.type,
        visible: isVisible(element),
        valuePresent: Boolean(element.value),
      }));
      const pathname = window.location.pathname;
      return {
        diagnosticsAvailable: true,
        pathname:
          pathname.length <= 160 && /^[A-Za-z0-9/_-]*$/.test(pathname)
            ? pathname
            : "(omitted)",
        title: document.title.slice(0, 100),
        visibleTestIds,
        secretInputFields,
      };
    })
    .catch(() => ({
      diagnosticsAvailable: false,
      pathname: "(unavailable)",
      title: "",
      visibleTestIds: [],
      secretInputFields: [],
    }));
  const canCaptureScreenshot =
    dom.diagnosticsAvailable &&
    dom.secretInputFields
      .filter((field) => field.visible && field.valuePresent)
      .every((field) => field.type === "password");
  let screenshot = null;
  if (canCaptureScreenshot) {
    screenshot = "mobile-connect-bootstrap-failure.png";
    await page
      .screenshot({ path: context.pathInArtifacts(screenshot) })
      .catch(() => {
        screenshot = null;
      });
  }
  await context.writeArtifactJson("mobile-connect-bootstrap-failure.json", {
    stage,
    diagnosticsAvailable: dom.diagnosticsAvailable,
    pathname: dom.pathname,
    title: dom.title,
    visibleTestIds: dom.visibleTestIds,
    secretInputFields: dom.secretInputFields,
    screenshot,
    screenshotSuppressedReason: canCaptureScreenshot
      ? null
      : dom.diagnosticsAvailable
        ? "visible-credential-is-not-password-masked"
        : "dom-diagnostics-unavailable",
  });
}

async function assistantTranscript(page) {
  return page
    .locator('[data-testid="message-assistant"]')
    .allInnerTexts()
    .then((rows) => rows.join("\n"));
}

async function assistantBodyTranscript(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid="message-assistant"]'))
      .map((row) => {
        const body = row.cloneNode(true);
        for (const tool of body.querySelectorAll('[data-testid^="tool-call-"]'))
          tool.remove();
        return body.innerText || "";
      })
      .join("\n"),
  );
}

async function inspectVisibleOrder(page, { progressMarker, finalMarker, secondMarker, readToolTestId, includeSecond }) {
  return page.evaluate(
    ({ progress, final, second, readToolId, includeSecond: withSecond }) => {
      const rows = Array.from(document.querySelectorAll('[data-testid="message-assistant"]'));
      const leafFor = (marker) => {
        for (const row of rows) {
          const leaf = Array.from(row.querySelectorAll("*"))
            .filter((node) => node.childElementCount === 0)
            .find((node) => node.textContent?.includes(marker) && isVisible(node));
          if (leaf) return leaf;
          if (row.textContent?.includes(marker) && isVisible(row)) return row;
        }
        return null;
      };
      const isVisible = (node) => {
        if (!node || node.getClientRects().length === 0) return false;
        const style = getComputedStyle(node);
        return style.display !== "none" && style.visibility !== "hidden";
      };
      const entries = [];
      if (leafFor(progress)) entries.push({ key: "progress", node: leafFor(progress) });
      const tool = Array.from(document.querySelectorAll('[data-testid^="tool-call-"]'))
        .find((node) => node.getAttribute("data-testid") === readToolId);
      if (isVisible(tool)) entries.push({ key: "read_tool", node: tool });
      if (leafFor(final)) entries.push({ key: "first_final", node: leafFor(final) });
      if (withSecond && leafFor(second)) entries.push({ key: "second_answer", node: leafFor(second) });
      const order = [...entries]
        .sort((left, right) => {
          if (left.node === right.node) return 0;
          const position = left.node.compareDocumentPosition(right.node);
          if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
          if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1;
          return 0;
        })
        .map((entry) => entry.key);
      const countInAssistant = (marker) =>
        rows.filter(isVisible).reduce((total, row) => {
          const text = row.innerText || "";
          return total + Math.max(0, text.split(marker).length - 1);
        }, 0);
      return {
        order,
        progressCount: countInAssistant(progress),
        firstFinalCount: countInAssistant(final),
        secondAnswerCount: withSecond ? countInAssistant(second) : 0,
        readToolCards: Array.from(document.querySelectorAll('[data-testid^="tool-call-"]'))
          .filter((node) => node.getAttribute("data-testid") === readToolId).length,
      };
    },
    {
      progress: progressMarker,
      final: finalMarker,
      second: secondMarker,
      readToolId: readToolTestId,
      includeSecond,
    },
  );
}

async function inspectHistory(page, options) {
  const visible = await inspectVisibleOrder(page, {
    progressMarker: options.progressMarker,
    finalMarker: options.finalMarker,
    secondMarker: options.secondAnswerMarker,
    readToolTestId: options.readToolTestId,
    includeSecond: true,
  });
  const userCounts = await page.evaluate(
    ({ firstPromptMarker, secondPromptMarker }) => {
      const rows = Array.from(document.querySelectorAll('[data-testid="message-user"]'));
      const count = (marker) =>
        rows.reduce((total, row) => {
          const text = row.innerText || "";
          return total + Math.max(0, text.split(marker).length - 1);
        }, 0);
      return {
        firstPrompt: count(firstPromptMarker),
        secondPrompt: count(secondPromptMarker),
      };
    },
    {
      firstPromptMarker: options.firstPromptMarker,
      secondPromptMarker: options.secondPromptMarker,
    },
  );
  const assistantText = await assistantTranscript(page);
  const assistantBodyText = await assistantBodyTranscript(page);
  return {
    order: visible.order,
    assistantCounts: {
      progress: visible.progressCount,
      firstFinal: visible.firstFinalCount,
      secondAnswer: visible.secondAnswerCount,
      nonce: assistantText.split(options.nonce).length - 1,
    },
    assistantBodyNonceMentions:
      assistantBodyText.split(options.nonce).length - 1,
    userCounts,
    readToolCards: visible.readToolCards,
    routeMatchesThread:
      new URL(page.url()).pathname.endsWith("/" + encodeURIComponent(options.threadId)) ||
      new URL(page.url()).pathname.endsWith("/" + options.threadId),
  };
}

function deltaText(delta) {
  if (typeof delta === "string") return delta;
  if (!delta || typeof delta !== "object") return "";
  return [delta.text, delta.content, delta.output_text]
    .filter((value) => typeof value === "string")
    .join("");
}

function parseFrame(payload) {
  try {
    return JSON.parse(String(payload));
  } catch {
    return null;
  }
}

function isClientMessageIdEnumError(value) {
  return /clientMessageId/i.test(value) && /(enum|variant|expected)/i.test(value);
}

function remaining(deadline, requestedMs) {
  const available = deadline - Date.now();
  assert.ok(available > 0, "Mobile real Provider case exceeded its four-minute budget");
  return Math.min(requestedMs, available);
}

function hashPrefix(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

async function ownedProcessSnapshot(gatewayPid, chromiumPid, expectedKcoderBin) {
  const procEntries = await readdir("/proc", { withFileTypes: true });
  const processes = new Map();
  for (const entry of procEntries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    const pid = Number(entry.name);
    try {
      const stat = await readFile("/proc/" + pid + "/stat", "utf8");
      const end = stat.lastIndexOf(")");
      const fields = stat.slice(end + 2).trim().split(/\s+/);
      const ppid = Number(fields[1]);
      const comm = (await readFile("/proc/" + pid + "/comm", "utf8")).trim();
      const executable = await readlink("/proc/" + pid + "/exe").catch(() => "");
      processes.set(pid, { pid, ppid, comm, executable });
    } catch {
      // Processes can exit while the read-only /proc snapshot is collected.
    }
  }
  const descendants = [];
  const queue = [gatewayPid];
  const visited = new Set(queue);
  while (queue.length) {
    const parent = queue.shift();
    for (const process of processes.values()) {
      if (process.ppid !== parent || visited.has(process.pid)) continue;
      visited.add(process.pid);
      queue.push(process.pid);
      descendants.push({
        pid: process.pid,
        ppid: process.ppid,
        comm: process.comm,
        executable: process.executable,
      });
    }
  }
  const chromium = processes.get(chromiumPid);
  const gateway = processes.get(gatewayPid);
  assert.equal(gateway?.pid, gatewayPid, "owned Gateway PID must exist during the live browser interaction");
  assert.equal(chromium?.pid, chromiumPid, "owned Chromium PID must exist during the live browser interaction");
  assert.ok(
    descendants.some((process) => process.executable === expectedKcoderBin),
    "the owned Gateway process tree must include the assigned app-server binary",
  );
  return { gateway, chromium, descendants };
}

async function procEntryExists(pid) {
  try {
    await access("/proc/" + pid + "/stat");
    return true;
  } catch {
    return false;
  }
}
