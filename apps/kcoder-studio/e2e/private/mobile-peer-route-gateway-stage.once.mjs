#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants, createReadStream } from "node:fs";
import { chmod, copyFile, lstat, mkdir, open, readFile, readdir, realpath, rename, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isolatedEnvironment } from "../harness/run-context.mjs";
import {
  createReadyReceipt,
  existsRegularFile,
  getAdminPairing,
  readRemoteOwnerConfig,
  revokeBenchmarkDevices,
  verifyMobileStaticReady,
  verifyRemoteRoot,
  writeJson0600,
  writeRemoteOwnerReceipt,
  writeRemoteOwnerStatus,
} from "./mobile-peer-route-owner-helpers.mjs";

process.umask(0o077);

const MOBILE_EXPORT_ROOT = resolve(
  "/data1/hyf/20260822_agent/kcoder-release-prep-20261019.fpomJy/mobile-web-e8af9f7d-official",
);
const MOBILE_EXPORT_RECEIPT = resolve(
  "/data1/hyf/20260822_agent/kcoder-release-prep-20261019.fpomJy/provenance/mobile-web-e8af9f7d-official-export-receipt.json",
);
const MOBILE_EXPORT_RECEIPT_SHA256 = "82dfec5d2e3dc77251434de6735a74c67e26c9e9bdc0fafa20dff01d9dc7b96e";
const MOBILE_EXPORT_REUSE_RECEIPT = resolve(
  "/data1/hyf/20260822_agent/kcoder-release-prep-20261019.fpomJy/provenance/mobile-web-reuse-receipt-75421ad7.json",
);
const MOBILE_EXPORT_REUSE_RECEIPT_SHA256 = "102444fb15f1e7d850792ab719465df420ff322c9122bd1071a1ffb667252639";
const PRODUCT_SOURCE_IDENTITY_RECEIPT = resolve(
  "/data1/hyf/20260822_agent/kcoder-release-prep-20261019.fpomJy/provenance/release-source-identity-75421ad7.json",
);
const PRODUCT_SOURCE_IDENTITY_RECEIPT_SHA256 = "2791a1dabac2c109af8e4604b76c7214fa05a3d40a11be74604b3cefbd86999d";
const MOBILE_EXPORT_MANIFEST_SHA256 = "19ed3c2e0e54962192a725d8fb13b2029d03695c15e91712967d400045951155";
const MOBILE_EXPORT_FILE_TABLE_SHA256 = "31371f12a7a4bb24944eb7c4c7aa415ec811062b2ca40b5a6ce80ef1e6257f5a";
const MOBILE_SHARED_SOURCE_IDENTITY_SHA256 = "e8b2530fb125de19cc7dc095aec649cd5a80748a5796dfa0963a95648125c3fe";
const FROZEN_PRODUCT_SOURCE_ROOT = resolve(
  "/data1/hyf/20260822_agent/kcoder-release-prep-20261019.fpomJy/source-clean",
);
const FROZEN_PRODUCT_SOURCE_PARENT_COMMIT = "e8af9f7dbe6adc67222ea1724d601f4b64b8c140";
const FROZEN_PRODUCT_SOURCE_COMMIT = "75421ad7ce51856ad22265c402c709258f2335e9";
const FROZEN_PRODUCT_SOURCE_TREE = "1568fca904bdf070f14885552a7f2695dbd65fd0";
const MOBILE_EXPORT_BUILD_SOURCE_COMMIT = "e8af9f7dbe6adc67222ea1724d601f4b64b8c140";
const MOBILE_EXPORT_BUILD_SOURCE_TREE = "279cbe8ca974225e7d6ce78ae3e275a6922cf067";
const MOBILE_EXPORT_BUILD_SOURCE_IDENTITY_SHA256 = "e8b2530fb125de19cc7dc095aec649cd5a80748a5796dfa0963a95648125c3fe";
const EXPECTED_MOBILE_ROOT_SOURCE_TREE_SHA256 = "057e159ce32d2d6ecf6b358a931259ce92aecbdb7ff0aa8bb5effc2e4bd23536";
const EXPECTED_STUDIO_SHARED_ROOT_SOURCE_TREE_SHA256 = "c80e0f4b0e9706936869524e07fca2ea9461223f157b947df60bfbcbea5d8677";
const EXPECTED_PRODUCT_MOBILE_GIT_TREE = "961e7c8504053bc7679c9f5f44fb5eba1d62c914";
const EXPECTED_PRODUCT_SHARED_GIT_TREE = "3441673737e8a444c118b44a4f2ee2f18d71928b";
const REGISTRATION_INPUT_PATH = resolve(
  "/data1/hyf/20260822_agent/Kunlun-Code-CYX/target/run/mobile-route-real-benchmark-20261019/.private/registration-input.json",
);
const BENCHMARK_BUNDLE_PATH = resolve(
  "/data1/hyf/20260822_agent/Kunlun-Code-CYX/target/run/mobile-route-real-benchmark-20261019/browser-build-rpc-safeerror-20261019T043136Z/mobile-peer-route-benchmark.browser.bundle.js",
);
const BENCHMARK_BUNDLE_PINS_PATH = resolve(
  "/data1/hyf/20260822_agent/Kunlun-Code-CYX/target/run/mobile-route-real-benchmark-20261019/browser-build-rpc-safeerror-20261019T043136Z/build-pins.json",
);
const BENCHMARK_BUNDLE_SHA256 = "d260394ff8f612b77c6f4e1ec36d28facb718f7c80007c61db0e40cc2996bb78";
const BENCHMARK_ENTRY_SOURCE_SHA256 = "489dcc67578fe38569ea53b54f6897c6a94307faa1f083ebba2ddfbf017256ae";
const BENCHMARK_ADAPTER_SOURCE_SHA256 = "ee1112ab74a6c047483ee0539f18f5c435fc3185921baa4cfd6b1e5e4f0c2d2f";
const REMOTE_HOSTS = Object.freeze({ lan: "A4500", public: "vps_first", browser: "H20-8" });
const RELAY_ORIGIN = "https://hyf2333.top:8451";
const RELAY_STUN_URL = "stun:47.80.92.250:8452";
const REQUIRED_MOBILE_FILES = 49;
const FIXTURE_SIZE_BYTES = 1024 * 1024;
const MAX_BENCH_RUNTIME_MS = 30 * 60 * 1000;
const MIN_PUBLIC_OWNER_MEMAVAILABLE_BYTES = 192 * 1024 * 1024;
const EXCLUDED_DIRECTORY_NAMES = new Set(["node_modules", "build", "test", "tests", "__tests__", "__fixtures__", ".git"]);
const SOURCE_FILE_PATTERN = /\.(?:[cm]?js|[cm]?ts|tsx|json|html|css|d\.ts)$/i;
const RUNTIME_COPY_FILES = [
  "e2e/harness/run-context.mjs",
  "e2e/harness/retention.mjs",
  "e2e/harness/owned-process.mjs",
  "e2e/harness/gateway.mjs",
  "e2e/harness/owned-redacted-stderr.mjs",
];
const WRITE_PRIVATE_FILE = [
  "import os,stat,sys",
  "p=sys.argv[1]; parent=os.path.dirname(p); st=os.lstat(parent)",
  "if not stat.S_ISDIR(st.st_mode) or stat.S_ISLNK(st.st_mode) or st.st_uid!=os.geteuid() or stat.S_IMODE(st.st_mode)!=0o700: raise SystemExit(20)",
  "fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)",
  "try:",
  "  data=sys.stdin.buffer.read(); view=memoryview(data)",
  "  while view:",
  "    n=os.write(fd,view); view=view[n:]",
  "  os.fsync(fd); s=os.fstat(fd)",
  "  if not stat.S_ISREG(s.st_mode) or s.st_nlink!=1 or s.st_uid!=os.geteuid() or stat.S_IMODE(s.st_mode)!=0o600: raise SystemExit(21)",
  "finally: os.close(fd)",
].join("\n");

if (process.argv.includes("--remote-owner")) {
  await runRemoteOwner(process.argv.slice(process.argv.indexOf("--remote-owner") + 1));
} else {
  await runLocalStage();
}

