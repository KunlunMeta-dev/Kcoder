import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  classifyRenderProfileSourceEvidenceV1,
  selectLegacyRenderProfileMappingEvidenceV1,
  selectRenderProfileMappingEvidenceV1,
} from "./render-profile-source-evidence-v1.mjs";
import {
  mapGeneratedProfilePosition,
  recordScriptUrlIdentity,
  resolveScriptMapBinding,
  verifyPinnedSourceInventoryBytes,
} from "./render-profile-attribution-contract.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const mobileContent = "export const marker = true;\n";
const sharedContent = "export type TurnReceipt = { id: string };\n";
const sourceTreeSha256 = "c".repeat(64);
const roots = [
  {
    name: "mobile",
    sourceRoot: "/private/frozen/mobile",
    destination: "apps/kcoder-studio/mobile",
    sha256: "a".repeat(64),
    fileCount: 1,
  },
  {
    name: "studio-shared",
    sourceRoot: "/private/frozen/shared",
    destination: "apps/kcoder-studio/shared",
    sha256: "b".repeat(64),
    fileCount: 1,
  },
];
const inventoryFiles = [
  {
    root: "mobile",
    path: "src/app/example.tsx",
    size: Buffer.byteLength(mobileContent),
    sha256: sha256(mobileContent),
  },
  {
    root: "studio-shared",
    path: "turnReceipt.ts",
    size: Buffer.byteLength(sharedContent),
    sha256: sha256(sharedContent),
  },
];
const inventoryBytes = Buffer.from(JSON.stringify({
  schemaVersion: 1,
  status: "derived-post-export-exact-source-inventory",
  sourceTreeSha256,
  fileCount: inventoryFiles.length,
  sourceRoots: roots,
  files: inventoryFiles,
}));
const legacyExactProvenance = {
  schemaVersion: 1,
  status: "complete",
  kind: "post-export-exact-source-root-inventory-derived-for-profile-input",
  sourceTreeSha256,
  sourceRoots: roots,
  candidateFiles: inventoryFiles.length,
  candidateDigest: sha256(inventoryBytes),
  candidateManifestPath: "/private/frozen/candidate-source-inventory.json",
};

function mappingFor(source) {
  return {
    GREATEST_LOWER_BOUND: 1,
    originalPositionFor: () => ({ source, line: 4, column: 2, name: "marker" }),
  };
}

function verifiedLegacyInventory(provenance = legacyExactProvenance, bytes = inventoryBytes) {
  return verifyPinnedSourceInventoryBytes({
    inventoryBytes: bytes,
    candidateDigest: provenance.candidateDigest,
    candidateFiles: provenance.candidateFiles,
    sourceTreeSha256: provenance.sourceTreeSha256,
    sourceRoots: provenance.sourceRoots,
    inputRoots: roots,
  });
}

test("classifies the three supported provenance schemas from their actual discriminating fields", () => {
  assert.deepEqual(
    classifyRenderProfileSourceEvidenceV1({
      schemaVersion: 1,
      status: "complete",
      kind: "data-only-adapter-for-retained-map-enabled-export",
      sourceOrigin: { commit: "e".repeat(40) },
      sourceRoots: roots,
      candidateFiles: 2,
      candidateDigest: "d".repeat(64),
      candidateManifestPath: "/private/git/source-inventory.json",
      candidateManifestSha256: "f".repeat(64),
    }),
    { schemaVersion: 1, kind: "candidate-git-export" },
  );
  assert.deepEqual(classifyRenderProfileSourceEvidenceV1(legacyExactProvenance), {
    schemaVersion: 1,
    kind: "legacy-exact-candidate-inventory",
  });
  assert.deepEqual(classifyRenderProfileSourceEvidenceV1({
    schemaVersion: 1,
    frozenSourceManifestSha256: "9".repeat(64),
    frozenSourceEntryCount: 321,
    sourceCompleteness: { manifestFileCount: 321, workspaceComplementCopied: false },
  }), {
    schemaVersion: 1,
    kind: "legacy-frozen-source-manifest",
  });
});

test("legacy exact candidate inventory keeps its raw digest verifier and maps pinned Mobile and shared aliases", () => {
  const inventory = verifiedLegacyInventory();
  assert.equal(inventory.status, "PINNED_CANDIDATE_SOURCE_INVENTORY");
  const selected = selectRenderProfileMappingEvidenceV1({
    kind: "legacy-exact-candidate-inventory",
    candidateSourceInventory: inventory,
  });
  assert.equal(selected.report.status, "PINNED_CANDIDATE_SOURCE_INVENTORY");

  const mobileMapping = mapGeneratedProfilePosition({}, { lineNumber: 2, columnNumber: 3 }, mappingFor("/src/app/example.tsx"), {
    ...selected.sourceEvidence,
    sourceMapSources: ["/src/app/example.tsx"],
    sourcesContent: [mobileContent],
  });
  assert.equal(mobileMapping.status, "MAPPED");
  assert.equal(mobileMapping.source, "apps/kcoder-studio/mobile/src/app/example.tsx");

  const sharedMapping = mapGeneratedProfilePosition({}, { lineNumber: 2, columnNumber: 3 }, mappingFor("/../shared/turnReceipt.ts"), {
    ...selected.sourceEvidence,
    sourceMapSources: ["/../shared/turnReceipt.ts"],
    sourcesContent: [sharedContent],
  });
  assert.equal(sharedMapping.status, "MAPPED");
  assert.equal(sharedMapping.source, "apps/kcoder-studio/shared/turnReceipt.ts");

  assert.throws(() => verifiedLegacyInventory({
    ...legacyExactProvenance,
    candidateDigest: "0".repeat(64),
  }), /candidate source inventory bytes differ from their pinned digest/);
  assert.throws(() => verifiedLegacyInventory({
    ...legacyExactProvenance,
    candidateFiles: 1,
  }), /candidate source inventory file count differs from the pinned provenance/);
});

