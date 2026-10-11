import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { startChromium } from "../../harness/chromium.mjs";
import {
  startGateway,
  waitForGatewayRpcToken,
} from "../../harness/gateway.mjs";
import { reuseMobileWebExport } from "../../harness/mobile-web-export-reuse.mjs";
import { findOwnedExecutableProcesses, hashExecutableFile } from "../../harness/owned-executable-provenance.mjs";
import {
  closeRpcAndWait,
  gatewayRpcUrl,
  initializeRpc,
  openRpc,
} from "../../harness/rpc.mjs";
import {
  repoRoot,
  runE2E,
  waitFor,
} from "../../harness/run-context.mjs";
import { startProviderRequestObserver } from "../../harness/provider-request-observer.mjs";
import { materializeWorkspace } from "../../harness/workspace-fixture.mjs";
import {
  captureRedactedMobileHistoryFailure,
  connectMobileWithGatewayAuth,
  parseMobileProfileHomeRoute,
  parseMobileTaskRoute,
  returnHomeAndReenterTaskFromSessions,
  safeTaskRoute,
} from "./real-provider-history-assertions.mjs";

const expectedKcoderBin = resolve(
  repoRoot,
  "target/test/coordination/mobile-eight-hour-audit/20260930-162836.000Z/final-app-server-idgate-20260930-221900Z/kcoder",
);
const expectedKcoderSha256 =
  "2a792be7e0033140dc93bf78d07567371c1f077653f1361985419791f917667c";
const expectedKcoderBinarySize = 406236048;
const expectedKcoderProvenanceRelativePath =
  "target/test/coordination/mobile-eight-hour-audit/20260930-162836.000Z/final-app-server-idgate-20260930-221900Z/binary-provenance.json";
const expectedKcoderProvenanceSha256 =
  "4fe27367f70221fa1d6b90e85eca666916b52e512e9523b1845831d999c1d9f3";

const sourceSnapshotRelativeRoot =
  "target/test/coordination/mobile-source-freezes/20261001-002529Z-taskheader-sessions";
const expectedSourceSnapshotId = "20261001-002529Z-taskheader-sessions";
const expectedSourceSnapshotManifestSha256 =
  "ece905d77de78c401b65d0eb27716a2379ab360cb5da6ec6206fb61b8e4aa42c";
const expectedSharedSourceManifestSha256 =
  "615c2c29e38c4276426f11142cde445da4274e3676186482431476be073fa518";
const expectedSourceTreeSha256 =
  "9cffbf156fd1351a9aecaf7c4cad8e898adc14126656d740ec614e88e2f88cd2";
const expectedSourceFileCount = 239;

const retainedBundleManifestPath = resolve(
  repoRoot,
  "target/test/apps/kcoder-studio/e2e/harness/mobile-web-export.test.mjs/20261001-002921.344Z/artifacts/public-mobile-web-export-manifest.json",
);
const expectedRetainedBundleManifestSha256 =
  "5eb8648ef848c40e5787abe29aad345f080d6d202e71bf872d97013906dca9fb";
const expectedWebBundleSha256 =
  "d1382f9b0aeeab7d24fa54d55da81043debd905df98577c69e54a89b177798e8";
const expectedWebBundleFileCount = 37;
const expectedIndexHtmlSha256 =
  "53ea1564a7808bb60c2fbdbf9c5ac4734fc0b6b05637ef0d92a22c0c30aa329d";

