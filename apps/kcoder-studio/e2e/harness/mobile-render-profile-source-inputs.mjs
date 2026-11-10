// Mechanisms for the formal Mobile render-profile suite. Creation starts no resources.
export function createMobileRenderProfileSourceInputs({
  SOURCE_MAP_TRUSTED_DEPLOY_MOUNT_PATH,
  SOURCE_MAP_TRUSTED_OFFICIAL_MOBILE_MOUNT_PATH,
  addOfficialMobileExportPostflight,
  assert,
  assertNoSymlinkAncestors,
  assertPathWithinApprovedRoots,
  assertSafeBundleRelativePath,
  basename,
  buildGatewayMobileWebManifest,
  captureStackDiagnostic,
  chmod,
  classifyRenderProfileSourceEvidenceV1,
  constants,
  copyFile,
  copyOfficialMobileStaticDist,
  coreAttributionOnly,
  createHash,
  derivePinnedGitExportSourceEvidence,
  dirname,
  inspectOfficialMobileStaticDist,
  lstat,
  mkdir,
  mobileMountSmoke,
  naturalFollowDiagnostic,
  optionValue,
  readFile,
  readOfficialMobileExportReceipt,
  readVerifiedMobileExportFile,
  readdir,
  relative,
  repoRoot,
  requiredDigest,
  requiredOption,
  resolve,
  resolveProvenanceReference,
  rm,
  sep,
  sha256,
  sha256File,
  verifyExactBundleTree,
  verifyMobileExportManifestEnvelope,
  verifyPinnedSourceInventoryBytes,
  verifySourceMapBundleEvidence,
  waitFor,
  writeFile,
  writeGatewayMobileWebManifest,
}) {
async function readSourceSpec(name, context) {
  if (naturalFollowDiagnostic) return readOfficial992SourceSpec(name, context);
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
  const sourceEvidenceClassification = classifyRenderProfileSourceEvidenceV1(sourceProvenance);
  const usesCandidateGitExportProvenance = sourceEvidenceClassification.kind === "candidate-git-export";
  const usesCandidateExportProvenance = usesCandidateGitExportProvenance
    || sourceEvidenceClassification.kind === "legacy-exact-candidate-inventory";
  const sourceFreezeEvidenceKind = usesCandidateExportProvenance
    ? "candidate-source-manifest"
    : "frozen-source-manifest-sha256";
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
    if (coreAttributionOnly || captureStackDiagnostic || mobileMountSmoke) verifySourceMapBundleEvidence(manifest.sourceMapEvidence, manifest);
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
  const candidateSourceEvidence = (coreAttributionOnly || captureStackDiagnostic) && usesCandidateExportProvenance
    ? await deriveCandidateSourceEvidence({
      name,
      context,
      sourceProvenance,
      sourceProvenancePath,
      sourceProvenanceSha256,
      manifest,
      manifestBytes,
      privateBoundary,
    })
    : null;
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
    sourceMappingEvidenceKind: sourceEvidenceClassification.kind,
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
    candidateSourceInventory: candidateSourceEvidence?.inventory ?? null,
    candidateSourceEvidenceArtifact: candidateSourceEvidence?.artifact ?? null,
    builderManifest: manifest,
  };
}

