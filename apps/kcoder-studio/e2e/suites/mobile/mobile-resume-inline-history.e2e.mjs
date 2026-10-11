import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, mkdir, readFile, readlink, realpath, readdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { AppServerStdioClient, waitForStdioChildClose } from "../../harness/app-server-stdio.mjs";
import { startChromium } from "../../harness/chromium.mjs";
import { startGateway, waitForGatewayRpcToken } from "../../harness/gateway.mjs";
import { hashExecutableFile, findOwnedExecutableProcesses } from "../../harness/owned-executable-provenance.mjs";
import { repoRoot, appRoot, runE2E, waitFor } from "../../harness/run-context.mjs";

const TEST_ID = "mobile-resume-inline-history-real-gateway-stdio";
const PIN_FILE_ENV = "KCODER_E2E_RESUME_HISTORY_PIN_FILE";
const PIN_SHA_ENV = "KCODER_E2E_RESUME_HISTORY_PIN_FILE_SHA256";
const RUN_NOTIFICATION_BUFFER_CASE = process.env.KCODER_E2E_RESUME_HISTORY_NOTIFICATION_BUFFER === "1";
const PRIVATE_INPUT_ROOT_RELATIVES = [
  "target/private-phone-ux-implementation",
  "target/private-phone-latency-implementation",
];
const RPC_TIMEOUT_MS = 20_000;
const CHILD_EXIT_TIMEOUT_MS = 10_000;
const RESUME_RESPONSE_HOLD_MS = 600;