await runE2E(
  import.meta.url,
  {
    testId: "mobile-real-provider-history-navigation-only",
    tier: "model-independent",
    modelPolicy:
      "model-independent real Mobile Web + Gateway + pinned Rust app-server navigation; creates one empty thread, sends no turn, and asserts zero Provider requests; no model-behavior claim",
    retainSuccessLogs: true,
  },
  async (context) => {
    let page = null;
    let currentStage = "preflight";
    let gateway = null;
    let gatewayProcessGroupId = null;
    let chromium = null;
    let seedRpc = null;
    let providerObserver = null;
    try {
      assert.equal(
        process.env.KCODER_E2E_CHROMIUM_NO_SANDBOX,
        "1",
        "UNMET_PREREQUISITE: isolated VM Chromium requires explicit KCODER_E2E_CHROMIUM_NO_SANDBOX=1",
      );
      const configuredBinary = resolve(
        process.env.KCODER_E2E_KCODER_BIN || expectedKcoderBin,
      );
      assert.equal(configuredBinary, expectedKcoderBin);
      const binaryStat = await lstat(configuredBinary);
      assert.ok(binaryStat.isFile());
      assert.equal(binaryStat.uid, 0);
      assert.equal(binaryStat.gid, 0);
      assert.equal(binaryStat.mode & 0o777, 0o555);
      assert.equal(binaryStat.size, expectedKcoderBinarySize);
      const binary = await hashExecutableFile(configuredBinary);
      assert.equal(binary.sha256, expectedKcoderSha256);

      const provenancePath = resolve(repoRoot, expectedKcoderProvenanceRelativePath);
      const provenanceStat = await lstat(provenancePath);
      assert.ok(provenanceStat.isFile());
      assert.equal(provenanceStat.uid, 0);
      assert.equal(provenanceStat.gid, 0);
      assert.equal(provenanceStat.mode & 0o777, 0o444);
      const provenanceBytes = await readFile(provenancePath);
      assert.equal(
        sha256(provenanceBytes),
        expectedKcoderProvenanceSha256,
      );
      const provenance = JSON.parse(provenanceBytes.toString("utf8"));
      assert.equal(provenance.binarySha256, expectedKcoderSha256);
      assert.equal(provenance.size, expectedKcoderBinarySize);
      assert.equal(provenance.immutableCopiedBinaryPath, expectedKcoderBin);

      const sourceSnapshot = await verifyPinnedSourceSnapshot(context);
      const retainedManifestBytes = await readFile(retainedBundleManifestPath);
      assert.equal(
        sha256(retainedManifestBytes),
        expectedRetainedBundleManifestSha256,
        "UNMET_PREREQUISITE: retained common bundle manifest digest changed",
      );
      const retainedManifest = JSON.parse(retainedManifestBytes.toString("utf8"));
      assert.equal(retainedManifest.bundleSha256, expectedWebBundleSha256);
      assert.equal(retainedManifest.bundleFileCount, expectedWebBundleFileCount);
      assert.equal(retainedManifest.indexHtmlSha256, expectedIndexHtmlSha256);
      const retainedRunRoot = dirname(dirname(retainedBundleManifestPath));
      const retainedBundleRoot = resolve(retainedRunRoot, retainedManifest.directory);
      const web = await reuseMobileWebExport(context, {
        bundleRoot: retainedBundleRoot,
        manifestPath: retainedBundleManifestPath,
        expectedSourceTreeSha256: expectedSourceTreeSha256,
        expectedManifestSha256: expectedRetainedBundleManifestSha256,
        expectedBundleSha256: expectedWebBundleSha256,
        label: "mobile-history-navigation-retained-9cff-web",
        outputName: "mobile-history-navigation-web-root",
      });
      assert.equal(web.exportPerformed, false);
      assert.equal(web.bundleFileCount, expectedWebBundleFileCount);
      assert.equal(web.bundleSha256, expectedWebBundleSha256);
      assert.equal(web.indexHtmlSha256, expectedIndexHtmlSha256);

      await context.writeArtifactJson("navigation-source-and-bundle.json", {
        sourceSnapshotId: expectedSourceSnapshotId,
        sourceSnapshotPath: sourceSnapshot.relativePath,
        sourceSnapshotManifestSha256: sourceSnapshot.manifestSha256,
        sharedSourceManifestSha256: sourceSnapshot.sharedManifestSha256,
        sourceTreeSha256: sourceSnapshot.sourceTreeSha256,
        verifiedSourceFileCount: sourceSnapshot.verifiedFileCount,
        binaryPath: expectedKcoderBin,
        binarySha256: binary.sha256,
        binarySize: binary.size,
        binaryProvenanceSha256: expectedKcoderProvenanceSha256,
        sourceExportPerformed: false,
        retainedBundleManifestSha256: web.sourceManifestSha256,
        bundleSha256: web.bundleSha256,
        bundleFileCount: web.bundleFileCount,
        indexHtmlSha256: web.indexHtmlSha256,
        reuseProvenancePath: relative(context.runRoot, web.provenancePath)
          .split(sep)
          .join("/"),
      });

      const { path: workspace } = await materializeWorkspace(context, "minimal", {
        instanceId: "mobile-history-navigation-empty-thread",
      });
      providerObserver = await startProviderRequestObserver(
        context,
        "mobile-history-navigation-no-provider-observer",
      );
      context.addCleanup(
        "verify app-server process stopped with owned Gateway",
        async () => {
          if (!gatewayProcessGroupId) {
            await context.writeArtifactJsonInternal(
              "navigation-process-cleanup.json",
              { status: "gateway-not-started", appServerProcessCount: 0 },
            );
            return;
          }
          const remaining = await findOwnedExecutableProcesses({
            pgid: gatewayProcessGroupId,
            executablePath: expectedKcoderBin,
          });
          await context.writeArtifactJsonInternal(
            "navigation-process-cleanup.json",
            {
              gatewayProcessGroup: gatewayProcessGroupId,
              status: remaining.length === 0 ? "clean" : "leaked-processes",
              appServerProcessCount: remaining.length,
              appServerBinarySha256: remaining.map((process) => process.sha256),
            },
          );
          assert.deepEqual(
            remaining,
            [],
            "run-owned app-server process must exit when its Gateway is stopped",
          );
        },
      );
      const configDir = context.pathInState("private-config");
      const settingsFile = await context.writeStateJson(
        "private-config/provider-observer-settings.json",
        {
          active_provider: "mobile-navigation-observer",
          permission_mode: "yolo",
          max_retries: 0,
          hooks: {},
          providers: {
            "mobile-navigation-observer": {
              api_format: "openai_chat_completions",
              authentication: { mode: "none" },
              endpoint: `${providerObserver.baseUrl}/v1`,
              default_model: "navigation-no-model",
              context_window_tokens: 128_000,
              output_headroom_tokens: 1024,
              max_output_tokens: 1024,
              request_timeout_secs: 5,
              no_proxy: true,
              extra_body: {},
            },
          },
        },
      );
      await context.writeStateJson("private-config/credentials.json", {});
      const serversFile = await context.writeStateJson("servers.json", [
        {
          id: "local",
          label: "Run-owned Mobile empty-history navigation",
          transport: "local",
          command: expectedKcoderBin,
          workspace,
          settingsFile,
        },
      ]);
      const gatewayLabel = "mobile-history-navigation-gateway";
      gateway = await startGateway(context, {
        auth: true,
        label: gatewayLabel,
        workspace,
        serversFile,
        kcoderBin: expectedKcoderBin,
        env: {
          KCODER_CONFIG_DIR: configDir,
          KCODER_STUDIO_WEB_ROOT: web.path,
          KCODER_TRAINING_MODE: "true",
          RUST_LOG: "warn",
        },
      });
      gatewayProcessGroupId =
        context.processes.get(gatewayLabel)?.pgid ?? gateway.child.pid;
      chromium = await startChromium(context, {
        label: "mobile-history-navigation-chromium",
      });
      page = await chromium.newPage({ viewport: { width: 390, height: 844 } });
      page.setDefaultTimeout(20_000);
      const rpcMethodCounts = { sent: {}, received: {} };
      const networkRequestCounts = {};
      const networkResponseCounts = {};
      let pageErrorCount = 0;
      page.on("pageerror", () => {
        pageErrorCount += 1;
      });
      page.on("request", (request) => {
        const route = safeGatewayPath(request.url(), gateway.baseUrl);
        if (!route) return;
        const key = `${request.method()} ${route}`;
        networkRequestCounts[key] = (networkRequestCounts[key] || 0) + 1;
      });
      page.on("response", (response) => {
        const route = safeGatewayPath(response.url(), gateway.baseUrl);
        if (!route) return;
        const key = `${response.status()} ${route}`;
        networkResponseCounts[key] = (networkResponseCounts[key] || 0) + 1;
      });
      page.on("websocket", (socket) => {
        socket.on("framesent", ({ payload }) =>
          recordRpcMethod(rpcMethodCounts.sent, payload),
        );
        socket.on("framereceived", ({ payload }) =>
          recordRpcMethod(rpcMethodCounts.received, payload),
        );
      });

      currentStage = "connect-mobile-profile-home";
      await connectMobileWithGatewayAuth(page, gateway, {
        onStage: (stage) => {
          currentStage = stage;
        },
      });
      const connectedHomePath = new URL(page.url()).pathname;
      const connectedHome = parseMobileProfileHomeRoute(connectedHomePath);
      assert.ok(connectedHome, "Mobile direct Gateway connection should open its profile Home");
      context.registerSecret(connectedHome.profileId);

      // The Gateway token endpoint is only served after login when auth is
      // enabled. Reuse this RunContext's browser-owned session cookie in memory
      // for the seed RPC; neither the cookie nor RPC token enters an artifact.
      currentStage = "read-owned-gateway-auth-session";
      const sessionCookies = (await page.context().cookies(gateway.baseUrl))
        .filter((cookie) => cookie.name === "kcoder_studio_session");
      assert.equal(
        sessionCookies.length,
        1,
        "the isolated Gateway login must establish exactly one owned session cookie",
      );
      const cookieValue = sessionCookies[0].value;
      assert.ok(cookieValue.length > 0);
      context.registerSecret(cookieValue);
      const cookieHeader = `kcoder_studio_session=${cookieValue}`;
      context.registerSecret(cookieHeader);

      currentStage = "seed-empty-thread-over-authenticated-rpc";
      const rpcToken = await waitForGatewayRpcToken(context, gateway, {
        headers: { cookie: cookieHeader },
      });
      seedRpc = await openRpc(gatewayRpcUrl(gateway, "local", rpcToken), {
        headers: {
          cookie: cookieHeader,
          origin: gateway.baseUrl,
        },
      });
      context.addCleanup("close empty history seed RPC", () =>
        closeRpcAndWait(seedRpc, "empty history seed RPC"),
      );
      const initialized = await initializeRpc(seedRpc, "mobile-history-navigation-seed");
      assert.equal(
        initialized.capabilities?.experimental?.residentThreads,
        true,
      );
      const started = await seedRpc.request("thread/start", { cwd: workspace });
      const threadId = started.thread?.id;
      assert.equal(typeof threadId, "string");
      assert.ok(threadId.length > 0);
      const sessionTitle = "Mobile empty navigation seed";
      await seedRpc.request("thread/metadata/update", {
        threadId,
        title: sessionTitle,
      });
      const seededHistory = await seedRpc.request("thread/read", {
        threadId,
        limit: 20,
      });
      assert.equal(seededHistory.thread?.id, threadId);
      assert.deepEqual(seededHistory.messages, []);
      const seededList = await seedRpc.request("thread/list", { allowPartial: true });
      assert.ok(seededList.threads?.some((thread) => thread.id === threadId));
      const appServerProcesses = await waitFor(
        async () => {
          const found = await findOwnedExecutableProcesses({
            pgid: gatewayProcessGroupId,
            executablePath: expectedKcoderBin,
          });
          return found.length ? found : null;
        },
        10_000,
        "this RunContext Gateway-owned fixed app-server process",
        50,
        context.abortSignal,
      );
      assert.equal(appServerProcesses.length, 1);
      assert.equal(appServerProcesses[0].sha256, expectedKcoderSha256);
      await context.writeArtifactJson("navigation-empty-thread-seed.json", {
        serverId: "local",
        residentThreadVisible: true,
        emptyTranscriptMessageCount: seededHistory.messages.length,
        titleSet: true,
        browserSessionCookiePresent: true,
        gatewayRpcTokenInjected: Boolean(rpcToken),
        rawRpcOriginWasOwnedGateway: true,
        rawRpcOpenedWithOwnedBrowserSession: true,
        appServerProcessCount: appServerProcesses.length,
        appServerBinarySha256: appServerProcesses[0].sha256,
        providerRequestCountBeforeMobile: providerObserver.requests.length,
      });
      await closeRpcAndWait(seedRpc, "empty history seed RPC");

      currentStage = "open-sessions-from-home";
      await page.getByTestId("sessions").waitFor({ state: "visible" });
      await page.getByTestId("sessions").click();
      await page.waitForURL((url) => url.pathname === "/sessions", {
        timeout: 20_000,
      });
      await page.getByTestId("sessions-list").waitFor({ state: "visible" });
      const initialRow = page.getByTestId(`session-${threadId}`);
      await initialRow.waitFor({ state: "visible", timeout: 20_000 });
      assert.equal(await initialRow.count(), 1);
      assert.ok((await initialRow.innerText()).includes(sessionTitle));
      await initialRow.click();
      await page.waitForURL(
        (url) => {
          const route = parseMobileTaskRoute(url.pathname);
          return (
            route?.routeKind === "profile-hosted" &&
            route.profileId === connectedHome.profileId &&
            route.serverId === "local" &&
            route.threadId === threadId
          );
        },
        { timeout: 20_000 },
      );
      await page
        .getByTestId("message-input-root")
        .waitFor({ state: "visible", timeout: 20_000 });
      const firstTaskPath = new URL(page.url()).pathname;
      const firstTaskRoute = parseMobileTaskRoute(firstTaskPath);
      assert.equal(firstTaskRoute.profileId, connectedHome.profileId);
      assert.equal(firstTaskRoute.threadId, threadId);
      assert.equal(await page.getByTestId("message-user").count(), 0);
      assert.equal(await page.getByTestId("message-assistant").count(), 0);
      assert.equal(
        rpcMethodCounts.sent["turn/start"] || 0,
        0,
        "Mobile must not send a turn/start while navigating an empty history item",
      );
      assert.equal(providerObserver.requests.length, 0);
      await context.writeArtifactJson("navigation-first-history-entry.json", {
        startRoute: "/h/:profile",
        sessionsRoute: "/sessions",
        taskRoute: safeTaskRoute(firstTaskPath),
        matchingHistoryRows: await initialRow.count(),
        visibleMessageCounts: { user: 0, assistant: 0 },
        routeMatchesSeededThread: true,
        turnStartFramesSent: rpcMethodCounts.sent["turn/start"] || 0,
        providerRequestCount: providerObserver.requests.length,
        pageErrorCount,
        rpcMethodCounts,
        networkRequestCounts,
        networkResponseCounts,
      });

      currentStage = "return-home-and-reenter-from-sessions";
      const reentry = await returnHomeAndReenterTaskFromSessions(page, {
        profileId: connectedHome.profileId,
        threadId,
        expectedTaskPath: firstTaskPath,
        timeoutMs: 20_000,
        backActivation: "space",
      });
      assert.equal(new URL(page.url()).pathname, firstTaskPath);
      assert.equal(await page.getByTestId("message-user").count(), 0);
      assert.equal(await page.getByTestId("message-assistant").count(), 0);
      assert.equal(
        rpcMethodCounts.sent["turn/start"] || 0,
        0,
        "returning to the same empty history item must not start a turn",
      );
      assert.equal(providerObserver.requests.length, 0);
      assert.equal(pageErrorCount, 0);
      await context.writeArtifactJson("navigation-same-thread-reentry.json", {
        ...reentry,
        providerRequestCount: providerObserver.requests.length,
        turnStartFramesSent: rpcMethodCounts.sent["turn/start"] || 0,
        pageErrorCount,
        rpcMethodCounts,
        networkRequestCounts,
        networkResponseCounts,
      });

      const gatewayProcessGroup = context.processes.get(gatewayLabel)?.pgid;
      const chromiumProcessGroup = context.processes.get("mobile-history-navigation-chromium")?.pgid;
      const processOwnershipBeforeCleanup = {
        gatewayPid: gateway.child.pid,
        gatewayProcessGroup: gatewayProcessGroup ?? null,
        gatewayPort: gateway.port,
        appServerProcesses,
        chromiumPid: chromium.child.pid,
        chromiumProcessGroup: chromiumProcessGroup ?? null,
        chromiumCdpPort: chromium.cdpPort,
        chromiumNoSandbox: chromium.noSandbox,
        chromiumExecutablePath: chromium.executablePath,
      };
      await context.writeArtifactJson("navigation-run-process-ownership.json", {
        ...processOwnershipBeforeCleanup,
        providerObserverPort: new URL(providerObserver.baseUrl).port,
        allPortsRunOwned: true,
      });
      return {
        sourceSnapshotVerified: true,
        retained37FileBundleVerified: true,
        exportPerformed: false,
        candidateBinarySha256: binary.sha256,
        phoneViewport: { width: 390, height: 844 },
        emptyThreadCreatedViaRawRpc: true,
        homeToSessionsToTask: true,
        taskBackHomeSessionsSameTask: true,
        turnStartFramesSent: 0,
        providerRequests: 0,
        pageErrors: 0,
      };
    } catch (error) {
      if (page) {
        await captureRedactedMobileHistoryFailure(page, context, {
          stage: currentStage,
          error,
          providerCounters: null,
        }).catch(() => undefined);
      }
      if (providerObserver) {
        await context
          .writeArtifactJson("navigation-failure-provider-observer.json", {
            requestCount: providerObserver.requests.length,
            requests: providerObserver.requests.map(({ method, path, bytes }) => ({
              method,
              path: path === "/v1/chat/completions" ? path : "/other",
              bytes,
            })),
          })
          .catch(() => undefined);
      }
      throw error;
    } finally {
      if (page) await page.close().catch(() => undefined);
      if (chromium) await chromium.close().catch(() => undefined);
      if (seedRpc) await closeRpcAndWait(seedRpc, "empty history seed RPC").catch(() => undefined);
      if (providerObserver) await providerObserver.close().catch(() => undefined);
    }
  },
);