async function runLocalStage() {
  const { runE2E, waitFor } = await import("../harness/run-context.mjs");
  const { stageGatewayDependencies } = await import("../../desktop/stage-gateway-dependencies.mjs");
  const serveBench = process.argv.includes("--serve-bench");

  await runE2E(import.meta.url, {
    testId: "mobile-peer-route-gateway-portable-stage",
    tier: "full-integration",
    modelPolicy: "current-source Gateway portable package and owned LAN/public transport fixtures; no model provider or Rust inference",
    retainSuccessEvidence: true,
    retainSuccessLogs: true,
    cleanupTimeoutMs: 30_000,
    bodyAbortTimeoutMs: 5_000,
  }, async context => {
    const productSourceIdentity = await verifyFrozenProductSource(context, waitFor);
    const stageRoot = context.pathInState("portable-gateway");
    const packageRoot = join(stageRoot, "package");
    const testStudioSource = resolve(fileURLToPath(new URL("../..", import.meta.url)));
    const testControllerRepoRoot = resolve(testStudioSource, "../..");
    const studioSource = join(FROZEN_PRODUCT_SOURCE_ROOT, "apps/kcoder-studio");
    const studioTarget = join(packageRoot, "apps", "kcoder-studio");
    await mkdir(studioTarget, { recursive: true, mode: 0o700 });

    const sourceFiles = [
      await copyRegularFile(join(studioSource, "package.json"), join(studioTarget, "package.json"), undefined, "apps/kcoder-studio/package.json"),
      await copyRegularFile(join(studioSource, "dev-server.mjs"), join(studioTarget, "dev-server.mjs"), undefined, "apps/kcoder-studio/dev-server.mjs"),
    ];
    for (const directory of ["src", "shared"]) {
      sourceFiles.push(...await copySourceTree(join(studioSource, directory), join(studioTarget, directory), directory));
    }

    const relayClientRoot = join(studioTarget, "relay-client");
    await mkdir(join(relayClientRoot, "src"), { recursive: true, mode: 0o700 });
    await writeFile(join(relayClientRoot, "package.json"), '{"name":"kcoder-peer-route-relay-client","private":true,"type":"module"}\n', { flag: "wx", mode: 0o600 });
    const relaySource = resolve(FROZEN_PRODUCT_SOURCE_ROOT, "apps/kcoder-relay/src");
    const relayFiles = [];
    for (const name of ["client.mjs", "config.mjs", "client-identity.mjs", "transport.mjs"]) {
      relayFiles.push(await copyRegularFile(join(relaySource, name), join(relayClientRoot, "src", name), undefined,
        `apps/kcoder-studio/relay-client/src/${name}`));
    }

    for (const name of RUNTIME_COPY_FILES) {
      const source = join(testStudioSource, name);
      const destination = join(studioTarget, name);
      sourceFiles.push(await copyRegularFile(source, destination, undefined, `apps/kcoder-studio/${name}`));
    }
    const fixtureSource = join(testStudioSource, "e2e/private/mobile-peer-route-rpc-fixture.once.mjs");
    const fixtureTarget = join(studioTarget, "e2e/private/mobile-peer-route-rpc-fixture.once.mjs");
    sourceFiles.push(await copyRegularFile(fixtureSource, fixtureTarget, 0o700,
      "apps/kcoder-studio/e2e/private/mobile-peer-route-rpc-fixture.once.mjs"));
    const lanTlsSource = join(testStudioSource, "e2e/private/mobile-route-lan-https-front.mjs");
    const lanTlsTarget = join(studioTarget, "e2e/private/mobile-route-lan-https-front.mjs");
    sourceFiles.push(await copyRegularFile(lanTlsSource, lanTlsTarget, undefined,
      "apps/kcoder-studio/e2e/private/mobile-route-lan-https-front.mjs"));
    const ownerHelpersSource = join(testStudioSource, "e2e/private/mobile-peer-route-owner-helpers.mjs");
    const ownerHelpersTarget = join(studioTarget, "e2e/private/mobile-peer-route-owner-helpers.mjs");
    sourceFiles.push(await copyRegularFile(ownerHelpersSource, ownerHelpersTarget, undefined,
      "apps/kcoder-studio/e2e/private/mobile-peer-route-owner-helpers.mjs"));

    const stageRunnerSource = fileURLToPath(import.meta.url);
    sourceFiles.push(await copyRegularFile(stageRunnerSource,
      join(studioTarget, "e2e/private/mobile-peer-route-gateway-stage.once.mjs"), 0o700,
      "apps/kcoder-studio/e2e/private/mobile-peer-route-gateway-stage.once.mjs"));

    const mobileInput = await verifyMobileExport(MOBILE_EXPORT_ROOT, MOBILE_EXPORT_RECEIPT);
    const mobileReuse = await verifyMobileExportReuse(productSourceIdentity, mobileInput);
    const mobileTarget = join(studioTarget, "mobile/dist");
    const mobileFiles = await copyVerifiedMobileExport(MOBILE_EXPORT_ROOT, mobileTarget, mobileInput.rows);
    const fixturePayloadPath = join(studioTarget, "e2e/private/fixture-payload-1m.bin");
    const fixturePayload = createDeterministicFixturePayload(FIXTURE_SIZE_BYTES);
    await writeFile(fixturePayloadPath, fixturePayload, { flag: "wx", mode: 0o600 });
    const fixturePayloadSha256 = sha256(fixturePayload);

    const runtimeNodePath = join(packageRoot, "runtime", "node");
    const runtimeNodeFile = await copyRegularFile(process.execPath, runtimeNodePath, 0o700, "runtime/node");
    const runtimeNodeVersion = await verifyPackagedNode(context, runtimeNodePath, waitFor);

    const dependencyStage = await stageGatewayDependencies({
      sourceRoot: studioSource,
      destination: join(studioTarget, "node_modules"),
      targetPlatform: process.platform,
      targetArch: process.arch,
    });
    for (const dependency of ["jsonc-parser", "node-datachannel", "ssh2", "ws"]) {
      assert.ok(Object.hasOwn(dependencyStage.packages, dependency), `portable package must include ${dependency}`);
    }
    assert.equal(dependencyStage.p2pNative.status, "included", "the portable package must carry a native P2P addon for this Linux x64 host");
    const nativeSmoke = await verifyStagedRuntime(studioTarget);

    const finalFiles = (await listRegularFiles(packageRoot, "package")).map(row => {
      assert.ok(row.path.startsWith("package/"), "local package inventory paths must stay beneath package/");
      return { ...row, path: row.path.slice("package/".length) };
    });
    const finalProductSourceIdentity = await verifyFrozenProductSource(context, waitFor, "final");
    assert.deepEqual(finalProductSourceIdentity, productSourceIdentity,
      "frozen product source identity must remain unchanged throughout packaging");
    const packagedSourceRows = sourceFiles.concat(relayFiles);
    const productSourceFiles = packagedSourceRows
      .filter(row => isPathWithin(row.sourcePath, FROZEN_PRODUCT_SOURCE_ROOT))
      .sort((left, right) => left.path.localeCompare(right.path));
    const testHarnessFiles = packagedSourceRows
      .filter(row => isPathWithin(row.sourcePath, testControllerRepoRoot))
      .sort((left, right) => left.path.localeCompare(right.path));
    const packageManifest = {
      schemaVersion: 1,
      purpose: "current-source Gateway transport fixture package; synthetic attachment payload; no model inference",
      runId: basename(context.runRoot),
      gitHead: context.gitCommit,
      controllerGitCommit: context.gitCommit,
      sourceCheckout: testControllerRepoRoot,
      releaseSourceCommit: productSourceIdentity.commit,
      releaseSourceTree: productSourceIdentity.tree,
      productSource: {
        gitCommit: productSourceIdentity.commit,
        gitTree: productSourceIdentity.tree,
        checkout: FROZEN_PRODUCT_SOURCE_ROOT,
        parentCommit: productSourceIdentity.parentCommit,
        sourceIdentityReceiptSha256: productSourceIdentity.receiptSha256,
        mobileSharedSourceIdentitySha256: productSourceIdentity.mobileSharedSourceIdentitySha256,
        mobileSharedSourceFileCount: productSourceIdentity.mobileSharedSourceFileCount,
        mobileSharedGitTrees: productSourceIdentity.mobileSharedGitTrees,
        fileCount: productSourceFiles.length,
        files: productSourceFiles,
      },
      testHarnessSource: {
        controllerGitCommit: context.gitCommit,
        checkout: testControllerRepoRoot,
        fileCount: testHarnessFiles.length,
        treeSha256: hashFileInventory(testHarnessFiles.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 }))),
        files: testHarnessFiles,
      },
      runtime: { nodeVersion: process.version, platform: process.platform, arch: process.arch },
      portableNode: { path: "runtime/node", version: runtimeNodeVersion, bytes: runtimeNodeFile.bytes, sha256: runtimeNodeFile.sha256 },
      gatewaySource: {
        entry: "apps/kcoder-studio/dev-server.mjs",
        packageManifest: "apps/kcoder-studio/package.json",
        sourceFileCount: sourceFiles.length + relayFiles.length,
        files: sourceFiles.concat(relayFiles).sort((left, right) => left.path.localeCompare(right.path)),
      },
      externalRuntimeImports: {
        packageRoots: dependencyStage.packages,
        nativeP2PAddon: dependencyStage.p2pNative,
        nativeSmoke,
      },
      mobileWeb: {
        sourceExportReceiptSha256: mobileInput.receiptSha256,
        exportBuiltFromCommit: mobileInput.buildSourceCommit,
        exportBuiltFromTree: mobileInput.buildSourceTree,
        sourceManifestSha256: mobileInput.manifestSha256,
        sourceTreeSha256: mobileInput.sourceTreeSha256,
        sourceBundleSha256: mobileInput.bundleSha256,
        sourceBundleDigestKind: "official-export-resource-file-table-sha256",
        reuseReceiptSha256: mobileReuse.receiptSha256,
        reusedForCommit: productSourceIdentity.commit,
        reusedForTree: productSourceIdentity.tree,
        currentMobileSharedSourceIdentitySha256: mobileReuse.currentMobileSharedSourceIdentitySha256,
        bundleFileCount: mobileInput.rows.length,
        copiedFiles: mobileFiles.sort((left, right) => left.path.localeCompare(right.path)),
      },
      appServerFixture: {
        source: "apps/kcoder-studio/e2e/private/mobile-peer-route-rpc-fixture.once.mjs",
        dataKind: "synthetic deterministic transport payload; no model/provider calls",
        attachmentPath: "/peer-route/fixture-payload-1m.bin",
        payloadFile: "fixture-payload-1m.bin",
        payloadBytes: FIXTURE_SIZE_BYTES,
        payloadSha256: fixturePayloadSha256,
        chunkBytes: 512 * 1024,
        rpc: ["initialize", "thread/list", "thread/read", "attachment/read/chunk"],
      },
      packageFileCount: finalFiles.length,
      packageTreeSha256: hashFileInventory(finalFiles),
    };
    await writeFile(join(stageRoot, "package-manifest.json"), `${JSON.stringify(packageManifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    const sourceCheck = await checkStagedSyntax(context, studioTarget, waitFor);
    packageManifest.syntaxFileCount = sourceCheck.fileCount;
    packageManifest.syntaxCheck = "pass";
    await writeFile(join(packageRoot, "package-manifest.json"), `${JSON.stringify(packageManifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await writeFile(join(stageRoot, "package-manifest.json"), `${JSON.stringify(packageManifest, null, 2)}\n`, { flag: "w", mode: 0o600 });
    await context.writeArtifactJson("gateway-portable-package-manifest.json", packageManifest);

    const archivePath = context.pathInArtifacts("gateway-portable-linux-x64.tar.gz");
    const archive = context.spawnOwned("gateway-portable-archive", "/usr/bin/tar", ["-czf", archivePath, "-C", stageRoot, "package"], { cwd: testControllerRepoRoot });
    await waitFor(() => archive.exitCode !== null || archive.signalCode !== null, 60_000, "Gateway portable archive", 25, context.abortSignal);
    assert.equal(archive.exitCode, 0, "Gateway portable archive must be built from this RunContext stage");
    await chmod(archivePath, 0o600);
    const archiveStat = await lstat(archivePath);
    const archiveSha256 = await hashFile(archivePath);
    assert.ok(archiveStat.isFile() && !archiveStat.isSymbolicLink() && archiveStat.nlink === 1);
    const result = {
      status: "portable-package-ready",
      sourceGitHead: context.gitCommit,
      controllerGitCommit: context.gitCommit,
      releaseSourceCommit: productSourceIdentity.commit,
      releaseSourceTree: productSourceIdentity.tree,
      runtime: packageManifest.runtime,
      packageFileCount: finalFiles.length,
      packageTreeSha256: packageManifest.packageTreeSha256,
      packageManifestSha256: sha256(Buffer.from(`${JSON.stringify(packageManifest, null, 2)}\n`)),
      archive: { path: archivePath, sizeBytes: archiveStat.size, sha256: archiveSha256 },
      mobileWeb: {
        bundleFileCount: mobileInput.rows.length,
        sourceExportReceiptSha256: mobileInput.receiptSha256,
        reuseReceiptSha256: mobileReuse.receiptSha256,
        exportBuiltFromCommit: mobileInput.buildSourceCommit,
        reusedForCommit: productSourceIdentity.commit,
        sourceManifestSha256: mobileInput.manifestSha256,
        resourceFileTableSha256: mobileInput.bundleSha256,
      },
      nativeP2PAddon: dependencyStage.p2pNative.status,
      nativeSmoke,
      syntheticAttachment: { bytes: FIXTURE_SIZE_BYTES, sha256: fixturePayloadSha256, chunkBytes: 512 * 1024 },
      serveBenchRequested: serveBench,
      remoteStage: serveBench ? "awaiting-owned-host-provisioning" : "not-started",
    };
    await context.writeArtifactJson("gateway-portable-package.json", result);

    if (serveBench) {
      result.remoteStage = await runBoundedBench(context, {
        packageRoot,
        archivePath,
        packageManifest,
        packageManifestSha256: result.packageManifestSha256,
        productSourceIdentity,
        mobileReuse,
        waitFor,
      });
    }
    return result;
  });
}

async function copySourceTree(sourceRoot, targetRoot, prefix) {
  const result = [];
  await mkdir(targetRoot, { recursive: true, mode: 0o700 });
  async function visit(source, target, relativePath) {
    const info = await lstat(source);
    if (info.isSymbolicLink()) throw new Error(`portable source contains a symbolic link: ${relativePath}`);
    if (info.isDirectory()) {
      if (EXCLUDED_DIRECTORY_NAMES.has(basename(source))) return;
      await mkdir(target, { recursive: true, mode: 0o700 });
      for (const name of (await readdir(source)).sort()) {
        if (EXCLUDED_DIRECTORY_NAMES.has(name)) continue;
        await visit(join(source, name), join(target, name), `${relativePath}/${name}`);
      }
      return;
    }
    if (!info.isFile() || !SOURCE_FILE_PATTERN.test(source) || /\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(source)) return;
    result.push(await copyRegularFile(source, target, undefined, `apps/kcoder-studio/${relativePath}`));
  }
  await visit(sourceRoot, targetRoot, prefix);
  return result;
}

async function copyRegularFile(source, target, mode, relativePath) {
  const before = await lstat(source);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw new Error(`portable input is not a private regular source file: ${source}`);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await copyFile(source, target, fsConstants.COPYFILE_EXCL);
  if (mode !== undefined) await chmod(target, mode);
  const after = await lstat(source);
  const copied = await lstat(target);
  const sourceHash = await hashFile(source);
  const copiedHash = await hashFile(target);
  if (before.size !== after.size || before.ino !== after.ino || sourceHash !== copiedHash || copied.size !== after.size) {
    throw new Error(`portable source changed while staging: ${source}`);
  }
  return { path: relativePath ?? target, sourcePath: source, bytes: copied.size, sha256: copiedHash };
}

