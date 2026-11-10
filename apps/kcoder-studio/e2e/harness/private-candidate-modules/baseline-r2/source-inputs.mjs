// Private historical candidate mechanisms; construction starts no resources.
export function createPrivateBaselineR2SourceInputs({
  assert,
  assertNoSymlinkAncestors,
  assertPathWithinApprovedRoots,
  assertSafeBundleRelativePath,
  basename,
  coreAttributionOnly,
  dirname,
  lstat,
  mkdir,
  optionValue,
  readFile,
  readVerifiedMobileExportFile,
  relative,
  repoRoot,
  requiredDigest,
  requiredOption,
  resolve,
  resolveProvenanceReference,
  rm,
  sep,
  sha256,
  verifyExactBundleTree,
  verifyMobileExportManifestEnvelope,
  verifySourceMapBundleEvidence,
  writeFile,
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
  if (coreAttributionOnly) verifySourceMapBundleEvidence(manifest.sourceMapEvidence, manifest);
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
    const mapFileCount = manifest.bundleFiles.filter((entry) => entry.path.endsWith(".map")).length;
    const expectedMapFileCount = coreAttributionOnly ? manifest.sourceMapEvidence?.mapFileCount : 0;
    assert.equal(mapFileCount, expectedMapFileCount, `${source.name} bundle source-map count does not match the active diagnostic mode`);
    assert.equal(expectedFiles.size - mapFileCount, 37, `${source.name} bundle must preserve exactly 37 standard files in addition to any explicitly pinned diagnostic maps`);
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

return { readSourceSpec, copyAndVerifyRetainedBuilderExport };
}