// This suite is model-independent: the seed child uses KCoder's deterministic
// app-server scenario; the ordinary Browser cases use no scenario and no Provider.
// The optional notification-buffer case uses a second real stdio child in scenario
// mode, and is reported separately from the normal resume/compatibility cases.
await runE2E(import.meta.url, {
  testId: TEST_ID,
  tier: "manual-live",
  retainSuccessLogs: true,
  modelPolicy: "real Mobile Web + KCODER_STUDIO_MOCK=0 Gateway + pinned Rust app-server stdio; deterministic local seed only, no external Provider",
}, async context => {
  // Pin validation runs before any child process, Gateway, or Chromium is created.
  const testSourcePin = await captureTestSourceInputs(context);
  const pins = await loadAndVerifyPins();
  await context.writeArtifactJson("resume-history-input-pins.json", {
    ...publicPinSummary(pins),
    testSourceManifestSha256: testSourcePin.manifestSha256,
    testSourceInputs: testSourcePin.files,
  });

  const workspace = context.pathInState("workspace");
  const configDir = context.pathInState("config");
  const homeDir = context.pathInState("home");
  const tempRoot = context.pathInState("tmp");
  await Promise.all([
    mkdir(workspace, { recursive: true, mode: 0o700 }),
    mkdir(configDir, { recursive: true, mode: 0o700 }),
    mkdir(homeDir, { recursive: true, mode: 0o700 }),
    mkdir(tempRoot, { recursive: true, mode: 0o700 }),
  ]);
  const settingsFile = resolve(configDir, "settings.json");
  await context.writeStateJson("config/settings.json", {
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

  const seed = await seedCompletedThread(context, {
    binaryPath: pins.rust.binaryPath,
    binarySha256: pins.rust.binarySha256,
    workspace,
    configDir,
    settingsFile,
    homeDir,
    tempRoot,
  });
  await context.writeArtifactJson("resume-history-seed.json", {
    threadId: seed.threadId,
    title: seed.title,
    completedTurnId: seed.turnId,
    messageCount: seed.page.messages.length,
    expectedMessageIds: seed.page.messages.map(message => message.id),
    expectedPage: pageEvidence(seed.page),
    seedChild: seed.provenance,
    childExitedBeforeGateway: true,
    externalProviderConfigured: false,
    deterministicScenarioProviderUsedOnlyForSeed: true,
  });

  const gatewaySettingsFile = await context.writeStateJson("gateway-servers.json", [{
    id: "local",
    label: "Isolated resume-history fixture",
    runtime: "kcoder",
    transport: "local",
    command: pins.rust.binaryPath,
    workspace,
    settingsFile,
  }]);
  const chromium = await startChromium(context, { label: "resume-history-chromium" });
  const cases = [];

  for (const options of [
    {
      caseId: "inline-history",
      capabilityView: "actual-server-capabilities",
      expectInline: true,
      hideResumeHistoryCapability: false,
    },
    {
      caseId: "client-capability-withheld",
      capabilityView: "Playwright hides only threadResumeHistoryPageV1 from Mobile initialize result",
      expectInline: false,
      hideResumeHistoryCapability: true,
    },
  ]) {
    // Give each Browser case a fresh app-server lifetime so both restore the
    // same completed disk thread instead of sharing a resident runtime.
    const gateway = await startResumeGateway(context, pins, {
      label: `resume-history-${options.caseId}-gateway`,
      workspace,
      serversFile: gatewaySettingsFile,
      scenario: false,
    });
    try {
      await waitForGatewayRpcToken(context, gateway);
      cases.push(await runResumeBrowserCase(context, chromium, gateway, seed, options));
    } finally {
      await stopGatewayAndVerify(context, gateway, pins.rust.binaryPath);
    }
  }

  if (RUN_NOTIFICATION_BUFFER_CASE) {
    const scenarioGateway = await startResumeGateway(context, pins, {
      label: "resume-history-notification-buffer-gateway",
      workspace,
      serversFile: gatewaySettingsFile,
      scenario: true,
    });
    try {
      await waitForGatewayRpcToken(context, scenarioGateway);
      cases.push(await runResumeBrowserCase(context, chromium, scenarioGateway, seed, {
        caseId: "scenario-notification-buffer",
        capabilityView: "actual-server-capabilities",
        expectInline: true,
        hideResumeHistoryCapability: false,
        injectScenarioTurnDuringResumeHold: true,
      }));
    } finally {
      await stopGatewayAndVerify(context, scenarioGateway, pins.rust.binaryPath);
    }
  }

  await chromium.close();
  assert.equal(context.processes.get("resume-history-chromium")?.stopped, true, "owned Chromium was not stopped before finalization");
  await verifyTestSourceInputsUnchanged(testSourcePin);
  const finalGatewaySource = await verifyGatewayRuntimeSources(pins.gateway, pins.verified.source);
  assert.equal(finalGatewaySource.sourceDigest, pins.gateway.runtimeSourceSha256, "Gateway source inputs changed during the Browser run");
  const finalGatewayDependencies = await verifyGatewayNodeDependencies(pins.gateway.nodeDependencies);
  assert.equal(finalGatewayDependencies.closureSha256, pins.gateway.nodeDependencies.closureSha256, "Gateway Node dependency inputs changed during the Browser run");
  const failures = cases.filter(item => item.status !== "PASS");
  assert.equal(failures.length, 0, `resume-history Browser case(s) failed: ${failures.map(item => item.caseId).join(", ")}`);

  return {
    status: "PASS",
    releaseId: pins.releaseId,
    cases,
    optionalScenarioNotificationBuffer: RUN_NOTIFICATION_BUFFER_CASE ? "PASS" : "NOT_RUN",
    browserViewport: { width: 390, height: 844 },
    configuredResponseHoldMs: RESUME_RESPONSE_HOLD_MS,
    responseHoldMeaning: "test-side additional upstream-response delivery hold; not RTT or physical-phone measurement",
    externalProviderConfigured: false,
    gatewayMockMode: "KCODER_STUDIO_MOCK=0",
    browserAndGatewayCleanupVerified: true,
    pinFileSha256: pins.pinFileSha256,
  };
});

async function loadAndVerifyPins() {
  const pinPathInput = process.env[PIN_FILE_ENV]?.trim();
  const expectedPinSha256 = process.env[PIN_SHA_ENV]?.trim().toLowerCase();
  assert.ok(pinPathInput, `UNMET_PREREQUISITE: set ${PIN_FILE_ENV} to the writer/root-owned final resume-history pin file`);
  assert.match(expectedPinSha256 || "", /^[0-9a-f]{64}$/, `UNMET_PREREQUISITE: set ${PIN_SHA_ENV} to the expected pin-file SHA-256`);

  const privateRoots = await Promise.all(PRIVATE_INPUT_ROOT_RELATIVES.map(path => realpath(resolve(repoRoot, path))));
  const pinPath = resolve(pinPathInput);
  const pinInfo = await lstat(pinPath);
  assert.ok(pinInfo.isFile() && !pinInfo.isSymbolicLink(), "resume-history pin file must be a regular, non-symlink file");
  const canonicalPinPath = await realpath(pinPath);
  assert.ok(isWithinAny(privateRoots, canonicalPinPath), "resume-history pin file must stay inside an approved private input root");
  const pinBytes = await readFile(canonicalPinPath);
  const pinFileSha256 = sha256(pinBytes);
  assert.equal(pinFileSha256, expectedPinSha256, "resume-history pin file digest differs from the explicitly supplied pin");
  const pins = JSON.parse(pinBytes.toString("utf8"));
  assert.equal(pins.schemaVersion, 1, "unsupported resume-history pin schema");
  assert.equal(pins.releaseId, "resume-history-20261008", "pins must identify the reviewed resume-history candidate");
  assert.ok(pins.source && pins.rust && pins.mobileWeb && pins.gateway && pins.node, "pin file must contain source, Rust binary, Mobile Web, Gateway, and Node provenance");
  pins.pinFileSha256 = pinFileSha256;

  const source = await verifyCandidateSnapshot(pins.source, privateRoots);
  const gateway = await verifyGatewayRuntimeSources(pins.gateway, source);
  gateway.nodeDependencies = await verifyGatewayNodeDependencies(pins.gateway.nodeDependencies);
  const rust = await verifyRustBuildInputs(pins.rust, privateRoots);

  const node = await hashExecutableFile(process.execPath);
  assert.equal(node.path, pins.node.path, "suite Node executable differs from the pinned Node runtime");
  assert.equal(node.sha256, pins.node.sha256, "suite Node executable differs from the pinned Node SHA-256");
  assert.equal(process.version, pins.node.version, "suite Node version differs from the pinned runtime version");

  const mobileWebRoot = privateRoots[PRIVATE_INPUT_ROOT_RELATIVES.indexOf("target/private-phone-ux-implementation")];
  const mobileWeb = await verifyMobileWebBundle(pins.mobileWeb, mobileWebRoot, source);
  return { ...pins, pinFileSha256, verified: { source, gateway, rust, node, mobileWeb, privateRoots } };
}

async function captureTestSourceInputs(context) {
  const suitePath = relative(repoRoot, fileURLToPath(import.meta.url)).split(sep).join("/");
  const sourcePaths = [
    suitePath,
    "apps/kcoder-studio/e2e/harness/app-server-stdio.mjs",
    "apps/kcoder-studio/e2e/harness/chromium.mjs",
    "apps/kcoder-studio/e2e/harness/gateway.mjs",
    "apps/kcoder-studio/e2e/harness/owned-executable-provenance.mjs",
    "apps/kcoder-studio/e2e/harness/owned-process.mjs",
    "apps/kcoder-studio/e2e/harness/retention.mjs",
    "apps/kcoder-studio/e2e/harness/run-context.mjs",
  ].sort();
  const files = [];
  for (const path of sourcePaths) {
    const absolute = resolve(repoRoot, ...path.split("/"));
    assert.ok(isWithin(repoRoot, absolute), `E2E source input escaped the repository: ${path}`);
    const bytes = await readFile(absolute);
    const artifactPath = context.pathInArtifacts(`source-freeze/${path}`);
    await mkdir(dirname(artifactPath), { recursive: true });
    await writeFile(artifactPath, bytes, { flag: "wx", mode: 0o600 });
    files.push({ path, bytes: bytes.length, sha256: sha256(bytes), archivedPath: relative(context.artifactsDir, artifactPath).split(sep).join("/") });
  }
  const manifestSha256 = sha256(Buffer.from(JSON.stringify(files)));
  await context.writeArtifactJson("resume-history-test-source-manifest.json", {
    status: "captured-before-runtime",
    digestEncoding: "sha256(JSON.stringify(sorted path/size/hash/archivedPath entries))",
    manifestSha256,
    files,
  });
  return { files, manifestSha256 };
}

async function verifyTestSourceInputsUnchanged(sourcePin) {
  for (const entry of sourcePin.files) {
    const bytes = await readFile(resolve(repoRoot, ...entry.path.split("/")));
    assert.equal(bytes.length, entry.bytes, `E2E test source input size changed during the run: ${entry.path}`);
    assert.equal(sha256(bytes), entry.sha256, `E2E test source input changed during the run: ${entry.path}`);
  }
}

async function verifyCandidateSnapshot(input, privateRoots) {
  assert.ok(input && [input.root, input.manifestPath, input.metadataPath].every(value => typeof value === "string" && isAbsolute(value)), "candidate source pin must use absolute paths");
  const root = await realpath(input.root);
  assert.ok(isWithinAny(privateRoots, root), "candidate source root must remain under an approved private implementation root");
  assert.equal(root, resolve(input.root), "candidate source root must be canonical");
  for (const [path, expected, label] of [
    [input.manifestPath, input.manifestSha256, "candidate SHA map"],
    [input.metadataPath, input.metadataSha256, "candidate metadata"],
  ]) {
    const info = await lstat(path);
    assert.ok(info.isFile() && !info.isSymbolicLink(), `${label} must be a regular, non-symlink file`);
    const canonicalPath = await realpath(path);
    assert.ok(isWithin(root, canonicalPath), `${label} must stay inside the candidate root`);
    assert.equal(canonicalPath, resolve(path), `${label} path must be canonical`);
    assert.equal(sha256(await readFile(canonicalPath)), expected, `${label} SHA-256 mismatch`);
  }
  assert.equal(resolve(input.manifestPath), resolve(root, "sha256.json"), "candidate source map must be the frozen sha256.json");
  assert.equal(resolve(input.metadataPath), resolve(root, "metadata.json"), "candidate metadata path must be the frozen metadata.json");

  const manifestBytes = await readFile(input.manifestPath);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  assert.ok(manifest && typeof manifest === "object" && !Array.isArray(manifest), "candidate sha256.json must be a path-to-SHA object");
  const entries = Object.entries(manifest).sort(([left], [right]) => left.localeCompare(right));
  assert.equal(entries.length, input.fileCount, "candidate source file count differs from its pin");
  const manifestSha256 = sha256(manifestBytes);
  assert.equal(manifestSha256, input.sourceDigest, "candidate sourceDigest must be the SHA-256 of exact sha256.json bytes");
  for (const [path, expectedSha256] of entries) {
    assert.ok(path.length > 0 && !path.includes("\\") && !path.startsWith("/") && !path.split("/").includes(".."), `candidate manifest has an unsafe path: ${path}`);
    assert.match(expectedSha256, /^[0-9a-f]{64}$/, `candidate manifest has an invalid SHA-256: ${path}`);
    const filePath = resolve(root, ...path.split("/"));
    assert.ok(isWithin(root, filePath), `candidate source file escaped its root: ${path}`);
    assert.equal(await realpath(filePath), filePath, `candidate source path traverses a symlink: ${path}`);
    const info = await lstat(filePath);
    assert.ok(info.isFile() && !info.isSymbolicLink(), `candidate source entry must be a regular file: ${path}`);
    assert.equal(sha256(await readFile(filePath)), expectedSha256, `candidate source SHA-256 mismatch: ${path}`);
  }

  const metadata = JSON.parse((await readFile(input.metadataPath)).toString("utf8"));
  assert.equal(metadata.status, "complete", "candidate freeze metadata is not complete");
  assert.equal(metadata.schemaVersion, 1, "unsupported candidate freeze metadata schema");
  assert.equal(metadata.sourceDigest, input.sourceDigest, "candidate metadata sourceDigest mismatch");
  assert.equal(metadata.manifestDigest, manifestSha256, "candidate metadata manifestDigest mismatch");
  assert.equal(metadata.digestEncoding, "sha256 of exact sha256.json UTF-8 bytes; path-sorted per-file copied bytes SHA", "candidate digest encoding differs from the pinned contract");
  assert.equal(metadata.sourceFiles, input.fileCount, "candidate metadata file count mismatch");
  for (const requiredPath of [
    "apps/kcoder-studio/mobile/package.json",
    "apps/kcoder-studio/mobile/app.json",
    "apps/kcoder-studio/mobile/app.config.ts",
    "apps/kcoder-studio/mobile/metro.config.cjs",
    "apps/kcoder-studio/mobile/scripts/build-terminal-webview.mjs",
    "apps/kcoder-studio/mobile/src/runtime/task-runtime/factories.ts",
    "apps/kcoder-studio/mobile/src/runtime/task-runtime/history.ts",
    "apps/kcoder-studio/dev-server.mjs",
  ]) assert.ok(manifest[requiredPath], `required frozen resume input is absent: ${requiredPath}`);
  return { root, manifestPath: input.manifestPath, metadataPath: input.metadataPath, manifestSha256, sourceDigest: manifestSha256, fileCount: entries.length, manifest, metadata };
}

async function verifyGatewayRuntimeSources(input, candidate) {
  assert.equal(input.sourcePrefix, "apps/kcoder-studio/", "Gateway source subset must use the pinned Studio root");
  assert.equal(input.excludedPrefix, "apps/kcoder-studio/mobile/", "Gateway source subset must exclude only the Mobile bundle subtree");
  const entries = Object.entries(candidate.manifest)
    .filter(([path]) => path.startsWith(input.sourcePrefix) && !path.startsWith(input.excludedPrefix))
    .sort(([left], [right]) => left.localeCompare(right));
  assert.equal(entries.length, input.fileCount, "Gateway runtime source count differs from its candidate subset pin");
  assert.ok(candidate.manifest["apps/kcoder-studio/dev-server.mjs"], "Gateway runtime candidate is missing dev-server.mjs");
  const liveRoot = await realpath(appRoot);
  assert.equal(liveRoot, resolve(repoRoot, "apps/kcoder-studio"), "Gateway runtime root differs from the expected Studio app root");
  for (const [candidatePath, expectedSha256] of entries) {
    const relativePath = candidatePath.slice(input.sourcePrefix.length);
    const livePath = resolve(liveRoot, ...relativePath.split("/"));
    assert.ok(isWithin(liveRoot, livePath), `Gateway runtime path escaped appRoot: ${relativePath}`);
    assert.equal(await realpath(livePath), livePath, `Gateway runtime path traverses a symlink: ${relativePath}`);
    const info = await lstat(livePath);
    assert.ok(info.isFile() && !info.isSymbolicLink(), `Gateway runtime input is not a regular file: ${relativePath}`);
    assert.equal(sha256(await readFile(livePath)), expectedSha256, `active Gateway input differs from the frozen candidate: ${relativePath}`);
  }
  const runtimeSourceSha256 = hashJson(entries.map(([path, sha256Value]) => ({ path, sha256: sha256Value })));
  assert.equal(runtimeSourceSha256, input.runtimeSourceSha256, "Gateway runtime subset digest mismatch");
  return { root: liveRoot, fileCount: entries.length, sourceDigest: runtimeSourceSha256 };
}

async function verifyGatewayNodeDependencies(input) {
  assert.equal(input.resolutionRoot, resolve(appRoot), "Gateway Node dependency resolution root differs from appRoot");
  const packageStore = await realpath(resolve(appRoot, "node_modules/.pnpm"));
  assert.equal(input.packageCount, input.packages?.length, "Gateway Node dependency package count mismatch");
  assert.equal(input.packageCount, 9, "Gateway's statically imported Node dependency closure changed");
  assert.deepEqual(input.direct.map(item => `${item.importer}:${item.name}`).sort(), [
    "src/resource-policy.js:jsonc-parser",
    "src/ssh-terminal.js:ssh2",
  ], "Gateway direct third-party imports changed from the reviewed closure");

  for (const direct of input.direct) {
    const importer = resolve(appRoot, ...direct.importer.split("/"));
    assert.ok(isWithin(appRoot, importer), "Gateway dependency importer escaped appRoot");
    const entryPath = createRequire(importer).resolve(direct.name);
    const packageInfo = await findNodePackageRoot(entryPath, direct.name);
    assert.equal(entryPath, direct.entryPath, `Gateway dependency entry changed: ${direct.name}`);
    assert.equal(packageInfo.root, direct.packageRoot, `Gateway dependency package root changed: ${direct.name}`);
  }

  const packageByRoot = new Map(input.packages.map(item => [item.root, item]));
  assert.equal(packageByRoot.size, input.packages.length, "Gateway dependency pin contains duplicate package roots");
  for (const pkg of input.packages) {
    const packageRoot = await realpath(pkg.root);
    assert.equal(packageRoot, resolve(pkg.root), `Gateway dependency path is not canonical: ${pkg.name}`);
    assert.ok(isWithin(packageStore, packageRoot), `Gateway dependency escapes the pinned pnpm package store: ${pkg.name}`);
    const metadataPath = resolve(packageRoot, "package.json");
    const metadata = JSON.parse((await readFile(metadataPath)).toString("utf8"));
    assert.equal(metadata.name, pkg.name, `Gateway dependency package name changed: ${pkg.name}`);
    assert.equal(metadata.version, pkg.version, `Gateway dependency package version changed: ${pkg.name}`);
    const files = await collectNodePackageFiles(packageRoot);
    assert.equal(files.length, pkg.fileCount, `Gateway dependency file count changed: ${pkg.name}`);
    assert.equal(hashJson(files), pkg.treeSha256, `Gateway dependency source tree changed: ${pkg.name}`);

    const requireFromPackage = createRequire(metadataPath);
    const actualDependencies = [];
    for (const [kind, declared] of [
      ["dependencies", metadata.dependencies ?? {}],
      ["optionalDependencies", metadata.optionalDependencies ?? {}],
      ["peerDependencies", metadata.peerDependencies ?? {}],
    ]) {
      for (const name of Object.keys(declared).sort()) {
        try {
          const entryPath = requireFromPackage.resolve(name);
          const resolvedPackage = await findNodePackageRoot(entryPath, name);
          actualDependencies.push({ name, kind, packageRoot: resolvedPackage.root, entryPath });
        } catch (error) {
          actualDependencies.push({ name, kind, packageRoot: null, errorCode: error?.code ?? "UNKNOWN" });
        }
      }
    }
    assert.deepEqual(actualDependencies, pkg.dependencies, `Gateway transitive dependency resolution changed: ${pkg.name}`);
    for (const dependency of actualDependencies) {
      if (dependency.packageRoot !== null) assert.ok(packageByRoot.has(dependency.packageRoot), `Gateway dependency closure omitted ${dependency.name}`);
    }
  }
  assert.equal(hashJson(input.packages.map(({ name, version, root, fileCount, treeSha256 }) => ({ name, version, root, fileCount, treeSha256 }))), input.closureSha256, "Gateway Node dependency closure digest mismatch");
  return { packageCount: input.packageCount, closureSha256: input.closureSha256, directImports: input.direct.map(({ importer, name, packageRoot }) => ({ importer, name, packageRoot })) };
}

async function findNodePackageRoot(entryPath, expectedName) {
  let current = dirname(entryPath);
  while (current !== dirname(current)) {
    const metadataPath = resolve(current, "package.json");
    try {
      const metadata = JSON.parse((await readFile(metadataPath)).toString("utf8"));
      if (metadata.name === expectedName) return { root: await realpath(current), metadata, metadataPath };
    } catch (error) {
      if (!["ENOENT", "ENOTDIR", "EACCES"].includes(error?.code)) throw error;
    }
    current = dirname(current);
  }
  throw new Error(`Gateway Node package root not found: ${expectedName}`);
}

async function collectNodePackageFiles(root) {
  const files = [];
  async function visit(directory) {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      if (child.name === "node_modules") continue;
      const path = resolve(directory, child.name);
      const info = await lstat(path);
      const relativePath = relative(root, path).split(sep).join("/");
      if (info.isSymbolicLink()) {
        files.push({ path: relativePath, type: "symlink", target: await readlink(path) });
      } else if (info.isDirectory()) {
        await visit(path);
      } else if (info.isFile()) {
        const bytes = await readFile(path);
        files.push({ path: relativePath, type: "file", size: bytes.length, sha256: sha256(bytes) });
      } else {
        assert.fail(`Gateway dependency contains a special file: ${relativePath}`);
      }
    }
  }
  await visit(root);
  files.sort((left, right) => left.path.localeCompare(right.path));
  return files;
}

async function verifyRustBuildInputs(input, privateRoots) {
  assert.ok(isAbsolute(input.binaryPath) && isAbsolute(input.buildProvenancePath) && isAbsolute(input.sourcePinPath), "Rust binary and build sidecar paths must be absolute");
  const binaryInfo = await lstat(input.binaryPath);
  assert.ok(binaryInfo.isFile() && !binaryInfo.isSymbolicLink(), "pinned Rust app-server must be a regular, non-symlink executable");
  const binary = await hashExecutableFile(input.binaryPath);
  await access(binary.path, constants.X_OK);
  assert.equal(await realpath(input.binaryPath), binary.path, "pinned Rust app-server path must be canonical");
  assert.ok(isWithinAny(privateRoots, binary.path), "final Rust app-server binary must be stored under an approved private implementation root");
  assert.equal(binary.sha256, input.binarySha256, "Rust app-server binary differs from the final production-build pin");
  assert.equal(binary.size, input.binaryBytes, "Rust app-server binary size differs from its pin");
  assert.notEqual(binary.sha256, "d1c98e33084e6dc8692d0e710d22affb01ebfd79a8d60a4b37965a6d841cbcf6", "legacy navigation binary is not valid evidence for the new resume protocol");

  for (const [path, digest, label] of [
    [input.buildProvenancePath, input.buildProvenanceSha256, "production build provenance"],
    [input.sourcePinPath, input.sourcePinSha256, "Rust source pin"],
  ]) {
    const info = await lstat(path);
    assert.ok(info.isFile() && !info.isSymbolicLink(), `${label} must be a regular, non-symlink file`);
    assert.equal(await realpath(path), resolve(path), `${label} path must be canonical`);
    assert.ok(isWithinAny(privateRoots, resolve(path)), `${label} must remain under an approved private implementation root`);
    assert.equal(sha256(await readFile(path)), digest, `${label} SHA-256 mismatch`);
  }
  const build = JSON.parse((await readFile(input.buildProvenancePath)).toString("utf8"));
  const sourcePin = JSON.parse((await readFile(input.sourcePinPath)).toString("utf8"));
  assert.equal(build.exitCode, 0, "pinned Rust production build did not complete successfully");
  assert.equal(build.sourceUnchanged, true, "Rust source changed during production build");
  assert.deepEqual(build.changedSources, [], "Rust production build reports changed source inputs");
  assert.equal(build.newDownloadsObserved, false, "Rust production build observed dependency downloads");
  assert.equal(build.sourcePinSha256, input.sourcePinSha256, "production build does not link to the pinned Rust source-pin file");
  assert.equal(build.binary.path, binary.path, "production build sidecar binary path differs from the pinned executable");
  assert.equal(build.binary.sha256, binary.sha256, "production build sidecar binary hash differs from the pinned executable");
  assert.equal(build.binary.bytes, binary.size, "production build sidecar binary size differs from the pinned executable");
  assert.ok(Array.isArray(sourcePin.sources) && sourcePin.sources.length === input.sourcePinEntryCount, "Rust source pin entry count mismatch");
  assert.ok(sourcePin.workspaceSourcesCopied > 0 && typeof sourcePin.scope === "string", "Rust source pin lacks build-input scope evidence");
  return { binary, buildProvenanceSha256: input.buildProvenanceSha256, sourcePinSha256: input.sourcePinSha256, sourcePinEntryCount: sourcePin.sources.length };
}

async function verifyMobileWebBundle(input, privateRoot, candidate) {
  assert.equal(input.bundleFileCount, 37, "the accepted Mobile Web export must contain the canonical 37-file bundle");
  assert.ok([input.root, input.manifestPath, input.provenancePath].every(value => typeof value === "string" && isAbsolute(value)), "Mobile Web root and sidecar paths must be absolute");
  const root = await realpath(input.root);
  const manifestPath = await realpath(input.manifestPath);
  const provenancePath = await realpath(input.provenancePath);
  assert.ok(isWithin(privateRoot, root) && isWithin(privateRoot, manifestPath) && isWithin(privateRoot, provenancePath), "Mobile Web root and sidecars must be immutable private inputs");
  const rootInfo = await lstat(input.root);
  const manifestInfo = await lstat(input.manifestPath);
  const provenanceInfo = await lstat(input.provenancePath);
  assert.ok(rootInfo.isDirectory() && !rootInfo.isSymbolicLink(), "Mobile Web root must be a real directory");
  assert.ok(manifestInfo.isFile() && !manifestInfo.isSymbolicLink(), "Mobile Web manifest must be a real file");
  assert.ok(provenanceInfo.isFile() && !provenanceInfo.isSymbolicLink(), "Mobile Web provenance must be a real file");
  const manifestBytes = await readFile(manifestPath);
  assert.equal(sha256(manifestBytes), input.manifestSha256, "Mobile Web manifest SHA-256 mismatch");
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const provenanceBytes = await readFile(provenancePath);
  assert.equal(sha256(provenanceBytes), input.provenanceSha256, "Mobile Web provenance SHA-256 mismatch");
  const provenance = JSON.parse(provenanceBytes.toString("utf8"));
  assert.equal(manifest.status, "complete", "Mobile Web export is not complete");
  assert.equal(manifest.sourceUnchanged, true, "Mobile Web source changed during its export");
  assert.equal(manifest.snapshotUnchangedDuringExport, true, "Mobile Web frozen input changed during its export");
  assert.equal(manifest.dependencyProvenance?.sourceUnchanged, true, "Mobile Web export dependency source changed during its export");
  assert.equal(manifest.sourceTreeSha256, input.sourceTreeSha256, "Mobile Web export source tree mismatch");
  assert.equal(provenance.status, "complete", "Mobile Web export provenance is not complete");
  assert.equal(provenance.candidateDigest, candidate.sourceDigest, "Mobile Web export does not use the pinned 245-file candidate");
  assert.equal(input.candidateSourceDigest, candidate.sourceDigest, "Mobile Web candidate digest pin differs from the 245-file freeze");
  assert.equal(provenance.sourceTreeSha256, input.sourceTreeSha256, "Mobile Web provenance source digest mismatch");
  assert.equal(manifest.bundleSha256, input.bundleSha256, "Mobile Web bundle SHA-256 mismatch");
  assert.equal(manifest.indexHtmlSha256, input.indexHtmlSha256, "Mobile Web index.html SHA-256 mismatch");
  assert.equal(provenance.bundleSha256, input.bundleSha256, "Mobile Web provenance bundle SHA-256 mismatch");
  assert.equal(provenance.bundleFileCount, input.bundleFileCount, "Mobile Web provenance bundle file count mismatch");
  assert.equal(provenance.dependencyInput?.sourceTreeSha256, input.dependencySourceTreeSha256, "Mobile Web dependency source tree differs from the pinned before input");
  assert.equal(provenance.dependencyInput?.ownedTreeSha256, input.dependencyOwnedTreeSha256, "Mobile Web owned dependency tree differs from the pinned before input");
  assert.equal(manifest.dependencyProvenance?.sourceTreeSha256Before, input.dependencySourceTreeSha256, "Mobile Web manifest dependency source tree differs from the pinned before input");
  assert.equal(manifest.dependencyProvenance?.copiedTreeSha256, input.dependencyOwnedTreeSha256, "Mobile Web manifest owned dependency tree differs from the pinned before input");
  await verifyMobileExportSourceRoots(candidate, manifest);
  const actualFiles = await hashRegularTree(root);
  assert.equal(actualFiles.length, input.bundleFileCount, "Mobile Web bundle file count mismatch");
  assert.deepEqual(actualFiles, manifest.bundleFiles, "Mobile Web per-file export manifest mismatch");
  assert.equal(sha256(Buffer.from(JSON.stringify(actualFiles))), input.bundleSha256, "Mobile Web aggregate bundle digest mismatch");
  const index = actualFiles.find(file => file.path === "index.html");
  assert.equal(index?.sha256, input.indexHtmlSha256, "Mobile Web index.html is not the pinned file");
  return { root, manifestPath, provenancePath, manifestSha256: input.manifestSha256, provenanceSha256: input.provenanceSha256, sourceTreeSha256: input.sourceTreeSha256, bundleSha256: input.bundleSha256, fileCount: actualFiles.length };
}

async function verifyMobileExportSourceRoots(candidate, manifest) {
  const expectedRoots = [
    { name: "mobile", destination: "apps/kcoder-studio/mobile", prefix: "apps/kcoder-studio/mobile/" },
    { name: "studio-shared", destination: "apps/kcoder-studio/shared", prefix: "apps/kcoder-studio/shared/" },
  ];
  assert.deepEqual(manifest.inputRootsAfter, manifest.inputRoots, "Mobile Web export input roots changed during export");
  assert.equal(manifest.inputRoots?.length, expectedRoots.length, "Mobile Web export must bind exactly the pinned Mobile and shared source roots");
  const aggregateRoots = [];
  for (let index = 0; index < expectedRoots.length; index += 1) {
    const expected = expectedRoots[index];
    const actual = manifest.inputRoots[index];
    assert.equal(actual.name, expected.name, `Mobile Web input root ${index} name mismatch`);
    assert.equal(actual.destination, expected.destination, `Mobile Web input root ${index} destination mismatch`);
    assert.equal(await realpath(actual.sourceRoot), resolve(candidate.root, expected.destination), `Mobile Web input root ${index} is not the candidate's frozen source`);
    const files = Object.entries(candidate.manifest)
      .filter(([path]) => path.startsWith(expected.prefix))
      .map(([path, digest]) => ({ path: path.slice(expected.prefix.length), size: 0, sha256: digest }))
      .sort((left, right) => left.path.localeCompare(right.path));
    for (const file of files) {
      const sourcePath = resolve(candidate.root, expected.destination, ...file.path.split("/"));
      const info = await lstat(sourcePath);
      assert.ok(info.isFile() && !info.isSymbolicLink(), `Mobile Web candidate source is not a regular file: ${expected.destination}/${file.path}`);
      file.size = info.size;
    }
    assert.equal(files.length, actual.fileCount, `Mobile Web candidate root ${expected.name} file count mismatch`);
    assert.equal(hashJson(files), actual.sha256, `Mobile Web candidate root ${expected.name} digest mismatch`);
    aggregateRoots.push({ name: actual.name, destination: actual.destination, sha256: actual.sha256 });
  }
  assert.equal(hashJson(aggregateRoots), manifest.sourceTreeSha256, "Mobile Web source tree digest does not match its pinned roots");
}

async function hashRegularTree(root) {
  const files = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = resolve(directory, entry.name);
      const path = relative(root, absolute).split(sep).join("/");
      const info = await lstat(absolute);
      assert.ok(!info.isSymbolicLink(), `bundle contains a symlink: ${path}`);
      if (info.isDirectory()) await visit(absolute);
      else if (info.isFile()) {
        const bytes = await readFile(absolute);
        files.push({ path, size: bytes.length, sha256: sha256(bytes) });
      } else assert.fail(`bundle contains a non-regular entry: ${path}`);
    }
  }
  await visit(root);
  files.sort((left, right) => left.path.localeCompare(right.path));
  return files;
}