async function verifyFrozenProductSource(context, waitFor, phase = "initial") {
  const identityOutput = await captureOwnedGitOutput(context, `release-source-identity-${phase}`,
    ["rev-parse", "HEAD", "HEAD^{tree}"], waitFor);
  const [commit, tree] = identityOutput.split(/\r?\n/).filter(Boolean);
  assert.equal(commit, FROZEN_PRODUCT_SOURCE_COMMIT, "product source must use the approved frozen release commit");
  assert.equal(tree, FROZEN_PRODUCT_SOURCE_TREE, "product source Git tree must match the frozen release tree");
  const status = await captureOwnedGitOutput(context, `release-source-cleanliness-${phase}`,
    ["status", "--porcelain=v1", "--untracked-files=all"], waitFor);
  assert.equal(status, "", "frozen product source checkout must remain clean while staging");

  const identityInfo = await lstat(PRODUCT_SOURCE_IDENTITY_RECEIPT);
  if (!identityInfo.isFile() || identityInfo.isSymbolicLink() || identityInfo.nlink !== 1 || identityInfo.uid !== process.getuid() ||
      (identityInfo.mode & 0o777) !== 0o600 || await realpath(PRODUCT_SOURCE_IDENTITY_RECEIPT) !== PRODUCT_SOURCE_IDENTITY_RECEIPT) {
    throw new Error("frozen release source identity receipt must be a private owned regular file");
  }
  const identityBytes = await readFile(PRODUCT_SOURCE_IDENTITY_RECEIPT);
  const receiptSha256 = sha256(identityBytes);
  assert.equal(receiptSha256, PRODUCT_SOURCE_IDENTITY_RECEIPT_SHA256, "frozen release source identity receipt changed");
  const identity = JSON.parse(identityBytes.toString("utf8"));
  const changedPaths = ["apps/kcoder-studio/src/mobile-peer-tunnel.js", "apps/kcoder-studio/src/mobile-peer-tunnel.test.mjs"];
  const expectedFilePins = [
    { path: changedPaths[0], sha256: "1552cbd131423a5b00da6a6235bbedc34b98f13657ec07063e8cbe3c0b987642" },
    { path: changedPaths[1], sha256: "cca91137c95470bd40ffcf5742f50f58434fdf39f2bf5f650f891dddd3908c16" },
  ];
  const sharedIdentity = identity.mobileSharedSourceIdentity;
  assert.equal(identity.schemaVersion, 1);
  assert.equal(identity.status, "PASS_RELEASE_COMMIT_EXACT_TWO_PATHS_AND_EXPORT_INPUTS_UNCHANGED");
  assert.equal(identity.sourceRoot, FROZEN_PRODUCT_SOURCE_ROOT);
  assert.equal(identity.parentCommit, FROZEN_PRODUCT_SOURCE_PARENT_COMMIT);
  assert.equal(identity.commit, commit);
  assert.equal(identity.tree, tree);
  assert.equal(identity.gitStatusClean, true);
  assert.deepEqual(identity.changedPaths, changedPaths, "release source receipt must identify exactly the approved backend fix files");
  assert.deepEqual(identity.newFilePins.map(({ path, sha256 }) => ({ path, sha256 })), expectedFilePins,
    "release source receipt must pin both approved backend fix files");
  assert.equal(sharedIdentity?.sha256, MOBILE_SHARED_SOURCE_IDENTITY_SHA256);
  assert.equal(sharedIdentity?.fileCount, 808);
  assert.equal(sharedIdentity?.byteCount, 25_951_925);
  assert.equal(sharedIdentity?.matchesE8PreExportInputs, true);
  assert.equal(sharedIdentity?.gitDiffMobileAndSharedEmpty, true);
  assert.deepEqual(sharedIdentity?.rootHashes, [
    { name: "mobile", sha256: EXPECTED_MOBILE_ROOT_SOURCE_TREE_SHA256, fileCount: 725 },
    { name: "studio-shared", sha256: EXPECTED_STUDIO_SHARED_ROOT_SOURCE_TREE_SHA256, fileCount: 83 },
  ], "release source receipt Mobile/shared roots must match the official MobileWeb build inputs");

  const gitSubtrees = (await captureOwnedGitOutput(context, `release-mobile-shared-git-trees-${phase}`,
    ["rev-parse",
      `${FROZEN_PRODUCT_SOURCE_COMMIT}:apps/kcoder-studio/mobile`,
      `${FROZEN_PRODUCT_SOURCE_COMMIT}:apps/kcoder-studio/shared`,
      `${MOBILE_EXPORT_BUILD_SOURCE_COMMIT}:apps/kcoder-studio/mobile`,
      `${MOBILE_EXPORT_BUILD_SOURCE_COMMIT}:apps/kcoder-studio/shared`], waitFor))
    .split(/\r?\n/).filter(Boolean);
  assert.equal(gitSubtrees.length, 4, "Git must return current and MobileWeb-build Mobile/shared subtree identities");
  const [mobileGitTree, sharedGitTree, builtMobileGitTree, builtSharedGitTree] = gitSubtrees;
  assert.equal(mobileGitTree, EXPECTED_PRODUCT_MOBILE_GIT_TREE);
  assert.equal(sharedGitTree, EXPECTED_PRODUCT_SHARED_GIT_TREE);
  assert.equal(mobileGitTree, builtMobileGitTree, "current product Mobile tree must equal the Web export build input");
  assert.equal(sharedGitTree, builtSharedGitTree, "current product shared tree must equal the Web export build input");
  return {
    commit,
    tree,
    parentCommit: identity.parentCommit,
    receiptSha256,
    mobileSharedSourceIdentitySha256: sharedIdentity.sha256,
    mobileSharedSourceFileCount: sharedIdentity.fileCount,
    mobileSharedGitTrees: { mobile: mobileGitTree, shared: sharedGitTree },
  };
}

async function captureOwnedGitOutput(context, label, args, waitFor) {
  const child = context.spawnOwned(label, "/usr/bin/git", ["-C", FROZEN_PRODUCT_SOURCE_ROOT, ...args], {
    cwd: FROZEN_PRODUCT_SOURCE_ROOT,
  });
  let stdout = "";
  child.stdout?.on("data", chunk => { stdout += chunk.toString("utf8"); });
  await waitFor(() => child.exitCode !== null || child.signalCode !== null, 15_000,
    `frozen product source ${label}`, 25, context.abortSignal);
  assert.equal(child.exitCode, 0, "frozen product source Git verification must complete successfully");
  return stdout.trim();
}

function isPathWithin(path, root) {
  const candidate = resolve(path);
  const parent = resolve(root);
  return candidate === parent || candidate.startsWith(`${parent}${sep}`);
}

async function verifyMobileExport(root, receiptPath) {
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || await realpath(root) !== root) throw new Error("verified MobileWeb export root is not a real directory");
  const receiptStat = await lstat(receiptPath);
  if (!receiptStat.isFile() || receiptStat.isSymbolicLink() || receiptStat.nlink !== 1 || (receiptStat.mode & 0o022) !== 0 ||
      await realpath(receiptPath) !== receiptPath) throw new Error("MobileWeb export receipt is not a pinned regular file");
  const receiptBytes = await readFile(receiptPath);
  const receiptSha256 = sha256(receiptBytes);
  if (receiptSha256 !== MOBILE_EXPORT_RECEIPT_SHA256) throw new Error("official MobileWeb export receipt SHA-256 changed");
  const receipt = JSON.parse(receiptBytes.toString("utf8"));
  const source = receipt?.source;
  const exported = receipt?.export;
  if (receipt.schemaVersion !== 1 || receipt.status !== "PASS_OFFICIAL_EXPORT_MANIFEST_AND_SOURCE_IDENTITY" ||
      receipt.productionMutationPerformed !== false || !source || source.commit !== MOBILE_EXPORT_BUILD_SOURCE_COMMIT ||
      source.tree !== MOBILE_EXPORT_BUILD_SOURCE_TREE || source.sourceIdentitySha256 !== MOBILE_EXPORT_BUILD_SOURCE_IDENTITY_SHA256 ||
      source.sourceRoot !== FROZEN_PRODUCT_SOURCE_ROOT || source.sourceIdentityFileCount !== 808 || source.cleanGitStatus !== true ||
      source.sourcePostMatchesPre !== true || source.buildPostMatchesPre !== true ||
      source.sourceIdentityByteCount !== 25_951_925 ||
      source.sourcePost?.sourceTreeSha256 !== MOBILE_EXPORT_BUILD_SOURCE_IDENTITY_SHA256 || source.sourcePost?.fileCount !== 808 ||
      source.sourcePost?.byteCount !== 25_951_925 ||
      source.buildPost?.sourceTreeSha256 !== MOBILE_EXPORT_BUILD_SOURCE_IDENTITY_SHA256 || source.buildPost?.fileCount !== 808 ||
      source.buildPost?.byteCount !== 25_951_925 ||
      !exported || exported.outputRoot !== root || exported.manifestPath !== join(root, "kcoder-mobile-web.json") ||
      exported.version !== 1 || exported.baseToken !== "/__kcoder_mobile_mount_v1__" ||
      exported.bundleFileCount !== REQUIRED_MOBILE_FILES || exported.totalResourceBytes !== 23_560_619 ||
      exported.fileTableSha256 !== MOBILE_EXPORT_FILE_TABLE_SHA256 || exported.fileTableMatchesManifest !== true ||
      !Array.isArray(exported.files) || exported.files.length !== REQUIRED_MOBILE_FILES) {
    throw new Error("official MobileWeb export receipt does not match the pinned release source and 49-file export");
  }
  const manifestPath = join(root, "kcoder-mobile-web.json");
  const manifestInfo = await lstat(manifestPath);
  if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink() || manifestInfo.nlink !== 1 || (manifestInfo.mode & 0o022) !== 0 ||
      await realpath(manifestPath) !== manifestPath) throw new Error("official MobileWeb build manifest is not a regular pinned file");
  const manifestBytes = await readFile(manifestPath);
  const manifestSha256 = sha256(manifestBytes);
  if (manifestSha256 !== MOBILE_EXPORT_MANIFEST_SHA256 || exported.manifestSha256 !== manifestSha256) {
    throw new Error("official MobileWeb build manifest SHA-256 changed");
  }
  const gatewayManifest = JSON.parse(manifestBytes.toString("utf8"));
  if (gatewayManifest.version !== 1 || gatewayManifest.baseToken !== "/__kcoder_mobile_mount_v1__" ||
      !Array.isArray(gatewayManifest.files) || gatewayManifest.files.length !== REQUIRED_MOBILE_FILES) {
    throw new Error("MobileWeb build manifest does not contain the official placeholder and expected file count");
  }
  const rows = exported.files.map(row => {
    if (!row || typeof row.path !== "string" || !Number.isSafeInteger(row.size) || row.size < 0 ||
        !/^[a-f0-9]{64}$/.test(row.sha256)) throw new Error("official MobileWeb export receipt has an invalid file row");
    return { path: row.path, bytes: row.size, size: row.size, sha256: row.sha256 };
  }).sort((left, right) => left.path.localeCompare(right.path));
  const manifestRows = gatewayManifest.files.map(row => ({ path: row.path, size: row.size, sha256: row.sha256 }))
    .sort((left, right) => left.path.localeCompare(right.path));
  assert.deepEqual(rows.map(({ path, size, sha256: fileSha256 }) => ({ path, size, sha256: fileSha256 })), manifestRows,
    "official export receipt rows must match the Gateway's 49-file manifest");
  assert.equal(rows.reduce((sum, row) => sum + row.size, 0), exported.totalResourceBytes,
    "official MobileWeb resource byte total must match its file inventory");
  const resourceTableSha256 = sha256(Buffer.from(JSON.stringify(rows.map(({ path, size, sha256: fileSha256 }) =>
    ({ path, size, sha256: fileSha256 })))));
  assert.equal(resourceTableSha256, exported.fileTableSha256,
    "official MobileWeb resource file-table digest must match its pinned inventory");
  return {
    receiptSha256,
    manifestSha256,
    bundleSha256: exported.fileTableSha256,
    sourceTreeSha256: source.sourceIdentitySha256,
    buildSourceCommit: source.commit,
    buildSourceTree: source.tree,
    rows: rows.map(({ path, size, sha256: fileSha256 }) => ({ path, size, sha256: fileSha256 })),
  };
}