async function deriveCandidateSourceEvidence({
  name,
  context,
  sourceProvenance,
  sourceProvenancePath,
  sourceProvenanceSha256,
  manifest,
  manifestBytes,
  privateBoundary,
}) {
  assert.equal(sourceProvenance.status, "complete", `${name} source evidence requires complete source provenance`);
  const candidateInventoryPath = sourceProvenance.candidateManifestPath;
  if (sourceProvenance.kind === "post-export-exact-source-root-inventory-derived-for-profile-input") {
    const candidateInventoryBytes = await readPinnedPrivateEvidenceFile({
      path: candidateInventoryPath,
      expectedPath: candidateInventoryPath,
      expectedSha256: sourceProvenance.candidateDigest,
      boundary: privateBoundary,
      label: `${name} legacy exact candidate source inventory`,
      maxBytes: 4 * 1024 * 1024,
    });
    const inventory = verifyPinnedSourceInventoryBytes({
      inventoryBytes: candidateInventoryBytes,
      candidateDigest: sourceProvenance.candidateDigest,
      candidateFiles: sourceProvenance.candidateFiles,
      sourceTreeSha256: sourceProvenance.sourceTreeSha256,
      sourceRoots: sourceProvenance.sourceRoots,
      inputRoots: manifest.inputRoots,
    });
    return {
      inventory: {
        ...inventory,
        verificationMetadata: {
          kind: "existing-raw-digest-and-exact-file-inventory-verifier",
          inventoryPath: candidateInventoryPath,
          inventoryRawSha256: sourceProvenance.candidateDigest,
        },
        artifact: {
          path: candidateInventoryPath,
          sha256: sourceProvenance.candidateDigest,
        },
      },
      artifact: {
        kind: "existing-exact-candidate-inventory",
        path: candidateInventoryPath,
        sha256: sourceProvenance.candidateDigest,
      },
    };
  }
  assert.equal(sourceProvenance.kind, "data-only-adapter-for-retained-map-enabled-export",
    `${name} source evidence kind is not a supported exact candidate schema`);
  const candidateInventoryBytes = await readPinnedPrivateEvidenceFile({
    path: candidateInventoryPath,
    expectedPath: candidateInventoryPath,
    expectedSha256: sourceProvenance.candidateManifestSha256,
    boundary: privateBoundary,
    label: `${name} Git source inventory`,
    maxBytes: 4 * 1024 * 1024,
  });
  const origin = sourceProvenance.sourceOrigin;
  assert.ok(origin && typeof origin === "object", `${name} Git source inventory needs its pinned source origin`);
  const combinedProvenancePath = origin.combinedProvenancePath;
  const combinedProvenanceBytes = await readPinnedPrivateEvidenceFile({
    path: combinedProvenancePath,
    expectedPath: combinedProvenancePath,
    expectedSha256: origin.combinedProvenanceSha256,
    boundary: [
      privateBoundary,
      resolve(repoRoot, "target/private-phone-ux-validation"),
    ],
    label: `${name} combined matched-export provenance`,
    maxBytes: 4 * 1024 * 1024,
  });
  const gitBlobs = await readPinnedGitArchiveBlobs(context, name, origin.commit, candidateInventoryBytes);
  const evidence = await derivePinnedGitExportSourceEvidence({
    inventoryBytes: candidateInventoryBytes,
    sourceProvenance,
    exportManifest: manifest,
    combinedProvenanceBytes,
    expectedCombinedProvenanceSha256: origin.combinedProvenanceSha256,
    readGitBlobs: async (objectIds) => objectIds.map((objectId) => {
      const bytes = gitBlobs.get(objectId);
      assert.ok(bytes, `${name} pinned Git archive is missing blob ${objectId}`);
      return bytes;
    }),
  });
  const artifactName = `phone-render-profile-${name}-git-source-evidence.json`;
  const artifact = {
    schemaVersion: 1,
    status: "DERIVED_PINNED_GIT_EXPORT_SOURCE_EVIDENCE",
    evidenceBoundary: "derived from raw-pinned Git inventory, combined provenance and export manifest; source bytes verified against pinned Git blob IDs; not a new freeze or build claim",
    sourceProvenancePath,
    sourceProvenanceSha256,
    exportManifestSha256: sha256(manifestBytes),
    candidateManifestPath: candidateInventoryPath,
    candidateManifestSha256: sha256(candidateInventoryBytes),
    combinedProvenancePath,
    combinedProvenanceSha256: sha256(combinedProvenanceBytes),
    verificationMetadata: evidence.verificationMetadata,
    sourceRoots: evidence.sourceRoots,
    files: evidence.files,
  };
  const artifactPath = await context.writeArtifactJson(artifactName, artifact);
  const artifactSha256 = sha256(await readFile(artifactPath));
  return {
    inventory: {
      status: "PINNED_GIT_EXPORT_SOURCE_EVIDENCE",
      sourceRoots: evidence.sourceRoots,
      files: evidence.files,
      verificationMetadata: evidence.verificationMetadata,
      artifact: { name: artifactName, sha256: artifactSha256 },
    },
    artifact: { name: artifactName, sha256: artifactSha256 },
  };
}

async function readPinnedPrivateEvidenceFile({ path, expectedPath, expectedSha256, boundary, label, maxBytes }) {
  assert.equal(typeof path, "string", `${label} path is missing`);
  const absolutePath = resolve(path);
  assert.equal(absolutePath, expectedPath, `${label} path must be normalized and absolute`);
  assert.equal(typeof expectedSha256, "string", `${label} expected digest is missing`);
  assert.match(expectedSha256, /^[a-f0-9]{64}$/, `${label} expected digest is invalid`);
  const approvedBoundaries = Array.isArray(boundary) ? boundary : [boundary];
  await assertPathWithinApprovedRoots(absolutePath, approvedBoundaries, label);
  const before = await lstat(absolutePath);
  assert.ok(before.isFile() && !before.isSymbolicLink() && before.nlink === 1, `${label} must be a single-link regular file`);
  assert.ok(before.size <= maxBytes, `${label} exceeds its byte bound`);
  const bytes = await readFile(absolutePath);
  const after = await lstat(absolutePath);
  assert.ok(after.isFile() && !after.isSymbolicLink() && after.nlink === 1, `${label} changed file kind while reading`);
  assert.equal(after.dev, before.dev, `${label} device changed while reading`);
  assert.equal(after.ino, before.ino, `${label} inode changed while reading`);
  assert.equal(after.size, before.size, `${label} size changed while reading`);
  assert.equal(bytes.length, before.size, `${label} read was incomplete`);
  assert.equal(sha256(bytes), expectedSha256, `${label} changed after its digest was pinned`);
  return bytes;
}

