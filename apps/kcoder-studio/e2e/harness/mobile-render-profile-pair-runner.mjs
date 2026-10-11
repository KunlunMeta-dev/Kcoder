#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  assertPathWithinApprovedRoots,
  readVerifiedMobileExportFile,
  verifyMobileExportManifestEnvelope,
} from "./mobile-web-export-input.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const privateRoot = resolve(repoRoot, "target/private-phone-ux-implementation");
const retainedE2eRoot = resolve(repoRoot, "target/test/apps/kcoder-studio/e2e");
const defaultGatewayRuntimeRoot = resolve(privateRoot, "nav-gateway-runtime-restored");
const suitePath = resolve(repoRoot, "apps/kcoder-studio/e2e/suites/mobile/mobile-render-profile.e2e.mjs");
const hashPattern = /^[a-f0-9]{64}$/;

await main().catch((error) => {
  console.error(error?.stack ?? String(error));
  process.exitCode = 1;
});

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) {
  console.log(`Usage: node ${relative(repoRoot, fileURLToPath(import.meta.url)).split(sep).join("/")} \\
  --before-source-provenance ABSOLUTE_PATH --before-export-manifest ABSOLUTE_PATH --before-bundle-root ABSOLUTE_PATH \\
  --after-source-provenance ABSOLUTE_PATH --after-export-manifest ABSOLUTE_PATH --after-bundle-root ABSOLUTE_PATH \\
  [--gateway-runtime-root ABSOLUTE_PATH] [--debug-smoke] [--execute]

The default mode validates and prints the pinned suite argv. --execute imports the E2E suite in this process and starts Chromium. --debug-smoke restricts execution to before/50/one sample per panel with the core profiler off.`);
    return;
  }
  const runnerSourceSha256 = sha256(await readFile(fileURLToPath(import.meta.url)));
  const suiteSourceSha256 = sha256(await readFile(suitePath));
  const sources = {};
  for (const name of ["before", "after"]) {
    sources[name] = await readSourceInput(name, parsed.values, parsed.execute);
  }

  const runtimeRoot = normalizeAbsolutePath(parsed.values.get("gateway-runtime-root") ?? defaultGatewayRuntimeRoot, "--gateway-runtime-root");
  await assertPathWithinApprovedRoots(runtimeRoot, [privateRoot], "frozen Gateway runtime root");
  const runtimeInfo = await lstat(runtimeRoot);
  assert.ok(runtimeInfo.isDirectory() && !runtimeInfo.isSymbolicLink(), "frozen Gateway runtime root must be a real directory");
  const runtimeManifestPath = resolve(runtimeRoot, "gateway-runtime-freeze.json");
  await assertPathWithinApprovedRoots(runtimeManifestPath, [privateRoot], "frozen Gateway runtime manifest");
  const runtimeManifestBytes = await readFile(runtimeManifestPath);
  const runtimeManifest = JSON.parse(runtimeManifestBytes.toString("utf8"));
  assert.equal(runtimeManifest.status, "complete", "frozen Gateway runtime manifest must be complete");
  const runtimeManifestSha256 = sha256(runtimeManifestBytes);
  const gatewaySourceTreeSha256 = requireDigest(runtimeManifest.sourceTreeSha256, "Gateway source tree");
  const gatewayDependencyTreeSha256 = requireDigest(runtimeManifest.dependencyTreeSha256, "Gateway dependency tree");
  const gatewayBinarySha256 = requireDigest(
    runtimeManifest.runtimeInputs?.kcoderBinarySha256 ?? runtimeManifest.kcoderBinarySha256,
    "Gateway KCoder binary",
  );
  assert.equal(runtimeManifest.runtimeInputs?.kcoderBinarySha256 ?? runtimeManifest.kcoderBinarySha256, runtimeManifest.kcoderBinarySha256, "Gateway binary digest must agree across runtime manifest fields");
  const gatewayBinaryPath = normalizeAbsolutePath(
    runtimeManifest.runtimeInputs?.kcoderBinaryPath ?? runtimeManifest.kcoderBinaryPath,
    "frozen Gateway KCoder binary path",
  );
  assert.equal(runtimeManifest.runtimeInputs?.nodeExecutable ?? runtimeManifest.nodeExecutable, runtimeManifest.nodeExecutable, "Gateway Node executable must agree across runtime manifest fields");
  assert.equal(runtimeManifest.nodeVersion, process.version, "argv runner Node version must match the frozen Gateway runtime Node version");
  requireDigest(runtimeManifestSha256, "Gateway runtime manifest");

  const suiteArgv = [
    `--samples=${parsed.debugSmoke ? 1 : 30}`,
    `--sources=${parsed.debugSmoke ? "before" : "before,after"}`,
    `--messages=${parsed.debugSmoke ? 50 : "50,500,2000"}`,
    `--capture-stack-diagnostic=false`,
    `--gateway-runtime-root=${runtimeRoot}`,
    `--gateway-binary=${gatewayBinaryPath}`,
    `--gateway-binary-sha256=${gatewayBinarySha256}`,
    `--gateway-source-tree-sha256=${gatewaySourceTreeSha256}`,
    `--gateway-dependency-tree-sha256=${gatewayDependencyTreeSha256}`,
    `--gateway-runtime-manifest-sha256=${runtimeManifestSha256}`,
  ];
  for (const name of ["before", "after"]) {
    const source = sources[name];
    suiteArgv.push(
      `--${name}-manifest=${source.manifestPath}`,
      `--${name}-source-provenance=${source.sourceProvenancePath}`,
      `--${name}-bundle-root=${source.bundleRoot}`,
      `--${name}-source-tree-sha256=${source.sourceTreeSha256}`,
      `--${name}-shared-input-sha256=${source.sharedSourceInputSha256}`,
      `--${name}-source-freeze-digest=${source.sourceFreezeEvidenceDigest}`,
      `--${name}-dependency-source-tree-sha256=${source.dependencySourceTreeSha256}`,
      `--${name}-source-provenance-sha256=${source.sourceProvenanceSha256}`,
      `--${name}-export-manifest-sha256=${source.exportManifestSha256}`,
    );
    if (source.sourceComplementSha256) suiteArgv.push(`--${name}-source-complement-sha256=${source.sourceComplementSha256}`);
    if (source.relocationSidecarSha256) suiteArgv.push(`--${name}-relocation-sidecar-sha256=${source.relocationSidecarSha256}`);
  }

  console.log(JSON.stringify({
    status: "PREFLIGHT_READY",
    mode: parsed.execute ? "execute" : "argv-preview-only",
    suite: relative(repoRoot, suitePath).split(sep).join("/"),
    runnerSourceSha256,
    suiteSourceSha256,
    runProfile: parsed.debugSmoke ? "single-source-before-50-two-panel-debug-smoke" : "paired-before-after-50-500-2000-formal",
    coreProfiler: false,
    samplesPerCoreScenario: parsed.debugSmoke ? 1 : 30,
    sources: parsed.debugSmoke ? ["before"] : ["before", "after"],
    messages: parsed.debugSmoke ? [50] : [50, 500, 2000],
    browserRunsWhenExecuted: true,
    runtime: {
      root: runtimeRoot,
      sourceTreeSha256: digestLabel(gatewaySourceTreeSha256),
      dependencyTreeSha256: digestLabel(gatewayDependencyTreeSha256),
      binaryPath: gatewayBinaryPath,
      binarySha256: digestLabel(gatewayBinarySha256),
      freezeManifestSha256: digestLabel(runtimeManifestSha256),
      nodeVersion: runtimeManifest.nodeVersion,
    },
    inputs: Object.fromEntries(Object.entries(sources).map(([name, source]) => [name, {
      sourceProvenancePath: source.sourceProvenancePath,
      sourceProvenanceSha256: digestLabel(source.sourceProvenanceSha256),
      relocationSidecarSha256: source.relocationSidecarSha256 ? digestLabel(source.relocationSidecarSha256) : null,
      exportManifestPath: source.manifestPath,
      exportManifestSha256: digestLabel(source.exportManifestSha256),
      bundleRoot: source.bundleRoot,
      sourceTreeSha256: digestLabel(source.sourceTreeSha256),
      bundleSha256: digestLabel(source.bundleSha256),
      bundleFileCount: source.bundleFileCount,
      individuallyHashedBundleFiles: source.individuallyHashedBundleFiles,
    }])),
    argv: suiteArgv,
  }, null, 2));

  if (!parsed.execute) return;
  process.argv = [process.argv[0], suitePath, ...suiteArgv];
  await import(pathToFileURL(suitePath).href);
}

