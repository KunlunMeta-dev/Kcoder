import { basename, dirname, relative, resolve, sep } from "node:path";
import assert from "node:assert/strict";
import { repoRoot, runE2E, waitFor } from "./run-context.mjs";
import { assertPathWithinApprovedRoots, readVerifiedMobileExportFile, verifyMobileExportManifestEnvelope } from "./mobile-web-export-input.mjs";
import { lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";

/** Shared suite helpers; the caller retains resource attribution and configuration. */
export function createMobileRenderProfileHelpers({
  requiredOption,
  requiredDigest,
  optionValue,
  sha256,
  sha256File,
  threadId,
  serverId,
}) {
async function readSourceSpec(name) {
  const prefix = `--${name}-`;
  const manifestArgument = requiredOption(`${prefix}manifest`);
  const sourceProvenanceArgument = requiredOption(`${prefix}source-provenance`);
  const bundleRootArgument = requiredOption(`${prefix}bundle-root`);
  const manifestPath = resolve(manifestArgument);
  const sourceProvenancePath = resolve(sourceProvenanceArgument);
  const bundleRoot = resolve(bundleRootArgument);
  const expectedManifestSha256 = requiredDigest(`${prefix}export-manifest-sha256`);
  const expectedSourceProvenanceSha256 = requiredDigest(`${prefix}source-provenance-sha256`);
  const sourceTreeSha256 = requiredDigest(`${prefix}source-tree-sha256`);
  const sharedSourceInputSha256 = requiredDigest(`${prefix}shared-input-sha256`);
  const sourceComplementArgument = optionValue(`${prefix}source-complement-sha256`, "");
  if (sourceComplementArgument) assert.match(sourceComplementArgument, /^[a-f0-9]{64}$/, `${name} source-complement-sha256 must be a lowercase SHA-256 digest`);
  const sourceFreezeEvidenceDigest = requiredDigest(`${prefix}source-freeze-digest`);
  const dependencySourceTreeSha256 = requiredDigest(`${prefix}dependency-source-tree-sha256`);
  assert.equal(manifestPath, manifestArgument, `${name} manifest path must be normalized and absolute`);
  assert.equal(sourceProvenancePath, sourceProvenanceArgument, `${name} source provenance path must be normalized and absolute`);
  assert.equal(bundleRoot, bundleRootArgument, `${name} bundle path must be normalized and absolute`);
  const artifactBoundary = resolve(repoRoot, "target/test/apps/kcoder-studio/e2e");
  const privateBoundary = resolve(repoRoot, "target/private-phone-ux-implementation");
  const artifactsDirectories = [];
  for (const candidatePath of [manifestPath, sourceProvenancePath]) {
    const candidateDirectory = dirname(candidatePath);
    const relativeToE2e = relative(artifactBoundary, candidateDirectory);
    const isRetainedE2ePath = relativeToE2e === "" || (relativeToE2e !== ".." && !relativeToE2e.startsWith(`..${sep}`));
    if (basename(candidateDirectory) === "artifacts" && isRetainedE2ePath) {
      await assertPathWithinApprovedRoots(candidateDirectory, [artifactBoundary], `${name} retained artifacts directory`);
      artifactsDirectories.push(candidateDirectory);
    }
  }
  const bundleArtifactsDirectory = dirname(bundleRoot);
  const relativeBundleArtifactsToE2e = relative(artifactBoundary, bundleArtifactsDirectory);
  const bundleIsInRetainedArtifacts = basename(bundleArtifactsDirectory) === "artifacts"
    && (relativeBundleArtifactsToE2e === "" || (relativeBundleArtifactsToE2e !== ".." && !relativeBundleArtifactsToE2e.startsWith(`..${sep}`)));
  if (bundleIsInRetainedArtifacts) {
    await assertPathWithinApprovedRoots(bundleArtifactsDirectory, [artifactBoundary], `${name} retained bundle artifacts directory`);
    artifactsDirectories.push(bundleArtifactsDirectory);
  }
  const approvedEvidenceRoots = [...new Set([privateBoundary, ...artifactsDirectories])];
  await assertPathWithinApprovedRoots(manifestPath, approvedEvidenceRoots, `${name} export manifest`);
  await assertPathWithinApprovedRoots(sourceProvenancePath, approvedEvidenceRoots, `${name} source provenance`);
  await assertPathWithinApprovedRoots(bundleRoot, approvedEvidenceRoots, `${name} public bundle`);
  const manifestBytes = await readFile(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const sourceProvenanceBytes = await readFile(sourceProvenancePath);
  const sourceProvenanceSha256 = sha256(sourceProvenanceBytes);
  assert.equal(sourceProvenanceSha256, expectedSourceProvenanceSha256, `${name} source provenance changed after its digest was pinned`);
  const sourceProvenance = JSON.parse(sourceProvenanceBytes.toString("utf8"));
  const relocationSidecarPath = resolve(dirname(sourceProvenancePath), "relocation-sidecar.json");
  const relocationSidecarArgument = optionValue(`${prefix}relocation-sidecar-sha256`, "");
  let relocationSidecarInfo;
  try {
    relocationSidecarInfo = await lstat(relocationSidecarPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  let relocationSidecar = null;
  if (relocationSidecarArgument) {
    assert.match(relocationSidecarArgument, /^[a-f0-9]{64}$/, `${name} relocation sidecar digest must be a lowercase SHA-256 digest`);
    assert.ok(relocationSidecarInfo?.isFile() && !relocationSidecarInfo.isSymbolicLink(), `${name} pinned relocation sidecar must be a regular file`);
    await assertPathWithinApprovedRoots(relocationSidecarPath, approvedEvidenceRoots, `${name} relocation sidecar`);
    const relocationSidecarBytes = await readFile(relocationSidecarPath);
    const observedRelocationSidecarSha256 = sha256(relocationSidecarBytes);
    assert.equal(observedRelocationSidecarSha256, relocationSidecarArgument, `${name} relocation sidecar changed after its digest was pinned`);
    relocationSidecar = JSON.parse(relocationSidecarBytes.toString("utf8"));
    assert.equal(relocationSidecar.status, "complete", `${name} relocation sidecar must be complete`);
    assert.equal(relocationSidecar.kind, "retention-safe-relocation-of-before-render-export-inputs", `${name} relocation sidecar kind is unsupported`);
    assert.equal(relocationSidecar.pinnedSourceProvenancePath, sourceProvenancePath, `${name} relocation sidecar must pin the supplied provenance path`);
    assert.equal(relocationSidecar.originalSourceProvenanceSha256, sourceProvenanceSha256, `${name} relocated source provenance bytes differ from the original`);
    assert.equal(relocationSidecar.pinnedExportManifestPath, manifestPath, `${name} relocation sidecar must pin the supplied manifest path`);
    assert.equal(relocationSidecar.originalExportManifestSha256, expectedManifestSha256, `${name} relocated export manifest bytes differ from the original`);
    assert.equal(relocationSidecar.pinnedBundleRoot, bundleRoot, `${name} relocation sidecar must pin the supplied bundle path`);
    assert.equal(relocationSidecar.bundleSha256, manifest.bundleSha256, `${name} relocation bundle digest differs from the export manifest`);
    assert.equal(relocationSidecar.bundleFileCount, 37, `${name} relocation must cover all 37 exported files`);
    assert.equal(relocationSidecar.sourceTreeSha256, sourceProvenance.sourceTreeSha256, `${name} relocation source tree digest differs from provenance`);
    assert.equal(relocationSidecar.sourceFreezeEvidenceDigest, sourceProvenance.frozenSourceManifestSha256, `${name} relocation freeze digest differs from provenance`);
    assert.equal(relocationSidecar.dependencySourceTreeSha256, sourceProvenance.dependencySourceTreeSha256, `${name} relocation dependency digest differs from provenance`);
    assert.equal(relocationSidecar.resolvedOriginalManifestReference, relocationSidecar.originalExportManifestPath, `${name} relocation manifest reference mapping is inconsistent`);
    assert.equal(
      relocationSidecar.resolvedOriginalProvenanceBundle,
      resolve(dirname(dirname(relocationSidecar.originalSourceProvenancePath)), sourceProvenance.exportedWebArtifact),
      `${name} relocation bundle reference mapping is inconsistent`,
    );
    const preservationInventoryPath = resolve(relocationSidecar.preservationInventoryPath);
    assert.equal(preservationInventoryPath, relocationSidecar.preservationInventoryPath, `${name} preservation inventory path must be normalized and absolute`);
    await assertPathWithinApprovedRoots(preservationInventoryPath, [privateBoundary], `${name} preservation inventory`);
    const preservationInventoryBytes = await readFile(preservationInventoryPath);
    assert.equal(sha256(preservationInventoryBytes), relocationSidecar.preservationInventorySha256, `${name} preservation inventory changed after relocation`);
    const preservationInventory = JSON.parse(preservationInventoryBytes.toString("utf8"));
    for (const entry of manifest.bundleFiles) {
      assert.equal(preservationInventory[`artifacts/mobile-web-export/${entry.path}`], entry.sha256, `${name} preservation inventory does not pin ${entry.path}`);
    }
    relocationSidecar.sha256 = observedRelocationSidecarSha256;
  } else {
    assert.ok(!relocationSidecarInfo, `${name} relocation sidecar exists but no explicit digest pin was provided`);
  }
  const inputRoots = manifest.inputRoots ?? [];
  const mobileRoot = inputRoots.find((root) => root.name === "mobile");
  const complementRoot = inputRoots.find((root) => root.name === "studio-shared");
  const dependency = manifest.dependencyProvenance ?? {};
  const usesCandidateExportProvenance = Array.isArray(sourceProvenance.sourceRoots)
    && Number.isSafeInteger(sourceProvenance.candidateFiles)
    && typeof sourceProvenance.candidateDigest === "string";
  const sourceFreezeEvidenceKind = typeof sourceProvenance.frozenSourceManifestSha256 === "string"
    ? "frozen-source-manifest-sha256"
    : usesCandidateExportProvenance ? "candidate-source-manifest" : null;
  assert.ok(sourceFreezeEvidenceKind, `${name} source provenance must pin a recognized frozen-source digest`);
  const provenanceFreezeDigest = sourceFreezeEvidenceKind === "frozen-source-manifest-sha256"
    ? sourceProvenance.frozenSourceManifestSha256
    : sourceProvenance.candidateDigest;
  assert.equal(provenanceFreezeDigest, sourceFreezeEvidenceDigest, `${name} source freeze evidence digest differs from its pinned provenance`);
  const frozenSourceEntryCount = sourceFreezeEvidenceKind === "frozen-source-manifest-sha256"
    ? sourceProvenance.frozenSourceEntryCount
    : sourceProvenance.candidateFiles;
  const provenanceDependencyDigest = sourceProvenance.dependencySourceTreeSha256
    ?? sourceProvenance.dependencyInput?.sourceTreeSha256;
  assert.equal(provenanceDependencyDigest, dependencySourceTreeSha256, `${name} source provenance dependency digest differs from its pinned input`);
  const sourceComplementSha256 = sourceProvenance.sourceComplementSha256 ?? null;
  const sourceCompleteness = sourceProvenance.sourceCompleteness ?? (usesCandidateExportProvenance ? {
    manifestFileCount: sourceProvenance.candidateFiles,
    workspaceComplementCopied: false,
    candidateMobileManifestFiles: sourceProvenance.candidateMobileManifestFiles,
    candidateSharedManifestFiles: sourceProvenance.candidateSharedManifestFiles,
    sourceRootsIndividuallyPinned: true,
  } : {});
  const complementarySourceDescription = optionValue(`${prefix}complement-description`, "")
    || sourceProvenance.complementarySourceDescription
    || sourceCompleteness.complementSource
    || sourceProvenance.complementChangeConfirmation
    || (usesCandidateExportProvenance ? "Mobile and studio-shared source roots are independently SHA-256 pinned in the export manifest" : "");
  assert.ok(complementarySourceDescription, `${name} complementary source description is required`);

  assert.equal(manifest.status, "complete", `${name} retained Mobile Web export must be complete`);
  assert.equal(manifest.sourceTreeSha256, sourceTreeSha256, `${name} export must match the pinned frozen source-tree digest`);
  assert.equal(manifest.sourceUnchanged, true, `${name} export source must remain unchanged during build`);
  assert.equal(manifest.snapshotUnchangedDuringExport, true, `${name} frozen snapshot must remain unchanged during export`);
  assert.ok(mobileRoot?.sha256 && complementRoot?.sha256, `${name} export must include both Mobile and shared source roots`);
  assert.equal(complementRoot.sha256, sharedSourceInputSha256, `${name} shared source-root digest must match the pinned complement input`);
  assert.equal(dependency.sourceTreeSha256Before, dependencySourceTreeSha256, `${name} dependency source digest must match the pinned frozen dependency tree`);
  assert.equal(dependency.sourceTreeSha256After, dependencySourceTreeSha256, `${name} dependency tree must remain unchanged during export`);
  assert.equal(dependency.sourceUnchanged, true, `${name} dependency tree must remain unchanged during export`);
  verifyMobileExportManifestEnvelope(manifest, manifestBytes, expectedManifestSha256, name);
  assert.equal(sourceProvenance.sourceTreeSha256, sourceTreeSha256, `${name} source provenance must match the frozen Mobile Web source tree`);
  if (sourceFreezeEvidenceKind === "frozen-source-manifest-sha256") {
    assert.equal(sourceProvenance.frozenSourceEntryCount, sourceProvenance.sourceCompleteness?.manifestFileCount, `${name} source provenance must report a freeze entry count consistent with its completeness ledger`);
  } else {
    assert.equal(sourceProvenance.status, "complete", `${name} candidate export provenance must be complete`);
    assert.equal(sourceProvenance.snapshotCopyMatchesSource, true, `${name} candidate export must record a byte-matching frozen copy`);
    assert.equal(sourceProvenance.snapshotUnchangedDuringExport, true, `${name} candidate snapshot must remain unchanged during export`);
  }
  const provenanceManifestReference = sourceProvenance.bundleManifest ?? sourceProvenance.exportManifestPath ?? sourceProvenance.manifestPath;
  if (typeof provenanceManifestReference === "string") {
    if (relocationSidecar) {
      const originalProvenanceBase = dirname(dirname(relocationSidecar.originalSourceProvenancePath));
      const originalReferencedManifestPath = resolveProvenanceReference(provenanceManifestReference, originalProvenanceBase);
      assert.equal(originalReferencedManifestPath, relocationSidecar.resolvedOriginalManifestReference, `${name} relocation must preserve the original manifest reference`);
      assert.equal(originalReferencedManifestPath, relocationSidecar.originalExportManifestPath, `${name} original manifest reference differs from relocation sidecar`);
      assert.equal(relocationSidecar.pinnedExportManifestPath, manifestPath, `${name} relocation must map to the explicitly pinned export manifest`);
    } else {
      const sourceProvenanceDirectory = dirname(sourceProvenancePath);
      const provenanceBase = basename(sourceProvenanceDirectory) === "artifacts" ? dirname(sourceProvenanceDirectory) : sourceProvenanceDirectory;
      const referencedManifestPath = resolveProvenanceReference(provenanceManifestReference, provenanceBase);
      assert.equal(referencedManifestPath, manifestPath, `${name} source provenance must name the exact builder manifest`);
    }
  }
  if (relocationSidecar && typeof sourceProvenance.exportedWebArtifact === "string") {
    const originalProvenanceBase = dirname(dirname(relocationSidecar.originalSourceProvenancePath));
    assert.equal(
      resolveProvenanceReference(sourceProvenance.exportedWebArtifact, originalProvenanceBase),
      relocationSidecar.resolvedOriginalProvenanceBundle,
      `${name} relocation must preserve the original provenance bundle reference`,
    );
    assert.equal(relocationSidecar.pinnedBundleRoot, bundleRoot, `${name} relocation must map to the explicitly pinned bundle root`);
  }
  for (const provenanceBundlePath of [sourceProvenance.bundlePath, sourceProvenance.bundleRoot]) {
    if (typeof provenanceBundlePath === "string") {
      const resolvedProvenanceBundlePath = provenanceBundlePath.startsWith("/") ? resolve(provenanceBundlePath) : resolve(repoRoot, provenanceBundlePath);
      assert.equal(resolvedProvenanceBundlePath, bundleRoot, `${name} source provenance bundle path must match the explicitly pinned bundle root`);
    }
  }
  assert.equal(sourceProvenance.bundleSha256, manifest.bundleSha256, `${name} source provenance bundle digest must match the builder manifest`);
  if (usesCandidateExportProvenance) {
    for (const root of sourceProvenance.sourceRoots) {
      const manifestRoot = inputRoots.find((item) => item.name === root.name);
      assert.ok(manifestRoot, `${name} candidate source root ${root.name} must appear in the export manifest`);
      assert.equal(root.sha256, manifestRoot.sha256, `${name} candidate source root ${root.name} digest must match the builder manifest`);
      assert.equal(root.fileCount, manifestRoot.fileCount, `${name} candidate source root ${root.name} file count must match the builder manifest`);
    }
    assert.ok(sourceProvenance.candidateManifestPath, `${name} candidate source manifest reference is required`);
    assert.ok(sourceProvenance.candidateFiles > 0, `${name} candidate source file count must be positive`);
  }
  if (sourceComplementArgument) {
    assert.equal(sourceComplementSha256, sourceComplementArgument, `${name} separate complement digest must match its retained source provenance`);
    assert.equal(sourceProvenance.sourceComplementStableDuringCopy, true, `${name} copied complement must remain stable while the frozen source is prepared`);
    assert.equal(sourceCompleteness.workspaceComplementCopied, true, `${name} source provenance must record its workspace complement copy`);
  } else {
    assert.equal(sourceComplementSha256, null, `${name} source provenance must not claim a separate workspace complement digest`);
    if (sourceFreezeEvidenceKind === "frozen-source-manifest-sha256") {
      assert.equal(sourceProvenance.sourceComplementStableDuringCopy, null, `${name} source provenance must not claim a separate workspace complement copy`);
      assert.equal(sourceCompleteness.workspaceComplementCopied, false, `${name} source provenance must record use of the exact frozen Mobile/shared snapshot`);
      assert.equal(sourceCompleteness.manifestFileCount, frozenSourceEntryCount, `${name} exact-frozen source must cover every entry listed by its freeze manifest`);
    } else {
      assert.equal(complementRoot.sha256, sharedSourceInputSha256, `${name} shared input must be pinned as an export root when there is no separate complement copy`);
    }
  }
  return {
    name,
    manifestPath,
    sourceProvenancePath,
    sourceProvenanceSha256: sha256(sourceProvenanceBytes),
    relocationSidecarSha256: relocationSidecar?.sha256 ?? null,
    bundleRoot,
    sourceTreeSha256,
    sourceComplementSha256,
    sharedSourceInputSha256,
    mobileExportInputFileCount: mobileRoot.fileCount,
    sharedExportInputFileCount: complementRoot.fileCount,
    frozenSourceEntryCount,
    sourceCompleteness,
    sourceFreezeEvidenceDigest,
    sourceFreezeEvidenceKind,
    dependencySourceTreeSha256,
    complementarySourceDescription,
    mobileSourceComponentSha256: mobileRoot?.sha256 ?? null,
    exportManifestSha256: sha256(manifestBytes),
    overlaySha256: sourceProvenance.frozenSourceOverlaySha256 ?? null,
    sourceComplementMode: sourceComplementArgument
      ? "separate-workspace-complement-copied-and-digest-pinned"
      : sourceFreezeEvidenceKind === "candidate-source-manifest"
        ? "mobile-and-shared-roots-individually-digest-pinned-by-the-export-manifest"
        : "mobile-and-shared-roots-covered-by-the-exact-frozen-source-manifest",
    builderManifest: manifest,
  };
}

function resolveProvenanceReference(reference, provenanceBase) {
  return reference.startsWith("/")
    ? resolve(reference)
    : reference.startsWith("target/")
      ? resolve(repoRoot, reference)
      : resolve(provenanceBase, reference);
}

async function readFrozenGatewayRuntime(rootArgument, binaryOverrideArgument, expectedBinarySha256, expectedSourceTreeSha256, expectedDependencyTreeSha256, expectedManifestSha256) {
  const root = resolve(rootArgument);
  const approvedBoundaries = [
    resolve(repoRoot, "target/test/apps/kcoder-studio/e2e"),
    resolve(repoRoot, "target/private-phone-ux-implementation"),
  ];
  assert.ok(approvedBoundaries.some((boundary) => root.startsWith(boundary + sep)), "frozen Gateway runtime must come from a retained or explicitly pinned private artifact, not the active workspace");
  const rootInfo = await lstat(root);
  assert.ok(rootInfo.isDirectory() && !rootInfo.isSymbolicLink(), "frozen Gateway runtime root must be an immutable artifact directory");
  const manifestPath = resolve(root, "gateway-runtime-freeze.json");
  const manifestBytes = await readFile(manifestPath);
  assert.equal(sha256(manifestBytes), expectedManifestSha256, "frozen Gateway runtime manifest differs from its explicit digest pin");
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  assert.equal(manifest.status, "complete", "frozen Gateway runtime manifest must be complete");
  const sourceRootLabel = String(manifest.sourceRoot ?? "").replaceAll("\\", "/");
  assert.ok(sourceRootLabel === "apps/kcoder-studio" || sourceRootLabel.endsWith("/apps/kcoder-studio"), "frozen Gateway runtime must pin the KCoder Studio source root");
  assert.equal(manifest.sourceTreeSha256, manifest.workspaceSourceTreeSha256, "frozen Gateway source tree must match the verified workspace source digest");
  assert.equal(manifest.dependencyTreeSha256, manifest.workspaceDependencyTreeSha256, "frozen Gateway dependencies must match the verified workspace dependency digest");
  assert.equal(manifest.sourceTreeSha256, expectedSourceTreeSha256, "frozen Gateway source tree must match its explicit digest pin");
  assert.equal(manifest.dependencyTreeSha256, expectedDependencyTreeSha256, "frozen Gateway dependencies must match their explicit digest pin");
  assert.ok(Array.isArray(manifest.sourceFiles) && manifest.sourceFiles.length > 0, "frozen Gateway source file inventory is required");
  assert.ok(Array.isArray(manifest.dependencyFiles) && manifest.dependencyFiles.length > 0, "frozen Gateway dependency file inventory is required");
  const binaryOverride = resolve(binaryOverrideArgument);
  const binaryInfo = await lstat(binaryOverride);
  assert.ok(binaryInfo.isFile() && !binaryInfo.isSymbolicLink(), "explicit Gateway KCoder binary override must be a regular file");
  const actualBinarySha256 = await sha256File(binaryOverride);
  assert.equal(actualBinarySha256, expectedBinarySha256, "explicit Gateway KCoder binary SHA-256 differs from its pinned digest");
  const manifestBinarySha256 = manifest.runtimeInputs?.kcoderBinarySha256 ?? manifest.kcoderBinarySha256 ?? null;
  if (manifestBinarySha256 !== null) assert.equal(manifestBinarySha256, expectedBinarySha256, "explicit Gateway KCoder binary digest must match the restored runtime manifest input when it is recorded");
  const explicitBinary = {
    path: binaryOverride,
    sha256: actualBinarySha256,
    size: binaryInfo.size,
    mtimeMs: binaryInfo.mtimeMs,
  };
  const script = resolve(root, "dev-server.mjs");
  const scriptInfo = await lstat(script);
  assert.ok(scriptInfo.isFile() && !scriptInfo.isSymbolicLink(), "frozen Gateway entry script must be a regular file");
  assert.ok(typeof manifest.nodeExecutable === "string" && manifest.nodeExecutable.startsWith("/"), "frozen Gateway Node executable must be pinned by its freeze manifest");
  assert.ok(typeof manifest.kcoderBinaryPath === "string" && manifest.kcoderBinaryPath.startsWith("/"), "frozen Gateway KCoder binary path must be pinned by its freeze manifest");
  const provenance = {
    runtimeRoot: relative(repoRoot, root).split(sep).join("/"),
    manifestPath: relative(repoRoot, manifestPath).split(sep).join("/"),
    manifestSha256: sha256(manifestBytes),
    sourceTreeSha256: manifest.sourceTreeSha256,
    sourceFileCount: manifest.sourceFiles.length,
    dependencyTreeSha256: manifest.dependencyTreeSha256,
    dependencyFileCount: manifest.dependencyFiles.length,
    dependencyCopySemantics: manifest.dependencyCopySemantics,
    nodeExecutable: manifest.nodeExecutable,
    nodeVersion: manifest.nodeVersion,
    kcoderBinaryPath: binaryOverride,
    kcoderBinarySha256: actualBinarySha256,
    manifestBinarySha256,
    kcoderBinaryStat: explicitBinary,
    binaryOverride: explicitBinary,
    runtimeInputs: {
      ...manifest.runtimeInputs,
      kcoderBinaryPath: binaryOverride,
      kcoderBinarySha256: actualBinarySha256,
      kcoderBinaryStat: explicitBinary,
    },
    treeRehashedByRenderProfile: false,
  };
  return { root, script, nodeExecutable: manifest.nodeExecutable, kcoderBinaryPath: binaryOverride, manifestSha256: provenance.manifestSha256, provenance };
}

async function startFrozenGateway(context, runtime, options) {
  const label = options.label || "render-profile-frozen-gateway";
  const host = "127.0.0.1";
  const authToken = randomBytes(24).toString("base64url");
  context.registerSecret(authToken);
  const env = context.isolatedEnvironment({
    KCODER_STUDIO_HOST: host,
    KCODER_STUDIO_PORT: "0",
    KCODER_STUDIO_KCODER_BIN: runtime.kcoderBinaryPath,
    KCODER_STUDIO_WORKSPACE: options.workspace,
    KCODER_STUDIO_WEB_ROOT: options.webRoot,
    KCODER_STUDIO_SERVERS_FILE: options.serversFile,
    KCODER_STUDIO_AUTH_TOKEN: authToken,
    KCODER_STUDIO_ALLOWED_HOSTS: "127.0.0.1,localhost,::1",
    KCODER_STUDIO_MOCK: "1",
  }, []);
  const child = context.spawnOwned(label, runtime.nodeExecutable, ["dev-server.mjs"], {
    cwd: runtime.root,
    env,
  });
  const logPath = resolve(context.logsDir, `${label}.log`);
  const port = await waitFor(async () => {
    const log = await readFile(logPath, "utf8").catch(() => "");
    const match = log.match(/KCoder Studio: http:\/\/[^:]+:(\d+)/);
    if (child.exitCode !== null) throw new Error(`frozen Gateway exited with code ${child.exitCode}; inspect ${logPath}`);
    return match ? Number(match[1]) : null;
  }, 15_000, "frozen Gateway startup", 50, context.abortSignal);
  context.registerPort(label, port);
  return {
    child,
    port,
    host,
    baseUrl: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}`,
    authToken,
    logPath,
    cwd: runtime.root,
    script: runtime.script,
    nodeExecutable: runtime.nodeExecutable,
  };
}

async function copyAndVerifyRetainedBuilderExport(context, source) {
  const manifestBytesBefore = await readFile(source.manifestPath);
  const manifest = JSON.parse(manifestBytesBefore.toString("utf8"));
  verifyMobileExportManifestEnvelope(manifest, manifestBytesBefore, source.exportManifestSha256, source.name);
  assert.equal(manifest.bundleSha256, source.builderManifest.bundleSha256, `${source.name} bundle digest changed after provenance was read`);

  const sourceRootInfo = await lstat(source.bundleRoot);
  assert.ok(sourceRootInfo.isDirectory() && !sourceRootInfo.isSymbolicLink(), `${source.name} source bundle root must be a real directory`);
  const ownedRoot = context.pathInState(`render-profile-${source.name}-bundle`);
  await mkdir(ownedRoot, { recursive: false, mode: 0o700 });
  context.registerTemporaryDirectory(`copied retained Mobile Web export ${source.name}`, ownedRoot);
  let totalBytes = 0;
  const expectedFiles = new Map();
  try {
    for (const entry of manifest.bundleFiles) {
      assert.ok(entry && typeof entry === "object" && !Array.isArray(entry), `${source.name} bundle file descriptor must be an object`);
      assert.deepEqual(Object.keys(entry), ["path", "size", "sha256"], `${source.name} bundle descriptor must contain only path, size, and SHA-256`);
      const parts = assertSafeBundleRelativePath(entry.path, source.name);
      assert.ok(!expectedFiles.has(entry.path), `${source.name} bundle file list contains a duplicate path`);
      expectedFiles.set(entry.path, entry);
      totalBytes += entry.size;
      assert.ok(totalBytes <= 64 * 1024 * 1024, `${source.name} public bundle exceeds the 64 MiB fixture limit`);

      const sourcePath = resolve(source.bundleRoot, ...parts);
      const sourceRelative = relative(source.bundleRoot, sourcePath);
      assert.ok(sourceRelative && !sourceRelative.startsWith(`..${sep}`) && sourceRelative !== "..", `${source.name} source asset escaped the bundle root`);
      await assertNoSymlinkAncestors(source.bundleRoot, parts, source.name);
      const bytes = await readVerifiedMobileExportFile(source.bundleRoot, entry, source.name);

      const destinationPath = resolve(ownedRoot, ...parts);
      const destinationRelative = relative(ownedRoot, destinationPath);
      assert.ok(destinationRelative && !destinationRelative.startsWith(`..${sep}`) && destinationRelative !== "..", `${source.name} copied asset escaped its owned directory`);
      await mkdir(dirname(destinationPath), { recursive: true, mode: 0o700 });
      await writeFile(destinationPath, bytes, { flag: "wx", mode: 0o600 });
    }
    assert.equal(expectedFiles.size, 37, `${source.name} bundle must contain exactly 37 files`);
    const indexEntry = expectedFiles.get("index.html");
    assert.ok(indexEntry, `${source.name} bundle must list root index.html`);
    assert.equal(indexEntry.sha256, manifest.indexHtmlSha256, `${source.name} index digest does not match its file entry`);
    await verifyExactBundleTree(ownedRoot, expectedFiles, source.name);

    const manifestBytesAfter = await readFile(source.manifestPath);
    assert.equal(sha256(manifestBytesAfter), source.exportManifestSha256, `${source.name} export manifest changed while the public bundle was copied`);
    await verifyExactBundleTree(source.bundleRoot, expectedFiles, source.name);
    const provenance = {
      schemaVersion: 1,
      status: "complete",
      kind: "locally-verified-copy-of-retained-builder-export-v2",
      exportPerformedInMeasurementRun: false,
      source: {
        name: source.name,
        manifestPath: relative(repoRoot, source.manifestPath).split(sep).join("/"),
        manifestSha256: source.exportManifestSha256,
        sourceProvenancePath: relative(repoRoot, source.sourceProvenancePath).split(sep).join("/"),
        sourceProvenanceSha256: source.sourceProvenanceSha256,
        sourceFreezeEvidenceDigest: source.sourceFreezeEvidenceDigest,
        sourceFreezeEvidenceKind: source.sourceFreezeEvidenceKind,
        frozenOverlaySha256: source.overlaySha256,
        sourceTreeSha256: source.sourceTreeSha256,
        mobileSourceComponentSha256: source.mobileSourceComponentSha256,
        sourceComplementSha256: source.sourceComplementSha256,
        sharedSourceInputSha256: source.sharedSourceInputSha256,
        frozenSourceEntryCount: source.frozenSourceEntryCount,
        sourceCompleteness: source.sourceCompleteness,
        dependencySourceTreeSha256: source.dependencySourceTreeSha256,
        bundleRoot: relative(repoRoot, source.bundleRoot).split(sep).join("/"),
        bundleSha256: manifest.bundleSha256,
        indexHtmlSha256: manifest.indexHtmlSha256,
        bundleFileCount: expectedFiles.size,
        sourceAndManifestUnchangedDuringCopy: true,
      },
      ownedCopy: {
        path: relative(context.runRoot, ownedRoot).split(sep).join("/"),
        bundleSha256: sha256(Buffer.from(JSON.stringify(manifest.bundleFiles))),
        bundleFileCount: expectedFiles.size,
        bytes: totalBytes,
        exactFileSetVerified: true,
        symlinks: 0,
      },
    };
    const provenancePath = await context.writeArtifactJson(`render-profile-${source.name}-bundle-provenance.json`, provenance);
    return {
      path: ownedRoot,
      sourceManifestPath: source.manifestPath,
      sourceManifestSha256: source.exportManifestSha256,
      sourceTreeSha256: source.sourceTreeSha256,
      bundleSha256: manifest.bundleSha256,
      bundleFileCount: expectedFiles.size,
      indexHtmlSha256: manifest.indexHtmlSha256,
      provenancePath,
      exportPerformed: false,
    };
  } catch (error) {
    await rm(ownedRoot, { recursive: true, force: true });
    throw error;
  }
}

function assertSafeBundleRelativePath(value, sourceName) {
  assert.ok(typeof value === "string" && value.length > 0 && !value.startsWith("/") && !value.includes("\\"), `${sourceName} bundle path must be a non-empty POSIX relative path`);
  const parts = value.split("/");
  assert.ok(parts.every((part) => part && part !== "." && part !== ".."), `${sourceName} bundle path contains an unsafe segment`);
  assert.ok(!parts.some((part) => part === ".env" || part === ".npmrc" || part === ".netrc" || /(?:credential|secret|token|api[-_.]?key|private[-_.]?key)/i.test(part)), `${sourceName} public bundle cannot include credential-like paths`);
  assert.ok(!/\.(?:pem|key|p12|pfx|keystore|jks)$/i.test(value), `${sourceName} public bundle cannot include private key material`);
  return parts;
}

async function assertNoSymlinkAncestors(root, parts, label) {
  let current = root;
  for (const part of parts) {
    current = resolve(current, part);
    const info = await lstat(current);
    assert.ok(!info.isSymbolicLink(), `${label} bundle path contains a symlink`);
  }
}

async function verifyExactBundleTree(root, expectedFiles, label) {
  const foundFiles = new Set();
  const foundDirectories = new Set();
  async function visit(directory, prefix = "") {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const parts = assertSafeBundleRelativePath(relativePath, label);
      const absolutePath = resolve(directory, entry.name);
      const info = await lstat(absolutePath);
      assert.ok(!info.isSymbolicLink(), `${label} bundle tree cannot contain symlinks`);
      if (info.isDirectory()) {
        foundDirectories.add(relativePath);
        await visit(absolutePath, relativePath);
        continue;
      }
      assert.ok(info.isFile(), `${label} bundle tree cannot contain special files`);
      const expected = expectedFiles.get(relativePath);
      assert.ok(expected, `${label} bundle contains an unlisted file: ${relativePath}`);
      assert.equal(info.size, expected.size, `${label} bundle file size changed: ${relativePath}`);
      assert.equal(sha256(await readFile(absolutePath)), expected.sha256, `${label} bundle file digest changed: ${relativePath}`);
      foundFiles.add(relativePath);
    }
  }
  const rootInfo = await lstat(root);
  assert.ok(rootInfo.isDirectory() && !rootInfo.isSymbolicLink(), `${label} bundle root must be a real directory`);
  await visit(root);
  assert.deepEqual([...foundFiles].sort(), [...expectedFiles.keys()].sort(), `${label} bundle file set differs from its manifest`);
  for (const directory of foundDirectories) {
    assert.ok([...expectedFiles.keys()].some((file) => file.startsWith(`${directory}/`)), `${label} bundle contains an unlisted directory`);
  }
}

function installPerformanceInstrumentation() {
  const interactions = new Map();
  const completed = new Map();
  const longTasks = [];
  const longAnimationFrames = [];
  const longAnimationFrameSupport = typeof PerformanceObserver === "function"
    && PerformanceObserver.supportedEntryTypes?.includes("long-animation-frame") === true;
  const eventTasks = [];
  const focusEvents = [];
  const mockSockets = new Map();
  const now = () => Number(performance.now().toFixed(3));
  const safeUrlPath = (value) => {
    try { return new URL(String(value), location.href).pathname; } catch { return ""; }
  };
  const ensureMockSocketRecord = (socket) => {
    if (!socket || typeof socket._id !== "string" || typeof socket._apiSendToPage !== "function") return null;
    let record = mockSockets.get(socket._id);
    if (!record) {
      record = { socket, browserMockId: socket._id, url: String(socket.url ?? ""), outgoingRpc: [], openSeen: false };
      mockSockets.set(socket._id, record);
    }
    return record;
  };
  const nativeDispatchEvent = EventTarget.prototype.dispatchEvent;
  EventTarget.prototype.dispatchEvent = function (event) {
    if (event?.type === "open" && typeof this?.url === "string") {
      const socketRecord = ensureMockSocketRecord(this);
      if (socketRecord) socketRecord.openSeen = true;
    }
    return nativeDispatchEvent.call(this, event);
  };
  window.__phoneRenderFocusEvents = () => focusEvents.slice(-40);
  const describeFocusTarget = (target) => ({
    tag: target instanceof Element ? target.tagName : null,
    testId: target instanceof Element ? target.getAttribute("data-testid") : null,
    role: target instanceof Element ? target.getAttribute("role") : null,
    ariaLabel: target instanceof Element ? target.getAttribute("aria-label") : null,
    className: target instanceof HTMLElement ? String(target.className).slice(0, 100) : null,
  });
  document.addEventListener("focusin", (event) => focusEvents.push({ type: "focusin", at: now(), target: describeFocusTarget(event.target) }), true);
  document.addEventListener("focusout", (event) => focusEvents.push({ type: "focusout", at: now(), target: describeFocusTarget(event.target), relatedTarget: describeFocusTarget(event.relatedTarget) }), true);
  window.__phoneRenderInstallMockSocketSendObserver = () => {
    const prototype = window.WebSocket?.prototype;
    if (!prototype || typeof prototype.send !== "function") return { installed: false, reason: "app-facing WebSocket mock prototype is unavailable" };
    if (prototype.__phoneRenderSendObserverInstalled) return { installed: true, alreadyInstalled: true };
    const originalSend = prototype.send;
    Object.defineProperty(prototype, "send", {
      configurable: true,
      writable: true,
      value(message) {
        const socketRecord = ensureMockSocketRecord(this);
        if (socketRecord) {
          try {
            const frame = JSON.parse(String(message));
            if (typeof frame?.method === "string") {
              socketRecord.outgoingRpc.push({
                method: frame.method,
                id: frame.id ?? null,
                threadId: frame.params?.threadId ?? null,
                at: now(),
              });
              if (socketRecord.outgoingRpc.length > 100) socketRecord.outgoingRpc.shift();
            }
          } catch {}
        }
        return originalSend.call(this, message);
      },
    });
    Object.defineProperty(prototype, "__phoneRenderSendObserverInstalled", { configurable: true, value: true });
    return { installed: true, mockClassName: prototype.constructor?.name ?? null };
  };
  const matchingMockSockets = (payload) => [...mockSockets.values()].filter(({ socket, url, outgoingRpc, openSeen }) => {
    try {
      const parsed = new URL(url, location.href);
      return socket.readyState === WebSocket.OPEN
        && openSeen === true
        && typeof socket._apiSendToPage === "function"
        && parsed.searchParams.get("server") === payload.server
        && parsed.searchParams.get("channel") === payload.channel
        && parsed.searchParams.get("workspace") === payload.workspace
        && outgoingRpc.some((request) => request.method === "thread/read" && request.threadId === payload.threadId && request.id === payload.threadReadId);
    } catch { return false; }
  });
  window.__phoneRenderDeliverFrames = (frames, expectedServer, expectedChannel, expectedWorkspace, expectedThreadId, expectedThreadReadId, captureDispatchDetails = false) => {
    const candidates = matchingMockSockets({ server: expectedServer, channel: expectedChannel, workspace: expectedWorkspace, threadId: expectedThreadId, threadReadId: expectedThreadReadId });
    if (candidates.length !== 1) return {
      delivered: 0,
      eligibleSocketCount: candidates.length,
      candidates: [...mockSockets.values()].map(({ socket, url, browserMockId, outgoingRpc }) => {
        const parsed = new URL(url, location.href);
        return {
          browserMockId,
          hasApiSendToPage: typeof socket._apiSendToPage === "function",
          path: parsed.pathname,
          server: parsed.searchParams.get("server"),
          channel: parsed.searchParams.get("channel"),
          workspace: parsed.searchParams.get("workspace"),
          readyState: socket.readyState,
          onMessageHandler: typeof socket.onmessage === "function",
          recentRequests: outgoingRpc.slice(-16),
          threadReadRequests: outgoingRpc.filter((request) => request.method === "thread/read").slice(-8),
        };
      }),
    };
    const dispatchStartedAt = now();
    for (const state of interactions.values()) {
      if (state.kind === "mutation" && state.finishedAt === null && state.startedAt === null) {
        state.dispatchStartedAt = dispatchStartedAt;
        state.startedAt = dispatchStartedAt;
      }
    }
    const { socket, browserMockId } = candidates[0];
    const dispatchTaskDurationsMs = [];
    const frameResults = [];
    for (const frame of frames) {
      const pageDispatchStartedAt = captureDispatchDetails ? Number(performance.now().toFixed(3)) : null;
      const domRowCountBefore = captureDispatchDetails
        ? document.querySelectorAll('[data-testid="message-user"], [data-testid="message-assistant"]').length
        : null;
      const taskStartedAt = performance.now();
      socket._apiSendToPage(JSON.stringify(frame));
      const dispatchHandlerSyncMs = Number((performance.now() - taskStartedAt).toFixed(3));
      const pageDispatchCompletedAt = captureDispatchDetails ? Number(performance.now().toFixed(3)) : null;
      const domRowCountAfter = captureDispatchDetails
        ? document.querySelectorAll('[data-testid="message-user"], [data-testid="message-assistant"]').length
        : null;
      dispatchTaskDurationsMs.push(dispatchHandlerSyncMs);
      frameResults.push({
        method: frame.method,
        sequence: frame.params?.sequence ?? null,
        serverId: frame.params?.serverId ?? null,
        threadId: frame.params?.threadId ?? null,
        turnId: frame.params?.turnId ?? null,
        browserMockId,
        dispatchHandlerSyncMs,
        ...(captureDispatchDetails ? {
          pageDispatchStartedAtMs: pageDispatchStartedAt,
          pageDispatchCompletedAtMs: pageDispatchCompletedAt,
          domRowCountBefore,
          domRowCountAfter,
        } : {}),
      });
    }
    return {
      delivered: frames.length,
      socketCopies: 1,
      browserMockId,
      dispatchStartedAt,
      frameResults,
      dispatchMethods: frames.map((frame) => frame.method),
      dispatchTaskDurationsMs,
    };
  };
  window.__phoneRenderSocketDiagnostics = () => [...mockSockets.values()].map(({ socket, url, browserMockId, outgoingRpc, openSeen }) => {
    try {
      const parsed = new URL(url, location.href);
      return {
        browserMockId,
        hasApiSendToPage: typeof socket._apiSendToPage === "function",
        openSeen,
        path: parsed.pathname,
        server: parsed.searchParams.get("server"),
        channel: parsed.searchParams.get("channel"),
        workspace: parsed.searchParams.get("workspace"),
        readyState: socket.readyState,
        onMessageHandler: typeof socket.onmessage === "function",
        recentRequests: outgoingRpc.slice(-16),
        threadReadRequests: outgoingRpc.filter((request) => request.method === "thread/read").slice(-8),
      };
    } catch { return { browserMockId, readyState: socket.readyState }; }
  });
  window.__phoneRenderDispatchFrameInTask = async (payload) => {
    const candidates = matchingMockSockets(payload);
    if (candidates.length !== 1) return {
      delivered: false,
      eligibleSocketCount: candidates.length,
      sockets: window.__phoneRenderSocketDiagnostics(),
    };
    const { socket, browserMockId } = candidates[0];
    return new Promise((resolve) => setTimeout(async () => {
      const eventDispatchAt = now();
      if (payload.startMeasurementAtThisFrame) {
        for (const state of interactions.values()) {
          if (state.kind === "mutation" && state.finishedAt === null && state.startedAt === null) {
            state.dispatchStartedAt = eventDispatchAt;
            state.startedAt = eventDispatchAt;
          }
        }
      }
      const taskStartedAt = performance.now();
      // Deliver through Playwright 1.62's app-facing WebSocketMock API. The
      // captured NativeWebSocket is only the upstream transport endpoint.
      socket._apiSendToPage(JSON.stringify(payload.frame));
      const dispatchHandlerSyncMs = Number((performance.now() - taskStartedAt).toFixed(3));
      let twoFrameOpportunityAt = null;
      let finalAssistantRow = null;
      if (payload.waitTwoFrames) {
        await new Promise((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(resolveFrame)));
        twoFrameOpportunityAt = now();
        if (payload.finalMarker) {
          const rows = [...document.querySelectorAll('[data-testid="message-assistant"]')];
          const row = rows.find((element) => (element.textContent ?? "").includes(payload.finalMarker));
          finalAssistantRow = row ? {
            present: true,
            textLength: (row.textContent ?? "").length,
            finalMarkerPresent: (row.textContent ?? "").includes(payload.finalMarker),
            failureMarkerPresent: Boolean(row.querySelector('[data-testid="message-attempt-failure"]')),
            unknownMarkerPresent: Boolean(row.querySelector('[data-testid="message-attempt-unknown"]')),
            runtimeTerminalUi: !document.querySelector('[data-testid="stop-turn"]')
              && Boolean(document.querySelector('[data-testid="send-message"]'))
              && !Boolean(document.querySelector('[data-testid="queue-message"]')),
          } : { present: false, textLength: null, finalMarkerPresent: false };
        }
      }
      resolve({
        delivered: true,
        browserMockId,
        eventDispatchAt,
        dispatchHandlerSyncMs,
        twoFrameOpportunityAt,
        dispatchMethod: payload.frame.method,
        dispatchSequence: payload.frame.params?.sequence ?? null,
        finalAssistantRow,
      });
    }, 0));
  };
  window.__phoneRenderDispatchActiveStreamInTasks = async (payload) => {
    const candidates = matchingMockSockets(payload);
    if (candidates.length !== 1) return {
      delivered: false,
      eligibleSocketCount: candidates.length,
      sockets: window.__phoneRenderSocketDiagnostics(),
    };
    const { socket, browserMockId } = candidates[0];
    const channel = new MessageChannel();
    const frameResults = [];
    const taskResults = [];
    let frameIndex = 0;
    let firstDeltaDispatchAt = null;
    let completionDispatchAt = null;
    const dispatchFrame = (frame) => {
      const eventDispatchAt = now();
      if (frame.method === "item/delta" && firstDeltaDispatchAt === null) {
        firstDeltaDispatchAt = eventDispatchAt;
        for (const state of interactions.values()) {
          if (state.kind === "mutation" && state.finishedAt === null && state.startedAt === null) {
            state.dispatchStartedAt = eventDispatchAt;
            state.startedAt = eventDispatchAt;
          }
        }
      }
      if (frame.method === "turn/completed") completionDispatchAt = eventDispatchAt;
      const handlerStartedAt = performance.now();
      socket._apiSendToPage(JSON.stringify(frame));
      frameResults.push({
        method: frame.method,
        sequence: frame.params?.sequence ?? null,
        serverId: frame.params?.serverId ?? null,
        threadId: frame.params?.threadId ?? null,
        turnId: frame.params?.turnId ?? null,
        eventDispatchAt,
        dispatchHandlerSyncMs: Number((performance.now() - handlerStartedAt).toFixed(3)),
        browserMockId,
      });
    };
    return new Promise((resolve, reject) => {
      channel.port1.onmessage = async () => {
        const browserTaskStartedAt = performance.now();
        const taskMethods = [];
        try {
          const frame = payload.frames[frameIndex++];
          dispatchFrame(frame);
          taskMethods.push(frame.method);
          // Keep the terminal pair in one browser task so turn/completed must flush
          // the final delta while its normal batching timer is still pending.
          if (frame.method === "item/delta" && frameIndex < payload.frames.length && payload.frames[frameIndex].method === "turn/completed") {
            const completionFrame = payload.frames[frameIndex++];
            dispatchFrame(completionFrame);
            taskMethods.push(completionFrame.method);
          }
          taskResults.push({
            frameMethods: taskMethods,
            wallMs: Number((performance.now() - browserTaskStartedAt).toFixed(3)),
          });
          if (frameIndex < payload.frames.length) {
            channel.port2.postMessage(null);
            return;
          }
          channel.port1.close();
          channel.port2.close();
          resolve({
            delivered: frameResults.length,
            browserMockId,
            frameResults,
            taskResults,
            firstDeltaDispatchAt,
            completionDispatchAt,
            deltaBurstDispatchMs: Number((completionDispatchAt - firstDeltaDispatchAt).toFixed(3)),
          });
        } catch (error) {
          channel.port1.close();
          channel.port2.close();
          reject(error);
        }
      };
      channel.port2.postMessage(null);
    });
  };
  const finish = (state, finishedAt, detail = {}) => {
    if (state.finishedAt !== null) return;
    state.finishedAt = finishedAt;
    completed.set(state.id, {
      id: state.id,
      startedAt: state.startedAt,
      finishedAt: state.finishedAt,
      durationMs: Number((state.finishedAt - state.startedAt).toFixed(3)),
      armToNotificationDispatchMs: Number.isFinite(state.dispatchStartedAt) ? Number((state.dispatchStartedAt - state.armedAt).toFixed(3)) : null,
      notificationDispatchAt: Number.isFinite(state.dispatchStartedAt) ? state.dispatchStartedAt : null,
      agentRevisionAt: Number.isFinite(state.agentRevisionAt) ? state.agentRevisionAt : null,
      notificationDispatchToAgentRevisionMs: Number.isFinite(state.dispatchStartedAt) && Number.isFinite(state.agentRevisionAt) ? Number((state.agentRevisionAt - state.dispatchStartedAt).toFixed(3)) : null,
      notificationDispatchToTwoFrameOpportunityMs: Number.isFinite(state.dispatchStartedAt) ? Number((state.finishedAt - state.dispatchStartedAt).toFixed(3)) : null,
      synchronousEventTaskMs: state.synchronousEventTaskMs,
      scrollEventTaskMs: state.scrollEventTaskMs,
      mutationObserverCallbackMs: state.mutationObserverCallbackMs ?? null,
      ...detail,
    });
    state.cleanup?.();
    interactions.delete(state.id);
  };
  const targetIsInput = (target) => target instanceof Element && Boolean(target.closest('[data-testid="message-input"]'));
  const targetIsScrollList = (target) => target instanceof Element && Boolean(target.closest("[data-phone-ux-scroll-host]"));
  const recordTask = (eventName, state, start) => {
    queueMicrotask(() => {
      const durationMs = Number((performance.now() - start).toFixed(3));
      eventTasks.push({ eventName, durationMs, at: now() });
      if (state && state.finishedAt === null) {
        if (eventName === "scroll") state.scrollEventTaskMs = durationMs;
        else state.synchronousEventTaskMs = durationMs;
      }
    });
  };

  window.__phoneRenderArmInput = (id) => {
    interactions.set(id, { id, kind: "input", startedAt: null, finishedAt: null, synchronousEventTaskMs: null, scrollEventTaskMs: null });
  };
  window.__phoneRenderInputResult = (id) => completed.get(id) ?? null;
  window.__phoneRenderArmScroll = (id) => {
    interactions.set(id, { id, kind: "scroll", startedAt: null, finishedAt: null, initialScrollTop: null, host: null, synchronousEventTaskMs: null, scrollEventTaskMs: null });
  };
  window.__phoneRenderArmMutation = (id, marker) => {
    const state = {
      id,
      marker,
      kind: "mutation",
      armedAt: now(),
      startedAt: null,
      dispatchStartedAt: null,
      agentRevisionAt: null,
      finishedAt: null,
      synchronousEventTaskMs: null,
      scrollEventTaskMs: null,
      mutationObserverCallbackMs: null,
      agentRevision: null,
      changesFilenameMarkerAt: null,
      cleanup: null,
    };
    const root = document.querySelector('[data-testid="message-list"]');
    const changesRoot = document.querySelector('[data-testid="changes-panel"]');
    const baseline = new Map(
      [...(root?.querySelectorAll('[data-testid="message-assistant"]') ?? [])]
        .map((row) => [row, row.textContent ?? ""]),
    );
    const observers = [];
    if (root) {
      const observer = new MutationObserver(() => {
        const callbackStartedAt = performance.now();
        const rows = [...root.querySelectorAll('[data-testid="message-assistant"]')];
        const changedIndex = rows.findIndex((row) => {
          const text = row.textContent ?? "";
          return text.includes(marker) && (!baseline.has(row) || baseline.get(row) !== text);
        });
        if (changedIndex < 0 || state.finishedAt !== null) return;
        const row = rows[changedIndex];
        state.mutationObserverCallbackMs = Number((performance.now() - callbackStartedAt).toFixed(3));
        state.agentRevisionAt = now();
        state.agentRevision = {
          assistantRowCount: rows.length,
          changedRowIndex: changedIndex,
          textLength: (row.textContent ?? "").length,
          fixtureMarkerPresent: (row.textContent ?? "").includes(marker),
        };
        requestAnimationFrame(() => requestAnimationFrame(() => finish(state, now(), {
          event: "synthetic-websocket-frame-to-agent-content-revision-two-frame-opportunity",
          agentRevision: state.agentRevision,
          changesFilenameMarkerObserved: state.changesFilenameMarkerAt !== null,
          changesFilenameMarkerAt: state.changesFilenameMarkerAt,
        })));
      });
      observer.observe(root, { childList: true, subtree: true, characterData: true });
      observers.push(observer);
    }
    if (changesRoot) {
      const changesObserver = new MutationObserver(() => {
        if (state.changesFilenameMarkerAt !== null || state.finishedAt !== null) return;
        const matched = changesRoot.textContent?.includes(marker) ?? false;
        if (matched) state.changesFilenameMarkerAt = now();
      });
      changesObserver.observe(changesRoot, { childList: true, subtree: true, characterData: true });
      observers.push(changesObserver);
    }
    state.cleanup = () => observers.forEach((observer) => observer.disconnect());
    interactions.set(id, state);
    return { observedRoot: Boolean(root), primaryBoundary: "changed assistant-row text under Mobile message-list followed by two requestAnimationFrame callbacks", supplementalChangesObserver: Boolean(changesRoot) };
  };
  window.__phoneRenderMutationResult = (id) => completed.get(id) ?? null;
  window.__phoneRenderLongTasks = () => longTasks.slice();
  window.__phoneRenderLongTasksBetween = (startedAt, finishedAt) => longTasks.filter((task) => task.startTimeMs < finishedAt && task.startTimeMs + task.durationMs >= startedAt);
  window.__phoneRenderLongAnimationFrameSupport = () => longAnimationFrameSupport;
  window.__phoneRenderLongAnimationFramesBetween = (startedAt, finishedAt) => longAnimationFrames.filter((frame) => frame.startTimeMs < finishedAt && frame.startTimeMs + frame.durationMs >= startedAt);
  window.__phoneRenderEventTasks = () => eventTasks.slice();

  document.addEventListener("keydown", (event) => {
    if (!targetIsInput(event.target)) return;
    const state = [...interactions.values()].find((value) => value.kind === "input" && value.startedAt === null);
    if (!state) return;
    state.startedAt = now();
    state.expectedValue = `${event.target.value ?? ""}${event.key.length === 1 ? event.key : ""}`;
    const start = performance.now();
    recordTask("keydown", state, start);
    requestAnimationFrame(() => {
      const input = document.querySelector('[data-testid="message-input"]');
      if (!(input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement)) return;
      if (input.value === state.expectedValue) finish(state, now(), { event: "keydown", inputValueLength: input.value.length });
    });
  }, true);
  document.addEventListener("input", (event) => {
    if (!targetIsInput(event.target)) return;
    const state = [...interactions.values()].find((value) => value.kind === "input" && value.startedAt === null);
    if (state) {
      state.startedAt = now();
      state.expectedValue = event.target.value;
      const start = performance.now();
      recordTask("input", state, start);
      requestAnimationFrame(() => finish(state, now(), { event: "input", inputValueLength: String(event.target.value ?? "").length }));
    }
  }, true);
  document.addEventListener("touchstart", (event) => {
    const state = [...interactions.values()].find((value) => value.kind === "scroll" && value.startedAt === null);
    if (!state || !targetIsScrollList(event.target)) return;
    const host = event.target.closest("[data-phone-ux-scroll-host]");
    state.startedAt = now();
    state.host = host;
    state.initialScrollTop = host.scrollTop;
    const start = performance.now();
    recordTask("touchstart", state, start);
  }, true);
  document.addEventListener("scroll", (event) => {
    const state = [...interactions.values()].find((value) => value.kind === "scroll" && value.startedAt !== null && value.finishedAt === null && !value.scrollSeen);
    if (!state || event.target !== state.host) return;
    state.scrollSeen = true;
    const start = performance.now();
    recordTask("scroll", state, start);
    requestAnimationFrame(() => {
      const delta = Math.abs(Number(state.host.scrollTop) - Number(state.initialScrollTop));
      if (delta > 1) finish(state, now(), { event: "touchstart-to-scroll-frame", scrollDeltaPx: Number(delta.toFixed(2)) });
    });
  }, true);

  if (typeof PerformanceObserver === "function") {
    try {
      new PerformanceObserver((listValue) => {
        for (const entry of listValue.getEntries()) {
          longTasks.push({
            startTimeMs: Number(entry.startTime.toFixed(3)),
            durationMs: Number(entry.duration.toFixed(3)),
            name: String(entry.name ?? "unknown").slice(0, 100),
            attribution: (entry.attribution ?? []).slice(0, 4).map((item) => ({
              containerType: String(item.containerType ?? "").slice(0, 40),
              containerName: String(item.containerName ?? "").slice(0, 100),
              containerSrcPath: safeUrlPath(item.containerSrc),
            })),
          });
        }
      }).observe({ type: "longtask", buffered: true });
    } catch {}
    if (longAnimationFrameSupport) {
      try {
        new PerformanceObserver((listValue) => {
          for (const entry of listValue.getEntries()) {
            longAnimationFrames.push({
              startTimeMs: Number(entry.startTime.toFixed(3)),
              durationMs: Number(entry.duration.toFixed(3)),
              blockingDurationMs: Number((entry.blockingDuration ?? 0).toFixed(3)),
              renderStartMs: Number((entry.renderStart ?? 0).toFixed(3)),
              styleAndLayoutStartMs: Number((entry.styleAndLayoutStart ?? 0).toFixed(3)),
              firstUIEventTimestampMs: Number((entry.firstUIEventTimestamp ?? 0).toFixed(3)),
              scripts: (entry.scripts ?? []).slice(0, 20).map((script) => ({
                startTimeMs: Number((script.startTime ?? 0).toFixed(3)),
                durationMs: Number((script.duration ?? 0).toFixed(3)),
                executionStartMs: Number((script.executionStart ?? 0).toFixed(3)),
                forcedStyleAndLayoutDurationMs: Number((script.forcedStyleAndLayoutDuration ?? 0).toFixed(3)),
                pauseDurationMs: Number((script.pauseDuration ?? 0).toFixed(3)),
                sourceFunctionName: String(script.sourceFunctionName ?? "").slice(0, 160),
                sourceUrlPath: safeUrlPath(script.sourceURL),
                sourceCharPosition: Number.isInteger(script.sourceCharPosition) ? script.sourceCharPosition : null,
                invoker: String(script.invoker ?? "").slice(0, 160),
                invokerType: String(script.invokerType ?? "").slice(0, 80),
                windowAttribution: String(script.windowAttribution ?? "").slice(0, 40),
              })),
            });
          }
        }).observe({ type: "long-animation-frame", buffered: true });
      } catch {}
    }
  }
}

async function configureRuntimeConsumerProbe(page, marker) {
  const safeMarker = marker.replace(/[^A-Za-z0-9_-]/g, "_");
  const identity = {
    marker,
    turnId: `ux-profile-turn-${safeMarker}`,
    itemId: `ux-profile-item-${safeMarker}`,
  };
  let result;
  try {
    result = await page.evaluate((value) => {
      const probe = window.__phoneRuntimeProbe;
      if (!probe || typeof probe.configure !== "function" || typeof probe.drain !== "function") {
        return { status: "PROBE_GLOBAL_UNAVAILABLE" };
      }
      try {
        return {
          status: probe.configure(value) === true ? "CONFIGURED" : "PROBE_CONFIG_REJECTED",
          configuredMarker: value.marker,
        };
      } catch {
        return { status: "PROBE_CONFIG_THROWN" };
      }
    }, identity);
  } catch (error) {
    result = { status: "PROBE_PAGE_CONFIGURATION_READ_FAILED", error: safeSeedErrorMessage(error) };
  }
  return { ...result, identity };
}

async function readRuntimeConsumerProbe(page, runtimeProbe, stage) {
  if (runtimeProbe?.configuration?.status !== "CONFIGURED") {
    return {
      stage: String(stage).slice(0, 64),
      status: "NOT_RUN_CONFIGURATION_UNAVAILABLE",
      configurationStatus: String(runtimeProbe?.configuration?.status ?? "PROBE_NOT_CONFIGURED").slice(0, 48),
      records: [],
    };
  }
  return drainRuntimeConsumerProbe(page, stage);
}

async function drainRuntimeConsumerProbe(page, stage) {
  try {
    return await page.evaluate((stageName) => {
    const probe = window.__phoneRuntimeProbe;
    if (!probe || typeof probe.drain !== "function") {
      return { stage: stageName, status: "PROBE_GLOBAL_UNAVAILABLE", records: [] };
    }
    let value;
    try { value = probe.drain(); }
    catch { return { stage: stageName, status: "PROBE_DRAIN_FAILED", records: [] }; }
    const asInt = (input) => Number.isSafeInteger(input) && input >= 0 ? input : null;
    const asText = (input, max = 48) => typeof input === "string" ? input.slice(0, max) : null;
    const sourceRecords = Array.isArray(value?.records) ? value.records : [];
    const records = sourceRecords.slice(0, 64).map((row) => {
      const snapshot = row?.snapshot && typeof row.snapshot === "object" ? row.snapshot : {};
      return {
        ordinal: asInt(row?.ordinal),
        kind: asText(row?.kind, 32),
        threadFingerprint: asText(row?.threadFingerprint, 16),
        turnFingerprint: asText(row?.turnFingerprint, 16),
        itemFingerprint: asText(row?.itemFingerprint, 16),
        rpcMethod: asText(row?.rpcMethod, 40),
        arrivalOrdinal: asInt(row?.arrivalOrdinal),
        snapshot: {
          messageCount: asInt(snapshot.messageCount),
          assistantMatchCount: asInt(snapshot.assistantMatchCount),
          contentLength: asInt(snapshot.contentLength),
          markerPresent: snapshot.markerPresent === true,
          status: asText(snapshot.status, 32),
          running: typeof snapshot.running === "boolean" ? snapshot.running : null,
          connected: typeof snapshot.connected === "boolean" ? snapshot.connected : null,
          disposed: typeof snapshot.disposed === "boolean" ? snapshot.disposed : null,
        },
      };
    });
    return {
      stage: stageName,
      status: value?.schemaVersion === 1 && value?.limit === 64 && Array.isArray(value?.records) ? "CAPTURED" : "INVALID_PROBE_ENVELOPE",
      sampledAtPageTimeMs: Number(performance.now().toFixed(3)),
      schemaVersion: value?.schemaVersion === 1 ? 1 : null,
      limit: value?.limit === 64 ? 64 : null,
      dropped: asInt(value?.dropped),
      sourceRecordCount: sourceRecords.length,
      harnessTruncated: sourceRecords.length > 64,
      records,
    };
    }, String(stage).slice(0, 64));
  } catch (error) {
    return {
      stage: String(stage).slice(0, 64),
      status: "PROBE_PAGE_READ_FAILED",
      sampledAtPageTimeMs: null,
      schemaVersion: null,
      limit: null,
      dropped: null,
      sourceRecordCount: null,
      harnessTruncated: false,
      records: [],
      readError: safeSeedErrorMessage(error),
    };
  }
}

function buildRuntimeConsumerSeedDiagnostic(source, state, seed, mobileWeb) {
  const probe = seed.runtimeProbe ?? { configuration: null, reads: [] };
  const reads = Array.isArray(probe.reads) ? probe.reads.slice(0, 2) : [];
  const records = reads.flatMap((read) => Array.isArray(read.records) ? read.records : []).slice(0, 128);
  const identity = probe.configuration?.identity ?? {};
  const fingerprint = (value) => {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
    return (hash >>> 0).toString(16).padStart(8, "0");
  };
  const expectedMethods = ["turn/started", "item/started", "item/delta", "turn/completed"];
  const rpcEnterMethods = records.filter((record) => record.kind === "rpc-enter").map((record) => record.rpcMethod);
  const acceptedMethods = records.filter((record) => record.kind === "protocol-accepted").map((record) => record.rpcMethod);
  const rpcReturnMethods = records.filter((record) => record.kind === "rpc-return").map((record) => record.rpcMethod);
  const snapshots = records.filter((record) => record.kind === "snapshot");
  const markerSnapshots = snapshots.filter((record) => record.snapshot.markerPresent);
  const markerTerminalSnapshots = markerSnapshots.filter((record) => record.snapshot.status === "completed");
  const probeConfigured = probe.configuration?.status === "CONFIGURED";
  const identitiesMatch = probeConfigured && records.length > 0 && records.every((record) => record.threadFingerprint === fingerprint(threadId)
    && record.turnFingerprint === fingerprint(identity.turnId ?? "")
    && record.itemFingerprint === fingerprint(identity.itemId ?? ""));
  const readFailureStatuses = reads
    .filter((read) => ["PROBE_DRAIN_FAILED", "PROBE_PAGE_READ_FAILED", "INVALID_PROBE_ENVELOPE"].includes(read.status))
    .map((read) => read.status);
  const everyMethodEntered = expectedMethods.every((method) => rpcEnterMethods.includes(method));
  const everyMethodAccepted = expectedMethods.every((method) => acceptedMethods.includes(method));
  let projectionStatus = "PROJECTION_NOT_OBSERVED";
  if (!probeConfigured) projectionStatus = "NOT_RUN";
  else if (readFailureStatuses.length > 0) projectionStatus = "OBSERVATION_READ_FAILED";
  else if (records.some((record) => record.kind === "rpc-threw")) projectionStatus = "RUNTIME_HANDLER_THROW_OBSERVED";
  else if (markerTerminalSnapshots.length > 0 && !identitiesMatch) projectionStatus = "TERMINAL_MARKER_IDENTITY_MISMATCH";
  else if (markerTerminalSnapshots.length > 0 && (!everyMethodEntered || !everyMethodAccepted)) projectionStatus = "TERMINAL_MARKER_WITH_INCOMPLETE_INGRESS_EVIDENCE";
  else if (markerTerminalSnapshots.length > 0 && identitiesMatch && everyMethodEntered && everyMethodAccepted) projectionStatus = "MARKER_AND_TERMINAL_STATE_OBSERVED";
  else if (markerSnapshots.length > 0) projectionStatus = "MARKER_OBSERVED_WITHOUT_TERMINAL_STATE";
  else if (everyMethodEntered) projectionStatus = "HANDLER_INGRESS_OBSERVED_WITHOUT_MARKER_SNAPSHOT";
  else if (records.some((record) => record.kind === "registered")) projectionStatus = "RUNTIME_REGISTERED_BUT_FRAME_INGRESS_INCOMPLETE";
  return {
    schemaVersion: 1,
    diagnosticOnly: true,
    performanceSample: false,
    evidenceClass: "isolated Mobile Web app-facing Playwright WebSocketMock dispatch plus private passive TaskRuntime projection; KCODER_STUDIO_MOCK Gateway, no Provider, no real app-server turn",
    source: {
      name: source.name,
      sourceTreeSha256: source.sourceTreeSha256,
      sourceFreezeEvidenceDigest: source.sourceFreezeEvidenceDigest,
      exportManifestSha256: source.exportManifestSha256,
      bundleSha256: mobileWeb.bundleSha256,
    },
    fixture: {
      requestedMessages: state.count,
      historyRowsDelivered: state.historyRowsDelivered,
      totalLoadedMessagesAfterSeed: state.historyRowsDelivered + 1,
      panelState: state.panelState,
      marker: identity.marker ?? null,
      turnId: identity.turnId ?? null,
      itemId: identity.itemId ?? null,
      threadId: threadId,
      activeRouteOrdinal: state.activeSocketRoute?.routeOrdinal ?? null,
      activeThreadReadRequestId: state.activeThreadReadRequestId,
    },
    mockDispatch: seed.seedDispatch ?? null,
    consumerProjection: {
      status: projectionStatus,
      configurationStatus: probe.configuration?.status ?? "PROBE_NOT_CONFIGURED",
      observationReadFailureCount: readFailureStatuses.length,
      observationReadFailureStatuses: readFailureStatuses,
      configure: probe.configuration,
      ringCapacityPerRead: 64,
      maximumStoredRecords: 128,
      readouts: reads,
      recordCount: records.length,
      runtimeRegistered: records.some((record) => record.kind === "registered"),
      rpcEnterMethods,
      protocolAcceptedMethods: acceptedMethods,
      rpcReturnMethods,
      handlerThrowCount: records.filter((record) => record.kind === "rpc-threw").length,
      snapshotRecordCount: snapshots.length,
      markerSnapshotCount: markerSnapshots.length,
      markerTerminalSnapshotCount: markerTerminalSnapshots.length,
      configuredIdentityFingerprintsMatch: probeConfigured && identitiesMatch,
      allFourMethodsEntered: everyMethodEntered,
      allFourMethodsProtocolAccepted: everyMethodAccepted,
      markerPresentInRuntimeSnapshot: markerSnapshots.length > 0,
      completedStatusObservedInMarkerSnapshot: markerTerminalSnapshots.length > 0,
    },
    domBoundary: {
      passedSeedVisibleTailGate: seed.ok === true,
      transcriptViewport: seed.transcriptViewport ?? null,
      changesPanelMounted: state.changesPanelMounted === true,
      changesPanelVisibilityEvidence: state.hiddenPanelEvidence ?? null,
      note: "Seed settlement requires the exact marker last-character Range to intersect the message-list viewport, stable tail geometry, and two animation-frame opportunities; probe reads do not alter or extend that gate.",
    },
    restrictions: {
      runtimeHandlerCalledDirectly: false,
      notificationFramesSentThrough: "the same identified app-facing Playwright 1.62 WebSocketMock selected by the existing active thread/read route guard",
      projectionReads: "one immediate drain after the four Mock frames and one drain after the existing DOM visibility/geometry gate; each drain is capped at 64 records",
      nativeStatus: "UNVERIFIED: Mobile Web Chromium only",
    },
  };
}

function summarizeSeedDispatchEvidence(state, marker, result, frames = []) {
  const frameResults = Array.isArray(result?.frameResults) ? result.frameResults : [];
  const expectedMethods = ["turn/started", "item/started", "item/delta", "turn/completed"];
  const observedMethods = frameResults.map((frame) => frame.method);
  const sequences = frameResults.map((frame) => frame.sequence);
  const expectedFrames = frames.map((frame) => ({
    method: frame.method,
    sequence: frame.params?.sequence ?? null,
    serverId: frame.params?.serverId ?? null,
    threadId: frame.params?.threadId ?? null,
    turnId: frame.params?.turnId ?? null,
  }));
  const browserMockIds = [...new Set(frameResults.map((frame) => frame.browserMockId).filter(Boolean))];
  const turnId = expectedFrames[0]?.turnId ?? null;
  const dispatchOrderValid = frameResults.length === expectedMethods.length
    && frames.length === expectedMethods.length
    && result?.delivered === expectedMethods.length
    && observedMethods.every((method, index) => method === expectedMethods[index])
    && frameResults.every((frame, index) => frame.serverId === expectedFrames[index]?.serverId
      && frame.threadId === expectedFrames[index]?.threadId
      && frame.turnId === expectedFrames[index]?.turnId)
    && browserMockIds.length === 1
    && frameResults.every((frame) => frame.browserMockId === result?.browserMockId)
    && sequences.every((value, index) => Number.isSafeInteger(value)
      && value === expectedFrames[index]?.sequence
      && (index === 0 || value > sequences[index - 1]));
  const route = state.activeSocketRoute;
  const durations = frameResults.map((frame) => frame.dispatchHandlerSyncMs).filter(Number.isFinite);
  return {
    marker,
    turnId,
    attemptId: expectedFrames[0] ? frames[0].params?.attemptId ?? null : null,
    itemId: expectedFrames[1] ? frames[1].params?.item?.id ?? null : null,
    serverId,
    channel: "runtime",
    workspaceLabel: `run-owned/workspace-${state.source}`,
    threadId,
    threadReadRequestId: state.activeThreadReadRequestId,
    route: route ? {
      routeOrdinal: route.routeOrdinal,
      server: route.server,
      channel: route.channel,
      workspaceMatchesFixture: route.workspaceMatchesFixture,
      threadReadRequestId: route.threadReadRequestId,
    } : null,
    deliveryReturned: result?.delivered ?? 0,
    expectedFrameCount: frames.length,
    eligibleSocketCount: result?.eligibleSocketCount ?? (frameResults.length ? 1 : 0),
    socketCopies: result?.socketCopies ?? null,
    browserMockId: result?.browserMockId ?? browserMockIds[0] ?? null,
    expectedFrames,
    observedMethods,
    observedSequences: sequences,
    dispatchOrderValid,
    dispatchTaskDurationsMs: result?.dispatchTaskDurationsMs ?? frameResults.map((frame) => frame.dispatchHandlerSyncMs),
    maximumDispatchHandlerSyncMs: durations.length ? Math.max(...durations) : null,
    frameResults: frameResults.map((frame) => ({
      method: frame.method,
      sequence: frame.sequence,
      serverId: frame.serverId,
      threadId: frame.threadId,
      turnId: frame.turnId,
      browserMockId: frame.browserMockId,
      dispatchHandlerSyncMs: frame.dispatchHandlerSyncMs,
      pageDispatchStartedAtMs: frame.pageDispatchStartedAtMs ?? null,
      pageDispatchCompletedAtMs: frame.pageDispatchCompletedAtMs ?? null,
      domRowCountBefore: frame.domRowCountBefore ?? null,
      domRowCountAfter: frame.domRowCountAfter ?? null,
    })),
    terminalNotificationStatus: frames.find((frame) => frame.method === "turn/completed")?.params?.turn?.status ?? null,
    fileChangesStatus: frames.find((frame) => frame.method === "turn/completed")?.params?.fileChanges?.status ?? null,
    evidenceBoundary: "test-side app-facing Playwright WebSocketMock dispatch and handler synchrony; does not alone prove reducer state, rendered row, queue state, or task submission",
  };
}

function summarizeSeedTranscriptViewport(viewport) {
  if (!viewport) return null;
  const compactSample = (sample) => sample ? ({
    observationSource: sample.observationSource ?? null,
    poll: sample.poll ?? null,
    sampledAtPageTimeMs: sample.sampledAtPageTimeMs ?? null,
    scrollTop: sample.scrollTop ?? null,
    scrollHeight: sample.scrollHeight ?? null,
    clientHeight: sample.clientHeight ?? null,
    bottomGapPx: sample.bottomGapPx ?? null,
    renderedMessageRowCount: sample.renderedMessageRowCount ?? null,
    targetRowFound: sample.targetRowFound ?? false,
    targetVisibleWithinMessageList: sample.targetVisibleWithinMessageList ?? false,
    targetRowRect: sample.targetRowRect ?? null,
    targetMarkerGeometryIncluded: sample.targetMarkerGeometryIncluded ?? false,
    targetMarkerOccurrenceCount: sample.targetMarkerOccurrenceCount ?? null,
    targetMarkerSelectedOccurrenceIndex: sample.targetMarkerSelectedOccurrenceIndex ?? null,
    targetMarkerLastCharacterRect: sample.targetMarkerLastCharacterRect ?? null,
    targetMarkerVisibleWithinMessageList: sample.targetMarkerVisibleWithinMessageList ?? null,
    jumpToLatestVisible: sample.jumpToLatestVisible ?? false,
  }) : null;
  const samples = Array.isArray(viewport.pollSamples) ? viewport.pollSamples.slice(0, 200) : [];
  return {
    expectedTailMarker: viewport.expectedTailMarker ?? null,
    before: compactSample(viewport.before),
    last: compactSample(viewport.last),
    afterTwoFrames: compactSample(viewport.afterTwoFrames),
    actions: (viewport.actions ?? []).map((action) => ({
      action: action.action,
      attemptNumber: action.attemptNumber ?? null,
      atPoll: action.atPoll ?? null,
      timeoutMs: action.timeoutMs ?? null,
      outcome: action.outcome ?? null,
      errorKind: action.errorKind ?? null,
      viewport: compactSample(action.viewport),
      recheck: action.recheck ? {
        locatorVisible: action.recheck.locatorVisible,
        buttonGone: action.recheck.buttonGone,
        viewport: compactSample(action.recheck.viewport),
      } : null,
    })),
    pollSamples: samples.map(compactSample),
    stableSamples: viewport.stableSamples ?? 0,
    pollCount: viewport.pollCount ?? samples.length,
    geometryStableAfterTwoFrames: viewport.geometryStableAfterTwoFrames ?? null,
  };
}

function safeSeedErrorMessage(error) {
  let message = String(error?.message || error || "seed failure");
  const routeDetails = message.indexOf("routeEvidence=");
  if (routeDetails >= 0) message = `${message.slice(0, routeDetails)}[route details omitted]`;
  const candidateDetails = message.indexOf("candidates=");
  if (candidateDetails >= 0) message = `${message.slice(0, candidateDetails)}[candidate details omitted]`;
  message = message.replace(/\b(?:https?|wss?|file):\/\/[^\s"'<>]+/gi, "[url omitted]");
  return message.slice(0, 500);
}

function safeSeedErrorStack(error) {
  if (typeof error?.stack !== "string") return null;
  return error.stack.split("\n").slice(0, 8).join("\n")
    .replace(/\b(?:https?|wss?|file):\/\/[^\s"'<>]+/gi, "[url omitted]")
    .slice(0, 1_200);
}

function beginSeedUiTraceInPage({ marker }) {
  const list = document.querySelector('[data-testid="message-list"]');
  if (!(list instanceof HTMLElement)) throw new Error("seed DOM trace could not find message-list");
  const scrollables = [list, ...list.querySelectorAll("*")].filter((element) =>
    element instanceof HTMLElement && element.scrollHeight > element.clientHeight + 16,
  ).sort((left, right) => (right.scrollHeight - right.clientHeight) - (left.scrollHeight - left.clientHeight));
  const hostCandidate = list.querySelector("[data-phone-ux-scroll-host]");
  const host = hostCandidate instanceof HTMLElement ? hostCandidate : scrollables[0] ?? list;
  const maxEntries = 200;
  const trace = {
    schemaVersion: 1,
    boundary: "seed only; standard DOM scroll/pointer/touch/wheel/MutationObserver/ResizeObserver; no React internals",
    marker,
    startedAtPageTimeMs: Number(performance.now().toFixed(3)),
    initialLayout: null,
    finalLayout: null,
    scrollEvents: [],
    resizeEvents: [],
    mutationEvents: [],
    pointerEvents: [],
    dropped: { scrollEvents: 0, resizeEvents: 0, mutationEvents: 0, pointerEvents: 0 },
  };
  let stopped = false;
  const resizeObserved = new WeakSet();
  const append = (key, value) => {
    if (trace[key].length < maxEntries) trace[key].push(value);
    else trace.dropped[key] += 1;
  };
  const rect = (element) => {
    if (!(element instanceof Element)) return null;
    const value = element.getBoundingClientRect();
    return {
      top: Number(value.top.toFixed(2)),
      bottom: Number(value.bottom.toFixed(2)),
      left: Number(value.left.toFixed(2)),
      right: Number(value.right.toFixed(2)),
      width: Number(value.width.toFixed(2)),
      height: Number(value.height.toFixed(2)),
    };
  };
  const rowsNow = () => [...list.querySelectorAll('[data-testid="message-user"], [data-testid="message-assistant"]')];
  const markerTokens = (text) => [...new Set(text.match(/(?:HISTORY-\d{4}|seed-[A-Za-z0-9_-]+|UX-[A-Za-z0-9_-]+)/g) ?? [])].slice(0, 12);
  const rowEvidence = () => {
    const rows = rowsNow();
    const selectedIndexes = new Set();
    for (let index = 0; index < Math.min(4, rows.length); index += 1) selectedIndexes.add(index);
    for (let index = Math.max(0, rows.length - 4); index < rows.length; index += 1) selectedIndexes.add(index);
    rows.forEach((row, index) => {
      const text = row.textContent ?? "";
      if (text.includes(marker) || /HISTORY-\d{4}/.test(text)) selectedIndexes.add(index);
    });
    const listRect = list.getBoundingClientRect();
    return [...selectedIndexes].sort((left, right) => left - right).slice(0, 24).map((index) => {
      const row = rows[index];
      const rowRect = row.getBoundingClientRect();
      return {
        mountedDomIndex: index,
        testId: row.getAttribute("data-testid"),
        dataIndex: row.getAttribute("data-index"),
        ariaPosInSet: row.getAttribute("aria-posinset"),
        markerTokens: markerTokens(row.textContent ?? ""),
        targetMarkerFound: (row.textContent ?? "").includes(marker),
        textLength: (row.textContent ?? "").length,
        rect: rect(row),
        intersectsMessageList: rowRect.width > 0 && rowRect.height > 0
          && rowRect.right > listRect.left && rowRect.left < listRect.right
          && rowRect.bottom > listRect.top && rowRect.top < listRect.bottom,
      };
    });
  };
  const spacerEvidence = () => {
    const candidates = [...new Set([list, ...list.children, host, ...host.children])];
    return candidates.map((element, index) => {
      if (!(element instanceof HTMLElement)) return null;
      const textLength = (element.textContent ?? "").trim().length;
      const box = rect(element);
      if (textLength !== 0 || !box || (box.height <= 0 && element.scrollHeight <= 0)) return null;
      const parentLabel = element === list ? "message-list"
        : element === host ? "scroll-host"
          : element.parentElement === list ? "message-list-child"
            : element.parentElement === host ? "scroll-host-child" : "container-child";
      return {
        candidateIndex: index,
        parentLabel,
        tagName: element.tagName,
        testId: element.getAttribute("data-testid"),
        dataIndex: element.getAttribute("data-index"),
        textLength,
        childCount: element.children.length,
        rect: box,
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
      };
    }).filter(Boolean).slice(0, 24);
  };
  const metrics = () => {
    const listRect = list.getBoundingClientRect();
    const jump = document.querySelector('[data-testid="jump-to-latest"]');
    const jumpRect = jump?.getBoundingClientRect();
    const jumpStyle = jump instanceof HTMLElement ? getComputedStyle(jump) : null;
    const jumpVisible = Boolean(jumpRect && jumpRect.width > 0 && jumpRect.height > 0
      && jumpStyle?.display !== "none" && jumpStyle?.visibility !== "hidden");
    return {
      pageTimeMs: Number(performance.now().toFixed(3)),
      scrollHostTestId: host.getAttribute("data-testid"),
      scrollTop: Number(host.scrollTop.toFixed(2)),
      scrollHeight: host.scrollHeight,
      clientHeight: host.clientHeight,
      bottomGapPx: Number(Math.max(0, host.scrollHeight - host.clientHeight - host.scrollTop).toFixed(2)),
      listRect: rect(list),
      renderedMessageRowCount: rowsNow().length,
      targetMarkerRowFound: rowsNow().some((row) => (row.textContent ?? "").includes(marker)),
      jumpToLatestVisible: jumpVisible,
    };
  };
  const layout = () => ({ ...metrics(), rows: rowEvidence(), nonTextChildSpacers: spacerEvidence() });
  const testIdFor = (target) => {
    const element = target instanceof Element ? target : null;
    const nearest = element?.closest("[data-testid]");
    return nearest?.getAttribute("data-testid") ?? null;
  };
  const syncResizeTargets = () => {
    for (const element of [list, host, list.firstElementChild, host.firstElementChild, ...list.children, ...host.children]) {
      if (!(element instanceof Element) || resizeObserved.has(element)) continue;
      resizeObserved.add(element);
      try { resizeObserver.observe(element); } catch {}
    }
  };
  const onScroll = (event) => append("scrollEvents", {
    eventType: "scroll",
    isTrusted: event.isTrusted,
    targetTestId: testIdFor(event.target),
    ...metrics(),
  });
  const onPointer = (event) => append("pointerEvents", {
    eventType: event.type,
    isTrusted: event.isTrusted,
    targetTestId: testIdFor(event.target),
    pageTimeMs: Number(performance.now().toFixed(3)),
    eventTimeStampMs: Number(event.timeStamp.toFixed(3)),
    ...metrics(),
  });
  document.addEventListener("scroll", onScroll, true);
  for (const eventName of ["pointerdown", "touchstart", "wheel"]) document.addEventListener(eventName, onPointer, true);
  const resizeObserver = new ResizeObserver((entries) => {
    append("resizeEvents", {
      eventType: "resize-observer",
      pageTimeMs: Number(performance.now().toFixed(3)),
      entries: entries.slice(0, 24).map((entry) => ({
        targetTestId: entry.target.getAttribute?.("data-testid") ?? null,
        targetTagName: entry.target.tagName,
        contentRect: {
          width: Number(entry.contentRect.width.toFixed(2)),
          height: Number(entry.contentRect.height.toFixed(2)),
        },
        scrollHeight: entry.target.scrollHeight ?? null,
        clientHeight: entry.target.clientHeight ?? null,
      })),
      layout: layout(),
    });
  });
  const mutationObserver = new MutationObserver((records) => {
    syncResizeTargets();
    append("mutationEvents", {
      eventType: "mutation-observer",
      pageTimeMs: Number(performance.now().toFixed(3)),
      recordCount: records.length,
      childListRecords: records.filter((record) => record.type === "childList").length,
      characterDataRecords: records.filter((record) => record.type === "characterData").length,
      targetTestIds: [...new Set(records.map((record) => testIdFor(record.target)).filter(Boolean))].slice(0, 12),
      layout: layout(),
    });
  });
  syncResizeTargets();
  resizeObserver.observe(list);
  resizeObserver.observe(host);
  mutationObserver.observe(list, { childList: true, subtree: true, characterData: true });
  trace.initialLayout = layout();
  window.__phoneSeedUiTrace = {
    stop() {
      if (stopped) return trace;
      stopped = true;
      const pendingMutations = mutationObserver.takeRecords();
      if (pendingMutations.length) {
        append("mutationEvents", {
          eventType: "mutation-observer-pending-at-stop",
          pageTimeMs: Number(performance.now().toFixed(3)),
          recordCount: pendingMutations.length,
          childListRecords: pendingMutations.filter((record) => record.type === "childList").length,
          characterDataRecords: pendingMutations.filter((record) => record.type === "characterData").length,
          targetTestIds: [...new Set(pendingMutations.map((record) => testIdFor(record.target)).filter(Boolean))].slice(0, 12),
          layout: layout(),
        });
      }
      trace.finalLayout = layout();
      trace.endedAtPageTimeMs = Number(performance.now().toFixed(3));
      trace.resizeEventCount = trace.resizeEvents.length;
      trace.mutationEventCount = trace.mutationEvents.length;
      trace.scrollEventCount = trace.scrollEvents.length;
      trace.pointerEventCount = trace.pointerEvents.length;
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      document.removeEventListener("scroll", onScroll, true);
      for (const eventName of ["pointerdown", "touchstart", "wheel"]) document.removeEventListener(eventName, onPointer, true);
      delete window.__phoneSeedUiTrace;
      return trace;
    },
  };
  return { started: true, pageTimeMs: trace.startedAtPageTimeMs, initialLayout: trace.initialLayout };
}

function endSeedUiTraceInPage() {
  return window.__phoneSeedUiTrace?.stop?.() ?? null;
}

async function captureSeedFailureDom(page, state, marker) {
  return page.evaluate(({ expectedWorkspace, expectedMarker }) => {
    const list = document.querySelector('[data-testid="message-list"]');
    if (!(list instanceof HTMLElement)) return { sampledAtPageTimeMs: Number(performance.now().toFixed(3)), listFound: false };
    const scrollables = [list, ...list.querySelectorAll("*")].filter((element) =>
      element instanceof HTMLElement && element.scrollHeight > element.clientHeight + 16,
    ).sort((left, right) => (right.scrollHeight - right.clientHeight) - (left.scrollHeight - left.clientHeight));
    const hostCandidate = list.querySelector("[data-phone-ux-scroll-host]");
    const host = hostCandidate instanceof HTMLElement ? hostCandidate : scrollables[0] ?? list;
    const listRect = list.getBoundingClientRect();
    const rect = (element) => {
      if (!(element instanceof Element)) return null;
      const value = element.getBoundingClientRect();
      return { top: Number(value.top.toFixed(2)), bottom: Number(value.bottom.toFixed(2)), height: Number(value.height.toFixed(2)), width: Number(value.width.toFixed(2)) };
    };
    const tokens = (text) => [...new Set(text.match(/(?:HISTORY-\d{4}|seed-[A-Za-z0-9_-]+|UX-[A-Za-z0-9_-]+)/g) ?? [])].slice(0, 12);
    const rows = [...list.querySelectorAll('[data-testid="message-user"], [data-testid="message-assistant"]')];
    const selected = new Set();
    for (let index = 0; index < Math.min(4, rows.length); index += 1) selected.add(index);
    for (let index = Math.max(0, rows.length - 4); index < rows.length; index += 1) selected.add(index);
    rows.forEach((row, index) => { if ((row.textContent ?? "").includes(expectedMarker)) selected.add(index); });
    const rowSummaries = [...selected].sort((a, b) => a - b).slice(0, 16).map((index) => {
      const row = rows[index];
      const rowRect = row.getBoundingClientRect();
      const text = row.textContent ?? "";
      return {
        mountedDomIndex: index,
        testId: row.getAttribute("data-testid"),
        dataIndex: row.getAttribute("data-index"),
        ariaPosInSet: row.getAttribute("aria-posinset"),
        markerTokens: tokens(text),
        targetMarkerFound: text.includes(expectedMarker),
        textLength: text.length,
        rect: rect(row),
        intersectsMessageList: rowRect.width > 0 && rowRect.height > 0
          && rowRect.right > listRect.left && rowRect.left < listRect.right
          && rowRect.bottom > listRect.top && rowRect.top < listRect.bottom,
      };
    });
    const jump = document.querySelector('[data-testid="jump-to-latest"]');
    const jumpRect = jump?.getBoundingClientRect();
    const jumpStyle = jump instanceof HTMLElement ? getComputedStyle(jump) : null;
    const visible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return box.width > 0 && box.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const sockets = (window.__phoneRenderSocketDiagnostics?.() ?? []).map((socket) => ({
      browserMockId: socket.browserMockId,
      hasApiSendToPage: socket.hasApiSendToPage,
      openSeen: socket.openSeen,
      path: socket.path,
      server: socket.server,
      channel: socket.channel,
      workspaceMatchesFixture: socket.workspace === expectedWorkspace,
      readyState: socket.readyState,
      onMessageHandler: socket.onMessageHandler,
      recentRequests: (socket.recentRequests ?? []).map((request) => ({ method: request.method, id: request.id ?? null, threadId: request.threadId ?? null, at: request.at ?? null })),
      threadReadRequests: (socket.threadReadRequests ?? []).map((request) => ({ method: request.method, id: request.id ?? null, threadId: request.threadId ?? null, at: request.at ?? null })),
    }));
    const spacerCandidates = [...new Set([list, ...list.children, host, ...host.children])].map((element, index) => {
      if (!(element instanceof HTMLElement) || (element.textContent ?? "").trim().length > 0) return null;
      const box = rect(element);
      if (!box || (box.height <= 0 && element.scrollHeight <= 0)) return null;
      return { candidateIndex: index, tagName: element.tagName, testId: element.getAttribute("data-testid"), dataIndex: element.getAttribute("data-index"), childCount: element.children.length, rect: box, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight };
    }).filter(Boolean).slice(0, 24);
    const composer = {};
    for (const testId of ["send-message", "stop-turn", "queue-message"]) {
      const element = document.querySelector(`[data-testid="${testId}"]`);
      composer[testId] = { visible: visible(element), disabled: element instanceof HTMLButtonElement ? element.disabled : null };
    }
    return {
      sampledAtPageTimeMs: Number(performance.now().toFixed(3)),
      viewport: {
        scrollHostTestId: host.getAttribute("data-testid"),
        scrollTop: Number(host.scrollTop.toFixed(2)),
        scrollHeight: host.scrollHeight,
        clientHeight: host.clientHeight,
        bottomGapPx: Number(Math.max(0, host.scrollHeight - host.clientHeight - host.scrollTop).toFixed(2)),
        listRect: rect(list),
        renderedMessageRowCount: rows.length,
        targetMarkerRowFound: rowSummaries.some((row) => row.targetMarkerFound),
        jumpToLatestVisible: Boolean(jumpRect && jumpRect.width > 0 && jumpRect.height > 0 && jumpStyle?.display !== "none" && jumpStyle?.visibility !== "hidden"),
      },
      marker: expectedMarker,
      rows: rowSummaries,
      nonTextChildSpacers: spacerCandidates,
      composer,
      sockets,
    };
  }, { expectedWorkspace: state.workspacePath, expectedMarker: marker });
}

  return {
    readSourceSpec,
    resolveProvenanceReference,
    readFrozenGatewayRuntime,
    startFrozenGateway,
    copyAndVerifyRetainedBuilderExport,
    assertSafeBundleRelativePath,
    assertNoSymlinkAncestors,
    verifyExactBundleTree,
    installPerformanceInstrumentation,
    configureRuntimeConsumerProbe,
    readRuntimeConsumerProbe,
    drainRuntimeConsumerProbe,
    buildRuntimeConsumerSeedDiagnostic,
    summarizeSeedDispatchEvidence,
    summarizeSeedTranscriptViewport,
    safeSeedErrorMessage,
    safeSeedErrorStack,
    beginSeedUiTraceInPage,
    endSeedUiTraceInPage,
    captureSeedFailureDom,
  };
}