async function verifyMobileExportReuse(productSourceIdentity, mobileInput) {
  const receiptInfo = await lstat(MOBILE_EXPORT_REUSE_RECEIPT);
  if (!receiptInfo.isFile() || receiptInfo.isSymbolicLink() || receiptInfo.nlink !== 1 || receiptInfo.uid !== process.getuid() ||
      (receiptInfo.mode & 0o777) !== 0o600 || await realpath(MOBILE_EXPORT_REUSE_RECEIPT) !== MOBILE_EXPORT_REUSE_RECEIPT) {
    throw new Error("MobileWeb export reuse receipt must be a private owned regular file");
  }
  const receiptBytes = await readFile(MOBILE_EXPORT_REUSE_RECEIPT);
  const receiptSha256 = sha256(receiptBytes);
  assert.equal(receiptSha256, MOBILE_EXPORT_REUSE_RECEIPT_SHA256, "MobileWeb export reuse receipt changed");
  const receipt = JSON.parse(receiptBytes.toString("utf8"));
  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.status, "PASS_REUSE_OFFICIAL_MOBILE_WEB_EXPORT_INPUTS_IDENTICAL");
  assert.equal(receipt.artifactRoot, MOBILE_EXPORT_ROOT);
  assert.equal(receipt.manifestPath, join(MOBILE_EXPORT_ROOT, "kcoder-mobile-web.json"));
  assert.equal(receipt.manifestSha256, mobileInput.manifestSha256);
  assert.equal(receipt.resourceFileCount, REQUIRED_MOBILE_FILES);
  assert.equal(receipt.totalResourceBytes, 23_560_619);
  assert.equal(receipt.fileTableSha256, MOBILE_EXPORT_FILE_TABLE_SHA256);
  assert.equal(receipt.exportBuiltFromCommit, MOBILE_EXPORT_BUILD_SOURCE_COMMIT);
  assert.equal(receipt.exportBuiltFromTree, MOBILE_EXPORT_BUILD_SOURCE_TREE);
  assert.equal(receipt.exportBuiltFromMobileSharedIdentity, MOBILE_EXPORT_BUILD_SOURCE_IDENTITY_SHA256);
  assert.equal(receipt.reusedForCommit, FROZEN_PRODUCT_SOURCE_COMMIT);
  assert.equal(receipt.reusedForTree, FROZEN_PRODUCT_SOURCE_TREE);
  assert.equal(receipt.currentMobileSharedIdentity, MOBILE_SHARED_SOURCE_IDENTITY_SHA256);
  assert.equal(receipt.currentMobileSharedFileCount, 808);
  assert.equal(receipt.mobileSharedInputsIdentical, true);
  assert.equal(receipt.gitDiffMobileAndSharedEmpty, true);
  assert.equal(receipt.manifestAndPhysicalFilesPreviouslyExactAudited, true);
  assert.equal(receipt.reexportPerformed, false);
  assert.equal(receipt.previousExportReceipt, MOBILE_EXPORT_RECEIPT);
  assert.equal(receipt.previousExportReceiptSha256, mobileInput.receiptSha256);
  assert.equal(receipt.currentSourceIdentityReceipt, PRODUCT_SOURCE_IDENTITY_RECEIPT);
  assert.equal(receipt.currentSourceIdentityReceiptSha256, productSourceIdentity.receiptSha256);
  assert.equal(productSourceIdentity.commit, receipt.reusedForCommit);
  assert.equal(productSourceIdentity.tree, receipt.reusedForTree);
  assert.equal(productSourceIdentity.mobileSharedSourceIdentitySha256, receipt.currentMobileSharedIdentity);
  assert.equal(mobileInput.sourceTreeSha256, receipt.exportBuiltFromMobileSharedIdentity);
  assert.equal(mobileInput.buildSourceCommit, receipt.exportBuiltFromCommit);
  assert.equal(mobileInput.buildSourceTree, receipt.exportBuiltFromTree);
  return {
    receiptSha256,
    currentMobileSharedSourceIdentitySha256: receipt.currentMobileSharedIdentity,
    builtFromCommit: receipt.exportBuiltFromCommit,
    builtFromTree: receipt.exportBuiltFromTree,
    reusedForCommit: receipt.reusedForCommit,
    reusedForTree: receipt.reusedForTree,
  };
}

async function copyVerifiedMobileExport(sourceRoot, targetRoot, rows) {
  await mkdir(targetRoot, { recursive: true, mode: 0o700 });
  const copied = [];
  for (const row of rows) {
    if (!row || typeof row.path !== "string" || row.path.startsWith("/") || row.path.includes("\\") ||
        row.path.split("/").some(part => !part || part === "." || part === "..") ||
        !Number.isSafeInteger(row.size) || row.size < 0 || !/^[a-f0-9]{64}$/.test(row.sha256)) {
      throw new Error("MobileWeb export receipt contains an unsafe file entry");
    }
    const source = resolve(sourceRoot, row.path);
    if (!source.startsWith(sourceRoot + sep)) throw new Error("MobileWeb export entry escaped its root");
    const sourceInfo = await lstat(source);
    if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink() || sourceInfo.size !== row.size || await hashFile(source) !== row.sha256) {
      throw new Error(`MobileWeb export file failed its source SHA-256: ${row.path}`);
    }
    const target = resolve(targetRoot, row.path);
    if (!target.startsWith(targetRoot + sep)) throw new Error("MobileWeb export target escaped its package root");
    const copiedRow = await copyRegularFile(source, target, undefined, `apps/kcoder-studio/mobile/dist/${row.path}`);
    if (copiedRow.sha256 !== row.sha256 || copiedRow.bytes !== row.size) throw new Error(`MobileWeb export copy SHA-256 mismatch: ${row.path}`);
    copied.push(copiedRow);
  }
  const sourceManifest = await copyRegularFile(join(sourceRoot, "kcoder-mobile-web.json"), join(targetRoot, "kcoder-mobile-web.json"), undefined,
    "apps/kcoder-studio/mobile/dist/kcoder-mobile-web.json");
  copied.push(sourceManifest);
  return copied;
}

async function verifyStagedRuntime(studioTarget) {
  const packageFile = join(studioTarget, "package.json");
  const require = createRequire(packageFile);
  const ws = require("ws");
  assert.equal(typeof ws.WebSocket, "function");
  const ssh2 = require("ssh2");
  assert.equal(typeof ssh2.Client, "function");
  const jsonc = require("jsonc-parser");
  assert.equal(typeof jsonc.parse, "function");
  const datachannelPath = require.resolve("node-datachannel");
  const datachannel = await import(pathToFileURL(datachannelPath).href);
  assert.equal(typeof datachannel.PeerConnection, "function");
  const peer = new datachannel.PeerConnection("gateway-stage-native-smoke", { iceServers: [], maxMessageSize: 16_384 });
  peer.close();
  return { ws: true, ssh2: true, jsoncParser: true, nodeDatachannelImport: true, peerConnectionConstructClose: true };
}

async function verifyPackagedNode(context, nodePath, waitFor) {
  const child = context.spawnOwned("gateway-portable-node-version", nodePath, ["--version"], { cwd: dirname(nodePath) });
  let stdout = "";
  child.stdout?.on("data", chunk => { stdout += chunk.toString("utf8"); });
  await waitFor(() => child.exitCode !== null || child.signalCode !== null, 10_000,
    "portable Node runtime version", 25, context.abortSignal);
  assert.equal(child.exitCode, 0, "portable Node runtime must execute on the staging host");
  const version = stdout.trim();
  assert.match(version, /^v22\./, "portable Node runtime must be Node 22");
  return version;
}

async function checkStagedSyntax(context, studioTarget, waitFor) {
  const files = await listRegularFiles(studioTarget, "apps/kcoder-studio");
  const scripts = files.map(row => row.path).filter(path => /\.(?:mjs|cjs|js)$/i.test(path) && !path.includes("/node_modules/"));
  for (const relativePath of scripts) {
    const child = context.spawnOwned(`gateway-syntax-${scripts.indexOf(relativePath)}`, process.execPath,
      ["--check", join(studioTarget, relativePath.replace("apps/kcoder-studio/", ""))], { cwd: studioTarget });
    await waitFor(() => child.exitCode !== null || child.signalCode !== null, 15_000, `syntax check ${relativePath}`, 25, context.abortSignal);
    assert.equal(child.exitCode, 0, `staged JavaScript syntax failed: ${relativePath}`);
  }
  return { fileCount: scripts.length };
}

async function listRegularFiles(root, prefix, { exclude = new Set(), excludePrefixes = [] } = {}) {
  const files = [];
  async function visit(directory, relativePath) {
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name);
      const childRelative = `${relativePath}/${name}`;
      if (exclude.has(childRelative) || excludePrefixes.some(item => childRelative.startsWith(item))) continue;
      const info = await lstat(path);
      if (info.isSymbolicLink()) throw new Error(`portable package contains a symbolic link: ${childRelative}`);
      if (info.isDirectory()) await visit(path, childRelative);
      else if (info.isFile()) files.push(await hashOneFile(path, childRelative));
      else throw new Error(`portable package contains a non-regular entry: ${childRelative}`);
    }
  }
  await visit(root, prefix);
  return files;
}

function createDeterministicFixturePayload(size) {
  const bytes = Buffer.allocUnsafe(size);
  for (let index = 0; index < size; index += 1) bytes[index] = (index * 131 + Math.floor(index / 251) * 17 + 29) & 0xff;
  return bytes;
}

async function hashOneFile(path, relativePath) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`portable hash input is not a regular file: ${relativePath}`);
  return { path: relativePath, bytes: info.size, sha256: await hashFile(path) };
}