async function readPinnedGitArchiveBlobs(context, name, commit, inventoryBytes) {
  assert.match(commit, /^[a-f0-9]{40}$/, `${name} source commit must be a pinned Git SHA-1`);
  const inventory = JSON.parse(inventoryBytes.toString("utf8"));
  assert.equal(inventory.kind, "git-mobile-shared-source-inventory", `${name} source inventory kind is unsupported`);
  assert.ok(Array.isArray(inventory.entries) && inventory.entries.length > 0 && inventory.entries.length <= 4096, `${name} Git source inventory count is out of bounds`);
  const expectedTreeRows = inventory.entries.map((entry) => {
    assert.ok(entry && (entry.mode === "100644" || entry.mode === "100755"), `${name} Git source entry must be a regular file`);
    assert.match(entry.objectId, /^[a-f0-9]{40}$/, `${name} Git source entry object ID is invalid`);
    assert.ok(typeof entry.path === "string" && entry.path.length > 0 && !/[\\\0\t\r\n]/.test(entry.path), `${name} Git source entry path has unsupported characters`);
    assert.ok(!entry.path.startsWith("/") && !entry.path.split("/").some((part) => !part || part === "." || part === ".."), `${name} Git source entry path is noncanonical`);
    assert.ok(entry.path.startsWith("apps/kcoder-studio/mobile/") || entry.path.startsWith("apps/kcoder-studio/shared/"), `${name} Git source entry escaped the Mobile/Shared roots`);
    return { mode: entry.mode, objectId: entry.objectId, path: entry.path };
  }).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const observedCommit = (await runOwnedSourceCommand(context, `${name}-git-commit`, "git", ["rev-parse", `${commit}^{commit}`])).toString("utf8").trim();
  assert.equal(observedCommit, commit, `${name} Git source commit object is unavailable or changed`);
  const treeOutput = (await runOwnedSourceCommand(context, `${name}-git-tree-ids`, "git", [
    "rev-parse",
    `${commit}:apps/kcoder-studio/mobile`,
    `${commit}:apps/kcoder-studio/shared`,
  ])).toString("utf8").trim().split(/\s+/);
  assert.deepEqual(treeOutput, [inventory.gitTrees?.mobile, inventory.gitTrees?.shared], `${name} Git source root trees differ from the inventory`);
  const treeBytes = await runOwnedSourceCommand(context, `${name}-git-tree-inventory`, "git", [
    "ls-tree", "-r", "-z", "--full-tree", commit, "--", "apps/kcoder-studio/mobile", "apps/kcoder-studio/shared",
  ], { maxOutputBytes: 8 * 1024 * 1024 });
  assert.deepEqual(parsePinnedGitTreeRows(treeBytes, name), expectedTreeRows, `${name} candidate inventory is not the exact pinned Git tree`);

  const stageRoot = context.pathInState(`${name}-git-source-materialization`);
  await mkdir(stageRoot, { recursive: false, mode: 0o700 });
  context.registerTemporaryDirectory(`${name} pinned Git source archive materialization`, stageRoot);
  const extractRoot = resolve(stageRoot, "extract");
  await mkdir(extractRoot, { recursive: false, mode: 0o700 });
  const archivePath = resolve(stageRoot, "source.tar");
  await runOwnedSourceCommand(context, `${name}-git-source-archive`, "git", [
    "archive", "--format=tar", `--output=${archivePath}`, commit,
    "apps/kcoder-studio/mobile", "apps/kcoder-studio/shared",
  ], { maxOutputBytes: 64 * 1024 });
  const archiveStat = await lstat(archivePath);
  assert.ok(archiveStat.isFile() && !archiveStat.isSymbolicLink() && archiveStat.nlink === 1, `${name} Git source archive must be an owned regular file`);
  assert.ok(archiveStat.size <= 128 * 1024 * 1024, `${name} Git source archive exceeds its bound`);
  await runOwnedSourceCommand(context, `${name}-git-source-extract`, "tar", [
    "--extract", "--file", archivePath, "--directory", extractRoot, "--no-same-owner",
  ], { maxOutputBytes: 64 * 1024 });
  const materialized = await collectPinnedGitArchiveFiles(extractRoot, name);
  assert.deepEqual(materialized.map((entry) => entry.path), expectedTreeRows.map((entry) => entry.path), `${name} Git archive file paths differ from the exact pinned tree`);
  const blobs = new Map();
  for (let index = 0; index < expectedTreeRows.length; index += 1) {
    const expected = expectedTreeRows[index];
    const actual = materialized[index];
    assert.equal(Boolean(actual.mode & 0o111), expected.mode === "100755", `${name} Git archive mode differs for ${expected.path}`);
    assert.equal(gitBlobSha1(actual.bytes), expected.objectId, `${name} Git archive blob differs for ${expected.path}`);
    const previous = blobs.get(expected.objectId);
    if (previous) assert.deepEqual(actual.bytes, previous, `${name} repeated Git object ID has inconsistent bytes`);
    else blobs.set(expected.objectId, actual.bytes);
  }
  return blobs;
}

