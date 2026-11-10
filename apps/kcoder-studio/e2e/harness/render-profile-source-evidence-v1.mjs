import assert from "node:assert/strict";

const CANDIDATE_MARKERS = Object.freeze([
  "candidateDigest",
  "candidateFiles",
  "candidateManifestPath",
  "candidateManifestSha256",
  "candidateMobileManifestFiles",
  "candidateSharedManifestFiles",
  "sourceOrigin",
]);
const GIT_CANDIDATE_KIND = "data-only-adapter-for-retained-map-enabled-export";
const LEGACY_EXACT_CANDIDATE_KIND = "post-export-exact-source-root-inventory-derived-for-profile-input";

export function classifyRenderProfileSourceEvidenceV1(sourceProvenance) {
  assert.ok(sourceProvenance && typeof sourceProvenance === "object" && !Array.isArray(sourceProvenance),
    "render-profile source provenance must be an object");

  const hasCandidateExportFields = Array.isArray(sourceProvenance.sourceRoots)
    && Number.isSafeInteger(sourceProvenance.candidateFiles)
    && typeof sourceProvenance.candidateDigest === "string"
    && typeof sourceProvenance.candidateManifestPath === "string";
  const declaresGitCandidate = sourceProvenance.kind === GIT_CANDIDATE_KIND
    || Object.hasOwn(sourceProvenance, "sourceOrigin")
    || Object.hasOwn(sourceProvenance, "candidateManifestSha256");
  if (declaresGitCandidate) {
    assert.equal(sourceProvenance.kind, GIT_CANDIDATE_KIND, "Git export provenance kind is unsupported");
    assert.ok(hasCandidateExportFields, "Git export provenance is missing candidate inventory fields");
    assert.equal(sourceProvenance.status, "complete", "Git export provenance must be complete");
    assert.ok(sourceProvenance.sourceOrigin && typeof sourceProvenance.sourceOrigin === "object"
      && !Array.isArray(sourceProvenance.sourceOrigin), "Git export provenance is missing its pinned source origin");
    assert.match(sourceProvenance.candidateDigest, /^[a-f0-9]{64}$/, "Git export provenance candidate digest is invalid");
    assert.match(sourceProvenance.candidateManifestSha256 ?? "", /^[a-f0-9]{64}$/, "Git export provenance is missing its raw inventory digest");
    return { schemaVersion: 1, kind: "candidate-git-export" };
  }
  if (sourceProvenance.kind === LEGACY_EXACT_CANDIDATE_KIND) {
    assert.ok(hasCandidateExportFields, "legacy candidate export provenance is missing exact inventory fields");
    assert.match(sourceProvenance.candidateDigest, /^[a-f0-9]{64}$/, "legacy candidate inventory digest is invalid");
    return { schemaVersion: 1, kind: "legacy-exact-candidate-inventory" };
  }

  const hasPartialCandidateEvidence = CANDIDATE_MARKERS.some((key) => Object.hasOwn(sourceProvenance, key))
    || sourceProvenance.kind === LEGACY_EXACT_CANDIDATE_KIND;
  if (hasPartialCandidateEvidence) {
    throw new Error("partial candidate export provenance cannot fall back to a legacy frozen source");
  }

  if (typeof sourceProvenance.frozenSourceManifestSha256 === "string") {
    return { schemaVersion: 1, kind: "legacy-frozen-source-manifest" };
  }

  throw new Error("render-profile source provenance has no recognized frozen source schema");
}

export function selectRenderProfileMappingEvidenceV1({ kind, candidateSourceInventory }) {
  assert.ok(kind === "candidate-git-export" || kind === "legacy-exact-candidate-inventory",
    "per-file source mapping evidence must use a recognized exact inventory schema");
  const expectedStatus = kind === "candidate-git-export"
    ? "PINNED_GIT_EXPORT_SOURCE_EVIDENCE"
    : "PINNED_CANDIDATE_SOURCE_INVENTORY";
  assert.equal(candidateSourceInventory?.status, expectedStatus,
    "per-file source mapping requires fully verified source evidence for its declared schema");
  assert.ok(Array.isArray(candidateSourceInventory.sourceRoots) && candidateSourceInventory.sourceRoots.length > 0,
    "per-file source mapping requires verified source roots");
  assert.ok(Array.isArray(candidateSourceInventory.files) && candidateSourceInventory.files.length > 0,
    "per-file source mapping requires verified source hashes");
  return {
    schemaVersion: 1,
    kind,
    sourceEvidence: {
      sourceRoots: candidateSourceInventory.sourceRoots,
      candidateSourceFiles: candidateSourceInventory.files,
    },
    report: {
      status: expectedStatus,
      evidenceKind: kind,
      verificationMetadata: candidateSourceInventory.verificationMetadata ?? null,
      artifact: candidateSourceInventory.artifact ?? null,
    },
  };
}

export function selectLegacyRenderProfileMappingEvidenceV1({ kind, candidateSourceInventory }) {
  assert.equal(kind, "legacy-frozen-source-manifest", "legacy mapping evidence must use the frozen-source schema");
  assert.equal(candidateSourceInventory ?? null, null,
    "legacy frozen-source provenance cannot claim a derived Git file inventory");
  return {
    schemaVersion: 1,
    kind,
    sourceEvidence: null,
    report: {
      status: "LEGACY_FROZEN_SOURCE_WITHOUT_PER_FILE_INVENTORY",
      metroAliasMapping: "UNRESOLVED_WITHOUT_PINNED_FILE_HASHES",
    },
  };
}
