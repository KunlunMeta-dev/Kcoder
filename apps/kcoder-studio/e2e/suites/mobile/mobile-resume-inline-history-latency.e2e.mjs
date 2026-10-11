import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access, copyFile, lstat, mkdir, readFile, readlink, realpath, readdir, symlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { AppServerStdioClient, waitForStdioChildClose } from "../../harness/app-server-stdio.mjs";
import { startChromium } from "../../harness/chromium.mjs";
import { startGateway, waitForGatewayRpcToken } from "../../harness/gateway.mjs";
import { hashExecutableFile, findOwnedExecutableProcesses } from "../../harness/owned-executable-provenance.mjs";
import { repoRoot, appRoot, runE2E, waitFor } from "../../harness/run-context.mjs";

const TEST_ID = "mobile-resume-inline-history-latency-real-gateway-stdio";
const GATEWAY_LABEL = "resume-history-latency-gateway";
const PRIVATE_INPUT_ROOTS = ["target/private-phone-ux-implementation", "target/private-phone-latency-implementation"];
const PIN_FILE_ENV = "KCODER_E2E_RESUME_HISTORY_PIN_FILE";
const PIN_SHA_ENV = "KCODER_E2E_RESUME_HISTORY_PIN_FILE_SHA256";
const REQUIRED_DELAYS_MS = [0, 300, 600, 1000];
const CONDITIONS = ["inline", "cap-withheld"];
const HISTORY_READ_METHODS = ["thread/read", "thread/read/indexed"];
const RPC_TIMEOUT_MS = 20_000;
const CHILD_EXIT_TIMEOUT_MS = 10_000;
const cli = parseCli(process.argv.slice(2));

assert.ok(["driver", "formal"].includes(cli.phase), "use --phase=driver or --phase=formal");
assert.equal(cli.samples, cli.phase === "driver" ? 1 : 30,
  cli.phase === "driver" ? "driver requires --samples=1" : "formal measurement requires --samples=30");
assert.deepEqual(cli.delays, REQUIRED_DELAYS_MS, "delay matrix is fixed at 0,300,600,1000ms");

await runE2E(import.meta.url, {
  testId: TEST_ID,
  tier: "manual-live",
  retainSuccessLogs: true,
  modelPolicy: "real Mobile Web + KCODER_STUDIO_MOCK=0 Gateway + pinned Rust app-server; deterministic seed only, no Browser turn or external Provider request",
}, async context => {
  const suitePath = fileURLToPath(import.meta.url);
  const suiteSha256 = sha256(await readFile(suitePath));
  const pins = await loadAndVerifyPins();
  await context.writeArtifactJson("resume-latency-input-pins.json", publicPinSummary(pins));
  const gatewayRuntime = await prepareFrozenGatewayRuntime(context, pins);

  const workspace = context.pathInState("workspace");
  const configDir = context.pathInState("config");
  const homeDir = context.pathInState("home");
  const tempRoot = context.pathInState("tmp");
  await Promise.all([workspace, configDir, homeDir, tempRoot].map(path => mkdir(path, { recursive: true, mode: 0o700 })));
  const settingsFile = await context.writeStateJson("config/settings.json", {
    active_provider: "integration-test",
    providers: {
      "integration-test": {
        api_format: "openai_chat_completions",
        endpoint: "http://127.0.0.1:1/v1",
        default_model: "deterministic-scenario",
        context_window_tokens: 128_000,
        output_headroom_tokens: 8_192,
        max_output_tokens: 8_192,
        request_timeout_secs: 30,
        no_proxy: true,
        extra_body: {},
      },
    },
    hooks: {},
  });
  await context.writeStateJson("config/credentials.json", {});
  const seed = await seedCompletedThread(context, { binaryPath: pins.rust.binaryPath, binarySha256: pins.rust.binarySha256, workspace, configDir, settingsFile, homeDir, tempRoot });
  await context.writeArtifactJson("resume-latency-seed.json", {
    threadIdSha256: sha256(Buffer.from(seed.threadId)),
    messageCount: seed.page.messages.length,
    messageProjectionSha256: sha256(Buffer.from(JSON.stringify(messageProjection(seed.page.messages)))),
    seedAppServerExitedBeforeGateway: true,
    deterministicLocalScenarioUsedOnlyForSeed: true,
    externalProviderRequested: false,
  });

  const serversFile = await context.writeStateJson("gateway-servers.json", [{
    id: "local", label: "Isolated resume-history latency fixture", runtime: "kcoder", transport: "local",
    command: pins.rust.binaryPath, workspace, settingsFile,
  }]);
  const gateway = await startGateway(context, {
    label: GATEWAY_LABEL,
    gatewayRoot: gatewayRuntime.root,
    cwd: gatewayRuntime.root,
    workspace,
    serversFile,
    kcoderBin: pins.rust.binaryPath,
    env: {
      KCODER_CONFIG_DIR: configDir,
      KCODER_TRAINING_MODE: "true",
      KCODER_STUDIO_WEB_ROOT: pins.mobileWeb.root,
      KCODER_STUDIO_MOCK: "0",
      KCODER_STUDIO_SCENARIO: "",
    },
  });
  await waitForGatewayRpcToken(context, gateway);
  const chromium = await startChromium(context, { label: "resume-history-latency-chromium", noSandbox: true });
  const results = [];
  let warmBackendIdentity = null;
  let ordinal = 0;
  const runErrors = [];
  const cleanupErrors = [];
  let summary = null;
  try {
    try {
      for (const delayMs of cli.delays) {
        for (let sampleIndex = 0; sampleIndex < cli.samples; sampleIndex += 1) {
          const conditions = sampleIndex % 2 === 0 ? CONDITIONS : [...CONDITIONS].reverse();
          for (const condition of conditions) {
            ordinal += 1;
            const options = {
              condition,
              delayMs,
              expectInline: condition === "inline",
              hideResumeHistoryCapability: condition === "cap-withheld",
              caseId: `${cli.phase}-d${delayMs}-${condition}-s${String(sampleIndex + 1).padStart(2, "0")}`,
            };
            try {
              const result = await measureSample(context, chromium, gateway, seed, options);
              if (warmBackendIdentity === null) warmBackendIdentity = result.gatewayRuntime;
              assert.equal(result.gatewayRuntime.gatewayPid, warmBackendIdentity.gatewayPid, "Gateway changed during the warm-backend run");
              assert.equal(result.gatewayRuntime.appServerPid, warmBackendIdentity.appServerPid, "Rust app-server changed during the warm-backend run");
              result.ordinal = ordinal;
              results.push(result);
              await context.writeArtifactJson(`resume-latency-sample-${safeSlug(options.caseId)}.json`, result);
            } catch (error) {
              const failure = {
                caseId: options.caseId, condition, delayMs, sampleIndex: sampleIndex + 1,
                status: error?.code === "UNPAIRED" ? "UNPAIRED" : "ERROR",
                error: context.redactText(error?.stack || error?.message || String(error)),
              };
              results.push(failure);
              await context.writeArtifactJson(`resume-latency-sample-result-${safeSlug(options.caseId)}.json`, failure);
              if (gateway.child.exitCode !== null || gateway.child.signalCode !== null) throw error;
            }
          }
        }
      }
    } catch (error) {
      runErrors.push(error);
    }

    try {
      const finalPins = await loadAndVerifyPins();
      assert.equal(finalPins.pinFileSha256, pins.pinFileSha256, "pinned source/runtime inputs changed during Browser run");
      assert.equal(sha256(await readFile(suitePath)), suiteSha256, "latency suite source changed while the run was active");
      summary = summarizeMatrix(results, cli);
      summary.suiteSha256 = suiteSha256;
      summary.pinFileSha256 = pins.pinFileSha256;
      summary.sourceDigest = pins.source.sourceDigest;
      summary.mobileWebBundleSha256 = pins.mobileWeb.bundleSha256;
      summary.rustBinarySha256 = pins.rust.binarySha256;
      summary.gatewayRuntimeRoot = gatewayRuntime.root;
      summary.gatewayRuntimeSourceSha256 = gatewayRuntime.sourceSha256;
      summary.backendReuse = "one pinned Gateway/app-server process for the run; warm backend, not cold Rust";
      summary.freshPerSample = "new Playwright BrowserContext and Mobile TaskRuntime for each sample; same completed persisted history is used as a protocol counterfactual";
      summary.responseHoldMeaning = "additional local hold from real upstream RPC response receipt to route send; not RTT or physical-phone latency";
      summary.pageVisibilityMeaning = "first Playwright-equivalent visible seed-user row observed by document-start MutationObserver+RAF; two-RAF marker is not compositor paint";
      await context.writeArtifactJson("resume-latency-summary.json", summary);
      if (summary.errorCount !== 0) runErrors.push(new Error(`resume latency matrix has failed samples: ${summary.errorCount}`));
    } catch (error) {
      runErrors.push(error);
    }
  } finally {
    await captureCleanupFailure(cleanupErrors, "Chromium close", () => chromium.close());
    const ownedChromium = context.processes.get("resume-history-latency-chromium");
    await captureCleanupFailure(cleanupErrors, "Chromium RunContext stop assertion", async () => {
      assert.equal(ownedChromium?.stopped, true, "owned Chromium did not stop");
    });
    await captureCleanupFailure(cleanupErrors, "Chromium child exit", async () => {
      await waitFor(() => chromium.child.exitCode !== null || chromium.child.signalCode !== null,
        5_000, "owned Chromium child exit", 25);
    });
    await captureCleanupFailure(cleanupErrors, "Gateway stop and process verification",
      () => stopGatewayAndVerify(context, gateway, pins.rust.binaryPath));
  }

  const collectedErrors = [...runErrors, ...cleanupErrors];
  if (collectedErrors.length === 1) throw collectedErrors[0];
  if (collectedErrors.length > 1) {
    throw new AggregateError(collectedErrors, "resume latency run failed; primary and cleanup errors are retained", {
      cause: runErrors[0] || cleanupErrors[0],
    });
  }
  return summary;
});