function parsePinnedGitTreeRows(bytes, name) {
  assert.ok(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes[bytes.length - 1] === 0, `${name} Git tree output must be NUL terminated`);
  const rows = [];
  let start = 0;
  while (start < bytes.length - 1) {
    const end = bytes.indexOf(0, start);
    assert.ok(end > start, `${name} Git tree contains an empty row`);
    const row = bytes.subarray(start, end);
    const tab = row.indexOf(0x09);
    assert.ok(tab > 0, `${name} Git tree row is malformed`);
    const metadata = row.subarray(0, tab).toString("ascii");
    const match = /^(100644|100755) blob ([a-f0-9]{40})$/.exec(metadata);
    assert.ok(match, `${name} Git tree contains a symlink, submodule or nonregular entry`);
    const pathBytes = row.subarray(tab + 1);
    const path = pathBytes.toString("utf8");
    assert.deepEqual(Buffer.from(path, "utf8"), pathBytes, `${name} Git tree path is not valid UTF-8`);
    assert.ok(!/[\\\0\t\r\n]/.test(path), `${name} Git tree path has unsupported characters`);
    rows.push({ mode: match[1], objectId: match[2], path });
    start = end + 1;
  }
  return rows.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

async function collectPinnedGitArchiveFiles(root, name) {
  const files = [];
  let totalBytes = 0;
  async function visit(directory) {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const child of children) {
      const path = relative(root, resolve(directory, child.name)).split(sep).join("/");
      assert.ok(path && !path.split("/").some((part) => !part || part === "." || part === ".."), `${name} Git archive path is noncanonical`);
      const absolute = resolve(directory, child.name);
      const info = await lstat(absolute);
      assert.equal(info.isSymbolicLink(), false, `${name} Git archive unexpectedly contains a symlink: ${path}`);
      if (info.isDirectory()) {
        await visit(absolute);
        continue;
      }
      assert.ok(info.isFile() && info.nlink === 1, `${name} Git archive contains a special or multiply linked file: ${path}`);
      assert.ok(files.length < 4096, `${name} Git archive exceeds its file bound`);
      assert.ok(info.size <= 16 * 1024 * 1024, `${name} Git archive contains an oversized blob`);
      totalBytes += info.size;
      assert.ok(totalBytes <= 128 * 1024 * 1024, `${name} Git archive extraction exceeds its byte bound`);
      files.push({ path, mode: info.mode, bytes: await readFile(absolute) });
    }
  }
  await visit(root);
  files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  return files;
}