async function seedCompletedThread(context, input) {
  const title = `RESUME_HISTORY_E2E_${randomHex(8)}`;
  const sentinel = `${title}_SEED_MESSAGE`;
  const label = "resume-history-stdio-seed";
  const binary = await hashExecutableFile(input.binaryPath);
  assert.equal(binary.sha256, input.binarySha256, "seed binary no longer matches its final pin");
  const env = context.isolatedEnvironment({
    HOME: input.homeDir,
    USERPROFILE: input.homeDir,
    XDG_CONFIG_HOME: input.configDir,
    KCODER_CONFIG_DIR: input.configDir,
    TMPDIR: input.tempRoot,
    TMP: input.tempRoot,
    TEMP: input.tempRoot,
  });
  const child = context.spawnOwned(label, binary.path, [
    "--settings-file", input.settingsFile,
    "--cwd", input.workspace,
    "app-server", "--training-mode", "--scenario", "thinking-preview",
  ], { cwd: input.workspace, env, stdin: "pipe" });
  assert.ok(child.stdin && child.stdout, "seed app-server must expose JSONL stdio");
  const client = new AppServerStdioClient(label, child, { defaultTimeoutMs: RPC_TIMEOUT_MS });
  const owned = context.processes.get(label);
  assert.ok(owned?.pid === child.pid && owned?.pgid > 0, "seed process must be registered under its exact RunContext owner");
  const actualProcess = await waitFor(async () => {
    const matches = await findOwnedExecutableProcesses({ pgid: owned.pgid, executablePath: binary.path });
    return matches.find(item => item.pid === child.pid) ?? null;
  }, 10_000, "pinned deterministic seed app-server", 50, context.abortSignal);
  assert.equal(actualProcess.sha256, binary.sha256, "seed child executable hash mismatch");
  assert.equal(await realpath(`/proc/${child.pid}/cwd`), input.workspace, "seed child cwd is not the isolated workspace");

  let closed = false;
  const server = { child, client, label, owned, binary, provenance: { pid: child.pid, pgid: owned.pgid, cwd: input.workspace, binaryPath: binary.path, binarySha256: actualProcess.sha256 } };
  context.addCleanup(`close ${label} JSONL child`, async () => {
    if (closed) return;
    if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end();
    await waitForStdioChildClose(child, CHILD_EXIT_TIMEOUT_MS, label).catch(() => undefined);
    await context.stopOwned(label).catch(() => undefined);
    client.closeReader();
    closed = true;
  });

  const initialized = await client.request("initialize", {
    protocolVersion: "2026-07-27",
    clientInfo: { name: "mobile-resume-inline-history-seed", version: "1" },
  });
  assert.equal(initialized.error, undefined, "seed initialize failed");
  assert.equal(initialized.result?.capabilities?.experimental?.threadResumeHistoryPageV1, true, "pinned seed binary did not advertise inline resume history");
  const started = await client.request("thread/start", {});
  assert.equal(started.error, undefined, "seed thread/start failed");
  const threadId = started.result?.thread?.id;
  assert.ok(typeof threadId === "string" && threadId.length > 0, "seed app-server did not return a thread id");
  const startResponse = await client.request("turn/start", {
    threadId,
    input: [{ type: "text", text: sentinel }],
  });
  assert.equal(startResponse.error, undefined, "deterministic seed turn/start failed");
  const turnId = startResponse.result?.turn?.id;
  assert.ok(typeof turnId === "string" && turnId.length > 0, "seed turn/start did not return a turn id");
  const completed = await client.waitForNotification(frame =>
    frame.method === "turn/completed" && frame.params?.threadId === threadId && frame.params?.turnId === turnId,
  30_000, "seed turn/completed");
  assert.equal(completed.params?.turn?.status, "completed", "seed scenario turn did not complete");
  const metadata = await client.request("thread/metadata/update", { threadId, title });
  assert.equal(metadata.error, undefined, "seed thread title update failed");
  const pageResponse = await client.request("thread/read", { threadId, limit: 50 });
  assert.equal(pageResponse.error, undefined, "seed thread/read failed");
  const page = pageResponse.result;
  assert.ok(Array.isArray(page?.messages) && page.messages.length > 0, "seed read returned no persisted history");
  assert.ok(page.messages.some(message => message.role === "user" && message.content?.includes(sentinel)), "seed history lacks its unique user marker");
  const seedMessageIds = page.messages.map(message => message.id);
  assert.equal(new Set(seedMessageIds).size, seedMessageIds.length, "seed history contains duplicate message ids");

  if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end();
  const exit = await waitForStdioChildClose(child, CHILD_EXIT_TIMEOUT_MS, label);
  await context.stopOwned(label);
  client.closeReader();
  closed = true;
  assert.equal(exit.code, 0, "seed app-server did not exit cleanly after JSONL EOF");
  const remaining = await findOwnedExecutableProcesses({ pgid: owned.pgid, executablePath: binary.path });
  assert.deepEqual(remaining, [], "seed app-server process group still contains the pinned child before Gateway startup");
  server.provenance.exitCode = exit.code;
  server.provenance.allSeedChildrenGoneBeforeGateway = true;
  return { threadId, title, sentinel, turnId, page, provenance: server.provenance };
}