async function loadAndVerifyPins() {
  const pinPath = process.env[PIN_FILE_ENV]?.trim();
  const expectedPinSha = process.env[PIN_SHA_ENV]?.trim().toLowerCase();
  assert.ok(pinPath && isAbsolute(pinPath), `set ${PIN_FILE_ENV} to the absolute private resume-history pin path`);
  assert.match(expectedPinSha || "", /^[0-9a-f]{64}$/, `set ${PIN_SHA_ENV} to the reviewed pin SHA-256`);
  const privateRoots = await Promise.all(PRIVATE_INPUT_ROOTS.map(path => realpath(resolve(repoRoot, path))));
  const pinInfo = await lstat(pinPath);
  assert.ok(pinInfo.isFile() && !pinInfo.isSymbolicLink(), "pin file must be a regular file");
  const canonicalPinPath = await realpath(pinPath);
  assert.ok(privateRoots.some(root => isWithin(root, canonicalPinPath)), "pin file escaped approved private roots");
  const pinBytes = await readFile(canonicalPinPath);
  const pinFileSha256 = sha256(pinBytes);
  assert.equal(pinFileSha256, expectedPinSha, "pin file digest mismatch");
  const pins = JSON.parse(pinBytes.toString("utf8"));
  assert.equal(pins.schemaVersion, 1);
  assert.equal(pins.releaseId, "resume-history-20261008");
  const source = await verifyCandidate(pins.source, privateRoots);
  const rust = await verifyRust(pins.rust, privateRoots);
  const mobileWeb = await verifyMobileWeb(pins.mobileWeb, privateRoots[0], source);
  const gatewaySourceFiles = gatewaySourceManifest(pins.gateway, source);
  const node = await hashExecutableFile(process.execPath);
  assert.equal(node.path, pins.node.path, "Node executable path differs from reviewed pin");
  assert.equal(node.sha256, pins.node.sha256, "Node executable hash differs from reviewed pin");
  assert.equal(process.version, pins.node.version, "Node version differs from reviewed pin");
  return { ...pins, pinFileSha256, source, rust, mobileWeb, gatewaySourceFiles, privateRoots };
}

async function prepareFrozenGatewayRuntime(context, pins) {
  const privateRoot = pins.privateRoots[0];
  const runKey = basename(context.runRoot);
  assert.match(runKey, /^\d{8}-\d{6}\.\d{3}Z$/);
  const root = resolve(privateRoot, `resume-history-gateway-runtime-${pins.source.sourceDigest.slice(0, 12)}-${runKey}`);
  assert.ok(isWithin(privateRoot, root));
  await mkdir(root, { recursive: false, mode: 0o700 });

  for (const { sourcePath, runtimePath, sha256: expectedSha256 } of pins.gatewaySourceFiles) {
    const sourceFile = resolve(pins.source.root, ...sourcePath.split("/"));
    const destination = resolve(root, ...runtimePath.split("/"));
    assert.ok(isWithin(pins.source.root, sourceFile));
    assert.ok(isWithin(root, destination));
    assert.equal(await realpath(sourceFile), sourceFile);
    const sourceInfo = await lstat(sourceFile);
    assert.ok(sourceInfo.isFile() && !sourceInfo.isSymbolicLink());
    assert.equal(sha256(await readFile(sourceFile)), expectedSha256, `Gateway candidate changed before relocation: ${sourcePath}`);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await copyFile(sourceFile, destination, constants.COPYFILE_EXCL);
    const destinationInfo = await lstat(destination);
    assert.ok(destinationInfo.isFile() && !destinationInfo.isSymbolicLink());
    assert.equal(sha256(await readFile(destination)), expectedSha256, `Gateway source relocation mismatch: ${sourcePath}`);
  }

  const pinnedNodeModules = resolve(pins.gateway.nodeDependencies.resolutionRoot, "node_modules");
  const runtimeNodeModules = resolve(root, "node_modules");
  await symlink(pinnedNodeModules, runtimeNodeModules, "dir");
  assert.equal(await readlink(runtimeNodeModules), pinnedNodeModules);
  assert.equal(await realpath(runtimeNodeModules), await realpath(pinnedNodeModules));

  const runtimeSource = await verifyGatewaySources(pins.gateway, pins.source, root);
  const dependencyEvidence = await verifyGatewayDependencies(pins.gateway.nodeDependencies, root);
  const sidecar = {
    status: "complete",
    sourceCandidateDigest: pins.source.sourceDigest,
    sourceCandidateManifestSha256: pins.source.manifestSha256,
    runtimeSourceSha256: pins.gateway.runtimeSourceSha256,
    runtimeSourceFileCount: runtimeSource.files.length,
    runtimeFiles: runtimeSource.files,
    gatewayRoot: runtimeSource.root,
    cwd: runtimeSource.root,
    scriptPath: runtimeSource.scriptPath,
    nodeModulesSymlink: {
      path: runtimeNodeModules,
      target: pinnedNodeModules,
      realTarget: await realpath(runtimeNodeModules),
      dependencyClosureSha256: pins.gateway.nodeDependencies.closureSha256,
      resolvedPackages: dependencyEvidence.direct,
    },
  };
  await context.writeArtifactJson("gateway-runtime-relocation.json", sidecar);
  return { root: runtimeSource.root, scriptPath: runtimeSource.scriptPath, sourceSha256: pins.gateway.runtimeSourceSha256 };
}

function gatewaySourceManifest(input, candidate) {
  const entries = Object.entries(candidate.manifest)
    .filter(([path]) => path.startsWith(input.sourcePrefix) && !path.startsWith(input.excludedPrefix))
    .sort(([a], [b]) => a.localeCompare(b));
  assert.equal(entries.length, input.fileCount, "Gateway candidate source count differs from the reviewed pin");
  assert.equal(hashJson(entries.map(([path, digest]) => ({ path, sha256: digest }))), input.runtimeSourceSha256,
    "Gateway candidate source digest differs from the reviewed pin");
  return entries.map(([sourcePath, digest]) => ({
    sourcePath,
    runtimePath: sourcePath.slice(input.sourcePrefix.length),
    sha256: digest,
  }));
}

async function verifyCandidate(input, privateRoots) {
  assert.ok([input.root, input.manifestPath, input.metadataPath].every(path => isAbsolute(path)), "candidate paths must be absolute");
  const root = await realpath(input.root);
  assert.ok(privateRoots.some(privateRoot => isWithin(privateRoot, root)), "candidate root escaped approved private roots");
  assert.equal(root, resolve(input.root), "candidate root is not canonical");
  const manifestBytes = await readFile(input.manifestPath);
  const metadataBytes = await readFile(input.metadataPath);
  assert.equal(sha256(manifestBytes), input.manifestSha256, "candidate manifest hash mismatch");
  assert.equal(sha256(metadataBytes), input.metadataSha256, "candidate metadata hash mismatch");
  assert.equal(input.manifestPath, resolve(root, "sha256.json"));
  assert.equal(input.metadataPath, resolve(root, "metadata.json"));
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const entries = Object.entries(manifest).sort(([a], [b]) => a.localeCompare(b));
  assert.equal(entries.length, 245, "candidate must be the reviewed 245-file source freeze");
  assert.equal(entries.length, input.fileCount);
  assert.equal(sha256(manifestBytes), input.sourceDigest, "candidate source digest mismatch");
  const metadata = JSON.parse(metadataBytes.toString("utf8"));
  assert.equal(metadata.status, "complete");
  assert.equal(metadata.sourceDigest, input.sourceDigest);
  assert.equal(metadata.sourceFiles, entries.length);
  for (const [path, digest] of entries) {
    assert.ok(path && !path.startsWith("/") && !path.includes("\\") && !path.split("/").includes(".."), `unsafe candidate path ${path}`);
    assert.match(digest, /^[0-9a-f]{64}$/);
    const file = resolve(root, ...path.split("/"));
    assert.ok(isWithin(root, file));
    assert.equal(await realpath(file), file, `candidate entry is symlinked: ${path}`);
    const info = await lstat(file);
    assert.ok(info.isFile() && !info.isSymbolicLink());
    assert.equal(sha256(await readFile(file)), digest, `candidate entry hash mismatch: ${path}`);
  }
  return { ...input, root, manifest, metadata };
}

