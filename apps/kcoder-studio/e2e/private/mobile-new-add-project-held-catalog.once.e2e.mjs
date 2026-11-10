// Current-source export and mounted navigation contract; no Provider or performance claim.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { buildGatewayMobileWebManifest, writeGatewayMobileWebManifest } from "../../mobile/scripts/gateway-mobile-web-manifest.mjs";
import { startChromium } from "../harness/chromium.mjs";
import { startGateway } from "../harness/gateway.mjs";
import { exportMobileWeb } from "../harness/mobile-web-export.mjs";
import { copyOfficialMobileStaticDist, inspectOfficialMobileStaticDist } from "../harness/mobile-static-dist-input.mjs";
import { repoRoot, runE2E, waitFor } from "../harness/run-context.mjs";

const productPins = {
  "apps/kcoder-studio/mobile/src/app/new.tsx": "ddd8c358c783412a9f13f77604fd99e28aa53b4f5860c0e30fc4c7fc0da0ddeb",
  "apps/kcoder-studio/mobile/src/app/__tests__/new-catalog-read-publication.review.test.tsx": "4ce3918d1716a733d61a85347a3a3cb2cbec480e0a0fa5e361cf543e3aba0eaa",
  "apps/kcoder-studio/mobile/src/runtime/task-runtime/workspaces.ts": "66b0be06affc3396145078ef7473bcd7ff7893dd82a206e703e535d24f5f16a5",
  "apps/kcoder-studio/mobile/src/app/open-project.tsx": "3465ce1306d8e11fb298f9bb039189a19587b1c92a5933c790d9b97b05db8bb2",
  "apps/kcoder-studio/mobile/src/runtime/task-runtime.catalog-snapshot-v1.review.test.ts": "9de3036a563755f9f12ce5d5b97dc1c121eb96a125424e238e5e60ba80926c80",
};
const execFileAsync = promisify(execFile);
const COMMITTED_SOURCE_ROOT = "/data1/hyf/20260822_agent/Kunlun-Code-CYX/target/worktree/2026/10/09/mobile-ux-followup-20261009/target/mobile-web-export-b0ec751a";
const COMMITTED_SOURCE_HEAD = "b0ec751a00b2a40464e4c26daafe93357b9748d3";
const supportPaths = ["apps/kcoder-studio/dev-server.mjs", "apps/kcoder-studio/src/mobile-web-static.js",
  "apps/kcoder-studio/mobile/package-lock.json", "apps/kcoder-studio/mobile/scripts/gateway-mobile-web-manifest.mjs",
  "apps/kcoder-studio/e2e/harness/mobile-web-export.mjs", "apps/kcoder-studio/e2e/harness/mobile-export-source-snapshot.mjs",
  "apps/kcoder-studio/e2e/harness/mobile-static-dist-input.mjs",
  "apps/kcoder-studio/e2e/harness/run-context.mjs", "apps/kcoder-studio/e2e/harness/gateway.mjs", "apps/kcoder-studio/e2e/harness/chromium.mjs"];
const sha256 = value => createHash("sha256").update(value).digest("hex");
const digest = async path => sha256(await readFile(path));
async function pins(root = repoRoot) {
  const rows = Object.fromEntries(await Promise.all([...Object.keys(productPins), ...supportPaths].map(async path => [path, await digest(resolve(root, path))])));
  for (const [path, expected] of Object.entries(productPins)) assert.equal(rows[path], expected, path);
  return rows;
}
async function supportPins(root = repoRoot) {
  return Object.fromEntries(await Promise.all(supportPaths.map(async path => [path, await digest(resolve(root, path))])));
}
async function verifyCommittedSourceRoot(sourceRoot) {
  const canonicalRoot = await realpath(sourceRoot);
  assert.equal(canonicalRoot, COMMITTED_SOURCE_ROOT, "committed source root must be the owned b0ec751a worktree");
  const [{ stdout: topLevel }, { stdout: head }, { stdout: branch }, { stdout: status }] = await Promise.all([
    execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd: canonicalRoot }),
    execFileAsync("git", ["rev-parse", "HEAD"], { cwd: canonicalRoot }),
    execFileAsync("git", ["branch", "--show-current"], { cwd: canonicalRoot }),
    execFileAsync("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: canonicalRoot }),
  ]);
  assert.equal(topLevel.trim(), canonicalRoot);
  assert.equal(head.trim(), COMMITTED_SOURCE_HEAD, "detached source HEAD changed");
  assert.equal(branch.trim(), "", "source worktree must remain detached");
  assert.equal(status.trim(), "", "committed source worktree must remain clean");
  return { kind: "detached-committed-source", root: canonicalRoot, head: head.trim(), detached: true, clean: true };
}
const [phase, ...phaseArgs] = process.argv.slice(2);
assert.ok(["export", "browser"].includes(phase));
assert.equal(repoRoot, "/data1/hyf/20260822_agent/Kunlun-Code-CYX/target/worktree/2026/10/09/mobile-ux-followup-20261009");
assert.equal(process.version, "v22.17.0");
assert.equal(await realpath(process.execPath), "/home/hyf/.local/opt/node-v22.17.0-linux-x64/bin/node");
const runnerSha256 = await digest(new URL(import.meta.url));
let receiptPath, receiptSha256, exportSourceRoot = repoRoot, committedSourceIdentity = null;
if (phase === "export") {
  assert.ok(phaseArgs.length === 0 || (phaseArgs.length === 2 && phaseArgs[0] === "--source-root"),
    "export accepts only an optional explicit --source-root");
  if (phaseArgs.length) {
    exportSourceRoot = resolve(phaseArgs[1]);
    committedSourceIdentity = await verifyCommittedSourceRoot(exportSourceRoot);
  }
} else {
  assert.equal(phaseArgs.length, 2, "browser requires the original export receipt path and SHA-256");
  [receiptPath, receiptSha256] = phaseArgs;
}