async function startResumeGateway(context, pins, { label, workspace, serversFile, scenario }) {
  const configDir = context.pathInState("config");
  const gateway = await startGateway(context, {
    label,
    workspace,
    serversFile,
    kcoderBin: pins.rust.binaryPath,
    env: {
      KCODER_CONFIG_DIR: configDir,
      KCODER_TRAINING_MODE: "true",
      KCODER_STUDIO_WEB_ROOT: pins.mobileWeb.root,
      KCODER_STUDIO_MOCK: "0",
      KCODER_STUDIO_SCENARIO: scenario ? "thinking-preview" : "",
    },
  });
  return {
    ...gateway,
    label,
    scenario,
    workspace,
    binaryPath: pins.rust.binaryPath,
    binarySha256: pins.rust.binarySha256,
  };
}

async function stopGatewayAndVerify(context, gateway, binaryPath) {
  const owned = context.processes.get(gateway.label);
  await context.stopOwned(gateway.label);
  assert.ok(owned?.pgid > 0, `Gateway ${gateway.label} lacks RunContext process ownership`);
  assert.equal(owned.stopped, true, `Gateway ${gateway.label} was not marked stopped by RunContext`);
  const remaining = await findOwnedExecutableProcesses({ pgid: owned.pgid, executablePath: binaryPath });
  assert.deepEqual(remaining, [], `Gateway ${gateway.label} left an app-server child running`);
}