async function verifyRust(input, privateRoots) {
  const info = await lstat(input.binaryPath);
  assert.ok(info.isFile() && !info.isSymbolicLink());
  const binary = await hashExecutableFile(input.binaryPath);
  await access(binary.path, constants.X_OK);
  assert.ok(privateRoots.some(root => isWithin(root, binary.path)), "Rust binary escaped approved private roots");
  assert.equal(binary.sha256, input.binarySha256);
  assert.equal(binary.size, input.binaryBytes);
  assert.notEqual(binary.sha256, "d1c98e33084e6dc8692d0e710d22affb01ebfd79a8d60a4b37965a6d841cbcf6", "legacy navigation binary cannot validate the new resume protocol");
  const buildBytes = await readFile(input.buildProvenancePath);
  const sourcePinBytes = await readFile(input.sourcePinPath);
  assert.equal(sha256(buildBytes), input.buildProvenanceSha256);
  assert.equal(sha256(sourcePinBytes), input.sourcePinSha256);
  const build = JSON.parse(buildBytes.toString("utf8"));
  const sourcePin = JSON.parse(sourcePinBytes.toString("utf8"));
  assert.equal(build.exitCode, 0);
  assert.equal(build.sourceUnchanged, true);
  assert.deepEqual(build.changedSources, []);
  assert.equal(build.newDownloadsObserved, false);
  assert.equal(build.binary.sha256, binary.sha256);
  assert.equal(build.sourcePinSha256, input.sourcePinSha256);
  assert.equal(typeof sourcePin.scope, "string");
  assert.ok(sourcePin.scope.length > 0);
  // The source-pin sidecar is bound by its reviewed exact-byte SHA above; this
  // suite does not reinterpret its large source inventory as a new source set.
  return { ...input, binary };
}

async function verifyMobileWeb(input, privateRoot, candidate) {
  const root = await realpath(input.root);
  assert.ok(isWithin(privateRoot, root), "Mobile Web root escaped the private export directory");
  const manifestBytes = await readFile(input.manifestPath);
  const provenanceBytes = await readFile(input.provenancePath);
  assert.equal(sha256(manifestBytes), input.manifestSha256);
  assert.equal(sha256(provenanceBytes), input.provenanceSha256);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const provenance = JSON.parse(provenanceBytes.toString("utf8"));
  assert.equal(manifest.status, "complete");
  assert.equal(manifest.sourceUnchanged, true);
  assert.equal(manifest.snapshotUnchangedDuringExport, true);
  assert.equal(manifest.sourceTreeSha256, input.sourceTreeSha256);
  assert.equal(provenance.status, "complete");
  assert.equal(provenance.candidateDigest, candidate.sourceDigest);
  assert.equal(provenance.bundleSha256, input.bundleSha256);
  assert.equal(provenance.bundleFileCount, 37);
  assert.equal(provenance.dependencyInput.sourceTreeSha256, input.dependencySourceTreeSha256);
  assert.equal(provenance.dependencyInput.ownedTreeSha256, input.dependencyOwnedTreeSha256);
  const files = await hashRegularTree(root);
  assert.deepEqual(files, manifest.bundleFiles);
  assert.equal(hashJson(files), input.bundleSha256);
  assert.equal(files.find(file => file.path === "index.html")?.sha256, input.indexHtmlSha256);
  return { ...input, root, manifest, provenance };
}

async function verifyGatewaySources(input, candidate, runtimeRoot) {
  const expectedFiles = gatewaySourceManifest(input, candidate);
  const root = await realpath(runtimeRoot);
  assert.equal(root, resolve(runtimeRoot), "frozen Gateway runtime root is not canonical");
  assert.ok(isWithin(await realpath(resolve(repoRoot, PRIVATE_INPUT_ROOTS[0])), root), "frozen Gateway runtime escaped its private root");
  for (const { sourcePath, runtimePath, sha256: expectedSha256 } of expectedFiles) {
    const sourceFile = resolve(candidate.root, ...sourcePath.split("/"));
    const runtimeFile = resolve(root, ...runtimePath.split("/"));
    assert.ok(isWithin(candidate.root, sourceFile));
    assert.ok(isWithin(root, runtimeFile));
    assert.equal(await realpath(sourceFile), sourceFile);
    assert.equal(await realpath(runtimeFile), runtimeFile);
    assert.equal(sha256(await readFile(sourceFile)), expectedSha256, `Gateway candidate source changed: ${sourcePath}`);
    assert.equal(sha256(await readFile(runtimeFile)), expectedSha256, `Frozen Gateway source differs from candidate: ${sourcePath}`);
  }
  const actualTree = await collectTree(root);
  const actualFiles = actualTree.filter(entry => entry.type === "file").map(({ path, size, sha256: digest }) => ({ path, size, sha256: digest }));
  const expectedTree = await Promise.all(expectedFiles.map(async file => ({
    path: file.runtimePath,
    size: (await lstat(resolve(root, ...file.runtimePath.split("/")))).size,
    sha256: file.sha256,
  })));
  assert.deepEqual(actualFiles, expectedTree, "frozen Gateway source tree contains missing, extra, or changed files");
  const nodeModulesLinks = actualTree.filter(entry => entry.type === "symlink");
  assert.deepEqual(nodeModulesLinks, [{ path: "node_modules", type: "symlink", target: resolve(input.nodeDependencies.resolutionRoot, "node_modules") }]);
  assert.equal(hashJson(expectedFiles.map(({ sourcePath, sha256: digest }) => ({ path: sourcePath, sha256: digest }))), input.runtimeSourceSha256);
  return { root, files: expectedTree, scriptPath: resolve(root, "dev-server.mjs") };
}

async function verifyGatewayDependencies(input, gatewayRoot) {
  assert.equal(input.resolutionRoot, resolve(appRoot));
  const nodeModules = resolve(gatewayRoot, "node_modules");
  assert.equal(await realpath(nodeModules), await realpath(resolve(input.resolutionRoot, "node_modules")),
    "frozen Gateway node_modules does not resolve to the pinned dependency tree");
  assert.equal(input.packageCount, input.packages.length);
  for (const pkg of input.packages) {
    const root = await realpath(pkg.root);
    assert.equal(root, resolve(pkg.root));
    const tree = await collectTree(root, { omitNodeModules: true });
    assert.equal(tree.length, pkg.fileCount, `Gateway dependency file count changed: ${pkg.name}`);
    assert.equal(hashJson(tree), pkg.treeSha256, `Gateway dependency tree changed: ${pkg.name}`);
  }
  assert.equal(hashJson(input.packages.map(({ name, version, root, fileCount, treeSha256 }) => ({ name, version, root, fileCount, treeSha256 }))), input.closureSha256);
  const directResolutions = [];
  for (const direct of input.direct) {
    const importer = resolve(gatewayRoot, ...direct.importer.split("/"));
    assert.equal(await realpath(importer), importer, `frozen Gateway dependency importer is not a regular path: ${direct.importer}`);
    const entry = createRequire(importer).resolve(direct.name);
    assert.equal(entry, direct.entryPath, `Gateway dependency resolution changed: ${direct.name}`);
    const packageRoot = (await findPackageRoot(entry, direct.name)).root;
    assert.equal(packageRoot, direct.packageRoot, `Gateway dependency root changed: ${direct.name}`);
    directResolutions.push({ name: direct.name, entryPath: entry, packageRoot });
  }
  return { direct: directResolutions };
}

async function findPackageRoot(entryPath, expectedName) {
  let current = dirname(entryPath);
  while (current !== dirname(current)) {
    try {
      const metadata = JSON.parse((await readFile(resolve(current, "package.json"))).toString("utf8"));
      if (metadata.name === expectedName) return { root: await realpath(current), metadata };
    } catch (error) {
      if (! ["ENOENT", "ENOTDIR", "EACCES"].includes(error?.code)) throw error;
    }
    current = dirname(current);
  }
  throw new Error(`Gateway dependency package root not found: ${expectedName}`);
}

async function collectTree(root, { omitNodeModules = false } = {}) {
  const files = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (omitNodeModules && entry.name === "node_modules") continue;
      const path = resolve(directory, entry.name);
      const info = await lstat(path);
      const relativePath = relative(root, path).split(sep).join("/");
      if (info.isSymbolicLink()) files.push({ path: relativePath, type: "symlink", target: await readlink(path) });
      else if (info.isDirectory()) await visit(path);
      else if (info.isFile()) files.push({ path: relativePath, type: "file", size: info.size, sha256: sha256(await readFile(path)) });
      else assert.fail(`unexpected special file in pinned input: ${relativePath}`);
    }
  }
  await visit(root);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