async function readSourceInput(name, values, executionRequested) {
  const sourceProvenancePath = normalizeAbsolutePath(requireValue(values, `--${name}-source-provenance`), `--${name}-source-provenance`);
  const manifestPath = normalizeAbsolutePath(requireValue(values, `--${name}-export-manifest`), `--${name}-export-manifest`);
  const bundleRoot = normalizeAbsolutePath(requireValue(values, `--${name}-bundle-root`), `--${name}-bundle-root`);
  for (const [label, path] of [["source provenance", sourceProvenancePath], ["export manifest", manifestPath], ["bundle root", bundleRoot]]) {
    const approvedRoots = await approvedRootsForEvidencePath(path);
    await assertPathWithinApprovedRoots(path, approvedRoots, `${name} ${label}`);
  }

  const manifestInfo = await lstat(manifestPath);
  assert.ok(manifestInfo.isFile() && !manifestInfo.isSymbolicLink(), `${name} export manifest must be a regular file`);
  const provenanceInfo = await lstat(sourceProvenancePath);
  assert.ok(provenanceInfo.isFile() && !provenanceInfo.isSymbolicLink(), `${name} source provenance must be a regular file`);
  const bundleInfo = await lstat(bundleRoot);
  assert.ok(bundleInfo.isDirectory() && !bundleInfo.isSymbolicLink(), `${name} public bundle root must be a real directory`);

  const manifestBytes = await readFile(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const exportManifestSha256 = sha256(manifestBytes);
  verifyMobileExportManifestEnvelope(manifest, manifestBytes, exportManifestSha256, name);
  const sourceProvenanceBytes = await readFile(sourceProvenancePath);
  const sourceProvenanceSha256 = sha256(sourceProvenanceBytes);
  const provenance = JSON.parse(sourceProvenanceBytes.toString("utf8"));
  if (provenance.status !== undefined) assert.equal(provenance.status, "complete", `${name} source provenance must be complete`);
  const relocationSidecar = await readRelocationSidecar({
    name,
    sourceProvenancePath,
    manifestPath,
    bundleRoot,
    sourceProvenanceSha256,
    exportManifestSha256,
    provenance,
    manifest,
  });

  const sourceTreeSha256 = requireDigest(provenance.sourceTreeSha256 ?? manifest.sourceTreeSha256, `${name} source tree`);
  assert.equal(manifest.sourceTreeSha256, sourceTreeSha256, `${name} source tree digest differs between provenance and export manifest`);
  const sourceFreezeEvidenceDigest = requireDigest(
    provenance.frozenSourceManifestSha256 ?? provenance.candidateDigest,
    `${name} source freeze evidence`,
  );
  const dependencySourceTreeSha256 = requireDigest(
    provenance.dependencySourceTreeSha256 ?? provenance.dependencyInput?.sourceTreeSha256,
    `${name} dependency source tree`,
  );
  const sharedRoot = manifest.inputRoots?.find((root) => root.name === "studio-shared");
  const mobileRoot = manifest.inputRoots?.find((root) => root.name === "mobile");
  assert.ok(sharedRoot && mobileRoot, `${name} export manifest must pin Mobile and shared source roots`);
  const sharedSourceInputSha256 = requireDigest(sharedRoot.sha256, `${name} shared source input`);
  const sourceComplementSha256 = provenance.sourceComplementSha256 ?? null;
  if (sourceComplementSha256 !== null) requireDigest(sourceComplementSha256, `${name} source complement`);
  assert.equal(provenance.bundleSha256, manifest.bundleSha256, `${name} source provenance bundle digest differs from export manifest`);
  assert.equal(provenance.bundleFileCount ?? manifest.bundleFileCount, 37, `${name} source provenance must report all 37 exported files when the count is available`);

  for (const bundleReference of [provenance.bundlePath, provenance.bundleRoot]) {
    if (typeof bundleReference === "string") {
      const referencedRoot = bundleReference.startsWith("/") ? resolve(bundleReference) : resolve(repoRoot, bundleReference);
      assert.equal(referencedRoot, bundleRoot, `${name} provenance must name the explicitly supplied bundle root`);
    }
  }
  const manifestReference = provenance.bundleManifest ?? provenance.exportManifestPath ?? provenance.manifestPath;
  if (typeof manifestReference === "string") {
    if (relocationSidecar) {
      const originalProvenanceBase = dirname(dirname(relocationSidecar.originalSourceProvenancePath));
      const originalReferencedManifest = resolveOriginalReference(manifestReference, originalProvenanceBase);
      assert.equal(originalReferencedManifest, relocationSidecar.resolvedOriginalManifestReference, `${name} relocation must preserve the original manifest reference target`);
      assert.equal(originalReferencedManifest, relocationSidecar.originalExportManifestPath, `${name} original manifest reference differs from the relocation record`);
      assert.equal(relocationSidecar.pinnedExportManifestPath, manifestPath, `${name} relocation manifest target differs from the explicitly supplied manifest`);
    } else {
      const provenanceDirectory = dirname(sourceProvenancePath);
      const provenanceBase = basename(provenanceDirectory) === "artifacts" ? dirname(provenanceDirectory) : provenanceDirectory;
      const referencedManifest = resolveOriginalReference(manifestReference, provenanceBase);
      assert.equal(referencedManifest, manifestPath, `${name} provenance must name the explicitly supplied export manifest`);
    }
  }
  if (relocationSidecar && typeof provenance.exportedWebArtifact === "string") {
    const originalProvenanceBase = dirname(dirname(relocationSidecar.originalSourceProvenancePath));
    const originalReferencedBundle = resolveOriginalReference(provenance.exportedWebArtifact, originalProvenanceBase);
    assert.equal(originalReferencedBundle, relocationSidecar.resolvedOriginalProvenanceBundle, `${name} relocation must preserve the original provenance bundle reference target`);
    assert.equal(relocationSidecar.pinnedBundleRoot, bundleRoot, `${name} relocation bundle target differs from the explicitly supplied bundle root`);
  }

  if (Array.isArray(provenance.sourceRoots)) {
    for (const root of provenance.sourceRoots) {
      const manifestRoot = manifest.inputRoots.find((item) => item.name === root.name);
      assert.ok(manifestRoot, `${name} source root ${root.name} is absent from the export manifest`);
      assert.equal(root.sha256, manifestRoot.sha256, `${name} source root ${root.name} digest differs from the export manifest`);
      assert.equal(root.fileCount, manifestRoot.fileCount, `${name} source root ${root.name} file count differs from the export manifest`);
    }
    assert.equal(provenance.snapshotCopyMatchesSource, true, `${name} frozen candidate copy must match its source`);
    assert.equal(provenance.snapshotUnchangedDuringExport, true, `${name} candidate must remain unchanged during export`);
  }

  await verifyExactBundleRoot(bundleRoot, manifest, name);
  if (executionRequested) {
    const manifestBytesAfter = await readFile(manifestPath);
    assert.equal(sha256(manifestBytesAfter), exportManifestSha256, `${name} export manifest changed during preflight`);
  }

  return {
    manifestPath,
    sourceProvenancePath,
    bundleRoot,
    sourceTreeSha256,
    sharedSourceInputSha256,
    sourceFreezeEvidenceDigest,
    dependencySourceTreeSha256,
    sourceComplementSha256,
    sourceProvenanceSha256,
    relocationSidecarSha256: relocationSidecar?.sha256 ?? null,
    exportManifestSha256,
    bundleSha256: manifest.bundleSha256,
    bundleFileCount: manifest.bundleFileCount,
    individuallyHashedBundleFiles: manifest.bundleFiles.length,
  };
}

async function readRelocationSidecar({ name, sourceProvenancePath, manifestPath, bundleRoot, sourceProvenanceSha256, exportManifestSha256, provenance, manifest }) {
  const sidecarPath = resolve(dirname(sourceProvenancePath), "relocation-sidecar.json");
  let sidecarInfo;
  try {
    sidecarInfo = await lstat(sidecarPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (!sidecarInfo) {
    return null;
  }
  assert.ok(sidecarInfo.isFile() && !sidecarInfo.isSymbolicLink(), `${name} relocation sidecar must be a regular file`);
  await assertPathWithinApprovedRoots(sidecarPath, await approvedRootsForEvidencePath(sidecarPath), `${name} relocation sidecar`);
  const bytes = await readFile(sidecarPath);
  const observedSha256 = sha256(bytes);
  assert.match(observedSha256, hashPattern, `${name} relocation sidecar SHA-256 is invalid`);
  const sidecar = JSON.parse(bytes.toString("utf8"));
  assert.equal(sidecar.status, "complete", `${name} relocation sidecar must be complete`);
  assert.equal(sidecar.kind, "retention-safe-relocation-of-before-render-export-inputs", `${name} relocation sidecar kind is unsupported`);
  assert.equal(sidecar.pinnedSourceProvenancePath, sourceProvenancePath, `${name} relocation must point to the supplied source provenance copy`);
  assert.equal(sidecar.originalSourceProvenanceSha256, sourceProvenanceSha256, `${name} relocated source provenance bytes must match the original digest`);
  assert.equal(sidecar.pinnedExportManifestPath, manifestPath, `${name} relocation must point to the supplied export manifest copy`);
  assert.equal(sidecar.originalExportManifestSha256, exportManifestSha256, `${name} relocated export manifest bytes must match the original digest`);
  assert.equal(sidecar.pinnedBundleRoot, bundleRoot, `${name} relocation must point to the supplied retained bundle`);
  assert.equal(sidecar.bundleSha256, manifest.bundleSha256, `${name} relocated bundle digest differs from its manifest`);
  assert.equal(sidecar.bundleFileCount, 37, `${name} relocation must identify all 37 exported files`);
  assert.equal(sidecar.sourceTreeSha256, provenance.sourceTreeSha256, `${name} relocation source tree digest differs from provenance`);
  assert.equal(sidecar.sourceFreezeEvidenceDigest, provenance.frozenSourceManifestSha256, `${name} relocation freeze digest differs from provenance`);
  assert.equal(sidecar.dependencySourceTreeSha256, provenance.dependencySourceTreeSha256, `${name} relocation dependency digest differs from provenance`);
  assert.equal(sidecar.resolvedOriginalManifestReference, sidecar.originalExportManifestPath, `${name} original manifest path mapping is inconsistent`);
  assert.equal(sidecar.resolvedOriginalProvenanceBundle, resolve(dirname(dirname(sidecar.originalSourceProvenancePath)), provenance.exportedWebArtifact), `${name} original bundle path mapping is inconsistent`);

  const preservationInventoryPath = normalizeAbsolutePath(sidecar.preservationInventoryPath, `${name} preservation inventory path`);
  await assertPathWithinApprovedRoots(preservationInventoryPath, [privateRoot], `${name} preservation inventory`);
  const inventoryBytes = await readFile(preservationInventoryPath);
  assert.equal(sha256(inventoryBytes), sidecar.preservationInventorySha256, `${name} private preservation inventory changed`);
  const inventory = JSON.parse(inventoryBytes.toString("utf8"));
  for (const entry of manifest.bundleFiles) {
    assert.equal(inventory[`artifacts/mobile-web-export/${entry.path}`], entry.sha256, `${name} private preservation inventory does not pin ${entry.path}`);
  }
  return { ...sidecar, sha256: observedSha256 };
}

function resolveOriginalReference(reference, provenanceBase) {
  return reference.startsWith("/")
    ? resolve(reference)
    : reference.startsWith("target/")
      ? resolve(repoRoot, reference)
      : resolve(provenanceBase, reference);
}

async function verifyExactBundleRoot(bundleRoot, manifest, label) {
  const expected = new Set(manifest.bundleFiles.map((entry) => entry.path));
  const visitedFiles = new Set();
  async function walk(directory, prefix = "") {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = resolve(directory, entry.name);
      const info = await lstat(absolute);
      assert.ok(!info.isSymbolicLink(), `${label} bundle cannot contain symlinks`);
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (info.isDirectory()) {
        await walk(absolute, relativePath);
      } else {
        assert.ok(info.isFile(), `${label} bundle cannot contain special files`);
        assert.ok(expected.has(relativePath), `${label} bundle contains an unlisted file ${relativePath}`);
        visitedFiles.add(relativePath);
      }
    }
  }

  await walk(bundleRoot);
  assert.deepEqual([...visitedFiles].sort(), [...expected].sort(), `${label} bundle tree must exactly match its 37-file manifest`);
  for (const entry of manifest.bundleFiles) await readVerifiedMobileExportFile(bundleRoot, entry, label);
}

async function approvedRootsForEvidencePath(candidatePath) {
  const roots = [privateRoot];
  const absolutePath = resolve(candidatePath);
  const pathFromRetained = relative(retainedE2eRoot, absolutePath);
  const insideRetained = pathFromRetained === "" || (pathFromRetained !== ".." && !pathFromRetained.startsWith(`..${sep}`));
  if (insideRetained) {
    const parts = pathFromRetained.split(sep).filter(Boolean);
    const artifactsIndex = parts.indexOf("artifacts");
    assert.ok(artifactsIndex >= 0, "retained E2E input must live under a retained artifacts directory");
    const artifactsDirectory = resolve(retainedE2eRoot, ...parts.slice(0, artifactsIndex + 1));
    await assertPathWithinApprovedRoots(artifactsDirectory, [retainedE2eRoot], "retained E2E artifacts directory");
    roots.push(artifactsDirectory);
  }
  return roots;
}

function parseArgs(argv) {
  if (argv.length === 1 && argv[0] === "--help") return { help: true, values: new Map(), execute: false };
  const values = new Map();
  let execute = false;
  let debugSmoke = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--execute") {
      assert.equal(execute, false, "--execute may only be supplied once");
      execute = true;
      continue;
    }
    if (argument === "--debug-smoke") {
      assert.equal(debugSmoke, false, "--debug-smoke may only be supplied once");
      debugSmoke = true;
      continue;
    }
    assert.ok(argument.startsWith("--"), `unexpected argument: ${argument}`);
    const value = argv[index + 1];
    assert.ok(value && !value.startsWith("--"), `missing value for ${argument}`);
    assert.ok(!values.has(argument), `duplicate argument: ${argument}`);
    values.set(argument, value);
    index += 1;
  }
  const expected = new Set([
    "--before-source-provenance", "--before-export-manifest", "--before-bundle-root",
    "--after-source-provenance", "--after-export-manifest", "--after-bundle-root",
    "--gateway-runtime-root",
  ]);
  for (const key of values.keys()) assert.ok(expected.has(key), `unsupported argument: ${key}`);
  for (const key of [...expected].filter((value) => value !== "--gateway-runtime-root")) {
    assert.ok(values.has(key), `missing required argument ${key}`);
  }
  return { values, execute, debugSmoke };
}

function normalizeAbsolutePath(value, label) {
  assert.ok(typeof value === "string" && value.length > 0, `${label} must be a non-empty path`);
  assert.ok(value.startsWith("/"), `${label} must be absolute`);
  const normalized = resolve(value);
  assert.equal(normalized, value, `${label} must be normalized`);
  return normalized;
}

function requireValue(values, key) {
  const value = values.get(key);
  assert.ok(value, `missing required argument ${key}`);
  return value;
}

function requireDigest(value, label) {
  assert.match(value ?? "", hashPattern, `${label} must be a lowercase SHA-256 digest`);
  return value;
}

function digestLabel(value) {
  return `${value.slice(0, 12)}… (${value.length})`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