async function verifyGatewayRuntime(context, gateway) {
  const owner = context.processes.get(gateway.label);
  assert.ok(owner?.pid === gateway.child.pid && owner.pgid > 0, `Gateway ${gateway.label} lacks its exact RunContext owner`);
  const processes = await findOwnedExecutableProcesses({ pgid: owner.pgid, executablePath: gateway.binaryPath });
  assert.equal(processes.length, 1, `Gateway ${gateway.label} must have exactly one real app-server child for the restored TaskRuntime`);
  const [runtime] = processes;
  assert.equal(runtime.sha256, gateway.binarySha256, "Gateway started an app-server binary that differs from the pinned Rust build");
  assert.equal(await realpath(`/proc/${runtime.pid}/cwd`), gateway.workspace, "Gateway app-server child cwd differs from the isolated seeded workspace");
  return {
    gatewayPid: gateway.child.pid,
    gatewayPgid: owner.pgid,
    appServerPid: runtime.pid,
    appServerSha256: runtime.sha256,
    appServerCwd: gateway.workspace,
  };
}

async function runResumeBrowserCase(context, chromium, gateway, seed, options) {
  const pageId = options.caseId;
  const page = await chromium.newPage({ viewport: { width: 390, height: 844 } });
  const pageContext = page.context();
  const observations = createProtocolObservations(pageId, seed.threadId, options);
  const browserErrors = [];
  page.on("pageerror", error => browserErrors.push(error.message));
  await installProtocolRoute(page, observations, options);
  try {
    await connectMobile(page, gateway);
    await page.getByTestId("sessions").click();
    await page.getByTestId("session-search").fill(seed.title);
    const session = page.getByTestId(`session-${seed.threadId}`);
    await session.waitFor({ state: "visible", timeout: 20_000 });
    observations.selectedSessionAt = performance.now();
    await session.click();
    await page.getByTestId("message-input-root").waitFor({ state: "visible", timeout: 20_000 });
    await page.getByTestId("message-user").filter({ hasText: seed.sentinel }).waitFor({ state: "visible", timeout: 20_000 });
    await nextFramePair(page);
    const gatewayRuntime = await verifyGatewayRuntime(context, gateway);
    await waitFor(() => observations.resumeResults.length === 1 && observations.resumeResults[0].forwardedAt !== null,
      10_000, `${pageId} forwarded thread/resume response`, 25, context.abortSignal);

    const resume = observations.resumeResults[0];
    assert.ok(observations.capabilityByResumeSocket, "TaskRuntime socket has no matched initialize capability response");
    assert.equal(observations.capabilityByResumeSocket.server.threadResumeHistoryPageV1, true, "actual app-server initialize did not advertise threadResumeHistoryPageV1 on the TaskRuntime socket");
    assert.equal(observations.capabilityByResumeSocket.client.threadResumeHistoryPageV1, !options.hideResumeHistoryCapability, "Mobile-facing capability view mismatch");
    assert.equal(resume.request.threadId, seed.threadId, "resume targeted a different thread");
    assert.equal(resume.configuredHoldMs, RESUME_RESPONSE_HOLD_MS, "resume response was not held at the configured test delay");
    assert.ok(resume.appliedHoldMs >= RESUME_RESPONSE_HOLD_MS, "resume response was forwarded before its full injected hold elapsed");
    assert.equal(resume.deliveredResult?.thread?.id, seed.threadId, "actual resume response belongs to another thread");

    const targetReads = observations.requests.filter(entry => entry.socketId === resume.socketId &&
      ["thread/read", "thread/read/indexed"].includes(entry.method) && entry.threadId === seed.threadId);
    if (options.expectInline) {
      assert.equal(resume.request.historyPresent, true, "inline resume request omitted the history parameter");
      assert.equal(resume.request.history?.limit, 50, "inline resume request did not ask for the first 50 history messages");
      assert.equal(resume.deliveredResult?.history?.status, "ready", "actual resume did not forward an inline ready page");
      assert.deepEqual(messageProjection(resume.deliveredResult.history.page.messages), messageProjection(seed.page.messages), "inline page differs from the pre-shutdown stdio history");
      assert.equal(targetReads.length, 0, "ready inline hydration issued an unnecessary separate thread/read on the same TaskRuntime socket");
    } else {
      assert.equal(resume.request.historyPresent, false, "capability-withheld client still sent the inline history parameter");
      assert.deepEqual(resume.request.history, { missing: true }, "absent inline history parameter was not recorded as missing");
      assert.equal(resume.deliveredResult?.history, undefined, "legacy request did not preserve Thread-only resume response shape");
      assert.equal(targetReads.length, 1, "legacy compatibility must perform exactly one same-socket history fallback read");
      assert.equal(targetReads[0].method, observations.capabilityByResumeSocket.client.threadIndexedPagesV1 ? "thread/read/indexed" : "thread/read", "legacy read method does not match the capability view");
      assert.deepEqual(messageProjection(targetReads[0].result?.messages), messageProjection(seed.page.messages), "legacy fallback page differs from the pre-shutdown stdio history");
    }

    if (options.injectScenarioTurnDuringResumeHold) {
      const buffered = observations.injectedScenarioTurn;
      assert.ok(buffered?.acknowledged && buffered.turnId, "deterministic scenario turn did not receive a real Gateway/app-server acknowledgement");
      const started = buffered.notifications.find(item => item.method === "turn/started");
      const completed = buffered.notifications.find(item => item.method === "turn/completed" && item.status === "completed");
      assert.ok(started && completed, "held resume did not observe the scenario turn's actual started/completed notifications");
      assert.equal(started.turnId, buffered.turnId, "scenario turn/started belongs to another turn");
      assert.equal(completed.turnId, buffered.turnId, "scenario turn/completed belongs to another turn");
      assert.ok(started.forwardedAt < completed.forwardedAt, "scenario turn notifications arrived out of order");
      assert.ok(completed.forwardedAt < resume.forwardedAt, "scenario terminal notification was not forwarded to Mobile before resume completed");
      const assistantRows = page.getByTestId("message-assistant").filter({ hasText: buffered.sentinel });
      await assistantRows.last().waitFor({ state: "visible", timeout: 20_000 });
      assert.equal(await assistantRows.count(), 1, "buffered turn must produce exactly one visible assistant row carrying its sentinel");
      const assistantRowText = normalizeVisibleText(await assistantRows.last().innerText());
      const expectedAssistantProjection = normalizeVisibleText(`thinking preview complete\n\nUser input: ${buffered.sentinel}`);
      assert.equal(countLiteralOccurrences(assistantRowText, expectedAssistantProjection), 1,
        "buffered turn must project the complete expected assistant body exactly once inside its unique visible row");
      assert.equal(countLiteralOccurrences(assistantRowText, buffered.sentinel), 1,
        "buffered turn sentinel must appear exactly once in the unique assistant row");
      const bodyStart = assistantRowText.indexOf(expectedAssistantProjection);
      const assistantProjection = assistantRowText.slice(bodyStart, bodyStart + expectedAssistantProjection.length);
      assert.equal(assistantProjection, expectedAssistantProjection, "assistant body extraction changed the complete expected projection");
      buffered.assistantProjection = assistantProjection;
    }

    assert.equal(observations.requests.filter(entry => entry.method === "turn/start" && entry.source === "browser").length, 0, "primary resume Browser case unexpectedly sent a user/model turn");
    assert.equal(browserErrors.length, 0, `Browser emitted page errors: ${browserErrors.join(" | ")}`);
    const caseEvidence = {
      caseId: pageId,
      status: "PASS",
      pageContextWasFresh: true,
      gatewayAndAppServerRuntimeWasFresh: true,
      gatewayRuntime,
      capabilityView: options.capabilityView,
      routeSocketId: resume.socketId,
      threadId: seed.threadId,
      resumeRequest: { id: resume.request.id, history: resume.request.history ?? null },
      serverCapability: observations.capabilityByResumeSocket.server,
      mobileCapability: observations.capabilityByResumeSocket.client,
      resumeResponse: {
        historyStatus: resume.deliveredResult?.history?.status ?? "legacy-thread-only",
        messageIds: resume.deliveredResult?.history?.page?.messages?.map(message => message.id) ?? null,
        forwardedAfterHoldMs: resume.appliedHoldMs,
      },
      injectedScenarioTurn: observations.injectedScenarioTurn ? {
        sentinel: observations.injectedScenarioTurn.sentinel,
        acknowledged: observations.injectedScenarioTurn.acknowledged,
        turnId: observations.injectedScenarioTurn.turnId,
        assistantProjection: observations.injectedScenarioTurn.assistantProjection ?? null,
        notifications: observations.injectedScenarioTurn.notifications,
      } : null,
      historyReadsOnTaskSocket: targetReads.map(entry => ({ method: entry.method, threadId: entry.threadId })),
      seedMessageIds: seed.page.messages.map(message => message.id),
      renderedSeedUserVisible: true,
      browserTurnStartRequests: 0,
      externalProviderConfigured: false,
      deterministicLocalScenarioUsed: Boolean(options.injectScenarioTurnDuringResumeHold),
      pageErrors: browserErrors,
    };
    await context.writeArtifactJson(`resume-history-${pageId}.json`, caseEvidence);
    return caseEvidence;
  } catch (error) {
    await page.screenshot({ path: context.pathInArtifacts(`resume-history-${pageId}-failure.png`) }).catch(() => {});
    await context.writeArtifactJson(`resume-history-${pageId}-failure.json`, {
      caseId: pageId,
      status: "FAIL",
      safeUrlPath: safePath(page.url()),
      visibleControls: await visibleTestIds(page).catch(() => []),
      routeSocketIds: observations.socketIds,
      requests: observations.requests.map(safeRequestEvidence),
      resumeResults: observations.resumeResults.map(safeResumeEvidence),
      browserErrors,
      error: context.redactText(error?.stack || error?.message || String(error)),
    });
    throw error;
  } finally {
    await page.close().catch(() => {});
    // Browser.newPage creates a separate temporary context; close it before the next case.
    await pageContext.close().catch(() => {});
  }
}