await runE2E(import.meta.url, {
  testId: `mobile-new-add-project-held-catalog-${phase}${committedSourceIdentity ? "-b0ec751a" : ""}`,
  tier: "manual-live", retainSuccessLogs: true,
  modelPolicy: phase === "export" && committedSourceIdentity
    ? "static Mobile Web export from detached committed b0ec751a Mobile+Shared source; no Browser, Gateway, Provider, or performance evidence"
    : "real current-source Expo/Gateway HTML and assets; controlled directory responses through real mock Gateway; no Rust, Provider, native, or latency evidence",
  sourceCommit: committedSourceIdentity?.head ?? null,
  nodeVersion: process.version,
}, async context => {
  const sourceRootForPins = phase === "export" ? exportSourceRoot : repoRoot;
  const sourceBefore = await pins(sourceRootForPins);
  const executionSupportBefore = phase === "export" ? await supportPins(repoRoot) : null;
  if (committedSourceIdentity) {
    assert.deepEqual(executionSupportBefore,
      Object.fromEntries(supportPaths.map(path => [path, sourceBefore[path]])),
      "export helper/support bytes must match the committed source worktree");
    await context.writeArtifactJson("source-selection.json", {
      ...committedSourceIdentity,
      runnerSha256,
      argv: process.argv.slice(1),
      environmentVariableNames: Object.keys(process.env).sort(),
      executionSupportPins: executionSupportBefore,
    });
  }
  await context.writeArtifactJson("source-before.json", sourceBefore);
  if (phase === "export") {
    const mobile = resolve(exportSourceRoot, "apps/kcoder-studio/mobile");
    // Export-only evidence leaves the historical Browser receipt/pin gate unchanged.
    const helperPath = resolve(exportSourceRoot, "apps/kcoder-studio/e2e/harness/mobile-export-source-snapshot.mjs");
    const helperSha256 = await digest(helperPath);
    const { captureMobileExportSourceSnapshot, verifyMobileExportSourceSnapshot } = await import("../harness/mobile-export-source-snapshot.mjs");
    const sourceRoots = [{ name: "mobile", path: mobile, destination: "apps/kcoder-studio/mobile" },
      { name: "studio-shared", path: resolve(exportSourceRoot, "apps/kcoder-studio/shared"), destination: "apps/kcoder-studio/shared" }];
    const snapshotRoot = context.pathInArtifacts("source-snapshot");
    const snapshot = await captureMobileExportSourceSnapshot({ sourceRoots, snapshotRoot });
    await context.writeArtifactJson("source-inventory.json", snapshot);
    const sourceInventorySha256 = await digest(context.pathInArtifacts("source-inventory.json"));
    const exported = await exportMobileWeb(context, {
      mobileRoot: mobile,
      sourceRoots,
      dependencyRoot: await realpath(resolve(mobile, "node_modules")),
      label: committedSourceIdentity ? "new-add-project-b0ec751a" : "new-add-project-current",
      outputName: committedSourceIdentity ? "new-add-project-export-b0ec751a" : "new-add-project-export",
      stateNamespace: committedSourceIdentity ? "new-add-project-b0ec751a" : "new-add-project",
      sourceMaps: false, deployMount: true, timeoutMs: 600_000,
    });
    const sourceVerification = await verifyMobileExportSourceSnapshot({ snapshot, snapshotRoot, sourceRoots, exported,
      exporterManifest: JSON.parse(await readFile(exported.bundleManifestPath, "utf8")) });
    assert.equal(await digest(helperPath), helperSha256, "export-only evidence helper changed");
    assert.equal(await digest(context.pathInArtifacts("source-inventory.json")), sourceInventorySha256, "source inventory changed");
    await context.writeArtifactJson("source-snapshot-verification.json", sourceVerification);
    const bundleRoot = context.pathInArtifacts("mobile-web-bundle");
    await cp(exported.path, bundleRoot, { recursive: true, force: false, errorOnExist: true });
    const official = await buildGatewayMobileWebManifest(bundleRoot, { expectedFiles: exported.bundleFiles });
    assert.equal(official.files.length, 37, "the committed Mobile Web export must contain exactly 37 deployable resources");
    await writeGatewayMobileWebManifest(bundleRoot, official);
    const officialManifestSha256 = await digest(resolve(bundleRoot, "kcoder-mobile-web.json"));
    const verified = await inspectOfficialMobileStaticDist({ distRoot: bundleRoot, expectedManifestSha256: officialManifestSha256 });
    assert.equal(verified.resourceCount, 37);
    await context.writeArtifactJson("export-receipt.json", {
      status: "PASS_EXPORT_NOT_BROWSER", bundleDirectory: "mobile-web-bundle", productPins, sourceBefore,
      sourceCommit: committedSourceIdentity?.head ?? null,
      deploymentMount: "/mobile",
      sourceSelection: committedSourceIdentity ? {
        ...committedSourceIdentity,
        runnerSha256,
        argv: process.argv.slice(1),
        environmentVariableNames: Object.keys(process.env).sort(),
        executionSupportPins: executionSupportBefore,
      } : null,
      sourceTreeSha256: exported.sourceTreeSha256, bundleSha256: exported.bundleSha256,
      dependencyRoot: exported.dependencyRoot,
      dependencySourceTreeSha256: exported.dependencySourceTreeSha256,
      dependencyOwnedTreeSha256: exported.dependencyOwnedTreeSha256,
      bundleFiles: exported.bundleFiles, exporterManifest: exported.bundleManifestPath,
      exporterManifestSha256: await digest(exported.bundleManifestPath), officialManifestSha256,
      officialResourceCount: verified.resourceCount, officialResourceTableSha256: verified.resourceTableSha256,
      sourceEvidence: { inventory: "source-inventory.json", inventorySha256: sourceInventorySha256,
        snapshotDirectory: "source-snapshot", helperSha256, verification: "source-snapshot-verification.json",
        verificationSha256: await digest(context.pathInArtifacts("source-snapshot-verification.json")), ...sourceVerification },
    });
  } else {
    assert.match(receiptSha256 ?? "", /^[a-f0-9]{64}$/);
    assert.equal(await digest(receiptPath), receiptSha256);
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    assert.equal(receipt.status, "PASS_EXPORT_NOT_BROWSER");
    assert.deepEqual(receipt.productPins, productPins);
    assert.deepEqual(receipt.sourceBefore, sourceBefore, "export and Browser inputs must be the same source bytes");
    const distRoot = resolve(dirname(receiptPath), receipt.bundleDirectory);
    const owned = await copyOfficialMobileStaticDist(context, { distRoot, expectedManifestSha256: receipt.officialManifestSha256 });
    const workspace = context.pathInState("workspace"); await mkdir(workspace, { mode: 0o700 });
    const serversFile = await context.writeStateJson("servers.json", [{ id: "local", label: "Navigation fixture", runtime: "kcoder", transport: "local", workspacePath: workspace, command: process.execPath }]);
    const gateway = await startGateway(context, { auth: true, label: "navigation-gateway", workspace, serversFile, kcoderBin: process.execPath,
      env: { KCODER_STUDIO_MOCK: "1", KCODER_STUDIO_WEB_ROOT: "", KCODER_STUDIO_MOBILE_WEB_ROOT: owned.ownedRoot } });
    const shortTmp = await mkdtemp("/tmp/kc-nav-");
    context.addCleanup("remove owned short Chromium tmp", () => rm(shortTmp, { recursive: true, force: true }));
    const chromium = await startChromium(context, { label: "navigation-chromium", executablePath: "/opt/cft/chrome-linux64/chrome", noSandbox: true,
      env: { TMPDIR: shortTmp, TMP: shortTmp, TEMP: shortTmp } });
    const page = await chromium.newPage({ viewport: { width: 390, height: 844 }, locale: "zh-CN" });
    const errors = [], assets = [], sockets = [];
    let hold = false, release = false;
    page.on("pageerror", error => errors.push(context.redactText(error.message)));
    page.on("response", response => { const url = new URL(response.url()); if (url.origin === gateway.baseUrl && /\.(js|css)$/.test(url.pathname)) assets.push({ path: url.pathname, status: response.status() }); });
    const assetStatusGroups = () => {
      const grouped = new Map();
      for (const { path, status } of assets) {
        const statuses = grouped.get(path) ?? [];
        statuses.push(status);
        grouped.set(path, statuses);
      }
      return [...grouped].map(([path, statuses]) => ({ path, statuses: [...statuses], notModified304Count: statuses.filter(status => status === 304).length }));
    };
    const assertAssetResponses = () => {
      const groups = assetStatusGroups();
      assert.ok(groups.some(row => row.path.endsWith(".js") && row.statuses.includes(200)), "at least one JavaScript asset must load with 200");
      assert.ok(groups.some(row => row.path.endsWith(".css") && row.statuses.includes(200)), "at least one CSS asset must load with 200");
      for (const { path, statuses } of groups) {
        const first200 = statuses.indexOf(200);
        assert.notEqual(first200, -1, `${path} must have an initial 200 response`);
        assert.equal(statuses.slice(0, first200).includes(304), false, `${path} cannot be cache-validated before a 200 response`);
        assert.ok(statuses.every(status => status === 200 || status === 304), `${path} responses may only be 200 or subsequent 304`);
      }
    };
    const catalogMethods = new Set(["runtime.workspaces.list", "runtime.worktrees.list"]);
    const readMethods = new Set(["initialize", "initialized", "thread/list", "thread/read", "runtime.models.list", ...catalogMethods]);
    await page.routeWebSocket("**/rpc*", routed => {
      const upstream = routed.connectToServer(), requests = new Map(), pending = [];
      const socket = { methods: [], held: 0, released: 0, clientClosed: false, gatewayClosed: false };
      sockets.push(socket);
      const sendFixture = frame => { if (!socket.clientClosed && !socket.gatewayClosed) { routed.send(JSON.stringify({ jsonrpc: "2.0", id: frame.id,
        result: { items: frame.method === "runtime.workspaces.list" ? [{ workspacePath: workspace, label: "Controlled navigation workspace" }] : [] } })); socket.released++; } };
      socket.release = () => { for (const frame of pending.splice(0)) sendFixture(frame); };
      routed.onMessage(raw => { const frame = JSON.parse(String(raw)); if (frame.method) socket.methods.push(frame.method);
        if (frame.id !== undefined) requests.set(String(frame.id), { id: frame.id, method: frame.method, hold }); upstream.send(raw); });
      upstream.onMessage(raw => { const frame = JSON.parse(String(raw)), request = requests.get(String(frame.id));
        requests.delete(String(frame.id));
        if (request?.hold && catalogMethods.has(request.method)) { socket.held++; if (release) sendFixture(request); else pending.push(request); }
        else routed.send(raw); });
      routed.onClose(() => { socket.clientClosed = true; pending.length = 0; if (!socket.gatewayClosed) upstream.close(); });
      upstream.onClose(() => { socket.gatewayClosed = true; pending.length = 0; if (!socket.clientClosed) routed.close(); });
    });
    let observed = { phase: "pairing" }, primaryError = null, closeError = null;
    const snapshot = () => ({ observed: { ...observed }, sockets: sockets.map(({ release: _release, ...row }) => ({ ...row, methods: [...row.methods] })),
      assets: assets.map(row => ({ ...row })), assetStatusGroups: assetStatusGroups(), errors: [...errors],
      mutationCount: sockets.flatMap(socket => socket.methods).filter(method => !readMethods.has(method)).length,
      evidenceClass: "real mounted current Mobile Web /mobile/ in Chromium; controlled workspace/worktree replies through owned JS mock Gateway; no Rust/Provider/native/performance claim", receiptSha256 });
    try {
      assert.equal((await page.goto(`${gateway.baseUrl}/mobile/`, { waitUntil: "domcontentloaded" })).status(), 200);
      await page.getByTestId("welcome-direct-connection").click();
      await page.getByTestId("gateway-endpoint").fill(gateway.baseUrl);
      await page.getByTestId("gateway-token").fill(gateway.authToken);
      await page.getByTestId("gateway-connect").click();
      await page.getByTestId("new-workspace").waitFor({ state: "visible", timeout: 30_000 });
      observed.phase = "home";
      const profileId = decodeURIComponent(new URL(page.url()).pathname.split("/").at(-1));
      // A full navigation creates a genuinely cold New cache, without deleting auth or changing product code.
      hold = true;
      const newUrl = new URL("/mobile/new", gateway.baseUrl); newUrl.searchParams.set("profileId", profileId);
      assert.equal((await page.goto(newUrl.toString(), { waitUntil: "domcontentloaded" })).status(), 200);
      observed.phase = "new-document";
      await waitFor(() => sockets.some(socket => socket.held >= 2), 20_000, "New's two catalog responses held", 25, context.abortSignal);
      await page.getByTestId("new-workspace-projects-loading").waitFor({ state: "visible" });
      observed.spinnerVisible = true;
      const add = page.getByLabel(/^(添加项目|Add project)$/);
      assert.equal(await add.isVisible(), true); assert.equal(await add.isEnabled(), true);
      observed.addVisibleAndEnabled = true;
      assert.equal(await page.getByTestId("create-workspace").isEnabled(), false);
      observed.createDisabled = true;
      assert.equal(sockets.flatMap(socket => socket.methods).filter(method => !readMethods.has(method)).length, 0);
      await add.click();
      observed.addClicked = true;
      await page.getByTestId("open-project-route").waitFor({ state: "visible", timeout: 10_000 });
      assert.equal(new URL(page.url()).pathname, "/mobile/open-project");
      assert.equal(new URL(page.url()).searchParams.get("profileId"), profileId);
      observed.heldCatalogResponsesAtNavigation = sockets.reduce((n, socket) => n + socket.held, 0);
      observed.reachedOpenProject = true;
      release = true; for (const socket of sockets) socket.release();
      const openProjectRoute = page.getByTestId("open-project-route");
      await openProjectRoute.waitFor({ state: "visible", timeout: 15_000 });
      const workspaceLabel = openProjectRoute.getByText("Controlled navigation workspace", { exact: true });
      await workspaceLabel.waitFor({ state: "visible", timeout: 15_000 });
      assert.equal(await workspaceLabel.count(), 1, "the exact controlled label must be unique on Open Project");
      const workspacePath = openProjectRoute.getByRole("textbox");
      await workspacePath.waitFor({ state: "visible", timeout: 15_000 });
      assert.equal(await workspacePath.count(), 1, "the Open Project path textbox must be unique");
      assert.equal(await workspacePath.inputValue(), workspace, "Open Project must show the owned workspace path");
      observed.releasedWorkspaceVisible = true;
      assert.equal(sockets.flatMap(socket => socket.methods).filter(method => !readMethods.has(method)).length, 0);
      assertAssetResponses();
      assert.deepEqual(errors, []);
      observed.businessAssertionsCompleted = true;
    } catch (error) {
      primaryError = error;
    } finally {
      // Persist the business snapshot before transport teardown can fail or append events.
      await context.writeArtifactJson("browser-navigation-before-close.json", {
        ...snapshot(), primaryError: primaryError ? context.redactText(primaryError.stack ?? String(primaryError)) : null,
      });
      const path = new URL(page.url()).pathname;
      if (["/mobile/new", "/mobile/open-project"].includes(path)) {
        try { await page.screenshot({ path: context.pathInArtifacts("navigation-page.png"), fullPage: false }); }
        catch (error) { observed.screenshotError = context.redactText(error.message); }
      }
      try {
        // Keep WebSocketRoute observers alive while the old document closes its sockets.
        await page.goto("about:blank");
        await waitFor(() => sockets.every(socket => socket.clientClosed && socket.gatewayClosed), 10_000, "both owned WebSocket endpoints closed", 25, context.abortSignal);
      } catch (error) { closeError = error; }
      finally { await page.close().catch(error => { closeError ??= error; }); }
      await context.writeArtifactJson("browser-navigation.json", { ...snapshot(),
        primaryError: primaryError ? context.redactText(primaryError.stack ?? String(primaryError)) : null,
        closeError: closeError ? context.redactText(closeError.stack ?? String(closeError)) : null,
      });
    }
    if (primaryError) throw primaryError;
    if (closeError) throw closeError;
  }
  const sourceAfter = await pins(sourceRootForPins); assert.deepEqual(sourceAfter, sourceBefore);
  if (committedSourceIdentity) {
    assert.deepEqual(await supportPins(repoRoot), executionSupportBefore, "export helpers changed while building committed source");
  }
  assert.equal(await digest(new URL(import.meta.url)), runnerSha256, "export runner changed during run");
  await context.writeArtifactJson("source-after.json", sourceAfter);
});