async function hashRegularTree(root) {
  const files = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      const info = await lstat(path);
      assert.ok(!info.isSymbolicLink(), `bundle path is a symlink: ${relative(root, path)}`);
      if (info.isDirectory()) await visit(path);
      else if (info.isFile()) files.push({ path: relative(root, path).split(sep).join("/"), size: info.size, sha256: sha256(await readFile(path)) });
      else assert.fail(`bundle path is not a regular file: ${relative(root, path)}`);
    }
  }
  await visit(root);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

async function seedCompletedThread(context, input) {
  const title = `RESUME_LATENCY_E2E_${randomBytes(6).toString("hex")}`;
  const sentinel = `${title}_SEED_MESSAGE`;
  const label = "resume-latency-stdio-seed";
  const binary = await hashExecutableFile(input.binaryPath);
  assert.equal(binary.sha256, input.binarySha256);
  const env = context.isolatedEnvironment({
    HOME: input.homeDir, USERPROFILE: input.homeDir, XDG_CONFIG_HOME: input.configDir,
    KCODER_CONFIG_DIR: input.configDir, TMPDIR: input.tempRoot, TMP: input.tempRoot, TEMP: input.tempRoot,
  });
  const child = context.spawnOwned(label, binary.path, ["--settings-file", input.settingsFile, "--cwd", input.workspace, "app-server", "--training-mode", "--scenario", "thinking-preview"], {
    cwd: input.workspace, env, stdin: "pipe",
  });
  assert.ok(child.stdin && child.stdout);
  const client = new AppServerStdioClient(label, child, { defaultTimeoutMs: RPC_TIMEOUT_MS });
  const owned = context.processes.get(label);
  assert.ok(owned?.pid === child.pid && owned.pgid > 0);
  await waitFor(async () => {
    const matches = await findOwnedExecutableProcesses({ pgid: owned.pgid, executablePath: binary.path });
    return matches.find(item => item.pid === child.pid) ?? null;
  }, 10_000, "pinned deterministic seed app-server", 50, context.abortSignal);
  let closed = false;
  context.addCleanup(`close ${label} JSONL child`, async () => {
    if (closed) return;
    if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end();
    await waitForStdioChildClose(child, CHILD_EXIT_TIMEOUT_MS, label).catch(() => undefined);
    await context.stopOwned(label).catch(() => undefined);
    client.closeReader();
    closed = true;
  });
  const initialized = await client.request("initialize", { protocolVersion: "2026-07-27", clientInfo: { name: TEST_ID, version: "1" } });
  assert.equal(initialized.error, undefined);
  assert.equal(initialized.result?.capabilities?.experimental?.threadResumeHistoryPageV1, true);
  const started = await client.request("thread/start", {});
  assert.equal(started.error, undefined);
  const threadId = started.result?.thread?.id;
  assert.ok(typeof threadId === "string" && threadId.length > 0);
  const turn = await client.request("turn/start", { threadId, input: [{ type: "text", text: sentinel }] });
  assert.equal(turn.error, undefined);
  const turnId = turn.result?.turn?.id;
  assert.ok(typeof turnId === "string" && turnId.length > 0);
  const completed = await client.waitForNotification(frame => frame.method === "turn/completed" && frame.params?.threadId === threadId && frame.params?.turnId === turnId,
    30_000, "seed turn/completed");
  assert.equal(completed.params?.turn?.status, "completed");
  assert.equal((await client.request("thread/metadata/update", { threadId, title })).error, undefined);
  const read = await client.request("thread/read", { threadId, limit: 50 });
  assert.equal(read.error, undefined);
  assert.ok(read.result?.messages?.some(message => message.role === "user" && message.content?.includes(sentinel)));
  const ids = read.result.messages.map(message => message.id);
  assert.equal(new Set(ids).size, ids.length);
  if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end();
  const exit = await waitForStdioChildClose(child, CHILD_EXIT_TIMEOUT_MS, label);
  await context.stopOwned(label);
  client.closeReader();
  closed = true;
  assert.equal(exit.code, 0);
  assert.deepEqual(await findOwnedExecutableProcesses({ pgid: owned.pgid, executablePath: binary.path }), []);
  return { threadId, title, sentinel, page: read.result };
}