async function hashFile(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function hashFileInventory(files) {
  const hash = createHash("sha256");
  for (const row of [...files].sort((left, right) => left.path.localeCompare(right.path))) {
    hash.update(`${row.path}\0${row.bytes}\0${row.sha256}\n`);
  }
  return hash.digest("hex");
}

async function runBoundedBench(context, {
  packageRoot,
  archivePath,
  packageManifest,
  packageManifestSha256,
  productSourceIdentity,
  mobileReuse,
  waitFor,
}) {
  const runId = `peer-route-${new Date().toISOString().replaceAll(/[^0-9]/g, "").slice(0, 14)}-${randomBytes(6).toString("hex")}`;
  const remoteRoots = {};
  const hostRows = [
    { role: "lan", host: REMOTE_HOSTS.lan },
    { role: "public", host: REMOTE_HOSTS.public },
    { role: "browser", host: REMOTE_HOSTS.browser },
  ];
  for (const entry of hostRows) {
    const path = `/tmp/kcoder-e2e-${runId}-${entry.role}`;
    const receipt = await createRemoteRoot(context, entry.host, path, runId, entry.role, waitFor);
    remoteRoots[entry.role] = { ...entry, path, receipt };
    context.addCleanup(`remove owned ${entry.role} remote root`, async () => {
      const owner = remoteRoots[entry.role];
      if (owner.ownerStarted && !owner.stopVerification) {
        throw new Error(`remote ${entry.role} owner has no verified stopped receipt; preserving its RunContext root`);
      }
      await removeRemoteRoot(context, entry.host, path, receipt, runId, waitFor, owner);
    });
  }
  const h20Paths = {
    repoRoot: remoteRoots.browser.path,
    harness: join(remoteRoots.browser.path, "apps/kcoder-studio/e2e/harness"),
    private: join(remoteRoots.browser.path, "apps/kcoder-studio/e2e/private"),
    rendererNodeModules: join(remoteRoots.browser.path, "apps/kcoder-studio/renderer/node_modules"),
  };
  const rootReady = {
    status: "run-context-roots-ready",
    runId,
    sourceGitHead: context.gitCommit,
    controllerGitCommit: context.gitCommit,
    releaseSourceCommit: packageManifest.releaseSourceCommit,
    releaseSourceTree: packageManifest.releaseSourceTree,
    package: { fileCount: packageManifest.packageFileCount, packageTreeSha256: packageManifest.packageTreeSha256,
      archiveBytes: (await lstat(archivePath)).size, archiveSha256: await hashFile(archivePath) },
    remoteRoots: Object.fromEntries(Object.entries(remoteRoots).map(([role, value]) => [role, value.path])),
    h20Paths,
    localStateDir: context.stateDir,
    localPrivateConfigPath: context.pathInState("gateway-private-results.json"),
    stopFile: context.pathInState("stop-bench"),
  };
  await context.writeArtifactJson("gateway-run-context-roots.json", rootReady);
  console.log(`STAGE_ROOTS_READY ${JSON.stringify(rootReady)}`);

  for (const role of ["lan", "public"]) {
    const owner = remoteRoots[role];
    await uploadPortableArchive(context, owner, archivePath, waitFor);
  }

  const fixture = {
    threadId: randomBytes(16).toString("hex"),
    attachmentPath: "/peer-route/fixture-payload-1m.bin",
    payloadFile: "fixture-payload-1m.bin",
    size: FIXTURE_SIZE_BYTES,
    payloadSha256: packageManifest.appServerFixture.payloadSha256,
    chunkBytes: packageManifest.appServerFixture.chunkBytes,
  };
  const benchmarkBundle = await readBenchmarkBundleIdentity();
  const mobileFiles = packageManifest.mobileWeb.copiedFiles;
  const staticIdentity = {
    schemaVersion: 1,
    runId,
    sourceGitHead: context.gitCommit,
    controllerGitCommit: context.gitCommit,
    releaseSourceCommit: packageManifest.releaseSourceCommit,
    releaseSourceTree: packageManifest.releaseSourceTree,
    productSource: {
      parentCommit: productSourceIdentity.parentCommit,
      sourceIdentityReceiptSha256: productSourceIdentity.receiptSha256,
      mobileSharedSourceIdentitySha256: productSourceIdentity.mobileSharedSourceIdentitySha256,
      mobileSharedSourceFileCount: productSourceIdentity.mobileSharedSourceFileCount,
      mobileSharedGitTrees: productSourceIdentity.mobileSharedGitTrees,
    },
    mobileWebReuse: {
      receiptSha256: mobileReuse.receiptSha256,
      exportBuiltFromCommit: mobileReuse.builtFromCommit,
      exportBuiltFromTree: mobileReuse.builtFromTree,
      reusedForCommit: mobileReuse.reusedForCommit,
      reusedForTree: mobileReuse.reusedForTree,
    },
    bundle: {
      path: benchmarkBundle.path,
      sha256: benchmarkBundle.bundleSha256,
      entrySourceSha256: benchmarkBundle.entrySourceSha256,
      mobileSourceTreeSha256: benchmarkBundle.mobileAndSharedSourceTreeSha256,
      sharedSourceTreeSha256: benchmarkBundle.studioSharedRootSourceTreeSha256,
    },
    fixture: { threadId: fixture.threadId, attachmentPath: fixture.attachmentPath, size: FIXTURE_SIZE_BYTES,
      sha256: fixture.payloadSha256, chunkBytes: fixture.chunkBytes, repetitions: 3 },
    mobileWebExport: {
      sourceTreeSha256: packageManifest.mobileWeb.sourceTreeSha256,
      bundleSha256: packageManifest.mobileWeb.sourceBundleSha256,
      manifestSha256: mobileFiles.find(row => row.path.endsWith("/kcoder-mobile-web.json"))?.sha256,
      manifestFileCount: packageManifest.mobileWeb.bundleFileCount,
    },
    gatewayPackage: {
      archivePath,
      archiveSha256: await hashFile(archivePath),
      packageTreeSha256: packageManifest.packageTreeSha256,
      packageManifestSha256,
      packageFileCount: packageManifest.packageFileCount,
      archiveBytes: (await lstat(archivePath)).size,
    },
  };
  const privateResultsPath = context.pathInState("gateway-private-results.json");
  const initialPrivate = { ...staticIdentity, status: "starting-lan-gateway", lan: null, public: null,
    caTrust: null, expectedGatewayIps: { lan: ["10.31.6.5"], public: ["107.173.236.155"] },
    expectedClientIps: { lan: ["10.31.6.8"], public: ["10.31.6.23", "175.0.133.87"] } };
  await writePrivateJson(privateResultsPath, initialPrivate);

  const lanConfig = createOwnerConfig({ runId, role: "lan", root: remoteRoots.lan.path, rootReceipt: remoteRoots.lan.receipt, fixture, packageManifest,
    publicOrigin: null, registrationKey: null });
  await sendRemoteOwnerConfig(context, remoteRoots.lan, lanConfig, waitFor);
  const lanSession = startRemoteOwner(context, remoteRoots.lan, waitFor);
  remoteRoots.lan.session = lanSession.child;
  remoteRoots.lan.ownerStarted = true;
  context.addCleanup("stop owned LAN Gateway owner", () => stopRemoteOwner(context, remoteRoots.lan, waitFor));
  const lanReady = await waitRemoteReady(lanSession, waitFor, 60_000, context.abortSignal);
  remoteRoots.lan.privateReceiptPath = lanReady.privateReceiptPath;
  const lanPrivate = await copyRemotePrivateReceipt(context, remoteRoots.lan, waitFor);
  for (const secret of collectCredentialValues(lanPrivate)) context.registerSecret(secret);
  initialPrivate.lan = lanPrivate.lane;
  initialPrivate.caTrust = await persistLanCaTrust(context, lanPrivate.caTrust);
  initialPrivate.status = "lan-gateway-ready-public-gateway-starting";
  await replacePrivateJson(privateResultsPath, initialPrivate);
  console.log(`LAN_GATEWAY_READY ${JSON.stringify(lanReady.safe)}`);

  const registrationKey = await readRegistrationKey(context);
  const publicConfig = createOwnerConfig({ runId, role: "public", root: remoteRoots.public.path, fixture,
    rootReceipt: remoteRoots.public.receipt, packageManifest, publicOrigin: RELAY_ORIGIN, registrationKey });
  await sendRemoteOwnerConfig(context, remoteRoots.public, publicConfig, waitFor);
  const mem = await readRemoteMemAvailable(context, remoteRoots.public, waitFor);
  if (mem.availableBytes < MIN_PUBLIC_OWNER_MEMAVAILABLE_BYTES) {
    throw new Error(`vps_first MemAvailable ${mem.availableBytes} bytes is below the ${MIN_PUBLIC_OWNER_MEMAVAILABLE_BYTES}-byte owned Gateway startup threshold`);
  }
  const publicSession = startRemoteOwner(context, remoteRoots.public, waitFor);
  remoteRoots.public.session = publicSession.child;
  remoteRoots.public.ownerStarted = true;
  context.addCleanup("stop owned public Gateway owner", () => stopRemoteOwner(context, remoteRoots.public, waitFor));
  const publicReady = await waitRemoteReady(publicSession, waitFor, 120_000, context.abortSignal);
  remoteRoots.public.privateReceiptPath = publicReady.privateReceiptPath;
  const publicPrivate = await copyRemotePrivateReceipt(context, remoteRoots.public, waitFor);
  for (const secret of collectCredentialValues(publicPrivate)) context.registerSecret(secret);
  initialPrivate.public = publicPrivate.lane;
  initialPrivate.publicMemoryAvailableBeforeOwnerBytes = mem.availableBytes;
  initialPrivate.status = "ready";
  await replacePrivateJson(privateResultsPath, initialPrivate);
  const ready = {
    status: "gateways-ready",
    runId,
    sourceGitHead: context.gitCommit,
    controllerGitCommit: context.gitCommit,
    releaseSourceCommit: packageManifest.releaseSourceCommit,
    releaseSourceTree: packageManifest.releaseSourceTree,
    stagePackage: { sha256: staticIdentity.gatewayPackage.archiveSha256, packageTreeSha256: staticIdentity.gatewayPackage.packageTreeSha256,
      fileCount: staticIdentity.gatewayPackage.packageFileCount, bytes: staticIdentity.gatewayPackage.archiveBytes },
    lan: lanReady.safe,
    public: publicReady.safe,
    h20RepoRoot: h20Paths.repoRoot,
    localStateDir: context.stateDir,
    localPrivateConfigPath: privateResultsPath,
    controlFiles: { stop: context.pathInState("stop-bench") },
    maxRuntimeMinutes: 30,
  };
  await context.writeArtifactJson("gateway-bench-ready.json", ready);
  console.log(`BENCH_READY ${JSON.stringify(ready)}`);

  await waitFor(async () => {
    if (context.abortSignal.aborted) return true;
    try {
      const info = await lstat(context.pathInState("stop-bench"));
      return info.isFile() && !info.isSymbolicLink() ? true : null;
    } catch (error) { if (error?.code === "ENOENT") return null; throw error; }
  }, MAX_BENCH_RUNTIME_MS - 30_000, "root stopfile or bounded benchmark owner timeout", 1000, context.abortSignal)
    .catch(error => {
      if (/Timed out waiting/.test(error.message)) return false;
      throw error;
    });
  return "stopped-cleanly";
}

function createOwnerConfig({ runId, role, root, rootReceipt, fixture, packageManifest, publicOrigin, registrationKey }) {
  const gatewayAuthToken = randomBytes(32).toString("base64url");
  const workspaceId = randomBytes(12).toString("hex");
  const gatewayId = role === "lan" ? `lan-${randomBytes(8).toString("hex")}` : undefined;
  return {
    schemaVersion: 1,
    runId,
    role,
    root,
    rootReceipt,
    gatewayAuthToken,
    fixture: { ...fixture },
    packageTreeSha256: packageManifest.packageTreeSha256,
    mobileWebBundleSha256: packageManifest.mobileWeb.sourceBundleSha256,
    workspaceId,
    serverId: "peer-route-fixture",
    ...(publicOrigin ? { publicOrigin, registrationKey } : {}),
    ...(gatewayId ? { gatewayId } : {}),
    stunUrl: RELAY_STUN_URL,
  };
}

async function readRegistrationKey(context) {
  const parent = dirname(REGISTRATION_INPUT_PATH);
  const parentInfo = await lstat(parent);
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink() || (parentInfo.mode & 0o077) !== 0 ||
      typeof process.getuid === "function" && parentInfo.uid !== process.getuid() || await realpath(parent) !== parent) {
    throw new Error("Relay registration input parent must be a real owned 0700 directory");
  }
  const info = await lstat(REGISTRATION_INPUT_PATH);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (info.mode & 0o077) !== 0 ||
      typeof process.getuid === "function" && info.uid !== process.getuid() || info.size > 4096 ||
      await realpath(REGISTRATION_INPUT_PATH) !== REGISTRATION_INPUT_PATH) {
    throw new Error("Relay registration input must be an owned regular 0600 file");
  }
  const parsed = JSON.parse(await readFile(REGISTRATION_INPUT_PATH, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.keys(parsed).length !== 1 ||
      typeof parsed.registrationKey !== "string" || !/^[A-Za-z0-9._~-]{32,512}$/.test(parsed.registrationKey)) {
    throw new Error("Relay registration input schema or credential shape is invalid");
  }
  context.registerSecret(parsed.registrationKey);
  return parsed.registrationKey;
}

async function createRemoteRoot(context, host, root, runId, role, waitFor) {
  const rootCode = [
    "import json,os,stat,sys",
    "p,run_id,role=sys.argv[1:4]",
    "if not p.startswith('/tmp/kcoder-e2e-peer-route-') or os.path.dirname(p)!='/tmp': raise SystemExit(20)",
    "os.mkdir(p,0o700)",
    "os.chmod(p,0o700)",
    "private=os.path.join(p,'private'); os.mkdir(private,0o700); os.chmod(private,0o700)",
    "if role=='browser':",
    "  for d in ['apps','apps/kcoder-studio','apps/kcoder-studio/e2e','apps/kcoder-studio/e2e/harness','apps/kcoder-studio/e2e/private','apps/kcoder-studio/renderer','apps/kcoder-studio/renderer/node_modules']:",
    "    q=os.path.join(p,d); os.makedirs(q,mode=0o700,exist_ok=True); os.chmod(q,0o700)",
    "s=os.lstat(p)",
    "print(json.dumps({'root':p,'runId':run_id,'role':role,'uid':s.st_uid,'dev':s.st_dev,'ino':s.st_ino,'mode':format(stat.S_IMODE(s.st_mode),'04o')},separators=(',',':')))"
  ].join("\n");
  const output = await runSshCommand(context, `create-${role}-root`, host,
    `python3 -c ${shellQuote(rootCode)} ${shellQuote(root)} ${shellQuote(runId)} ${shellQuote(role)}`,
    { timeoutMs: 30_000, waitFor });
  const receipt = parseJsonLine(output.stdout, `remote ${role} root receipt`);
  assert.equal(receipt.runId, runId);
  assert.equal(receipt.role, role);
  assert.equal(receipt.root, root);
  assert.equal(receipt.mode, "0700");
  return receipt;
}