function createProtocolObservations(pageId, threadId, options) {
  return {
    pageId,
    threadId,
    socketIds: [],
    requests: [],
    resumeResults: [],
    capabilityByResumeSocket: null,
    selectedSessionAt: null,
    errors: [],
    options,
  };
}

async function installProtocolRoute(page, observations, options) {
  let nextSocketId = 0;
  await page.routeWebSocket("**/rpc*", routed => {
    const socketId = `${observations.pageId}-rpc-${++nextSocketId}`;
    observations.socketIds.push(socketId);
    const upstream = routed.connectToServer();
    const calls = new Map();
    let injectedTurnRequestId = null;
    let injectedTurnId = null;
    let injectedTurnAck = false;
    let injectedTurnCompleted = false;
    let heldResume = null;

    routed.onMessage(raw => {
      const frame = parseFrame(raw);
      if (frame && frame.id !== undefined && typeof frame.method === "string") {
        const params = frame.params ?? {};
        const entry = {
          socketId,
          pageId: observations.pageId,
          id: String(frame.id),
          method: frame.method,
          params,
          historyPresent: Object.hasOwn(params, "history"),
          source: "browser",
          sentAt: performance.now(),
        };
        calls.set(String(frame.id), entry);
        observations.requests.push({ ...entry, threadId: frame.params?.threadId ?? null });
      }
      upstream.send(raw);
    });

    upstream.onMessage(raw => {
      const frame = parseFrame(raw);
      if (frame && frame.id !== undefined) {
        if (injectedTurnRequestId !== null && String(frame.id) === injectedTurnRequestId) {
          injectedTurnAck = !frame.error;
          injectedTurnId = frame.result?.turn?.id ?? null;
          if (observations.injectedScenarioTurn) {
            observations.injectedScenarioTurn.acknowledged = injectedTurnAck;
            observations.injectedScenarioTurn.turnId = injectedTurnId;
          }
          if (injectedTurnId) maybeReleaseHeldResume();
          return;
        }
        const request = calls.get(String(frame.id));
        if (request?.method === "initialize") {
          const experimental = frame.result?.capabilities?.experimental ?? {};
          const serverCaps = {
            threadResumeHistoryPageV1: experimental.threadResumeHistoryPageV1 === true,
            threadIndexedPagesV1: experimental.threadIndexedPagesV1 === true,
          };
          let forwarded = raw;
          let clientCaps = { ...serverCaps };
          if (options.hideResumeHistoryCapability) {
            const modified = structuredClone(frame);
            if (modified.result?.capabilities?.experimental) delete modified.result.capabilities.experimental.threadResumeHistoryPageV1;
            clientCaps.threadResumeHistoryPageV1 = false;
            forwarded = JSON.stringify(modified);
          }
          const initializeEvidence = observations.requests.find(item => item.socketId === socketId &&
            item.method === "initialize" && String(item.id) === String(frame.id));
          if (initializeEvidence) initializeEvidence.initializeCaps = { server: serverCaps, client: clientCaps };
          observations._capabilitiesBySocket ??= new Map();
          observations._capabilitiesBySocket.set(socketId, { server: serverCaps, client: clientCaps });
          routed.send(forwarded);
          return;
        }
        if (request?.method === "thread/resume" && request.params?.threadId === observations.threadId) {
          const result = {
            socketId,
            request: {
              id: String(frame.id),
              threadId: request.params.threadId,
              historyPresent: request.historyPresent,
              history: request.historyPresent ? request.params.history : { missing: true },
            },
            upstreamResult: frame.result ?? null,
            deliveredResult: null,
            receivedAt: performance.now(),
            forwardedAt: null,
            configuredHoldMs: RESUME_RESPONSE_HOLD_MS,
            appliedHoldMs: null,
          };
          observations.resumeResults.push(result);
          observations.capabilityByResumeSocket = observations._capabilitiesBySocket?.get(socketId) ?? null;
          if (options.injectScenarioTurnDuringResumeHold) {
            heldResume = { raw, frame, result, deadline: performance.now() + RESUME_RESPONSE_HOLD_MS };
            injectedTurnRequestId = `${observations.pageId}-buffer-turn-start`;
            observations.injectedScenarioTurn = {
              requestId: injectedTurnRequestId,
              threadId: observations.threadId,
              sentinel: `${observations.pageId}_BUFFERED_SCENARIO_SENTINEL`,
              acknowledged: false,
              turnId: null,
              notifications: [],
            };
            upstream.send(JSON.stringify({
              jsonrpc: "2.0",
              id: injectedTurnRequestId,
              method: "turn/start",
              params: { threadId: observations.threadId, input: [{ type: "text", text: observations.injectedScenarioTurn.sentinel }] },
            }));
            return;
          }
          void forwardHeldResume(routed, result, raw, result.receivedAt);
          return;
        }
        if (request && ["thread/read", "thread/read/indexed"].includes(request.method) && request.params?.threadId === observations.threadId) {
          const evidence = observations.requests.find(item => item.socketId === socketId && item.method === request.method && String(item.id) === String(frame.id));
          if (evidence) evidence.result = frame.result ?? null;
        }
        routed.send(raw);
        return;
      }

      if (frame && typeof frame.method === "string") {
        if (options.injectScenarioTurnDuringResumeHold && observations.injectedScenarioTurn &&
            frame.params?.threadId === observations.threadId && frame.params?.turnId === injectedTurnId) {
          const event = {
            method: frame.method,
            turnId: frame.params?.turnId ?? null,
            status: frame.params?.turn?.status ?? null,
            receivedAt: performance.now(),
          };
          routed.send(raw);
          event.forwardedAt = performance.now();
          observations.injectedScenarioTurn.notifications.push(event);
          if (event.method === "turn/completed" && event.status === "completed") injectedTurnCompleted = true;
          if (injectedTurnCompleted) maybeReleaseHeldResume();
          return;
        }
        observations.serverNotifications ??= [];
        if (frame.params?.threadId === observations.threadId && observations.serverNotifications.length < 64) {
          observations.serverNotifications.push({ socketId, method: frame.method, turnId: frame.params?.turnId ?? null });
        }
        routed.send(raw);
        if (injectedTurnCompleted) maybeReleaseHeldResume();
        return;
      }
      routed.send(raw);
    });

    function maybeReleaseHeldResume() {
      if (!heldResume || !injectedTurnAck || !injectedTurnId || !injectedTurnCompleted) return;
      const pending = heldResume;
      heldResume = null;
      void forwardHeldResume(routed, pending.result, pending.raw, pending.result.receivedAt);
    }
  });
}