async function measureSample(context, chromium, gateway, seed, options) {
  const page = await chromium.newPage({ viewport: { width: 390, height: 844 } });
  const pageContext = page.context();
  const observations = {
    pageId: options.caseId,
    threadId: seed.threadId,
    socketIds: [],
    socketRecords: new Map(),
    requests: [],
    responses: [],
    holds: [],
    setupInitializations: [],
    unpairedInitializations: [],
    runtimeTaskCandidate: null,
    runtimeTaskCandidateAmbiguous: false,
    sessionClickCapture: null,
    runtimeWindowArm: null,
    resumeResults: [],
    capabilitiesBySocket: new Map(),
  };
  const browserErrors = [];
  const httpEvents = [];
  const nodeTimeline = {};
  page.on("pageerror", error => browserErrors.push(error.message));
  page.on("request", request => httpEvents.push({ type: "request", method: request.method(), path: safePath(request.url()), atNodeMs: performance.now() }));
  page.on("response", response => httpEvents.push({ type: "response", method: response.request().method(), path: safePath(response.url()), status: response.status(), atNodeMs: performance.now() }));
  try {
    await page.exposeBinding("__resumeHistoryLatencyClickObserved", (_source, event) => {
      if (event?.testId !== `session-${seed.threadId}` || observations.sessionClickCapture) return;
      observations.sessionClickCapture = {
        browserPerformanceNowMs: event.performanceNowMs,
        browserEpochMs: event.epochMs,
        nodeObservedAtMs: performance.now(),
      };
    });
    await page.addInitScript(installSeedUserObserver, { sentinel: seed.sentinel, sessionTestId: `session-${seed.threadId}` });
    await installRpcInstrumentation(page, observations, options);
    await connectMobile(page, gateway, nodeTimeline);
    await markNode(nodeTimeline, "sessionsClick", () => page.getByTestId("sessions").click());
    await markNode(nodeTimeline, "sessionSearchFill", () => page.getByTestId("session-search").fill(seed.title));
    const session = page.getByTestId(`session-${seed.threadId}`);
    await session.waitFor({ state: "visible", timeout: 20_000 });
    const armStartedAtNodeMs = performance.now();
    const arm = await page.evaluate(() => window.__resumeHistoryLatency.armTaskRuntimeWindow());
    observations.runtimeWindowArm = { ...arm, armedAtNodeMs: armStartedAtNodeMs };
    nodeTimeline.runtimeSocketWindowArm = { armedAtNodeMs: armStartedAtNodeMs, armedAtBrowserEpochMs: arm.epochMs };
    await markNode(nodeTimeline, "sessionSelectClick", () => session.click());
    await waitFor(() => observations.sessionClickCapture !== null, 5_000,
      `${options.caseId} page-observed session click`, 10, context.abortSignal)
      .catch(() => requirePaired(false, "Playwright click completed but the page's capture-phase session click was not observed in Node"));

    const observerWaitStart = performance.now();
    await page.waitForFunction(() => {
      const snapshot = window.__resumeHistoryLatency?.snapshot?.();
      return Boolean(snapshot?.seedUser?.firstVisible);
    }, undefined, { timeout: 20_000, polling: "raf" });
    const observerWaitEnd = performance.now();
    nodeTimeline.pageObserverWait = { startedAtNodeMs: observerWaitStart, returnedAtNodeMs: observerWaitEnd, elapsedMs: observerWaitEnd - observerWaitStart };
    const locator = page.getByTestId("message-user").filter({ hasText: seed.sentinel });
    const locatorWaitStart = performance.now();
    await locator.waitFor({ state: "visible", timeout: 20_000 });
    const locatorWaitEnd = performance.now();
    nodeTimeline.playwrightLocatorWait = { startedAtNodeMs: locatorWaitStart, returnedAtNodeMs: locatorWaitEnd, elapsedMs: locatorWaitEnd - locatorWaitStart };
    await page.getByTestId("message-input-root").waitFor({ state: "visible", timeout: 20_000 });
    const pageTiming = await page.evaluate(() => window.__resumeHistoryLatency.snapshot());
    assert.equal(await locator.count(), 1);
    assert.equal(await locator.isVisible(), true);
    assert.equal(countOccurrences(await locator.innerText(), seed.sentinel), 1);
    assert.equal(pageTiming.seedUser.visibleMatchesAtFirstVisible, 1);
    assert.ok(pageTiming.clicks.sessionSelect);
    assert.ok(pageTiming.seedUser.firstVisible.performanceNowMs >= pageTiming.clicks.sessionSelect.performanceNowMs);
    requirePaired(pageTiming.clicks.sessionSelect.epochMs === observations.sessionClickCapture.browserEpochMs,
      "page click observer and Node binding did not identify the same session-selection click");
    requirePaired(pageTiming.runtimeSocketWindowArmed?.epochMs === observations.runtimeWindowArm.epochMs,
      "page and Node did not observe the same pre-click runtime-window arm");

    const gatewayRuntime = await verifyGatewayRuntime(context, gateway, pins.rust.binaryPath);
    await waitFor(() => observations.resumeResults.length >= 1 && observations.resumeResults[0].forwardedAt !== null,
      10_000, `${options.caseId} resume response delivery`, 25, context.abortSignal);
    requirePaired(observations.resumeResults.length === 1,
      `expected one target thread/resume response, observed ${observations.resumeResults.length}`);
    const resume = observations.resumeResults[0];
    assert.equal(observations.capabilitiesBySocket.get(resume.socketId)?.server.threadResumeHistoryPageV1, true);
    assert.equal(observations.capabilitiesBySocket.get(resume.socketId)?.client.threadResumeHistoryPageV1, options.expectInline);
    assert.equal(resume.request.threadId, seed.threadId);
    const targetResumeRequests = observations.requests.filter(entry => entry.method === "thread/resume" && entry.threadId === seed.threadId);
    requirePaired(targetResumeRequests.length === 1, `expected one target resume request, observed ${targetResumeRequests.length}`);
    const targetReads = observations.requests.filter(entry => HISTORY_READ_METHODS.includes(entry.method) && entry.threadId === seed.threadId);
    const taskSocketReads = targetReads.filter(entry => entry.socketId === resume.socketId);
    requirePaired(observations.runtimeTaskCandidate?.socketId === resume.socketId,
      "session click did not produce a uniquely observed new TaskRuntime initialize socket used by thread/resume");
    requirePaired(observations.runtimeTaskCandidateAmbiguous === false,
      "more than one post-click initialize socket was eligible for TaskRuntime ownership");
    requirePaired(observations.runtimeWindowArm.armedAtNodeMs < observations.sessionClickCapture.nodeObservedAtMs &&
      observations.runtimeWindowArm.epochMs < observations.sessionClickCapture.browserEpochMs,
    "TaskRuntime socket window was not armed before the actual session click");
    requirePaired(observations.runtimeTaskCandidate.socketOpenedAtNodeMs >= observations.sessionClickCapture.nodeObservedAtMs,
      "candidate WebSocket route was observed before the actual session click");
    requirePaired(observations.runtimeTaskCandidate.initializeRequest.sentAtNodeMs >= observations.sessionClickCapture.nodeObservedAtMs,
      "candidate initialize request route was observed before the actual session click");
    requirePaired(resume.initializeResponse?.forwardedAt !== null && resume.initializeResponse?.forwardedAt <= resume.request.sentAtNodeMs,
      "candidate TaskRuntime initialize response was not forwarded before its same-socket thread/resume request");
    requirePaired(observations.runtimeTaskCandidate.initializeRequest.id === resume.initializeResponse.rpcId,
      "candidate initialize request/response RPC IDs did not pair");
    requirePaired(resume.request.id === resume.hold.rpcId,
      "target thread/resume request/response RPC IDs did not pair");
    assert.equal(resume.deliveredResult?.thread?.id, seed.threadId, "resume response belongs to a different persisted thread");
    if (options.expectInline) {
      assert.equal(resume.request.historyPresent, true);
      assert.equal(resume.request.history?.limit, 50);
      assert.equal(resume.deliveredResult?.history?.status, "ready");
      assert.deepEqual(messageProjection(resume.deliveredResult.history.page.messages), messageProjection(seed.page.messages));
      assert.equal(targetReads.length, 0, "inline resume issued no fallback history read on any socket");
    } else {
      assert.equal(resume.request.historyPresent, false);
      assert.deepEqual(resume.request.history, { missing: true });
      assert.equal(resume.deliveredResult?.history, undefined);
      assert.equal(targetReads.length, 1, "withheld capability must issue exactly one fallback history read");
      requirePaired(taskSocketReads.length === 1, "fallback history read did not use the TaskRuntime socket");
      assert.equal(targetReads[0].method, observations.capabilitiesBySocket.get(resume.socketId)?.client.threadIndexedPagesV1 ? "thread/read/indexed" : "thread/read");
      assert.deepEqual(messageProjection(targetReads[0].result?.messages), messageProjection(seed.page.messages));
      requirePaired(resume.forwardedAt !== null && resume.forwardedAt <= targetReads[0].sentAtNodeMs,
        "thread/resume response was not forwarded before the same-socket fallback read request");
      requirePaired(targetReads[0].id === targetReads[0].responseRpcId,
        "fallback history read request/response RPC IDs did not pair");
      requirePaired(targetReads[0].responseForwardedAtNodeMs !== null,
        "fallback history read response was not forwarded to the TaskRuntime socket");
    }
    if (options.expectInline) assert.equal(taskSocketReads.length, 0, "inline resume issued no same-socket fallback read");
    const initializeRequests = observations.requests.filter(entry => entry.method === "initialize" && entry.socketId === resume.socketId);
    requirePaired(initializeRequests.length === 1, `TaskRuntime socket must have one initialize request, observed ${initializeRequests.length}`);
    const measuredRequests = [...initializeRequests,
      ...observations.requests.filter(entry => entry.socketId === resume.socketId && entry.method === "thread/resume" && entry.threadId === seed.threadId),
      ...taskSocketReads];
    assert.equal(measuredRequests.length, options.expectInline ? 2 : 3);
    assert.deepEqual(measuredRequests.map(entry => entry.method).sort(), observations.holds.filter(entry => entry.socketId === resume.socketId).map(entry => entry.method).sort());
    for (const hold of observations.holds.filter(entry => entry.socketId === resume.socketId)) {
      assert.equal(hold.configuredHoldMs, options.delayMs);
      assert.ok(hold.appliedHoldMs + 1 >= options.delayMs, `${hold.method} response hold under-ran`);
    }
    const nonCritical = observations.responses.filter(entry => !(entry.runtimeTaskInitialize === true ||
      (entry.socketId === resume.socketId && entry.threadId === seed.threadId && (entry.method === "thread/resume" || HISTORY_READ_METHODS.includes(entry.method)))));
    assert.ok(nonCritical.every(entry => entry.configuredHoldMs === 0), "setup/list response received an injected hold");
    assert.ok(observations.setupInitializations.every(entry => entry.configuredHoldMs === 0), "setup initialize responses must never receive the injected hold");
    assert.ok(observations.unpairedInitializations.every(entry => entry.configuredHoldMs === 0), "unpaired initialize responses must never receive the injected hold");
    const allInitializeResponses = observations.responses.filter(entry => entry.method === "initialize");
    const candidateInitializeResponses = allInitializeResponses.filter(entry => entry.runtimeTaskInitialize);
    requirePaired(candidateInitializeResponses.length === 1,
      `expected one click-associated TaskRuntime initialize response, observed ${candidateInitializeResponses.length}`);
    assert.equal(allInitializeResponses.length,
      observations.setupInitializations.length + observations.unpairedInitializations.length + candidateInitializeResponses.length,
      "every initialize response must be classified as setup, unpaired, or the TaskRuntime candidate");
    assert.equal(observations.requests.filter(entry => entry.method === "turn/start").length, 0, "Browser unexpectedly started a model turn");
    assert.equal(browserErrors.length, 0);

    const firstVisible = pageTiming.seedUser.firstVisible.performanceNowMs;
    const sample = {
      caseId: options.caseId,
      status: "PASS",
      condition: options.condition,
      delayMs: options.delayMs,
      freshBrowserContext: true,
      freshMobileTaskRuntime: true,
      warmBackend: true,
      gatewayRuntime,
      pageId: observations.pageId,
      taskRuntimeSocketId: resume.socketId,
      threadIdSha256: sha256(Buffer.from(seed.threadId)),
      timing: {
        pageTimeOriginEpochMs: pageTiming.timeOriginEpochMs,
        navigationStartPerformanceNowMs: pageTiming.navigationStartPerformanceNowMs,
        actualSessionClickPerformanceNowMs: pageTiming.clicks.sessionSelect.performanceNowMs,
        actualSessionClickEpochMs: pageTiming.clicks.sessionSelect.epochMs,
        firstSeedUserVisiblePerformanceNowMs: firstVisible,
        firstSeedUserVisibleEpochMs: pageTiming.seedUser.firstVisible.epochMs,
        twoRafAfterVisiblePerformanceNowMs: pageTiming.seedUser.twoRafAt?.performanceNowMs ?? null,
        navigationToFirstVisibleMs: firstVisible - pageTiming.navigationStartPerformanceNowMs,
        sessionClickToFirstVisibleMs: firstVisible - pageTiming.clicks.sessionSelect.performanceNowMs,
        uniqueVisibleRowsAtFirstVisible: pageTiming.seedUser.visibleMatchesAtFirstVisible,
        mutationCount: pageTiming.mutationCount,
        animationFrameScans: pageTiming.scanCount,
        nodeTimeline,
      },
      protocol: {
        initializeCountOnTaskRuntimeSocket: initializeRequests.length,
        resumeCountOnTaskRuntimeSocket: observations.requests.filter(entry => entry.socketId === resume.socketId && entry.method === "thread/resume" && entry.threadId === seed.threadId).length,
        fallbackReadCountOnTaskRuntimeSocket: taskSocketReads.length,
        criticalResponseHolds: observations.holds.filter(entry => entry.socketId === resume.socketId).map(safeHold),
        runtimeTaskSocketProof: {
          armBeforeClick: observations.runtimeWindowArm.epochMs < observations.sessionClickCapture.browserEpochMs,
          armObservedBeforeClickInNode: observations.runtimeWindowArm.armedAtNodeMs < observations.sessionClickCapture.nodeObservedAtMs,
          clickCapture: observations.sessionClickCapture,
          candidate: safeRuntimeCandidate(observations.runtimeTaskCandidate),
          allRoutedSockets: [...observations.socketRecords.values()].map(safeSocketRecord),
          setupInitializeResponses: observations.setupInitializations.map(safeHold),
          unpairedInitializeResponses: observations.unpairedInitializations.map(safeHold),
          candidateSocketRouteObservedAfterClick: observations.runtimeTaskCandidate.socketOpenedAtNodeMs >= observations.sessionClickCapture.nodeObservedAtMs,
          candidateInitializeObservedAfterClick: observations.runtimeTaskCandidate.initializeRequest.sentAtNodeMs >= observations.sessionClickCapture.nodeObservedAtMs,
          initializeForwardedBeforeResumeRequest: observations.runtimeTaskCandidate.initializeResponse.forwardedAt <= resume.request.sentAtNodeMs,
          resumeForwardedBeforeFallbackReadRequest: options.expectInline ? null : resume.forwardedAt <= targetReads[0].sentAtNodeMs,
        },
        nonCriticalResponseCounts: summarizeMethods(observations.requests.filter(entry => entry.method !== "initialize" && !(entry.socketId === resume.socketId && entry.threadId === seed.threadId && (entry.method === "thread/resume" || HISTORY_READ_METHODS.includes(entry.method))))),
      },
      nodePageObserverWaitMs: nodeTimeline.pageObserverWait.elapsedMs,
      nodeLocatorWaitMs: nodeTimeline.playwrightLocatorWait.elapsedMs,
      httpEvents,
      browserTurnStarts: 0,
      externalProviderRequested: false,
      pageErrors: browserErrors,
    };
    return sample;
  } catch (error) {
    await page.screenshot({ path: context.pathInArtifacts(`resume-latency-${safeSlug(options.caseId)}-failure.png`) }).catch(() => {});
    await context.writeArtifactJson(`resume-latency-${safeSlug(options.caseId)}-diagnostic.json`, {
      caseId: options.caseId,
      condition: options.condition,
      delayMs: options.delayMs,
      safeUrlPath: safePath(page.url()),
      visibleTestIds: await visibleTestIds(page).catch(() => []),
      pageTiming: await page.evaluate(() => window.__resumeHistoryLatency?.snapshot?.() ?? null).catch(() => null),
      nodeTimeline,
      socketIds: observations.socketIds,
      socketRecords: [...observations.socketRecords.values()].map(safeSocketRecord),
      runtimeWindowArm: observations.runtimeWindowArm,
      sessionClickCapture: observations.sessionClickCapture,
      runtimeTaskCandidate: safeRuntimeCandidate(observations.runtimeTaskCandidate),
      runtimeTaskCandidateAmbiguous: observations.runtimeTaskCandidateAmbiguous,
      setupInitializations: observations.setupInitializations.map(safeHold),
      unpairedInitializations: observations.unpairedInitializations.map(safeHold),
      requests: observations.requests.map(safeRequest),
      resumeResults: observations.resumeResults.map(safeResume),
      responseHolds: observations.holds.map(safeHold),
      protocolResponses: observations.responses.map(safeHold),
      httpEvents,
      browserErrors,
      error: context.redactText(error?.stack || error?.message || String(error)),
    });
    throw error;
  } finally {
    await page.close().catch(() => {});
    await pageContext.close().catch(() => {});
  }
}