async function removeRemoteRoot(context, host, root, receipt, runId, waitFor, owner) {
  if (["lan", "public"].includes(receipt.role) && owner?.ownerStarted && !owner.stopVerification) {
    throw new Error(`remote ${receipt.role} root cannot be removed without a verified owner stop receipt`);
  }
  const removeCode = [
    "import os,shutil,stat,sys",
    "p,run_id,role,dev,ino,uid=sys.argv[1:7]",
    "if os.path.dirname(p)!='/tmp' or not p.startswith('/tmp/kcoder-e2e-peer-route-'): raise SystemExit(20)",
    "s=os.lstat(p)",
    "if not stat.S_ISDIR(s.st_mode) or stat.S_ISLNK(s.st_mode) or (s.st_dev,s.st_ino,str(s.st_uid))!=(int(dev),int(ino),uid) or s.st_uid!=os.geteuid() or stat.S_IMODE(s.st_mode)!=0o700: raise SystemExit(21)",
    "if role in ('lan','public'):",
    "  import json,signal",
    "  private=os.path.join(p,'private')",
    "  ps=os.lstat(private)",
    "  if not stat.S_ISDIR(ps.st_mode) or stat.S_ISLNK(ps.st_mode) or ps.st_uid!=os.geteuid() or stat.S_IMODE(ps.st_mode)!=0o700: raise SystemExit(22)",
    "  status_path=os.path.join(private,'owner-status.json')",
    "  fd=os.open(status_path,os.O_RDONLY|os.O_NOFOLLOW)",
    "  fs=os.fstat(fd)",
    "  if not stat.S_ISREG(fs.st_mode) or fs.st_nlink!=1 or fs.st_uid!=os.geteuid() or stat.S_IMODE(fs.st_mode)!=0o600: raise SystemExit(23)",
    "  with os.fdopen(fd,'r',encoding='utf8') as f: status=json.load(f)",
    "  if status.get('schemaVersion')!=1 or status.get('status') not in ('stopped','failed') or status.get('runId')!=run_id or status.get('role')!=role or status.get('root')!=p or status.get('rootDev')!=str(s.st_dev) or status.get('rootIno')!=str(s.st_ino) or status.get('allOwnedProcessGroupsGone') is not True: raise SystemExit(24)",
    "  groups=status.get('ownedProcessGroups')",
    "  if not isinstance(groups,list) or any(not isinstance(g,dict) or not isinstance(g.get('pgid'),int) or g.get('alive') is not False for g in groups): raise SystemExit(25)",
    "  for g in groups:",
    "    try: os.killpg(g['pgid'],0)",
    "    except ProcessLookupError: continue",
    "    except PermissionError: raise SystemExit(26)",
    "    raise SystemExit(27)",
    "  owner=status.get('owner')",
    "  if not isinstance(owner,dict) or not isinstance(owner.get('pid'),int) or not isinstance(owner.get('startTicks'),int): raise SystemExit(28)",
    "  try:",
    "    raw=open('/proc/%d/stat'%owner['pid'],encoding='utf8').read(); fields=raw[raw.rfind(')')+2:].split()",
    "    if int(fields[19])==owner['startTicks']: raise SystemExit(29)",
    "  except FileNotFoundError: pass",
    "shutil.rmtree(p)"
  ].join("\n");
  await runSshCommand(context, `remove-${receipt.role}-root`, host,
    `python3 -c ${shellQuote(removeCode)} ${shellQuote(root)} ${shellQuote(runId)} ${shellQuote(receipt.role)} ${shellQuote(receipt.dev)} ${shellQuote(receipt.ino)} ${shellQuote(receipt.uid)}`,
    { timeoutMs: 30_000, waitFor });
}

async function uploadPortableArchive(context, owner, archivePath, waitFor) {
  const command = `/usr/bin/tar -xzf - -C ${shellQuote(owner.path)} --no-same-owner --no-same-permissions`;
  const child = spawnSsh(context, `upload-${owner.role}-portable-gateway`, owner.host, command, "pipe");
  try {
    await pipeline(createReadStream(archivePath), child.stdin);
    await waitChildExit(child, waitFor, `upload portable Gateway to ${owner.role}`, 180_000, context.abortSignal);
    assert.equal(child.exitCode, 0, `portable Gateway upload to ${owner.role} must succeed`);
  } catch (error) {
    await context.stopOwned(`upload-${owner.role}-portable-gateway`).catch(() => {});
    throw error;
  }
}

async function sendRemoteOwnerConfig(context, owner, config, waitFor) {
  for (const value of collectCredentialValues(config)) context.registerSecret(value);
  const bytes = Buffer.from(`${JSON.stringify(config)}\n`);
  const path = `${owner.path}/private/owner-config.json`;
  const command = `python3 -c ${shellQuote(WRITE_PRIVATE_FILE)} ${shellQuote(path)}`;
  const child = spawnSsh(context, `write-${owner.role}-private-config`, owner.host, command, "pipe");
  try {
    child.stdin.end(bytes);
    await waitChildExit(child, waitFor, `write ${owner.role} private config`, 30_000, context.abortSignal);
    assert.equal(child.exitCode, 0, `private ${owner.role} config write must succeed`);
  } catch (error) {
    await context.stopOwned(`write-${owner.role}-private-config`).catch(() => {});
    throw error;
  }
}

function startRemoteOwner(context, owner, _waitFor) {
  const script = `${owner.path}/package/apps/kcoder-studio/e2e/private/mobile-peer-route-gateway-stage.once.mjs`;
  const node = `${owner.path}/package/runtime/node`;
  const command = `cd ${shellQuote(`${owner.path}/package`)} && exec ${shellQuote(node)} --max-old-space-size=64 ${shellQuote(script)} --remote-owner ${shellQuote(owner.path)}`;
  const child = spawnSsh(context, `remote-${owner.role}-gateway-owner`, owner.host, command, "ignore");
  let stdout = "";
  child.stdout?.on("data", chunk => { stdout += chunk.toString("utf8"); });
  return { child, get stdout() { return stdout; } };
}

async function waitRemoteReady(session, waitFor, timeoutMs, signal) {
  const ready = await waitFor(() => {
    for (const line of session.stdout.split(/\r?\n/)) {
      if (!line.startsWith("REMOTE_GATEWAY_READY ")) continue;
      const receipt = parseJsonLine(line.slice("REMOTE_GATEWAY_READY ".length), "remote Gateway readiness receipt");
      if (receipt.safe && typeof receipt.safe === "object") return receipt;
      const { privateReceiptPath, ...safe } = receipt;
      return { safe, privateReceiptPath };
    }
    if (session.child.exitCode !== null || session.child.signalCode !== null) {
      throw new Error(`remote Gateway owner exited before readiness (exit ${session.child.exitCode ?? "signal"})`);
    }
    return null;
  }, timeoutMs, "remote Gateway owner readiness", 100, signal);
  return ready;
}

async function stopRemoteOwner(context, owner, waitFor) {
  if (!owner?.ownerStarted) return;
  if (owner.stopVerification) return owner.stopVerification;
  const stopCode = [
    "import json,os,stat,sys,time",
    "p,run_id,role,dev,ino,uid=sys.argv[1:7]",
    "root=os.lstat(p)",
    "if not stat.S_ISDIR(root.st_mode) or stat.S_ISLNK(root.st_mode) or (root.st_dev,root.st_ino,str(root.st_uid))!=(int(dev),int(ino),uid) or root.st_uid!=os.geteuid() or stat.S_IMODE(root.st_mode)!=0o700: raise SystemExit(21)",
    "private=os.path.join(p,'private'); ps=os.lstat(private)",
    "if not stat.S_ISDIR(ps.st_mode) or stat.S_ISLNK(ps.st_mode) or ps.st_uid!=os.geteuid() or stat.S_IMODE(ps.st_mode)!=0o700: raise SystemExit(22)",
    "def read_private(name):",
    "  fd=os.open(os.path.join(private,name),os.O_RDONLY|os.O_NOFOLLOW)",
    "  s=os.fstat(fd)",
    "  if not stat.S_ISREG(s.st_mode) or s.st_nlink!=1 or s.st_uid!=os.geteuid() or stat.S_IMODE(s.st_mode)!=0o600: os.close(fd); raise SystemExit(23)",
    "  with os.fdopen(fd,'r',encoding='utf8') as f: return json.load(f)",
    "cfg=read_private('owner-config.json')",
    "lease=read_private('owner-running.json')",
    "if cfg.get('runId')!=run_id or cfg.get('role')!=role or cfg.get('root')!=p or str(cfg.get('rootReceipt',{}).get('dev'))!=dev or str(cfg.get('rootReceipt',{}).get('ino'))!=ino or str(cfg.get('rootReceipt',{}).get('uid'))!=uid: raise SystemExit(24)",
    "if lease.get('schemaVersion')!=1 or lease.get('runId')!=run_id or lease.get('role')!=role or lease.get('root')!=p or lease.get('rootDev')!=dev or lease.get('rootIno')!=ino or lease.get('process',{}).get('pid')!=lease.get('process',{}).get('pgid') or lease.get('process',{}).get('pid')!=lease.get('process',{}).get('sid'): raise SystemExit(25)",
    "stop_path=os.path.join(p,'stop')",
    "try:",
    "  fd=os.open(stop_path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600); os.write(fd,run_id.encode()); os.fsync(fd); os.close(fd)",
    "except FileExistsError:",
    "  fd=os.open(stop_path,os.O_RDONLY|os.O_NOFOLLOW); ss=os.fstat(fd)",
    "  if not stat.S_ISREG(ss.st_mode) or ss.st_nlink!=1 or ss.st_uid!=os.geteuid() or stat.S_IMODE(ss.st_mode)!=0o600: os.close(fd); raise SystemExit(26)",
    "  with os.fdopen(fd,'rb') as f: existing=f.read(256)",
    "  if existing!=run_id.encode(): raise SystemExit(27)",
    "deadline=time.monotonic()+100",
    "while time.monotonic()<deadline:",
    "  try: status=read_private('owner-status.json')",
    "  except FileNotFoundError: time.sleep(0.25); continue",
    "  if status.get('schemaVersion')!=1 or status.get('status') not in ('stopped','failed') or status.get('runId')!=run_id or status.get('role')!=role or status.get('root')!=p or status.get('rootDev')!=dev or status.get('rootIno')!=ino or status.get('owner')!=lease.get('process') or status.get('allOwnedProcessGroupsGone') is not True: time.sleep(0.25); continue",
    "  groups=status.get('ownedProcessGroups')",
    "  if not isinstance(groups,list) or any(not isinstance(g,dict) or not isinstance(g.get('pgid'),int) or g.get('alive') is not False for g in groups): time.sleep(0.25); continue",
    "  groups_alive=False",
    "  for g in groups:",
    "    try: os.killpg(g['pgid'],0); groups_alive=True; break",
    "    except ProcessLookupError: pass",
    "    except PermissionError: groups_alive=True; break",
    "  proc=lease['process']; owner_alive=False",
    "  try:",
    "    raw=open('/proc/%d/stat'%proc['pid'],encoding='utf8').read(); fields=raw[raw.rfind(')')+2:].split()",
    "    owner_alive=int(fields[19])==proc['startTicks'] and int(fields[2])==proc['pgid'] and int(fields[3])==proc['sid'] and fields[0]!='Z'",
    "  except FileNotFoundError: pass",
    "  if not groups_alive and not owner_alive:",
    "    print(json.dumps({'status':'owner-stopped','ownerStatus':status['status'],'runId':run_id,'role':role,'root':p,'rootDev':dev,'rootIno':ino,'ownerPid':proc['pid'],'ownerStartTicks':proc['startTicks'],'ownedProcessGroups':[g['pgid'] for g in groups],'allOwnedProcessGroupsGone':True},separators=(',',':'))); raise SystemExit(0)",
    "  time.sleep(0.25)",
    "raise SystemExit(28)"
  ].join("\n");
  const command = "python3 -c " + shellQuote(stopCode) + " " + [
    owner.path, owner.receipt.runId, owner.role, owner.receipt.dev, owner.receipt.ino, owner.receipt.uid,
  ].map(shellQuote).join(" ");
  const verification = await runSshCommand(context, "signal-" + owner.role + "-owner-stop-and-verify", owner.host,
    command, { timeoutMs: 115_000, waitFor });
  const receipt = parseJsonLine(verification.stdout, "remote " + owner.role + " owner stop receipt");
  assert.equal(receipt.status, "owner-stopped");
  assert.equal(receipt.runId, owner.receipt.runId);
  assert.equal(receipt.role, owner.role);
  assert.equal(receipt.root, owner.path);
  assert.equal(receipt.rootDev, String(owner.receipt.dev));
  assert.equal(receipt.rootIno, String(owner.receipt.ino));
  assert.equal(receipt.allOwnedProcessGroupsGone, true);
  owner.stopVerification = receipt;
  await context.writeArtifactJsonInternal(owner.role + "-remote-owner-stop-receipt.json", receipt);
  const child = owner.session;
  if (child && child.exitCode === null && child.signalCode === null) {
    await waitChildExit(child, waitFor, "remote " + owner.role + " owner SSH channel close", 15_000,
      context.finishing ? undefined : context.abortSignal);
  }
  return receipt;
}