async function forwardHeldResume(routed, result, raw, receivedAt) {
  const deadline = receivedAt + RESUME_RESPONSE_HOLD_MS;
  let remaining;
  while ((remaining = deadline - performance.now()) > 0) {
    await new Promise(resolveWait => setTimeout(resolveWait, Math.ceil(remaining)));
  }
  result.appliedHoldMs = performance.now() - receivedAt;
  const frame = parseFrame(raw);
  result.deliveredResult = frame?.result ?? null;
  result.forwardedAt = performance.now();
  routed.send(raw);
}

async function connectMobile(page, gateway) {
  await page.goto(gateway.baseUrl, { waitUntil: "domcontentloaded" });
  await page.getByTestId("welcome-direct-connection").waitFor({ state: "visible", timeout: 20_000 });
  await page.getByTestId("welcome-direct-connection").click();
  await page.getByTestId("gateway-endpoint").fill(gateway.baseUrl);
  await page.getByTestId("gateway-connect").click();
  await page.getByTestId("new-workspace").waitFor({ state: "visible", timeout: 20_000 });
}

async function nextFramePair(page) {
  await page.evaluate(() => new Promise(resolveFrame => requestAnimationFrame(() => requestAnimationFrame(resolveFrame))));
}

function messageProjection(messages) {
  return (messages ?? []).map(message => ({ id: message.id, role: message.role, content: message.content }));
}