async function installRpcInstrumentation(page, observations, options) {
  let nextSocketId = 0;
  await page.routeWebSocket("**/rpc*", routed => {
    const socketId = `${observations.pageId}-rpc-${++nextSocketId}`;
    const socketRecord = {
      pageId: observations.pageId,
      socketId,
      openedAtNodeMs: performance.now(),
      openedAtEpochMs: Date.now(),
      initializeRequests: [],
      initializeResponses: [],
    };
    observations.socketIds.push(socketId);
    observations.socketRecords.set(socketId, socketRecord);
    const upstream = routed.connectToServer();
    const requestsById = new Map();
    routed.onMessage(raw => {
      const requestObservedAtNodeMs = performance.now();
      const frame = parseFrame(raw);
      if (frame && frame.id !== undefined && typeof frame.method === "string") {
        const params = frame.params ?? {};
        const request = {
          pageId: observations.pageId,
          socketId,
          id: String(frame.id),
          method: frame.method,
          threadId: typeof params.threadId === "string" ? params.threadId : null,
          historyPresent: Object.hasOwn(params, "history"),
          history: Object.hasOwn(params, "history") ? params.history : { missing: true },
          sentAtNodeMs: requestObservedAtNodeMs,
        };
        if (request.method === "initialize") socketRecord.initializeRequests.push(request);
        requestsById.set(String(frame.id), request);
        observations.requests.push(request);
      }
      upstream.send(raw);
    });
    upstream.onMessage(raw => {
      const responseReceivedAtNodeMs = performance.now();
      const frame = parseFrame(raw);
      const request = frame?.id !== undefined ? requestsById.get(String(frame.id)) : null;
      if (!request || !frame) {
        routed.send(raw);
        return;
      }
      let clientRaw = raw;
      let runtimeTaskInitialize = false;
      let initializeClassification = null;
      if (request.method === "initialize") {
        const experimental = frame.result?.capabilities?.experimental ?? {};
        const server = {
          threadResumeHistoryPageV1: experimental.threadResumeHistoryPageV1 === true,
          threadIndexedPagesV1: experimental.threadIndexedPagesV1 === true,
        };
        const client = { ...server };
        if (options.hideResumeHistoryCapability) {
          const adjusted = structuredClone(frame);
          if (adjusted.result?.capabilities?.experimental) delete adjusted.result.capabilities.experimental.threadResumeHistoryPageV1;
          client.threadResumeHistoryPageV1 = false;
          clientRaw = JSON.stringify(adjusted);
        }
        observations.capabilitiesBySocket.set(socketId, { server, client });
        const click = observations.sessionClickCapture;
        const arm = observations.runtimeWindowArm;
        const armPredatesClick = Boolean(arm && click && arm.armedAtNodeMs < click.nodeObservedAtMs && arm.epochMs < click.browserEpochMs);
        const socketOpenedAfterClick = Boolean(click && socketRecord.openedAtNodeMs >= click.nodeObservedAtMs);
        const initializeSentAfterClick = Boolean(click && request.sentAtNodeMs >= click.nodeObservedAtMs);
        const eligibleAfterClick = armPredatesClick && socketOpenedAfterClick && initializeSentAfterClick;
        if (eligibleAfterClick && observations.runtimeTaskCandidate === null) {
          runtimeTaskInitialize = true;
          initializeClassification = "candidate-new-runtime-socket";
          observations.runtimeTaskCandidate = {
            pageId: observations.pageId,
            socketId,
            socketOpenedAtNodeMs: socketRecord.openedAtNodeMs,
            socketOpenedAtEpochMs: socketRecord.openedAtEpochMs,
            clickObservedAtNodeMs: click.nodeObservedAtMs,
            clickBrowserEpochMs: click.browserEpochMs,
            initializeRequest: request,
            initializeResponse: null,
          };
        } else if (eligibleAfterClick && observations.runtimeTaskCandidate.socketId === socketId) {
          runtimeTaskInitialize = true;
          initializeClassification = "candidate-new-runtime-socket";
        } else if (eligibleAfterClick) {
          observations.runtimeTaskCandidateAmbiguous = true;
          initializeClassification = "ambiguous-post-click-candidate";
        } else if (!arm && !click) {
          initializeClassification = "setup-before-runtime-window-arm";
        } else if (arm && socketRecord.openedAtNodeMs < arm.armedAtNodeMs && request.sentAtNodeMs < arm.armedAtNodeMs) {
          initializeClassification = "setup-before-runtime-window-arm";
        } else if (!click) {
          initializeClassification = "uncorrelated-no-click-capture";
        } else {
          initializeClassification = "unpaired-initialize-outside-click-window";
        }
      }
      const isTargetThread = request.threadId === observations.threadId;
      const isTargetResume = isTargetThread && request.method === "thread/resume";
      const isTargetRead = isTargetThread && HISTORY_READ_METHODS.includes(request.method);
      const isTaskRuntimeSocket = observations.runtimeTaskCandidate?.socketId === socketId;
      const critical = runtimeTaskInitialize || (isTaskRuntimeSocket && (isTargetResume || isTargetRead));
      const response = {
        pageId: observations.pageId,
        socketId,
        rpcId: String(frame.id),
        method: request.method,
        threadId: isTargetThread ? observations.threadId : null,
        taskRuntimeSocket: isTaskRuntimeSocket,
        runtimeTaskInitialize,
        initializeClassification,
        configuredHoldMs: critical ? options.delayMs : 0,
        receivedAt: responseReceivedAtNodeMs,
        forwardedAt: null,
        appliedHoldMs: null,
      };
      observations.responses.push(response);
      if (critical) observations.holds.push(response);
      if (request.method === "initialize") {
        socketRecord.initializeResponses.push(response);
        if (runtimeTaskInitialize && observations.runtimeTaskCandidate?.socketId === socketId) {
          observations.runtimeTaskCandidate.initializeResponse = response;
        } else if (initializeClassification === "setup-before-runtime-window-arm") {
          observations.setupInitializations.push(response);
        } else {
          observations.unpairedInitializations.push(response);
        }
      }
      if (isTargetResume) {
        const resume = {
          pageId: observations.pageId,
          socketId,
          request: { id: String(frame.id), threadId: request.threadId, historyPresent: request.historyPresent, history: request.history, sentAtNodeMs: request.sentAtNodeMs },
          deliveredResult: null,
          forwardedAt: null,
          hold: response,
          initializeResponse: observations.runtimeTaskCandidate?.socketId === socketId
            ? observations.runtimeTaskCandidate.initializeResponse
            : null,
        };
        observations.resumeResults.push(resume);
        response.resume = resume;
      }
      if (isTargetRead) {
        request.result = frame.result ?? null;
        request.responseForwardedAtNodeMs = null;
        request.responseRpcId = String(frame.id);
        response.request = request;
      }
      void sendAfterConfiguredHold(routed, response, clientRaw);
    });
  });
}