async function verifyPinnedSourceSnapshot(context) {
  const snapshotRoot = resolve(repoRoot, sourceSnapshotRelativeRoot);
  const sourceManifestPath = resolve(snapshotRoot, "source-snapshot-manifest.json");
  const sharedManifestPath = resolve(snapshotRoot, "mobile-shared-source-manifest.json");
  const snapshotRootStat = await lstat(snapshotRoot);
  assert.ok(snapshotRootStat.isDirectory());
  assert.equal(snapshotRootStat.uid, 0);
  assert.equal(snapshotRootStat.gid, 0);
  assert.equal(snapshotRootStat.mode & 0o777, 0o555);
  const sourceManifestStat = await lstat(sourceManifestPath);
  assert.ok(sourceManifestStat.isFile());
  assert.equal(sourceManifestStat.uid, 0);
  assert.equal(sourceManifestStat.mode & 0o777, 0o444);
  const sourceManifestBytes = await readFile(sourceManifestPath);
  const manifestSha256 = sha256(sourceManifestBytes);
  assert.equal(manifestSha256, expectedSourceSnapshotManifestSha256);
  const manifest = JSON.parse(sourceManifestBytes.toString("utf8"));
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.snapshotId, expectedSourceSnapshotId);
  assert.equal(manifest.source.sourceTreeSha256, expectedSourceTreeSha256);
  assert.equal(manifest.source.fileCount, expectedSourceFileCount);
  assert.equal(
    manifest.source.mobileSharedSourceManifestPath,
    `${sourceSnapshotRelativeRoot}/mobile-shared-source-manifest.json`,
  );
  assert.equal(
    manifest.source.mobileSharedSourceManifestSha256,
    expectedSharedSourceManifestSha256,
  );
  assert.equal(manifest.destination.sourceTreeSha256, expectedSourceTreeSha256);
  assert.equal(manifest.destination.destinationTreeSha256, expectedSourceTreeSha256);
  assert.equal(manifest.destination.fileCount, expectedSourceFileCount);
  assert.equal(manifest.destination.relativePath, sourceSnapshotRelativeRoot);
  if (manifest.fileCount !== undefined)
    assert.equal(manifest.fileCount, expectedSourceFileCount);
  assert.deepEqual(manifest.sensitiveManifestPaths, []);

  const sharedStat = await lstat(sharedManifestPath);
  assert.ok(sharedStat.isFile());
  assert.equal(sharedStat.uid, 0);
  assert.equal(sharedStat.mode & 0o777, 0o444);
  const sharedBytes = await readFile(sharedManifestPath);
  const sharedManifestSha256 = sha256(sharedBytes);
  assert.equal(sharedManifestSha256, expectedSharedSourceManifestSha256);
  const sharedManifest = JSON.parse(sharedBytes.toString("utf8"));
  assert.equal(sharedManifest.snapshotId, expectedSourceSnapshotId);
  assert.equal(sharedManifest.fileCount, expectedSourceFileCount);
  assert.equal(sharedManifest.current.sourceTreeSha256, expectedSourceTreeSha256);
  assert.equal(sharedManifest.files.length, expectedSourceFileCount);
  const fileEntries = Array.isArray(manifest.files)
    ? manifest.files
    : sharedManifest.files;
  assert.equal(fileEntries.length, expectedSourceFileCount);

  const outerRoots = manifest.roots;
  const sharedRoots = sharedManifest.current.roots;
  assert.ok(Array.isArray(outerRoots));
  assert.ok(Array.isArray(sharedRoots));
  assert.deepEqual(
    outerRoots.map(({ name }) => name).sort(),
    ["mobile", "studio-shared"],
  );
  assert.deepEqual(
    sharedRoots.map(({ name }) => name).sort(),
    ["mobile", "studio-shared"],
  );
  for (const outerRoot of outerRoots) {
    const sharedRoot = sharedRoots.find((root) => root.name === outerRoot.name);
    assert.ok(sharedRoot, `shared-source manifest is missing ${outerRoot.name}`);
    const rootSha256 = outerRoot.expectedSha256 ?? outerRoot.sha256;
    assert.match(rootSha256, /^[a-f0-9]{64}$/);
    assert.equal(rootSha256, sharedRoot.sha256);
    assert.equal(outerRoot.destination, sharedRoot.destination);
    assert.equal(outerRoot.fileCount, sharedRoot.fileCount);
    if (outerRoot.sourceRecomputedSha256 !== undefined)
      assert.equal(outerRoot.sourceRecomputedSha256, rootSha256);
    if (outerRoot.destinationRecomputedSha256 !== undefined)
      assert.equal(outerRoot.destinationRecomputedSha256, rootSha256);
  }

  const seen = new Set();
  const expectedFiles = new Set([
    "source-snapshot-manifest.json",
    "mobile-shared-source-manifest.json",
  ]);
  const expectedDirectories = new Set();
  for (const entry of fileEntries) {
    assert.ok(entry.root === "mobile" || entry.root === "studio-shared");
    assert.equal(typeof entry.destinationPath, "string");
    assert.ok(!isAbsolute(entry.destinationPath));
    const filePath = resolve(snapshotRoot, entry.destinationPath);
    const fileRelativePath = relative(snapshotRoot, filePath);
    assert.ok(fileRelativePath && fileRelativePath !== ".." && !fileRelativePath.startsWith(`..${sep}`));
    assert.equal(resolve(snapshotRoot, fileRelativePath), filePath);
    const expectedPrefix = entry.root === "mobile"
      ? "apps/kcoder-studio/mobile/"
      : "apps/kcoder-studio/shared/";
    assert.ok(fileRelativePath.startsWith(expectedPrefix));
    assert.ok(!seen.has(fileRelativePath));
    seen.add(fileRelativePath);
    expectedFiles.add(fileRelativePath.split(sep).join("/"));
    assert.ok(Number.isSafeInteger(entry.size) && entry.size >= 0);
    assert.match(entry.destinationSha256, /^[a-f0-9]{64}$/);
    assert.equal(entry.destinationSha256, entry.sourceSha256);

    let directory = snapshotRoot;
    const directorySegments = dirname(fileRelativePath).split(sep).filter(Boolean);
    let relativeDirectory = "";
    for (const segment of directorySegments) {
      directory = resolve(directory, segment);
      relativeDirectory = relativeDirectory ? `${relativeDirectory}/${segment}` : segment;
      expectedDirectories.add(relativeDirectory);
      const directoryStat = await lstat(directory);
      assert.ok(directoryStat.isDirectory());
      assert.equal(directoryStat.uid, 0);
      assert.equal(directoryStat.mode & 0o777, 0o555);
    }
    const fileStat = await lstat(filePath);
    assert.ok(fileStat.isFile());
    assert.equal(fileStat.uid, 0);
    assert.equal(fileStat.mode & 0o777, 0o444);
    const bytes = await readFile(filePath);
    assert.equal(bytes.byteLength, entry.size);
    assert.equal(sha256(bytes), entry.destinationSha256);
  }
  assert.equal(seen.size, expectedSourceFileCount);
  const actualFiles = new Set();
  const actualDirectories = new Set();
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const entryPath = resolve(directory, entry.name);
      const relativePath = relative(snapshotRoot, entryPath).split(sep).join("/");
      const entryStat = await lstat(entryPath);
      if (entry.isSymbolicLink()) throw new Error("source snapshot contains a symlink");
      if (entry.isDirectory()) {
        assert.ok(entryStat.isDirectory());
        actualDirectories.add(relativePath);
        await walk(entryPath);
      } else {
        assert.ok(entry.isFile() && entryStat.isFile());
        actualFiles.add(relativePath);
      }
    }
  }
  await walk(snapshotRoot);
  assert.deepEqual([...actualFiles].sort(), [...expectedFiles].sort());
  assert.deepEqual([...actualDirectories].sort(), [...expectedDirectories].sort());
  const verification = {
    status: "verified",
    snapshotId: expectedSourceSnapshotId,
    relativePath: sourceSnapshotRelativeRoot,
    manifestSha256,
    sharedManifestSha256,
    sourceTreeSha256: expectedSourceTreeSha256,
    expectedFileCount: expectedSourceFileCount,
    verifiedFileCount: seen.size,
    rootOwnedReadOnlyFilesAndDirectories: true,
    sensitiveManifestPaths: 0,
    inspectedAtUtc: new Date().toISOString(),
  };
  await context.writeArtifactJson("navigation-source-freeze-verification.json", verification);
  return {
    relativePath: sourceSnapshotRelativeRoot,
    manifestSha256,
    sharedManifestSha256,
    sourceTreeSha256: expectedSourceTreeSha256,
    verifiedFileCount: seen.size,
  };
}

function safeGatewayPath(requestUrl, gatewayBaseUrl) {
  try {
    const actual = new URL(requestUrl);
    const expected = new URL(gatewayBaseUrl);
    if (actual.origin !== expected.origin) return null;
    if (["/", "/rpc", "/favicon.ico"].includes(actual.pathname)) return actual.pathname;
    return "/other";
  } catch {
    return null;
  }
}

function recordRpcMethod(target, payload) {
  try {
    const value = JSON.parse(String(payload));
    if (typeof value.method !== "string" || !/^[a-z]+(?:\/[a-z]+)+$/i.test(value.method)) return;
    target[value.method] = (target[value.method] || 0) + 1;
  } catch {
    // RPC payloads are parsed in memory and only method names/counts are kept.
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