test("complete Git provenance requires derived Git evidence and preserves sourceContent hash checks", () => {
  const gitProvenance = {
    schemaVersion: 1,
    status: "complete",
    kind: "data-only-adapter-for-retained-map-enabled-export",
    sourceOrigin: { commit: "e".repeat(40) },
    sourceRoots: roots,
    candidateFiles: 2,
    candidateDigest: "d".repeat(64),
    candidateManifestPath: "/private/git/source-inventory.json",
    candidateManifestSha256: "f".repeat(64),
  };
  const mode = classifyRenderProfileSourceEvidenceV1(gitProvenance);
  const inventory = {
    status: "PINNED_GIT_EXPORT_SOURCE_EVIDENCE",
    sourceRoots: roots,
    files: inventoryFiles,
    verificationMetadata: { gitFileCount: 2, exportFileCount: 2 },
  };
  const selected = selectRenderProfileMappingEvidenceV1({ kind: mode.kind, candidateSourceInventory: inventory });
  const mapped = mapGeneratedProfilePosition({}, { lineNumber: 2, columnNumber: 3 }, mappingFor("/src/app/example.tsx"), {
    ...selected.sourceEvidence,
    sourceMapSources: ["/src/app/example.tsx"],
    sourcesContent: [mobileContent],
  });
  assert.equal(mapped.status, "MAPPED");
  const mismatchedContent = mapGeneratedProfilePosition({}, { lineNumber: 2, columnNumber: 3 }, mappingFor("/src/app/example.tsx"), {
    ...selected.sourceEvidence,
    sourceMapSources: ["/src/app/example.tsx"],
    sourcesContent: ["changed source"],
  });
  assert.equal(mismatchedContent.status, "SOURCE_CONTENT_SHA256_MISMATCH");
  assert.throws(() => selectRenderProfileMappingEvidenceV1({ kind: mode.kind, candidateSourceInventory: null }),
    /fully verified source evidence/);
});

test("partial Git fields fail closed even when legacy freeze fields are also present", () => {
  assert.throws(() => classifyRenderProfileSourceEvidenceV1({
    ...legacyExactProvenance,
    frozenSourceManifestSha256: "9".repeat(64),
    kind: "data-only-adapter-for-retained-map-enabled-export",
    sourceOrigin: { commit: "e".repeat(40) },
  }), /Git export provenance is missing its raw inventory digest/);
  assert.throws(() => classifyRenderProfileSourceEvidenceV1({
    schemaVersion: 1,
    status: "complete",
    kind: "post-export-exact-source-root-inventory-derived-for-profile-input",
    frozenSourceManifestSha256: "9".repeat(64),
    candidateFiles: 2,
    candidateDigest: "d".repeat(64),
  }), /legacy candidate export provenance is missing exact inventory fields/);
  assert.throws(() => classifyRenderProfileSourceEvidenceV1({
    schemaVersion: 1,
    frozenSourceManifestSha256: "9".repeat(64),
    candidateManifestPath: "/private/partial/inventory.json",
  }), /partial candidate export provenance cannot fall back/);
});

test("frozen root-only provenance does not claim Metro alias mapping and keeps exact URL/map binding", () => {
  const mode = classifyRenderProfileSourceEvidenceV1({
    schemaVersion: 1,
    frozenSourceManifestSha256: "9".repeat(64),
    frozenSourceEntryCount: 321,
    sourceCompleteness: { manifestFileCount: 321, workspaceComplementCopied: false },
  });
  const selected = selectLegacyRenderProfileMappingEvidenceV1({
    kind: mode.kind,
    candidateSourceInventory: null,
  });
  const unresolved = mapGeneratedProfilePosition({}, { lineNumber: 2, columnNumber: 3 }, mappingFor("/src/app/example.tsx"), selected.sourceEvidence ?? undefined);
  assert.equal(unresolved.status, "PINNED_SOURCE_INVENTORY_MISSING");
  assert.equal(selected.report.metroAliasMapping, "UNRESOLVED_WITHOUT_PINNED_FILE_HASHES");

  const identity = recordScriptUrlIdentity(
    "https://fixture.invalid/__kcoder_mobile_mount_v1__/_expo/static/js/web/entry-123.js",
    "https://fixture.invalid/",
  );
  const exact = resolveScriptMapBinding(identity, ["_expo/static/js/web/entry-123.js.map"], {
    trustedMountPath: "/__kcoder_mobile_mount_v1__",
  });
  assert.equal(exact.status, "EXACT_BUNDLE_PATH_MATCH");
  assert.equal(resolveScriptMapBinding(identity, ["_expo/static/js/web/other.js.map"], {
    trustedMountPath: "/__kcoder_mobile_mount_v1__",
  }).status, "NO_EXACT_BUNDLE_PATH_MAP");
  const foreign = recordScriptUrlIdentity(
    "https://foreign.invalid/__kcoder_mobile_mount_v1__/_expo/static/js/web/entry-123.js",
    "https://fixture.invalid/",
  );
  assert.equal(foreign.status, "FOREIGN_SCRIPT_ORIGIN");
});