function gitBlobSha1(bytes) {
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

async function runOwnedSourceCommand(context, label, command, args, { maxOutputBytes = 1024 * 1024, timeoutMs = 120_000 } = {}) {
  const child = context.spawnOwned(label, command, args, {
    cwd: repoRoot,
    env: context.isolatedEnvironment({
      PATH: process.env.PATH || "/usr/bin:/bin",
      LC_ALL: "C",
      LANG: "C",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    }),
    windowsHide: true,
  });
  const chunks = [];
  let outputBytes = 0;
  let overflow = false;
  let spawnError = null;
  child.stdout?.on("data", (chunk) => {
    outputBytes += chunk.length;
    if (outputBytes <= maxOutputBytes) chunks.push(Buffer.from(chunk));
    else overflow = true;
  });
  child.once("error", (error) => { spawnError = error; });
  try {
    await waitFor(() => spawnError || child.exitCode !== null || child.signalCode !== null, timeoutMs, `owned ${label}`, 50, context.abortSignal);
    if (spawnError) throw new Error(`${label} could not start: ${spawnError.name}`);
    assert.equal(child.exitCode, 0, `${label} exited with ${child.signalCode || child.exitCode}`);
    assert.equal(overflow, false, `${label} stdout exceeded its bound`);
    return Buffer.concat(chunks);
  } finally {
    await context.stopOwned(label);
  }
}

async function readOfficial992SourceSpec(name, context) {
  assert.equal(name, "after", "the natural-follow diagnostic only accepts its pinned official after input");
  assert.ok(context, "the official export receipt must be registered with this run's cleanup");
  const officialInput = {
    receiptPath: resolve(repoRoot, "target/test/apps/kcoder-studio/e2e/private/mobile-web-export-9925461c.once.e2e.mjs/20261009-181452.098Z/artifacts/official-mobile-web-export-9925461c.json"),
    receiptSha256: "375eb4c038da738edb3aa6267b3500a930928051f25c5d17a9905176a01d3ef7",
    runManifestSha256: "8100981519df028f3f98ef4a10318b6a9ca3a661e0e1729053b244958933f4f8",
  };
  const sourceSnapshotOptions = {
    sourceSnapshotRoot: resolve(repoRoot, "target/private-official-export-receipt-wiring-20261009/source-adapter-9925461c"),
    sourceSnapshotManifestSha256: "7d64b37bb56592f3e33dc222af0e58bf3a2cf44b72261092c42339acd30d935e",
  };
  const official = await readOfficialMobileExportReceipt(officialInput, sourceSnapshotOptions);
  const receipt = official.receipt;
  assert.equal(official.builderCommit, "9925461ca047031f3f7f37d1f039d986c305fec3");
  assert.equal(receipt.source.sourceTreeSha256, "b22dbddabf802b08a4a586de178c875b576a8279efc51d142a6f1948e40dd020");
  assert.equal(receipt.source.freezeManifestSha256, "97e63d0b0614787e8b84369e4c6d15c3d3387884e4595a00867f0dbfe3d544f7");
  assert.equal(official.manifestSha256, "7ce760cfc9aabc14dd8fee65043c6ded400bb2f0eccf6d3f04930f8403b23d13");
  assert.equal(receipt.officialDeployment.bundleSha256, "d32df934303a04eb919711914d71aca622897ab1f0bfac20990e235fbeab8a3c");
  assert.equal(receipt.officialDeployment.resourceCount, 37);
  assert.equal(receipt.officialDeployment.physicalFileCount, 38);

  const freezePath = resolve(dirname(officialInput.receiptPath), "source-freeze-9925461c.json");
  const freezeBytes = await readFile(freezePath);
  assert.equal(sha256(freezeBytes), receipt.source.freezeManifestSha256, "992 source freeze changed after official receipt verification");
  const freeze = JSON.parse(freezeBytes.toString("utf8"));
  assert.equal(freeze.sourceCommit, official.builderCommit);
  assert.equal(freeze.trackedFilesVerified, 370);
  assert.equal(freeze.sourceRoots[0]?.trackedFiles, 351);
  assert.equal(freeze.sourceRoots[1]?.trackedFiles, 19);
  addOfficialMobileExportPostflight(context, officialInput, official, sourceSnapshotOptions);

  const manifestBytes = await readFile(official.sourceDist.manifestPath);
  assert.equal(sha256(manifestBytes), official.manifestSha256, "official 992 static manifest changed after receipt verification");
  const builderManifest = JSON.parse(manifestBytes.toString("utf8"));
  return {
    name,
    manifestPath: official.sourceDist.manifestPath,
    sourceProvenancePath: officialInput.receiptPath,
    sourceProvenanceSha256: officialInput.receiptSha256,
    relocationSidecarSha256: null,
    bundleRoot: official.distRoot,
    sourceTreeSha256: receipt.source.sourceTreeSha256,
    sourceComplementSha256: null,
    sharedSourceInputSha256: null,
    mobileExportInputFileCount: freeze.sourceRoots[0].trackedFiles,
    sharedExportInputFileCount: freeze.sourceRoots[1].trackedFiles,
    frozenSourceEntryCount: freeze.trackedFilesVerified,
    sourceCompleteness: {
      manifestFileCount: freeze.trackedFilesVerified,
      mobileGitTree: freeze.sourceRoots[0].gitTree,
      mobileTrackedFiles: freeze.sourceRoots[0].trackedFiles,
      sharedGitTree: freeze.sourceRoots[1].gitTree,
      sharedTrackedFiles: freeze.sourceRoots[1].trackedFiles,
      gitInventorySha256: freeze.gitInventorySha256,
      sourceArchiveSha256: freeze.archive.sha256,
    },
    sourceFreezeEvidenceDigest: receipt.source.freezeManifestSha256,
    sourceFreezeEvidenceKind: "official-mobile-export-receipt-source-freeze",
    builderSourceProvenance: official.builderSourceProvenance,
    builderSourceParity: official.builderSourceParity,
    dependencySourceTreeSha256: receipt.dependencies.sourceTreeSha256Before,
    complementarySourceDescription: "The official 992 export receipt verifies the Mobile and Shared Git trees, source archive, package lock, dependencies, builder manifest, and static files.",
    mobileSourceComponentSha256: null,
    exportManifestSha256: official.manifestSha256,
    overlaySha256: null,
    sourceComplementMode: "official-export-receipt-pins-mobile-and-shared-source-roots",
    builderManifest,
    officialExportInput: officialInput,
    officialExportReceipt: official,
  };
}

async function copyAndVerifyRetainedBuilderExport(context, source) {
  if (source.officialExportReceipt) {
    const copied = await copyOfficialMobileStaticDist(context, {
      distRoot: source.officialExportReceipt.distRoot,
      expectedManifestSha256: source.officialExportReceipt.manifestSha256,
      outputName: `render-profile-${source.name}-bundle`,
    });
    const provenancePath = await context.writeArtifactJson(`render-profile-${source.name}-official-bundle-provenance.json`, {
      schemaVersion: 1,
      status: "complete",
      kind: "verified-owned-copy-of-official-mobile-web-export-receipt",
      exportPerformedInMeasurementRun: false,
      receiptPath: relative(repoRoot, source.officialExportInput.receiptPath).split(sep).join("/"),
      receiptSha256: source.officialExportInput.receiptSha256,
      runManifestSha256: source.officialExportInput.runManifestSha256,
      sourceCommit: source.officialExportReceipt.builderCommit,
      builderSourceProvenance: source.builderSourceProvenance ?? null,
      sourceFreezeEvidenceDigest: source.sourceFreezeEvidenceDigest,
      sourceTreeSha256: source.sourceTreeSha256,
      packageLockSha256: source.officialExportReceipt.receipt.source.packageLockSha256,
      dependencySourceTreeSha256: source.dependencySourceTreeSha256,
      exportManifestPath: relative(repoRoot, copied.manifestPath).split(sep).join("/"),
      exportManifestSha256: copied.manifestSha256,
      bundleSha256: source.officialExportReceipt.receipt.officialDeployment.bundleSha256,
      bundleFileCount: copied.resourceCount,
      resourceTableSha256: copied.resourceTableSha256,
      ownedCopy: {
        path: relative(context.runRoot, copied.ownedRoot).split(sep).join("/"),
        exactFileSetVerified: copied.ownedCopyVerified,
        directoryMode: copied.ownedDirectoryMode,
        fileMode: copied.ownedFileMode,
      },
    });
    return {
      path: copied.ownedRoot,
      sourceManifestPath: copied.manifestPath,
      sourceManifestSha256: copied.manifestSha256,
      sourceTreeSha256: source.sourceTreeSha256,
      bundleSha256: source.officialExportReceipt.receipt.officialDeployment.bundleSha256,
      bundleFileCount: copied.resourceCount,
      indexHtmlSha256: source.officialExportReceipt.receipt.officialDeployment.indexHtmlSha256,
      provenancePath,
      exportPerformed: false,
    };
  }
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
    const expectedMapFileCount = coreAttributionOnly || captureStackDiagnostic || mobileMountSmoke ? manifest.sourceMapEvidence?.mapFileCount : 0;
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

async function materializeProfileMobileStaticDist(context, source, mobileWeb) {
  const bundleRows = source.builderManifest.bundleFiles;
  assert.ok(Array.isArray(bundleRows), "deploy-mounted Mobile export must include its pinned bundle file table");
  const mapRows = bundleRows.filter((row) => row.path.endsWith(".map"));
  const sourceMapEvidence = source.builderManifest.sourceMapEvidence;
  assert.equal(sourceMapEvidence?.enabled, true, "profile deployment adapter requires the pinned source-map diagnostic export");
  assert.equal(mapRows.length, sourceMapEvidence.mapFileCount, "raw source-map files differ from the export manifest evidence");
  assert.deepEqual(mapRows, sourceMapEvidence.mapFiles, "raw source-map descriptors differ from the export manifest evidence");

  const resourceRows = bundleRows
    .filter((row) => !row.path.endsWith(".map"))
    .map(({ path, size, sha256: digest }) => ({ path, size, sha256: digest }))
    .sort((left, right) => left.path.localeCompare(right.path));
  assert.equal(resourceRows.length, 37, "Gateway Mobile deployment adapter requires exactly the 37 static resources");
  const validatorOrderedResourceRows = [...resourceRows].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const expectedFiles = new Map(bundleRows.map((row) => [row.path, row]));
  const rawMapBefore = await Promise.all(mapRows.map(async (row) => {
    const parts = assertSafeBundleRelativePath(row.path, `${source.name} raw source map`);
    await assertNoSymlinkAncestors(mobileWeb.path, parts, `${source.name} raw source map`);
    const bytes = await readVerifiedMobileExportFile(mobileWeb.path, row, `${source.name} raw source map`);
    return { path: row.path, size: bytes.length, sha256: sha256(bytes) };
  }));

  const stateRoot = resolve(context.stateDir);
  const stagingRoot = context.pathInState(`render-profile-${source.name}-mobile-static-dist-source`);
  assert.equal(resolve(stagingRoot), stagingRoot, "RunContext returned a non-normalized Mobile static-dist staging path");
  const relativeStagingRoot = relative(stateRoot, stagingRoot);
  assert.ok(relativeStagingRoot && relativeStagingRoot !== ".." && !relativeStagingRoot.startsWith(`..${sep}`), "derived Mobile static-dist staging must remain inside RunContext state");
  try {
    await lstat(stagingRoot);
    assert.fail("derived Mobile static-dist staging path already exists");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await mkdir(stagingRoot, { recursive: false, mode: 0o700 });
  await chmod(stagingRoot, 0o700);
  context.registerTemporaryDirectory("source-map-excluded official Mobile static-dist staging", stagingRoot);

  for (const row of resourceRows) {
    const parts = assertSafeBundleRelativePath(row.path, `${source.name} deploy resource`);
    await assertNoSymlinkAncestors(mobileWeb.path, parts, `${source.name} raw bundle`);
    const bytes = await readVerifiedMobileExportFile(mobileWeb.path, row, `${source.name} raw bundle`);
    assert.equal(bytes.length, row.size, `raw bundle resource size changed: ${row.path}`);
    assert.equal(sha256(bytes), row.sha256, `raw bundle resource digest changed: ${row.path}`);

    let parent = stagingRoot;
    for (const segment of parts.slice(0, -1)) {
      parent = resolve(parent, segment);
      const relativeParent = relative(stagingRoot, parent);
      assert.ok(relativeParent && relativeParent !== ".." && !relativeParent.startsWith(`..${sep}`), "derived Mobile resource directory escaped staging root");
      try {
        await mkdir(parent, { recursive: false, mode: 0o700 });
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }
      const parentInfo = await lstat(parent);
      assert.ok(parentInfo.isDirectory() && !parentInfo.isSymbolicLink(), "derived Mobile resource parent must be a real directory");
      await chmod(parent, 0o700);
    }
    const destination = resolve(stagingRoot, ...parts);
    const relativeDestination = relative(stagingRoot, destination);
    assert.ok(relativeDestination && relativeDestination !== ".." && !relativeDestination.startsWith(`..${sep}`), "derived Mobile resource escaped staging root");
    await writeFile(destination, bytes, { flag: "wx", mode: 0o600 });
    await chmod(destination, 0o600);
  }

  const manifest = await buildGatewayMobileWebManifest(stagingRoot, { expectedFiles: resourceRows });
  await writeGatewayMobileWebManifest(stagingRoot, manifest);
  const manifestPath = resolve(stagingRoot, "kcoder-mobile-web.json");
  await chmod(manifestPath, 0o600);
  const manifestBytes = await readFile(manifestPath);
  const manifestSha256 = sha256(manifestBytes);
  const stagedValidation = await inspectOfficialMobileStaticDist({ distRoot: stagingRoot, expectedManifestSha256: manifestSha256 });
  assert.equal(stagedValidation.resourceCount, 37, "derived static-dist manifest must contain exactly 37 resources");
  assert.deepEqual(
    stagedValidation.resources.map(({ path, size, sha256: digest }) => ({ path, size, sha256: digest })),
    validatorOrderedResourceRows,
    "derived static-dist resources differ from the pinned map-enabled export's non-map files",
  );

  const owned = await copyOfficialMobileStaticDist(context, {
    distRoot: stagingRoot,
    expectedManifestSha256: manifestSha256,
    outputName: `render-profile-${source.name}-mobile-static-dist`,
  });
  assert.equal(owned.ownedCopyVerified, true, "derived official Mobile static dist must pass the owned-copy verifier");
  assert.equal(owned.sourceStableDuringCopy, true, "derived official Mobile static dist must remain stable during copy");
  assert.deepEqual(
    owned.resources.map(({ path, size, sha256: digest }) => ({ path, size, sha256: digest })),
    validatorOrderedResourceRows,
    "owned Mobile static dist differs from the pinned 37-resource table",
  );

  const rawMapAfter = await Promise.all(mapRows.map(async (row) => {
    const parts = assertSafeBundleRelativePath(row.path, `${source.name} raw source map after adaptation`);
    await assertNoSymlinkAncestors(mobileWeb.path, parts, `${source.name} raw source map after adaptation`);
    const bytes = await readVerifiedMobileExportFile(mobileWeb.path, row, `${source.name} raw source map after adaptation`);
    return { path: row.path, size: bytes.length, sha256: sha256(bytes) };
  }));
  assert.deepEqual(rawMapAfter, rawMapBefore, "raw source-map bytes changed during Gateway static-dist adaptation");
  await verifyExactBundleTree(mobileWeb.path, expectedFiles, `${source.name} retained map-enabled raw bundle`);

  const evidence = {
    schemaVersion: 1,
    status: "complete",
    kind: "derived-gateway-mobile-static-dist-from-pinned-map-enabled-export",
    sourceExportManifestPath: relative(repoRoot, mobileWeb.sourceManifestPath).split(sep).join("/"),
    sourceExportManifestSha256: mobileWeb.sourceManifestSha256,
    sourceBundleSha256: mobileWeb.bundleSha256,
    sourceBundleFileCount: mobileWeb.bundleFileCount,
    sourceMapRows: rawMapAfter,
    sourceMapsUnchangedDuringAdaptation: true,
    gatewayResourceCount: owned.resourceCount,
    gatewayResourceTableSha256: owned.resourceTableSha256,
    derivedGatewayManifestPath: relative(context.runRoot, manifestPath).split(sep).join("/"),
    derivedGatewayManifestSha256: manifestSha256,
    ownedGatewayRoot: relative(context.runRoot, owned.ownedRoot).split(sep).join("/"),
    ownedCopyVerified: owned.ownedCopyVerified,
    claimBoundary: "Gateway deploy-mount input derived from the exact 37 non-map resources in the pinned 38-file diagnostic export; raw bundle and source maps remain separate and unchanged",
  };
  const artifactPath = await context.writeArtifactJson("render-profile-mobile-static-dist-adapter.json", evidence);
  return { ownedRoot: owned.ownedRoot, manifestSha256, resourceTableSha256: owned.resourceTableSha256, evidence, artifactPath };
}

function trustedSourceMapMountPathForEntry(source, mobileEntry) {
  if (source.builderManifest.deployMount !== true) return undefined;
  assert.equal(mobileEntry?.status, "PASS", "deploy-mounted source maps require a successful official Mobile entry proof");
  assert.equal(mobileEntry.sameOrigin, true, "deploy-mounted source maps require same-origin Mobile entry evidence");
  const verifiedMounts = [
    { entryPath: `${SOURCE_MAP_TRUSTED_OFFICIAL_MOBILE_MOUNT_PATH}/`, mountPath: SOURCE_MAP_TRUSTED_OFFICIAL_MOBILE_MOUNT_PATH },
    { entryPath: `${SOURCE_MAP_TRUSTED_DEPLOY_MOUNT_PATH}/`, mountPath: SOURCE_MAP_TRUSTED_DEPLOY_MOUNT_PATH },
  ].filter(({ entryPath, mountPath }) => mobileEntry.path === entryPath
    && mobileEntry.responses.some((row) => row.resourceType === "script"
      && row.status === 200
      && typeof row.path === "string"
      && row.path.startsWith(`${mountPath}/`)));
  assert.equal(verifiedMounts.length, 1, "deploy-mounted source maps require exactly one entry-evidenced trusted mount prefix");
  return verifiedMounts[0].mountPath;
}

async function copyPinnedConfiguredGatewayBinary(context, sourcePathArgument, expectedSha256) {
  const sourcePath = resolve(sourcePathArgument);
  const sourceBeforeStat = await lstat(sourcePath, { bigint: true });
  assert.ok(sourceBeforeStat.isFile() && !sourceBeforeStat.isSymbolicLink(), "pinned KCoder binary source must be a regular non-symlink file");
  assert.ok((sourceBeforeStat.mode & 0o111n) !== 0n, "pinned KCoder binary source must be executable");
  const sourceBeforeSha256 = await sha256File(sourcePath);
  assert.equal(sourceBeforeSha256, expectedSha256, "pinned KCoder binary source must match its explicit SHA-256");

  const copyRoot = context.pathInState("configured-kcoder-binary");
  context.registerTemporaryDirectory("configured KCoder binary copy", copyRoot);
  await mkdir(copyRoot, { recursive: false, mode: 0o700 });
  const copyPath = context.pathInState("configured-kcoder-binary", "kcoder");
  await copyFile(sourcePath, copyPath, constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL);
  await chmod(copyPath, 0o500);

  const copyStat = await lstat(copyPath, { bigint: true });
  assert.ok(copyStat.isFile() && !copyStat.isSymbolicLink(), "run-owned KCoder binary copy must be a regular non-symlink file");
  assert.equal(Number(copyStat.mode & 0o777n), 0o500, "run-owned configured KCoder copy must be read-only and executable for its owner");
  const copySha256 = await sha256File(copyPath);
  assert.equal(copySha256, expectedSha256, "run-owned KCoder binary copy must preserve the pinned executable bytes");
  const sourceAfterStat = await lstat(sourcePath, { bigint: true });
  const sourceAfterSha256 = await sha256File(sourcePath);
  const statSummary = (value) => ({
    device: String(value.dev),
    inode: String(value.ino),
    mode: Number(value.mode).toString(8),
    links: String(value.nlink),
    size: String(value.size),
    mtimeNs: String(value.mtimeNs),
    ctimeNs: String(value.ctimeNs),
  });
  const sourceBefore = statSummary(sourceBeforeStat);
  const sourceAfter = statSummary(sourceAfterStat);
  assert.deepEqual(sourceAfter, sourceBefore, "pinned KCoder binary source metadata must remain unchanged while it is copied");
  assert.equal(sourceAfterSha256, sourceBeforeSha256, "pinned KCoder binary source bytes must remain unchanged while it is copied");
  const evidence = {
    sourcePath,
    sourceSha256Before: sourceBeforeSha256,
    sourceSha256After: sourceAfterSha256,
    sourceStatBefore: sourceBefore,
    sourceStatAfter: sourceAfter,
    copiedPath: copyPath,
    copiedSha256: copySha256,
    copiedStat: statSummary(copyStat),
    copyMode: "COPYFILE_FICLONE|COPYFILE_EXCL then chmod 0500",
    executionBoundary: "configured in KCODER_STUDIO_MOCK=1 only; not exercised as Rust behavior",
  };
  await context.writeArtifactJson("configured-kcoder-binary-copy.json", evidence);
  return { path: copyPath, evidence };
}

return { readSourceSpec, deriveCandidateSourceEvidence, readPinnedPrivateEvidenceFile, readPinnedGitArchiveBlobs, parsePinnedGitTreeRows, collectPinnedGitArchiveFiles, gitBlobSha1, runOwnedSourceCommand, readOfficial992SourceSpec, copyAndVerifyRetainedBuilderExport, materializeProfileMobileStaticDist, trustedSourceMapMountPathForEntry, copyPinnedConfiguredGatewayBinary };
}