function normalizeVisibleText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function countLiteralOccurrences(value, needle) {
  if (!needle) return 0;
  let count = 0;
  let offset = 0;
  while ((offset = value.indexOf(needle, offset)) !== -1) {
    count += 1;
    offset += needle.length;
  }
  return count;
}

function pageEvidence(page) {
  return {
    rangeStart: page.rangeStart ?? null,
    rangeEnd: page.rangeEnd ?? null,
    hasMoreBefore: page.hasMoreBefore ?? null,
    messageIds: page.messages.map(message => message.id),
    messageDigests: page.messages.map(message => ({ id: message.id, role: message.role, contentSha256: sha256(Buffer.from(String(message.content ?? ""))) })),
  };
}

function safeRequestEvidence(request) {
  return {
    pageId: request.pageId,
    socketId: request.socketId,
    id: request.id,
    method: request.method,
    threadId: request.threadId,
    historyPresent: request.historyPresent,
    history: request.historyPresent ? request.params.history : { missing: true },
    source: request.source,
  };
}

function safeResumeEvidence(result) {
  return {
    socketId: result.socketId,
    request: result.request,
    upstreamHistoryStatus: result.upstreamResult?.history?.status ?? "legacy-thread-only",
    deliveredHistoryStatus: result.deliveredResult?.history?.status ?? null,
    receivedAt: result.receivedAt,
    forwardedAt: result.forwardedAt,
    configuredHoldMs: result.configuredHoldMs,
    appliedHoldMs: result.appliedHoldMs,
  };
}

async function visibleTestIds(page) {
  return page.locator("[data-testid]").evaluateAll(nodes => nodes.filter(node => {
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }).map(node => node.getAttribute("data-testid")).filter(Boolean).slice(0, 80));
}

function safePath(url) {
  try { return new URL(url).pathname; } catch { return "[unavailable]"; }
}

function publicPinSummary(pins) {
  return {
    releaseId: pins.releaseId,
    pinFileSha256: pins.pinFileSha256,
    sourceDigest: pins.source.sourceDigest,
    sourceManifestSha256: pins.source.manifestSha256,
    rustBinarySha256: pins.rust.binarySha256,
    rustBuildProvenanceSha256: pins.rust.buildProvenanceSha256,
    rustSourcePinSha256: pins.rust.sourcePinSha256,
    mobileWebManifestSha256: pins.mobileWeb.manifestSha256,
    mobileWebProvenanceSha256: pins.mobileWeb.provenanceSha256,
    mobileWebSourceTreeSha256: pins.mobileWeb.sourceTreeSha256,
    mobileWebBundleSha256: pins.mobileWeb.bundleSha256,
    mobileWebFileCount: pins.mobileWeb.bundleFileCount,
    gatewayRuntimeSourceSha256: pins.gateway.runtimeSourceSha256,
    gatewayNodeDependencyClosureSha256: pins.gateway.nodeDependencies.closureSha256,
    node: pins.node,
  };
}

function parseFrame(raw) {
  try { return JSON.parse(String(raw)); } catch { return null; }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function hashJson(value) {
  return sha256(Buffer.from(JSON.stringify(value)));
}

function isWithin(root, path) {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

function isWithinAny(roots, path) {
  return roots.some(root => isWithin(root, path));
}

function randomHex(byteCount) {
  return randomBytes(byteCount).toString("hex");
}