async function runSshCommand(context, label, host, remoteCommand, { timeoutMs = 30_000, waitFor } = {}) {
  const child = spawnSsh(context, label, host, remoteCommand, "ignore");
  let stdout = "";
  child.stdout?.on("data", chunk => { stdout += chunk.toString("utf8"); });
  await waitChildExit(child, waitFor, label, timeoutMs, context.finishing ? undefined : context.abortSignal);
  if (child.exitCode !== 0) throw new Error(`SSH operation failed: ${label}`);
  return { stdout };
}

function spawnSsh(context, label, host, remoteCommand, stdin) {
  const home = process.env.HOME || "/home/hyf";
  const spawnOwned = context.finishing ? context.spawnCleanupOwned.bind(context) : context.spawnOwned.bind(context);
  return spawnOwned(label, "/usr/bin/ssh", ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", host, remoteCommand], {
    cwd: process.cwd(), stdin,
    env: isolatedEnvironment({}, ["SSH_AUTH_SOCK"], { HOME: home, USERPROFILE: home }),
  });
}

async function copyRemotePrivateReceipt(context, owner, waitFor) {
  const destination = context.pathInState("private-receipts", `${owner.role}.json`);
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const placeholder = await open(destination, "wx", 0o600);
  await placeholder.close();
  const source = `${owner.host}:${owner.privateReceiptPath}`;
  const child = context.spawnOwned(`copy-${owner.role}-private-receipt`, "/usr/bin/scp",
    ["-q", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", source, destination], {
      cwd: process.cwd(),
      env: context.isolatedEnvironment({}, ["SSH_AUTH_SOCK"], {
        HOME: process.env.HOME || "/home/hyf", USERPROFILE: process.env.HOME || "/home/hyf",
      }),
    });
  await waitChildExit(child, waitFor, `private ${owner.role} receipt transfer`, 30_000, context.abortSignal);
  assert.equal(child.exitCode, 0, `private ${owner.role} receipt must transfer through scp`);
  await chmod(destination, 0o600);
  const info = await lstat(destination);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (info.mode & 0o077) !== 0 ||
      typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new Error(`private ${owner.role} receipt failed local ownership or mode validation`);
  }
  return JSON.parse(await readFile(destination, "utf8"));
}

async function waitChildExit(child, waitFor, label, timeoutMs, signal) {
  await waitFor(() => child.exitCode !== null || child.signalCode !== null, timeoutMs, label, 50, signal);
}

function parseJsonLine(text, label) {
  let value;
  try { value = JSON.parse(String(text).trim()); }
  catch { throw new Error(`${label} was not valid JSON`); }
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value;
}

async function writePrivateJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const handle = await open(path, "wx", 0o600);
  try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync(); }
  finally { await handle.close(); }
}

async function replacePrivateJson(path, value) {
  const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync(); }
  finally { await handle.close(); }
  await rename(temporary, path);
}

function collectCredentialValues(value) {
  const found = [];
  const visit = (current, key = "") => {
    if (typeof current === "string" && /(?:authToken|pairingToken|registrationKey|secret|credential)$/i.test(key) &&
        current.length >= 32 && /^[A-Za-z0-9._~-]+$/.test(current)) found.push(current);
    else if (current && typeof current === "object") {
      for (const [childKey, child] of Object.entries(current)) visit(child, childKey);
    }
  };
  visit(value);
  return found;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

async function runRemoteOwner(args) {
  const root = args[0];
  if (args.length !== 1 || typeof root !== "string" || !/^\/tmp\/kcoder-e2e-peer-route-[a-z0-9-]+-(?:lan|public)$/.test(root)) {
    throw new Error("remote owner requires one exact run-owned Gateway root");
  }
  const { RunContext, waitFor } = await import("../harness/run-context.mjs");
  const { startGateway } = await import("../harness/gateway.mjs");
  const { createLanRouteTlsMaterial, startLanRouteHttpsFront } = await import("./mobile-route-lan-https-front.mjs");
  const config = await readRemoteOwnerConfig(root);
  const rootInfo = await verifyRemoteRoot(root, config.rootReceipt);
  const context = await RunContext.create(import.meta.url, {
    testId: `mobile-peer-route-${config.role}-gateway-owner`,
    tier: "manual-live",
    modelPolicy: "current-source Gateway with synthetic transport fixture; no model provider, Rust inference or browser on remote host",
    retainSuccessEvidence: true,
    retainSuccessLogs: true,
    cleanupTimeoutMs: 30_000,
    processSignalTimeoutMs: 5_000,
  });
  const ownerProcess = await readCurrentLinuxProcessIdentity();
  const ownerLease = {
    schemaVersion: 1,
    runId: config.runId,
    role: config.role,
    root,
    rootDev: rootInfo.dev,
    rootIno: rootInfo.ino,
    process: ownerProcess,
  };
  await writeJson0600(join(root, "private/owner-running.json"), ownerLease);
  for (const secret of collectCredentialValues(config)) context.registerSecret(secret);
  const controller = new AbortController();
  context.abortSignal = controller.signal;
  let signalReceived = false;
  const onSignal = () => { signalReceived = true; if (!controller.signal.aborted) controller.abort(new Error("remote owner received stop signal")); };
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);
  let readyReceipt;
  let failure;
  try {
    const stagedPackage = join(root, "package");
    const stagedManifest = JSON.parse(await readFile(join(stagedPackage, "package-manifest.json"), "utf8"));
    assert.equal(config.fixture.attachmentPath, stagedManifest.appServerFixture.attachmentPath,
      "remote fixture route must match the staged package manifest");
    assert.equal(config.fixture.payloadFile, stagedManifest.appServerFixture.payloadFile,
      "remote fixture file must match the staged package manifest");
    assert.equal(config.fixture.size, stagedManifest.appServerFixture.payloadBytes,
      "remote synthetic payload size must match the staged package manifest");
    assert.equal(config.fixture.payloadSha256, stagedManifest.appServerFixture.payloadSha256,
      "remote synthetic payload SHA-256 must match the staged package manifest");
    assert.equal(config.fixture.chunkBytes, stagedManifest.appServerFixture.chunkBytes,
      "remote fixture chunk size must match the staged package manifest");
    const stagedHashRows = await listRegularFiles(stagedPackage, "package", {
      exclude: new Set(["package/package-manifest.json"]),
      excludePrefixes: ["package/target/"],
    });
    const normalizedHashRows = stagedHashRows.map(row => {
      assert.ok(row.path.startsWith("package/"), "remote package inventory paths must stay beneath package/");
      return { ...row, path: row.path.slice("package/".length) };
    });
    const actualTreeHash = hashFileInventory(normalizedHashRows);
    assert.equal(actualTreeHash, config.packageTreeSha256, "remote staged Gateway package tree hash must match RunContext source receipt");
    const studioRoot = join(stagedPackage, "apps/kcoder-studio");
    const state = {
      workspace: context.pathInState("workspace"),
      gatewayConfig: context.pathInState("gateway-config"),
      serversStore: context.pathInState("gateway-data/servers.json"),
      serversFile: context.pathInState("servers.json"),
      relayIdentity: context.pathInState("relay/client-identity.json"),
      fixtureDirectory: context.pathInState("fixture"),
      fixtureLauncher: context.pathInState("fixture-launcher"),
    };
    await Promise.all([state.workspace, state.gatewayConfig, dirname(state.serversStore), dirname(state.relayIdentity), state.fixtureDirectory]
      .map(path => mkdir(path, { recursive: true, mode: 0o700 })));
    state.fixtureConfig = join(state.fixtureDirectory, "fixture-config.json");
    state.fixturePayload = join(state.fixtureDirectory, config.fixture.payloadFile);
    await copyFile(join(studioRoot, "e2e/private", config.fixture.payloadFile), state.fixturePayload);
    await chmod(state.fixturePayload, 0o600);
    const copiedPayloadInfo = await lstat(state.fixturePayload);
    assert.ok(copiedPayloadInfo.isFile() && !copiedPayloadInfo.isSymbolicLink() && copiedPayloadInfo.nlink === 1 &&
      copiedPayloadInfo.size === config.fixture.size, "RunContext-owned fixture payload must be a single 0600 regular file of the pinned size");
    assert.equal(await hashFile(state.fixturePayload), config.fixture.payloadSha256,
      "RunContext-owned fixture payload SHA-256 must match the staged package pin");
    const fixtureConfig = {
      threadId: config.fixture.threadId,
      attachmentPath: config.fixture.attachmentPath,
      payloadFile: config.fixture.payloadFile,
      payloadSha256: config.fixture.payloadSha256,
      chunkBytes: config.fixture.chunkBytes,
    };
    await writeJson0600(state.fixtureConfig, fixtureConfig);
    const fixtureScript = join(studioRoot, "e2e/private/mobile-peer-route-rpc-fixture.once.mjs");
    const nodePath = join(stagedPackage, "runtime/node");
    const launcher = `#!/bin/sh\nNODE_OPTIONS=--max-old-space-size=48 exec ${shellQuote(nodePath)} ${shellQuote(fixtureScript)} "$@"\n`;
    await writeFile(state.fixtureLauncher, launcher, { flag: "wx", mode: 0o700 });
    await chmod(state.fixtureLauncher, 0o700);
    const serverEntry = [{ id: config.serverId, label: "Synthetic peer route fixture", runtime: "kcoder", transport: "local",
      command: state.fixtureLauncher, workspace: state.workspace }];
    await writeJson0600(state.serversFile, serverEntry);

    let lanMaterial;
    let lanFront;
    let gatewayOrigin;
    let tlsOrigin;
    let relayClient;
    let relayGatewayId = config.gatewayId;
    let gateway;
    const gatewayLabel = `${config.role}-current-source-gateway`;
    const publicOrigin = config.role === "public" ? config.publicOrigin : null;
    if (config.role === "lan") {
      lanMaterial = await createLanRouteTlsMaterial(context);
      lanFront = await startLanRouteHttpsFront(context, { material: lanMaterial, listenPort: 0, label: "lan-route-https-front" });
      tlsOrigin = lanFront.origin;
      gatewayOrigin = tlsOrigin;
    } else {
      gatewayOrigin = publicOrigin;
    }

    const startConfiguredGateway = async ({ port = 0, advertisedPublicUrl, label = gatewayLabel } = {}) => {
      const env = {
        KCODER_CONFIG_DIR: state.gatewayConfig,
        XDG_CONFIG_HOME: state.gatewayConfig,
        KCODER_STUDIO_WEB_ROOT: join(studioRoot, "renderer/dist"),
        KCODER_STUDIO_MOBILE_WEB_ROOT: join(studioRoot, "mobile/dist"),
        KCODER_STUDIO_SERVERS_STORE: state.serversStore,
        KCODER_STUDIO_MOBILE_WEB_ORIGINS: gatewayOrigin,
        KCODER_STUDIO_PUBLIC_ORIGINS: gatewayOrigin,
        KCODER_STUDIO_LAN_ACCESS_URLS: config.role === "lan" ? gatewayOrigin : undefined,
        KCODER_STUDIO_PUBLIC_ACCESS_URL: advertisedPublicUrl || gatewayOrigin,
        KCODER_STUDIO_P2P: config.role === "public" ? "1" : "0",
        KCODER_STUDIO_P2P_STUN_URLS: config.role === "public" ? config.stunUrl : undefined,
        KCODER_E2E_PEER_FIXTURE_CONFIG: state.fixtureConfig,
        NODE_OPTIONS: "--max-old-space-size=96",
      };
      const started = await startGateway(context, {
        label,
        host: "127.0.0.1",
        port,
        gatewayRoot: studioRoot,
        cwd: studioRoot,
        workspace: state.workspace,
        serversFile: state.serversFile,
        serversStore: state.serversStore,
        authToken: config.gatewayAuthToken,
        allowedHosts: config.role === "lan"
          ? `127.0.0.1,localhost,::1,10.31.6.5,${new URL(gatewayOrigin).host}`
          : `127.0.0.1,localhost,::1,${new URL(publicOrigin).host}`,
        env,
        passEnv: [],
        startTimeoutMs: 30_000,
      });
      if (lanFront && !lanFront.upstreamPort) lanFront.setUpstream(started.port);
      return started;
    };

    if (config.role === "lan") {
      gateway = await startConfiguredGateway({ advertisedPublicUrl: tlsOrigin, label: gatewayLabel });
      const routes = await getAdminPairing(context, gateway, config.gatewayAuthToken);
      await verifyMobileStaticReady(gateway);
      context.addCleanup("revoke bench Mobile devices on LAN Gateway", () => revokeBenchmarkDevices(context, gateway, config.gatewayAuthToken));
      readyReceipt = await createReadyReceipt({ root, rootInfo, config, gateway, gatewayOrigin, tlsOrigin,
        pairing: routes.pairing, routes: routes.connectionRoutes, caMaterial: lanMaterial, publicOrigin: null,
        relayGatewayId: null, stagedManifest, context });
    } else {
      gateway = await startConfiguredGateway({ advertisedPublicUrl: `${publicOrigin}/g/pending`, label: "public-gateway-bootstrap" });
      const pairingInfo = await getAdminPairing(context, gateway, config.gatewayAuthToken);
      const registrationKey = config.registrationKey;
      if (registrationKey) context.registerSecret(registrationKey);
      const relayClientModule = await import(pathToFileURL(join(studioRoot, "relay-client/src/client.mjs")).href);
      const identityModule = await import(pathToFileURL(join(studioRoot, "relay-client/src/client-identity.mjs")).href);
      let online = false;
      const onlineTimeoutMs = 30_000;
      relayClient = await relayClientModule.startRegisteredClient({
        url: publicOrigin,
        registrationKey,
        // The Relay mount proof is checked by createMobileWebStatic with the
        // Gateway auth token. The derived Mobile pairing token remains the
        // browser's pairing credential and must not become Relay identity.
        pairingToken: config.gatewayAuthToken,
        identityFile: state.relayIdentity,
        gateway: gateway.baseUrl,
        retryMs: 250,
        onOnline: () => { online = true; },
        onDiagnostic: record => {
          if (record.event === "control_open") online = true;
          if (record.event === "control_close" || record.event === "client_stopped") online = false;
        },
      });
      context.addCleanup("close registered public Relay Gateway client", () => relayClient.close());
      await waitFor(() => online ? true : null, onlineTimeoutMs, "registered public Gateway Relay control channel", 50, context.abortSignal);
      const identity = await identityModule.readRegisteredClientIdentity({ identityFile: state.relayIdentity,
        relayUrl: publicOrigin, pairingToken: config.gatewayAuthToken });
      context.registerSecret(identity.secret);
      relayGatewayId = identity.id;
      context.registerSecret(pairingInfo.pairing.token);
      const port = gateway.port;
      await context.stopOwned("public-gateway-bootstrap");
      gateway = await startConfiguredGateway({ port, advertisedPublicUrl: `${publicOrigin}/g/${relayGatewayId}`, label: "public-gateway-final" });
      const verifiedPairing = await getAdminPairing(context, gateway, config.gatewayAuthToken);
      const verifiedRoutes = verifiedPairing.connectionRoutes;
      assert.ok(verifiedRoutes.endpoints.some(endpoint => endpoint.kind === "public" && endpoint.url === `${publicOrigin}/g/${relayGatewayId}`),
        "registered public Gateway must advertise its official Relay route");
      await verifyMobileStaticReady(gateway);
      context.addCleanup("revoke bench Mobile devices on public Gateway", () => revokeBenchmarkDevices(context, gateway, config.gatewayAuthToken));
      readyReceipt = await createReadyReceipt({ root, rootInfo, config, gateway, gatewayOrigin,
        tlsOrigin: null, pairing: verifiedPairing.pairing, routes: verifiedRoutes, caMaterial: null,
        publicOrigin, relayGatewayId, stagedManifest, context });
    }
    await writeRemoteOwnerReceipt(root, readyReceipt, context);
    process.stdout.write(`REMOTE_GATEWAY_READY ${JSON.stringify({
      ...readyReceipt.safe,
      privateReceiptPath: join(root, "private/ready.json"),
    })}\n`);
    await waitFor(async () => {
      if (signalReceived || context.abortSignal.aborted) return true;
      if (await existsRegularFile(join(root, "stop"))) return true;
      return null;
    }, MAX_BENCH_RUNTIME_MS - 10_000, "remote stop file or 30-minute owner deadline", 500, context.abortSignal)
      .catch(error => { if (/Timed out waiting/.test(error.message)) return null; throw error; });
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
    process.stderr.write(`REMOTE_OWNER_FAILED ${context.redactText(error instanceof Error ? error.message : String(error)).slice(0, 300)}\n`);
  } finally {
    try {
      await context.finish(failure ? "failed" : "passed", readyReceipt?.safe ?? null, failure);
    } catch (cleanupError) {
      failure ??= cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError));
      process.stderr.write(`REMOTE_OWNER_FINISH_FAILED ${context.redactText(failure.message).slice(0, 250)}\n`);
    }
    await writeRemoteOwnerStatus(root, failure ? "failed" : "stopped", context, ownerLease).catch(() => {});
    process.removeListener("SIGTERM", onSignal);
    process.removeListener("SIGINT", onSignal);
  }
  if (failure) process.exitCode = 1;
}