async function sendAfterConfiguredHold(routed, response, raw) {
  const deadline = response.receivedAt + response.configuredHoldMs;
  let remaining;
  while ((remaining = deadline - performance.now()) > 0) await new Promise(resolveWait => setTimeout(resolveWait, Math.ceil(remaining)));
  routed.send(raw);
  response.forwardedAt = performance.now();
  response.appliedHoldMs = response.forwardedAt - response.receivedAt;
  if (response.resume) {
    response.resume.forwardedAt = response.forwardedAt;
    response.resume.deliveredResult = parseFrame(raw)?.result ?? null;
  }
  if (response.request) response.request.responseForwardedAtNodeMs = response.forwardedAt;
}

async function connectMobile(page, gateway, nodeTimeline) {
  await markNode(nodeTimeline, "goto", () => page.goto(gateway.baseUrl, { waitUntil: "domcontentloaded" }));
  await page.getByTestId("welcome-direct-connection").waitFor({ state: "visible", timeout: 20_000 });
  await markNode(nodeTimeline, "welcomeDirectConnectionClick", () => page.getByTestId("welcome-direct-connection").click());
  await page.getByTestId("gateway-endpoint").fill(gateway.baseUrl);
  await markNode(nodeTimeline, "gatewayConnectClick", () => page.getByTestId("gateway-connect").click());
  await markNode(nodeTimeline, "newWorkspaceWait", () => page.getByTestId("new-workspace").waitFor({ state: "visible", timeout: 20_000 }));
}

async function markNode(timeline, name, operation) {
  const startedAtNodeMs = performance.now();
  const value = await operation();
  const returnedAtNodeMs = performance.now();
  timeline[name] = { startedAtNodeMs, returnedAtNodeMs, elapsedMs: returnedAtNodeMs - startedAtNodeMs };
  return value;
}

function installSeedUserObserver({ sentinel, sessionTestId }) {
  const state = {
    timeOriginEpochMs: performance.timeOrigin,
    navigationStartPerformanceNowMs: performance.getEntriesByType("navigation")[0]?.startTime ?? 0,
    clicks: {},
    runtimeSocketWindowArmed: null,
    seedUser: { firstFound: null, firstVisible: null, twoRafAt: null, visibleMatchesAtFirstVisible: null },
    mutationCount: 0,
    scanCount: 0,
  };
  const stamp = () => ({ performanceNowMs: Number(performance.now().toFixed(3)), epochMs: Number((performance.timeOrigin + performance.now()).toFixed(3)) });
  const isVisible = element => {
    const style = getComputedStyle(element);
    if (style.visibility !== "visible") return false;
    if (style.display === "contents") return [...element.children].some(isVisible);
    if (Element.prototype.checkVisibility) {
      if (!element.checkVisibility()) return false;
    } else {
      const details = element.closest("details,summary");
      if (details !== element && details?.nodeName === "DETAILS" && !details.open) return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  document.addEventListener("click", event => {
    const target = event.target instanceof Element ? event.target.closest("[data-testid]") : null;
    const sessionTarget = event.composedPath().find(node => node instanceof Element && node.getAttribute("data-testid") === sessionTestId);
    const testId = sessionTarget ? sessionTestId : target?.getAttribute("data-testid");
    if (["welcome-direct-connection", "gateway-connect", "sessions", sessionTestId].includes(testId)) {
      const click = stamp();
      const clickKey = testId === sessionTestId ? "sessionSelect" : testId;
      if (!state.clicks[clickKey]) {
        state.clicks[clickKey] = click;
        if (clickKey === "sessionSelect" && typeof window.__resumeHistoryLatencyClickObserved === "function") {
          void window.__resumeHistoryLatencyClickObserved({ testId, ...click }).catch(() => {});
        }
      }
    }
  }, true);
  let rafPending = false;
  const scheduleScan = () => {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      state.scanCount += 1;
      const rows = [...document.querySelectorAll('[data-testid="message-user"]')].filter(row => (row.innerText || row.textContent || "").includes(sentinel));
      if (rows.length) state.seedUser.firstFound ??= stamp();
      const visibleRows = rows.filter(isVisible);
      if (!state.seedUser.firstVisible && visibleRows.length) {
        state.seedUser.firstVisible = stamp();
        state.seedUser.visibleMatchesAtFirstVisible = visibleRows.length;
        requestAnimationFrame(() => requestAnimationFrame(() => { state.seedUser.twoRafAt = stamp(); }));
      }
      if (!state.seedUser.firstVisible) scheduleScan();
    });
  };
  const observer = new MutationObserver(() => { state.mutationCount += 1; scheduleScan(); });
  observer.observe(document, { subtree: true, childList: true, characterData: true, attributes: true,
    attributeFilter: ["class", "style", "hidden", "aria-hidden", "aria-expanded"] });
  scheduleScan();
  Object.defineProperty(window, "__resumeHistoryLatency", {
    configurable: false,
    enumerable: false,
    value: {
      snapshot: () => structuredClone(state),
      armTaskRuntimeWindow: () => {
        state.runtimeSocketWindowArmed ??= stamp();
        return state.runtimeSocketWindowArmed;
      },
    },
  });
}

async function verifyGatewayRuntime(context, gateway, binaryPath) {
  const owner = context.processes.get(GATEWAY_LABEL);
  assert.ok(owner?.pid === gateway.child.pid && owner.pgid > 0);
  const processRoot = `/proc/${gateway.child.pid}`;
  const cwdLink = await readlink(resolve(processRoot, "cwd"));
  const actualCwd = await realpath(cwdLink);
  assert.equal(actualCwd, gateway.cwd, "Gateway child cwd differs from the frozen runtime root");
  const argv = (await readFile(resolve(processRoot, "cmdline"))).toString("utf8").split("\0").filter(Boolean);
  const scriptArgument = argv[gateway.scriptArgIndex];
  assert.ok(scriptArgument, "Gateway child command line is missing its script argument");
  const actualScriptPath = await realpath(isAbsolute(scriptArgument) ? scriptArgument : resolve(actualCwd, scriptArgument));
  assert.equal(actualScriptPath, gateway.scriptPath, "Gateway child script path differs from the frozen runtime source");
  const processes = await findOwnedExecutableProcesses({ pgid: owner.pgid, executablePath: binaryPath });
  assert.equal(processes.length, 1, "Gateway must own exactly one pinned app-server child");
  const runtime = processes[0];
  assert.equal(runtime.sha256, await shaFile(binaryPath));
  return { gatewayPid: gateway.child.pid, gatewayPgid: owner.pgid, gatewayCwd: actualCwd,
    gatewayScriptPath: actualScriptPath, appServerPid: runtime.pid, appServerSha256: runtime.sha256 };
}

async function stopGatewayAndVerify(context, gateway, binaryPath) {
  const owner = context.processes.get(GATEWAY_LABEL);
  const failures = [];
  if (!owner) failures.push(new Error("RunContext has no Gateway ownership record"));
  else if (owner.pid !== gateway.child.pid || !Number.isInteger(owner.pgid) || owner.pgid <= 0) {
    failures.push(new Error("RunContext does not own the expected Gateway child/process group"));
  }

  try {
    await context.stopOwned(GATEWAY_LABEL);
  } catch (error) {
    failures.push(error);
  }
  if (owner?.stopped !== true) failures.push(new Error("RunContext did not mark the Gateway child stopped"));

  try {
    await waitFor(() => gateway.child.exitCode !== null || gateway.child.signalCode !== null,
      5_000, "owned Gateway child exit", 25);
  } catch (error) {
    failures.push(error);
  }

  if (owner?.pgid > 0) {
    try {
      await waitFor(async () => {
        const processes = await findOwnedExecutableProcesses({ pgid: owner.pgid, executablePath: binaryPath });
        return processes.length === 0 ? processes : null;
      }, 5_000, "owned pinned app-server exit", 25);
    } catch (error) {
      failures.push(error);
    }
  } else {
    failures.push(new Error("Cannot verify pinned app-server exit without an owned Gateway process group"));
  }

  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, "Gateway stop and process verification failed");
  }
}

async function captureCleanupFailure(errors, label, operation) {
  try {
    await operation();
  } catch (error) {
    errors.push(new Error(`${label} failed`, { cause: error }));
  }
}

function summarizeMatrix(samples, options) {
  const cells = [];
  for (const delayMs of options.delays) for (const condition of CONDITIONS) {
    const entries = samples.filter(item => item.delayMs === delayMs && item.condition === condition);
    const passed = entries.filter(item => item.status === "PASS");
    const errors = entries.length - passed.length;
    const nav = passed.map(item => item.timing.navigationToFirstVisibleMs);
    const click = passed.map(item => item.timing.sessionClickToFirstVisibleMs);
    const node = passed.map(item => item.nodeLocatorWaitMs);
    const holds = passed.flatMap(item => item.protocol.criticalResponseHolds.map(hold => hold.appliedHoldMs));
    const quantilesEligible = options.phase === "formal" && passed.length === 30 && errors === 0;
    const stat = values => ({
      p50: quantilesEligible ? percentile(values, 0.5) : null,
      p95: quantilesEligible ? percentile(values, 0.95) : null,
      max: quantilesEligible && values.length ? Math.max(...values) : null,
      sampleCount: values.length,
    });
    const criticalCalls = condition === "inline" ? 2 : 3;
    cells.push({
      condition,
      delayMs,
      plannedSamples: options.samples,
      attemptedSamples: entries.length,
      completeDomSamples: passed.length,
      errorCount: errors,
      unpairedCount: entries.filter(item => item.status === "UNPAIRED").length,
      errorRate: entries.length ? errors / entries.length : null,
      criticalResponseCountPerSample: criticalCalls,
      configuredHoldBudgetMs: options.samples * criticalCalls * delayMs,
      navigationToFirstVisibleMs: stat(nav),
      sessionClickToFirstVisibleMs: stat(click),
      nodeLocatorWaitMs: stat(node),
      appliedCriticalHoldMs: stat(holds),
      percentileEligible: quantilesEligible,
      sampleIds: entries.map(item => ({ caseId: item.caseId, status: item.status })),
    });
  }
  const errorCount = samples.filter(item => item.status !== "PASS").length;
  return {
    status: errorCount ? "PARTIAL" : options.phase === "driver" ? "DRIVER_SMOKE_PASS_NOT_PERFORMANCE" : "PASS",
    phase: options.phase,
    conditions: CONDITIONS,
    delaysMs: options.delays,
    requestedSamplesPerCell: options.samples,
    requiredFormalSamplesPerCell: 30,
    sampleCount: samples.length,
    errorCount,
    quantileMethod: "nearest-rank: sorted[Math.ceil(n*q)-1]; with n=30, P95 is the 29th sorted sample",
    cells,
  };
}

function parseCli(args) {
  const option = name => {
    const prefix = `--${name}=`;
    const found = args.find(arg => arg.startsWith(prefix));
    assert.ok(found, `missing required ${prefix}<value>`);
    return found.slice(prefix.length);
  };
  for (const arg of args) assert.match(arg, /^--(?:phase|samples|delays)=/, `unsupported argument ${arg}`);
  return { phase: option("phase"), samples: Number(option("samples")), delays: option("delays").split(",").map(Number) };
}

function safeHold(entry) {
  return { pageId: entry.pageId, socketId: entry.socketId, rpcId: entry.rpcId, method: entry.method,
    threadIdSha256: entry.threadId ? sha256(Buffer.from(entry.threadId)) : null,
    taskRuntimeSocket: entry.taskRuntimeSocket ?? false,
    runtimeTaskInitialize: entry.runtimeTaskInitialize ?? false,
    initializeClassification: entry.initializeClassification ?? null,
    configuredHoldMs: entry.configuredHoldMs, receivedAtNodeMs: entry.receivedAt,
    forwardedAtNodeMs: entry.forwardedAt, appliedHoldMs: entry.appliedHoldMs };
}

function safeRequest(entry) {
  return { pageId: entry.pageId, socketId: entry.socketId, id: entry.id, method: entry.method,
    threadIdSha256: entry.threadId ? sha256(Buffer.from(entry.threadId)) : null,
    sentAtNodeMs: entry.sentAtNodeMs,
    responseRpcId: entry.responseRpcId ?? null,
    responseForwardedAtNodeMs: entry.responseForwardedAtNodeMs ?? null,
    historyPresent: entry.historyPresent, history: entry.historyPresent ? entry.history : { missing: true } };
}

function safeResume(entry) {
  return { pageId: entry.pageId, socketId: entry.socketId, request: safeRequest(entry.request),
    initializeForwardedAtNodeMs: entry.initializeResponse?.forwardedAt ?? null,
    responseForwardedAtNodeMs: entry.forwardedAt,
    historyStatus: entry.deliveredResult?.history?.status ?? "legacy-thread-only" };
}

function safeRuntimeCandidate(candidate) {
  if (!candidate) return null;
  return {
    pageId: candidate.pageId,
    socketId: candidate.socketId,
    socketOpenedAtNodeMs: candidate.socketOpenedAtNodeMs,
    socketOpenedAtEpochMs: candidate.socketOpenedAtEpochMs,
    clickObservedAtNodeMs: candidate.clickObservedAtNodeMs,
    clickBrowserEpochMs: candidate.clickBrowserEpochMs,
    initializeRequest: safeRequest(candidate.initializeRequest),
    initializeResponse: candidate.initializeResponse ? safeHold(candidate.initializeResponse) : null,
  };
}

function safeSocketRecord(record) {
  return { pageId: record.pageId, socketId: record.socketId, openedAtNodeMs: record.openedAtNodeMs,
    openedAtEpochMs: record.openedAtEpochMs,
    initializeRequests: record.initializeRequests.map(safeRequest),
    initializeResponses: record.initializeResponses.map(safeHold) };
}

function requirePaired(condition, message) {
  if (condition) return;
  const error = new Error(`UNPAIRED: ${message}`);
  error.code = "UNPAIRED";
  throw error;
}

function safePath(value) {
  try { return new URL(value).pathname; } catch { return "[unavailable]"; }
}

function summarizeMethods(entries) {
  const counts = Object.create(null);
  for (const entry of entries) counts[entry.method] = (counts[entry.method] ?? 0) + 1;
  return counts;
}

function visibleTestIds(page) {
  return page.locator("[data-testid]").evaluateAll(nodes => nodes.filter(node => {
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }).map(node => node.getAttribute("data-testid")).filter(Boolean).slice(0, 80));
}

function messageProjection(messages) { return (messages ?? []).map(message => ({ id: message.id, role: message.role, content: message.content })); }
function countOccurrences(value, needle) { return needle ? String(value).split(needle).length - 1 : 0; }
function parseFrame(raw) { try { return JSON.parse(Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw)); } catch { return null; } }
function percentile(values, q) { return values.length ? [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * q) - 1)] : null; }
function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function hashJson(value) { return sha256(Buffer.from(JSON.stringify(value))); }
function isWithin(root, path) { const rel = relative(root, path); return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`)); }
function safeSlug(value) { return String(value).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-|-$/g, "") || "sample"; }
async function shaFile(path) { return (await hashExecutableFile(path)).sha256; }
function publicPinSummary(pins) { return { releaseId: pins.releaseId, pinFileSha256: pins.pinFileSha256,
  sourceDigest: pins.source.sourceDigest, sourceFileCount: pins.source.fileCount,
  rustBinarySha256: pins.rust.binarySha256, mobileWebBundleSha256: pins.mobileWeb.bundleSha256,
  mobileWebFileCount: pins.mobileWeb.bundleFileCount, gatewayRuntimeSourceSha256: pins.gateway.runtimeSourceSha256,
  gatewayNodeDependencyClosureSha256: pins.gateway.nodeDependencies.closureSha256, node: pins.node }; }