async function readCurrentLinuxProcessIdentity() {
  if (process.platform !== "linux") throw new Error("remote Gateway owner lifecycle receipt requires Linux /proc identity");
  const raw = await readFile(`/proc/${process.pid}/stat`, "utf8");
  const fields = raw.slice(raw.lastIndexOf(")") + 2).trim().split(/\s+/);
  const identity = {
    pid: process.pid,
    pgid: Number(fields[2]),
    sid: Number(fields[3]),
    startTicks: Number(fields[19]),
    uid: process.getuid(),
  };
  if (!Number.isSafeInteger(identity.pgid) || identity.pgid !== identity.pid ||
      !Number.isSafeInteger(identity.sid) || identity.sid !== identity.pid ||
      !Number.isSafeInteger(identity.startTicks) || identity.startTicks <= 0) {
    throw new Error("remote Gateway owner process identity is not isolated in its own process group");
  }
  return identity;
}

async function readBenchmarkBundleIdentity() {
  const [bundleInfo, pinsInfo] = await Promise.all([lstat(BENCHMARK_BUNDLE_PATH), lstat(BENCHMARK_BUNDLE_PINS_PATH)]);
  for (const [path, info] of [[BENCHMARK_BUNDLE_PATH, bundleInfo], [BENCHMARK_BUNDLE_PINS_PATH, pinsInfo]]) {
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== process.getuid() ||
        (info.mode & 0o777) !== 0o600 || await realpath(path) !== path) {
      throw new Error("browser benchmark bundle input must be a pinned regular source artifact");
    }
  }
  const pinsBytes = await readFile(BENCHMARK_BUNDLE_PINS_PATH);
  const pinsSha256 = sha256(pinsBytes);
  const pins = JSON.parse(pinsBytes.toString("utf8"));
  const actual = await hashFile(BENCHMARK_BUNDLE_PATH);
  if (pins.schemaVersion !== 1 || pins.bundleFile !== basename(BENCHMARK_BUNDLE_PATH) ||
      pins.evidenceClass !== "test-harness browser bundle; no browser or network execution" ||
      pins.testHarnessRoot !== "/data1/hyf/20260822_agent/Kunlun-Code-CYX" ||
      pins.bundleBytes !== bundleInfo.size || pins.bundleSha256 !== actual || actual !== BENCHMARK_BUNDLE_SHA256 ||
      pins.entrySourceFile !== "/data1/hyf/20260822_agent/Kunlun-Code-CYX/apps/kcoder-studio/e2e/private/mobile-peer-route-benchmark.browser.ts" ||
      pins.entrySourceSha256 !== BENCHMARK_ENTRY_SOURCE_SHA256 ||
      pins.cryptoAdapterSourceSha256 !== BENCHMARK_ADAPTER_SOURCE_SHA256 ||
      pins.mobileAndSharedSourceTreeSha256 !== MOBILE_SHARED_SOURCE_IDENTITY_SHA256 ||
      pins.mobileRootSourceTreeSha256 !== EXPECTED_MOBILE_ROOT_SOURCE_TREE_SHA256 ||
      pins.studioSharedRootSourceTreeSha256 !== EXPECTED_STUDIO_SHARED_ROOT_SOURCE_TREE_SHA256 ||
      pins.sourceRelease?.commit !== FROZEN_PRODUCT_SOURCE_COMMIT ||
      pins.sourceRelease?.gitTree !== FROZEN_PRODUCT_SOURCE_TREE ||
      pins.sourceRelease?.parentCommit !== FROZEN_PRODUCT_SOURCE_PARENT_COMMIT ||
      pins.sourceRelease?.identityReceiptPath !== PRODUCT_SOURCE_IDENTITY_RECEIPT ||
      pins.sourceRelease?.identityReceiptSha256 !== PRODUCT_SOURCE_IDENTITY_RECEIPT_SHA256 ||
      !Array.isArray(pins.sourceRoots) || pins.sourceRoots.length !== 2 ||
      pins.sourceRoots[0]?.name !== "mobile" || pins.sourceRoots[0]?.destination !== "apps/kcoder-studio/mobile" ||
      pins.sourceRoots[0]?.sha256 !== EXPECTED_MOBILE_ROOT_SOURCE_TREE_SHA256 || pins.sourceRoots[0]?.fileCount !== 725 ||
      pins.sourceRoots[1]?.name !== "studio-shared" || pins.sourceRoots[1]?.destination !== "apps/kcoder-studio/shared" ||
      pins.sourceRoots[1]?.sha256 !== EXPECTED_STUDIO_SHARED_ROOT_SOURCE_TREE_SHA256 || pins.sourceRoots[1]?.fileCount !== 83 ||
      pins.esbuildInputCount !== 320 ||
      pins.inputGroups?.frozenProduct !== 16 || pins.inputGroups?.approvedDependency !== 303 ||
      pins.inputGroups?.ownedTestEntry !== 1 || !/^[a-f0-9]{64}$/.test(pins.inputsSha256)) {
    throw new Error("browser benchmark bundle failed its source pin verification");
  }
  return {
    path: BENCHMARK_BUNDLE_PATH,
    bundleSha256: pins.bundleSha256,
    entrySourceSha256: pins.entrySourceSha256,
    mobileAndSharedSourceTreeSha256: pins.mobileAndSharedSourceTreeSha256,
    studioSharedRootSourceTreeSha256: pins.studioSharedRootSourceTreeSha256,
    pinsSha256,
  };
}

async function readRemoteMemAvailable(context, owner, waitFor) {
  const output = await runSshCommand(context, "vps-memory-preflight", owner.host,
    "cat /proc/meminfo", { timeoutMs: 15_000, waitFor });
  const match = output.stdout.match(/^MemAvailable:\s+(\d+)\s+kB\s*$/m);
  if (!match) throw new Error("vps_first MemAvailable could not be read before Gateway startup");
  return { availableBytes: Number(match[1]) * 1024 };
}

async function persistLanCaTrust(context, material) {
  assert.ok(material && typeof material.certificatePem === "string" && typeof material.certificateSha256 === "string");
  assert.equal(sha256(Buffer.from(material.certificatePem)), material.certificateSha256, "LAN public CA certificate SHA-256 must match remote owner receipt");
  assert.match(material.certificatePem, /^-----BEGIN CERTIFICATE-----\r?\n/);
  const certificatePath = context.pathInState("lan-route-test-ca.pem");
  const handle = await open(certificatePath, "wx", 0o600);
  try { await handle.writeFile(material.certificatePem); await handle.sync(); }
  finally { await handle.close(); }
  return {
    certificatePath,
    certificateSha256: material.certificateSha256,
    nickname: material.nickname,
  };
}

async function rmFile(path) {
  const { unlink } = await import("node:fs/promises");
  await unlink(path);
}
