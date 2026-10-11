import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, readdir } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { repoRoot, runE2E } from "../harness/run-context.mjs";

const EXPECTED_SUITE_SHA256 = "80c0468a16cde23271979564754726f358a6daff2dd3ae721ac0b1b90b0c3600";
const EXPECTED_REUSE_HELPER_SHA256 = "d3e84b074e485dd2bf171d690d18e130920689b67711ad3f56a3bd791eb363f3";
const EXPECTED_BINARY_SHA256 = "289618f7e0670be9840b48adcd93d73261ea1c20034596ae6a95d5ed41f3b67d";
const EXPECTED_STATIC02_EXPORT_MANIFEST_SHA256 = "7e18947fd6627cfbfc4770d2e4ee694af87405e03e1a1260f58e32094972b4fe";
const EXPECTED_STATIC02_DERIVED_PROVENANCE_SHA256 = "e16eeeea3b29980562b05f95ac768bde17f038e71d994032048f760dbee44421";
const EXPECTED_STATIC02_DERIVATION_PROOF_SHA256 = "b028f2e7739b941760dae75e135090ddcfc3c0af3d25dea5a2b3406545d028d8";
const EXPECTED_WEB_SOURCE_TREE_SHA256 = "2b9bf9e9e6f623962d04c3561e7130d186d79b91e38fe206cfae79f74154af02";
const EXPECTED_WEB_BUNDLE_SHA256 = "ec2fc4f871873fd3bb2295212abb3687e2fb691e381514f4ca1ed9695f835ada";
const EXPECTED_WEB_FILE_COUNT = 37;
const EXPECTED_DERIVED_REUSE_MANIFEST_SHA256 = "ca418f46a102ab3fdcae5bd5e52d41b6c3ed43cc6e5475e42e709969282042d5";
const EXPECTED_STATIC02_CANDIDATE_MANIFEST_SHA256 = "51c36f401fc6addc93610f0c5c690103e4aa397865329e713011dd2e82f2df5e";
const EXPECTED_STATIC02_NEW_TSX_SHA256 = "a8aa57b0fc3071c01cd0e48276ddc54fb2bd48b189dba492eeb6aa6666574b7a";
const EXPECTED_STATIC03_SOURCE_DIGEST = "0a51d82e17ef78d9db034d34143258b49f094d605a2e89e2c2e8498e70ffc15b";
const EXPECTED_STATIC03_SOURCE_ARCHIVE_SHA256 = "1c3388b58f89e9d4a2dc45ed3fc41a307126f108500e93d2689330f447003789";
const EXPECTED_STATIC03_SOURCE_LIST_SHA256 = "130f826bab343002b18de35e64bacb63d4c7fb41728316ca97c77d957451ed25";
const EXPECTED_STATIC03_BUILD_MANIFEST_SHA256 = "da245c5521c9ea7ac7716c4b8a072c5808d913996c6cab15014501ac29a10932";
const EXPECTED_STATIC03_BINARY_COPY_PROOF_SHA256 = "708b6282a6c73e89308c48f59a327a166f1287789d9b53e174a1654fae40ff7c";
const EXPECTED_NODE_VERSION = "v22.17.0";
const EXPECTED_NODE_EXECUTABLE = "/home/hyf/.local/opt/node-v22.17.0-linux-x64/bin/node";
const STATIC03_BUILD_EVIDENCE_ROOT = resolve(repoRoot, "target/private-phone-ux-validation/b2-static03-build-20261008");
const STATIC03_SOURCE_ARCHIVE_PATH = resolve(STATIC03_BUILD_EVIDENCE_ROOT, "source-archive.json");
const STATIC03_SOURCE_BEFORE_PATH = resolve(STATIC03_BUILD_EVIDENCE_ROOT, "source-before.sha256");
const STATIC03_SOURCE_AFTER_PATH = resolve(STATIC03_BUILD_EVIDENCE_ROOT, "source-after.sha256");
const STATIC03_BUILD_MANIFEST_PATH = resolve(STATIC03_BUILD_EVIDENCE_ROOT, "static03-manifest.json");
const STATIC03_BINARY_COPY_PROOF_PATH = resolve(STATIC03_BUILD_EVIDENCE_ROOT, "frozen-copy.json");
const EXPECTED_GATEWAY_SOURCE_SET_SHA256 = "29a66cb56cba0a4ea89bee51823297966b02f7e7479cb6aeddf38989e4d7431b";
const EXPECTED_GATEWAY_SOURCE_FILES = [
  { path: "apps/kcoder-studio/dev-server.mjs", sha256: "b791281b303dfebad4b5686fc2d262503dfe6fa1957bef8b2a2fb10942024003", size: 117145 },
  { path: "apps/kcoder-studio/src/workspace-app-server-broker.js", sha256: "de270981df51156abcc4320113f0717fa238b7cdbfbea6027098b711c19ceb59", size: 88632 },
  { path: "apps/kcoder-studio/src/retention-context.js", sha256: "23f2fc8a613f2822cfaccb2fb582dfe7b9726bd3303a5ff9e4b7368c9c7d541f", size: 13989 },
  { path: "apps/kcoder-studio/src/mobile-device-auth.js", sha256: "2bbaa56e754ddb757ed129d88042e738917bdcb38adb9de525593435cfb9d125", size: 10766 },
  { path: "apps/kcoder-studio/src/mobile-device-private-storage.js", sha256: "19aaa69ea9b8a7b548fbf698358834ce6e3196f3629c78761e15263f0307d1d6", size: 3769 },
  { path: "apps/kcoder-studio/src/server-config.js", sha256: "39a5058b453a4abb76752862f275121fa370c48d224ad30dbd84b90a2f402b01", size: 15548 },
  { path: "apps/kcoder-studio/src/runtime-target-adapter.js", sha256: "75e5a2074caba0e9608353a77e775552395688f5b8eba5662b36593b11187525", size: 1564 },
  { path: "apps/kcoder-studio/src/gateway-channel.js", sha256: "7b7eb511e58ddfd038b90bb8bafa76d2b31058b93e4f218e68c7f2c051a4f12a", size: 699 },
  { path: "apps/kcoder-studio/src/request-load.js", sha256: "7d6f7b224fdb952958d145da7ae8865cd171131c845d7cd40bfd1e978336b6f1", size: 2970 },
  { path: "apps/kcoder-studio/src/broker-request-budget.js", sha256: "ac17d5e702eefada5192185f2978844472971beb608a6c8cb52a6b2eda7664c5", size: 3025 },
  { path: "apps/kcoder-studio/src/workspace-broker-release.js", sha256: "043006fe985028ab4a0768a1a5cc1a8d21bc05f6acca729b9d4b7574578a0725", size: 1815 },
];
const STATIC02_WEB_EXPORT_PINS_READY = true;
const PINNED_BINARY_SOURCE_READY = true;
const DERIVED_WEB_MANIFEST_DIRECTORY = "artifacts/worktree-static02-source-bundle";
const DERIVED_WEB_MANIFEST_NAME = "worktree-static02-derived-reuse-manifest.json";
const STATIC02_EXPORT_ROOT = resolve(repoRoot, "target/private-phone-ux-implementation/worktree-handoff-static02-derived-export-153821-20261008");
const STATIC02_EXPORT_BUNDLE_ROOT = resolve(STATIC02_EXPORT_ROOT, "bundle");
const STATIC02_EXPORT_MANIFEST_PATH = resolve(STATIC02_EXPORT_ROOT, "mobile-web-export-worktree-handoff-static02-schema2-manifest.json");
const STATIC02_DERIVED_PROVENANCE_PATH = resolve(STATIC02_EXPORT_ROOT, "mobile-web-export-worktree-handoff-static02-schema1-provenance.json");
const STATIC02_DERIVATION_PROOF_PATH = resolve(STATIC02_EXPORT_ROOT, "derivation-proof.json");
const HANDOFF_CASE_FILTER = "worktree_link_ack_loss_reload";
const EXPECTED_SCENARIO_NAMES = [HANDOFF_CASE_FILTER];
const SOURCE_COMPOSITION_NOTE = "Mixed input scope: the fixed 11-file current Gateway JavaScript set; New315 Mobile Web candidate digest 2b9bf9e9e6f623962d04c3561e7130d186d79b91e38fe206cfae79f74154af02 with static-02 New.tsx SHA-256 a8aa57b0fc3071c01cd0e48276ddc54fb2bd48b189dba492eeb6aa6666574b7a; the Expo export completed and was independently verified as 37 files / bundle SHA-256 ec2fc4f871873fd3bb2295212abb3687e2fb691e381514f4ca1ed9695f835ada from schema-2 manifest SHA-256 7e18947fd6627cfbfc4770d2e4ee694af87405e03e1a1260f58e32094972b4fe, but its original wrapper result remains FAIL (EEXIST) and is not promoted. The retained schema-1 provenance and derivation proof remain distinct evidence; this runner derives a separate local schema-1 reuse-helper input from the pinned schema-2 bundleFiles and leaves the original schema-2 manifest untouched. This frozen New315 export does not include the later live two-file reuse patch and remains on its recorded factory baseline. App-server input is the immutable B2 static-03 candidate built from a separately pinned 17-file Rust source set (source digest 0a51d82e17ef78d9db034d34143258b49f094d605a2e89e2c2e8498e70ffc15b, source archive SHA-256 1c3388b58f89e9d4a2dc45ed3fc41a307126f108500e93d2689330f447003789; build metadata status STATIC_ONLY_NOT_RUN, so runtime remains untested), binary SHA-256 289618f7e0670be9840b48adcd93d73261ea1c20034596ae6a95d5ed41f3b67d, frozen-copy proof SHA-256 708b6282a6c73e89308c48f59a327a166f1287789d9b53e174a1654fae40ff7c. B2 production capability remains disabled; the real app-server initialize capability gate must pass, which does not claim production enablement. This single worktree recovery scenario makes no real Provider or model-quality claim.";
const EXPECTED_MODEL_POLICY = "Run only worktree_link_ack_loss_reload with an owned immutable app-server copy and a loopback deterministic provider; this is one mixed-source integration scenario, makes no B2 backend-support claim, and makes no real Provider or model-quality claim";
const SUITE_RELATIVE = "apps/kcoder-studio/e2e/suites/mobile/mobile-workspace-task-handoff-browser.observed.review.e2e.mjs";
const REUSE_HELPER_RELATIVE = "apps/kcoder-studio/e2e/harness/mobile-web-export-reuse.mjs";
const GATEWAY_SOURCE_PATHS = [
  "apps/kcoder-studio/dev-server.mjs",
  "apps/kcoder-studio/src/workspace-app-server-broker.js",
  "apps/kcoder-studio/src/retention-context.js",
  "apps/kcoder-studio/src/mobile-device-auth.js",
  "apps/kcoder-studio/src/mobile-device-private-storage.js",
  "apps/kcoder-studio/src/server-config.js",
  "apps/kcoder-studio/src/runtime-target-adapter.js",
  "apps/kcoder-studio/src/gateway-channel.js",
  "apps/kcoder-studio/src/request-load.js",
  "apps/kcoder-studio/src/broker-request-budget.js",
  "apps/kcoder-studio/src/workspace-broker-release.js",
];
const BINARY_SOURCE = resolve(repoRoot, "target/private-phone-ux-validation/b2-static03-build-20261008/frozen-candidate/kcoder");

await runE2E(import.meta.url, {
  testId: "mobile-workspace-task-handoff-owned-binary-runner-static02-once",
  tier: "full-integration",
  modelPolicy: EXPECTED_MODEL_POLICY,
  sourceComposition: SOURCE_COMPOSITION_NOTE,
  retainSuccessLogs: true,
  cleanupTimeoutMs: 15_000,
  survivorCheckTimeoutMs: 10_000,
}, async context => {
  const invalidCaseFilter = HANDOFF_CASE_FILTER !== undefined
    && HANDOFF_CASE_FILTER !== "worktree_link_ack_loss_reload";
  await context.writeArtifactJson("case-selection-preflight.json", {
    status: invalidCaseFilter ? "FAIL" : "PASS",
    mode: "single-case",
    filterPresent: true,
    filterAccepted: !invalidCaseFilter,
    expectedScenarioNames: invalidCaseFilter ? [] : EXPECTED_SCENARIO_NAMES,
    expectedScenarioCount: invalidCaseFilter ? 0 : EXPECTED_SCENARIO_NAMES.length,
    modelPolicy: EXPECTED_MODEL_POLICY,
  });
  assert.equal(invalidCaseFilter, false,
    "the owned static-02 runner is fixed to worktree_link_ack_loss_reload");
  await context.writeArtifactJson("source-composition-preflight.json", {
    status: STATIC02_WEB_EXPORT_PINS_READY && PINNED_BINARY_SOURCE_READY
      ? "READY" : "WAITING_FOR_APPROVED_STATIC02_EXPORT_AND_IMMUTABLE_BINARY_SOURCE_PINS",
    sourceComposition: SOURCE_COMPOSITION_NOTE,
    gatewaySourceSetSha256: EXPECTED_GATEWAY_SOURCE_SET_SHA256,
    gatewaySourceFileCount: EXPECTED_GATEWAY_SOURCE_FILES.length,
    appServerBinarySha256: EXPECTED_BINARY_SHA256,
    appServerBinarySourceReady: PINNED_BINARY_SOURCE_READY,
    mobileWebStatic02PinsReady: STATIC02_WEB_EXPORT_PINS_READY,
  });
  assert.equal(STATIC02_WEB_EXPORT_PINS_READY && PINNED_BINARY_SOURCE_READY, true,
    "the approved New315 Mobile Web export pins and immutable binary source path are not complete; this draft runner must not start");
  assert.equal(process.version, EXPECTED_NODE_VERSION, "owned handoff runner must use the approved Node version");
  assert.equal(process.execPath, EXPECTED_NODE_EXECUTABLE, "owned handoff runner must use the approved Node executable path");

  const static03BuildEvidence = await verifyPinnedStatic03BuildEvidence();
  await context.writeArtifactJson("b2-static03-build-source-provenance.json", {
    status: "PASS_STATIC_SOURCE_AND_COPY_PROOF",
    appServerBinaryPath: BINARY_SOURCE,
    appServerBinarySha256: EXPECTED_BINARY_SHA256,
    appServerBinarySize: 465_185_944,
    appServerBinaryMode: 0o555,
    sourceArchivePath: STATIC03_SOURCE_ARCHIVE_PATH,
    sourceArchiveSha256: EXPECTED_STATIC03_SOURCE_ARCHIVE_SHA256,
    sourceBeforeAndAfterListSha256: EXPECTED_STATIC03_SOURCE_LIST_SHA256,
    sourceDigest: EXPECTED_STATIC03_SOURCE_DIGEST,
    verifiedSourceFileCount: static03BuildEvidence.sourceFiles.length,
    verifiedSourceFiles: static03BuildEvidence.sourceFiles,
    buildManifestPath: STATIC03_BUILD_MANIFEST_PATH,
    buildManifestSha256: EXPECTED_STATIC03_BUILD_MANIFEST_SHA256,
    buildManifestStatus: "STATIC_ONLY_NOT_RUN",
    buildManifestListedFileCount: static03BuildEvidence.buildManifestFiles.length,
    frozenCopyProofPath: STATIC03_BINARY_COPY_PROOF_PATH,
    frozenCopyProofSha256: EXPECTED_STATIC03_BINARY_COPY_PROOF_SHA256,
    frozenCopyProofStatus: "FROZEN_COPY_PASS",
    productionRetentionCapabilityEnabled: false,
    runtimeCapabilityRequirement: "the selected real app-server initialize capability gate must pass; this does not enable production capability",
  });

  const suitePath = resolve(repoRoot, SUITE_RELATIVE);
  const helperPath = resolve(repoRoot, REUSE_HELPER_RELATIVE);
  assert.equal(await hashRegularFile(suitePath), EXPECTED_SUITE_SHA256, "handoff suite source differs from its approved pin");
  assert.equal(await hashRegularFile(helperPath), EXPECTED_REUSE_HELPER_SHA256, "Mobile export reuse helper differs from its approved pin");
  const gatewaySourceSet = await hashGatewaySources();
  assert.equal(gatewaySourceSet.aggregateSha256, EXPECTED_GATEWAY_SOURCE_SET_SHA256,
    "the named 11-file Gateway source set differs from its approved pin");
  assert.deepEqual(gatewaySourceSet.files, EXPECTED_GATEWAY_SOURCE_FILES,
    "each named Gateway JavaScript file must match its fixed path, SHA-256, and size pin");

  const webSourceBefore = await readPinnedStatic02Export();
  const stagedWeb = await stagePinnedStatic02Export(context, webSourceBefore);
  const WEB_RUN_ROOT = context.runRoot;
  const WEB_BUNDLE_ROOT = stagedWeb.bundleRoot;
  const WEB_MANIFEST_PATH = stagedWeb.manifestPath;
  const EXPECTED_WEB_MANIFEST_SHA256 = stagedWeb.manifestSha256;
  const webManifestBytes = await readRegularFile(WEB_MANIFEST_PATH, 1024 * 1024);
  assert.equal(sha256(webManifestBytes), EXPECTED_WEB_MANIFEST_SHA256, "retained Web manifest differs from its approved pin");
  const webManifest = parseJson(webManifestBytes, "retained Web manifest");
  assert.equal(webManifest.schemaVersion, 1);
  assert.equal(webManifest.directory, DERIVED_WEB_MANIFEST_DIRECTORY);
  assert.equal(webManifest.sourceTreeSha256, EXPECTED_WEB_SOURCE_TREE_SHA256);
  assert.equal(webManifest.bundleSha256, EXPECTED_WEB_BUNDLE_SHA256);
  assert.equal(webManifest.bundleFileCount, EXPECTED_WEB_FILE_COUNT);
  assert.equal(webManifest.files?.length, EXPECTED_WEB_FILE_COUNT);
  assert.equal(resolve(WEB_RUN_ROOT, webManifest.directory), WEB_BUNDLE_ROOT,
    "retained Web bundle must match the RunContext artifact manifest");
  await context.writeArtifactJson("worktree-static02-derived-source-provenance.json", {
    schemaVersion: 1,
    status: "derived-inputs-verified; original export wrapper remains failed",
    new315Candidate: {
      sourceDigest: EXPECTED_WEB_SOURCE_TREE_SHA256,
      fileCount: 315,
      mobileFileCount: 296,
      sharedFileCount: 19,
      overlayManifestSha256: EXPECTED_STATIC02_CANDIDATE_MANIFEST_SHA256,
      overlayNewTsxSha256: EXPECTED_STATIC02_NEW_TSX_SHA256,
    },
    export: {
      standardSchemaVersion: 2,
      standardManifestPath: STATIC02_EXPORT_MANIFEST_PATH,
      standardManifestSha256: webSourceBefore.exportManifestSha256,
      sourceTreeSha256: webSourceBefore.exportManifest.sourceTreeSha256,
      bundleSha256: webSourceBefore.exportManifest.bundleSha256,
      bundleFileCount: webSourceBefore.exportManifest.bundleFileCount,
      dependencySourceTreeSha256: webSourceBefore.exportManifest.dependencyProvenance.sourceTreeSha256Before,
      dependencyOwnedTreeSha256: webSourceBefore.exportManifest.dependencyProvenance.copiedTreeSha256,
      dependencyCopiedFileCount: webSourceBefore.exportManifest.dependencyProvenance.copiedFileCount,
    },
    originalWrapperRun: webSourceBefore.derivedProvenance.wrapperRun,
    originalFailureCategory: webSourceBefore.derivationProof.sourceRun.failureCategory,
    derivedProvenancePath: STATIC02_DERIVED_PROVENANCE_PATH,
    derivedProvenanceSha256: webSourceBefore.derivedProvenanceSha256,
    derivationProofPath: STATIC02_DERIVATION_PROOF_PATH,
    derivationProofSha256: webSourceBefore.derivationProofSha256,
    derivedCompatibleView: {
      kind: "legacy-reuse-helper-input-derived-from-standard-schema-2-bundleFiles",
      schemaVersion: 1,
      manifestPath: WEB_MANIFEST_PATH,
      manifestSha256: EXPECTED_WEB_MANIFEST_SHA256,
      bundleRoot: WEB_BUNDLE_ROOT,
      bundleSha256: EXPECTED_WEB_BUNDLE_SHA256,
      bundleFileCount: EXPECTED_WEB_FILE_COUNT,
    },
    appServer: {
      binaryPath: BINARY_SOURCE,
      binarySha256: EXPECTED_BINARY_SHA256,
      sourceDigest: EXPECTED_STATIC03_SOURCE_DIGEST,
      sourceFileCount: static03BuildEvidence.sourceFiles.length,
      buildManifestPath: STATIC03_BUILD_MANIFEST_PATH,
      buildManifestSha256: EXPECTED_STATIC03_BUILD_MANIFEST_SHA256,
      buildMetadataStatus: "STATIC_ONLY_NOT_RUN",
      frozenCopyProofPath: STATIC03_BINARY_COPY_PROOF_PATH,
      frozenCopyProofSha256: EXPECTED_STATIC03_BINARY_COPY_PROOF_SHA256,
      productionRetentionCapabilityEnabled: false,
      runtimeInitializeCapabilityGateRequired: true,
    },
    gatewaySourceSetSha256: EXPECTED_GATEWAY_SOURCE_SET_SHA256,
    sourceBoundary: "Single worktree recovery case only. Frozen New315 Mobile Web excludes the later live two-file reuse patch and stays on its recorded factory baseline. This does not claim B2 capability is enabled or that the failed original export wrapper passed.",
  });
  await context.writeArtifactJson("worktree-static02-derived-source-preflight.json", {
    status: "PASS",
    sourceComposition: SOURCE_COMPOSITION_NOTE,
    standardExportManifestPath: STATIC02_EXPORT_MANIFEST_PATH,
    standardExportManifestSha256: webSourceBefore.exportManifestSha256,
    standardExportManifestSchemaVersion: 2,
    derivedProvenancePath: STATIC02_DERIVED_PROVENANCE_PATH,
    derivedProvenanceSha256: webSourceBefore.derivedProvenanceSha256,
    derivationProofPath: STATIC02_DERIVATION_PROOF_PATH,
    derivationProofSha256: webSourceBefore.derivationProofSha256,
    originalWrapperStatus: "failed",
    originalWrapperFailureCategory: "EEXIST collision between the schema-2 export manifest and the wrapper's attempted schema-1 reusable artifact",
    originalWrapperWasPromoted: false,
    candidateDigest: EXPECTED_WEB_SOURCE_TREE_SHA256,
    candidateFileCount: 315,
    candidateMobileFileCount: 296,
    candidateSharedFileCount: 19,
    candidateOverlayManifestSha256: EXPECTED_STATIC02_CANDIDATE_MANIFEST_SHA256,
    candidateNewTsxSha256: EXPECTED_STATIC02_NEW_TSX_SHA256,
    dependencySourceTreeSha256: "d91f89f1237d2139ef31ee75565230105014536dc5c9a8c34bf436d0bcc7340c",
    dependencyOwnedTreeSha256: "754d1db10bd502faeb0b6e82820d455cae680166008a443f7397457f1ef21d29",
    dependencyCopiedFileCount: 52_252,
    bundleSha256: EXPECTED_WEB_BUNDLE_SHA256,
    bundleFileCount: EXPECTED_WEB_FILE_COUNT,
    derivedReusableInputManifestPath: WEB_MANIFEST_PATH,
    derivedReusableInputManifestSha256: EXPECTED_WEB_MANIFEST_SHA256,
    derivedReusableInputManifestSchemaVersion: 1,
    derivedReusableInputPurpose: "derived-compatible-view from the pinned schema-2 bundleFiles; distinct from both standard export manifest and schema-1 provenance",
    derivedBundleRoot: WEB_BUNDLE_ROOT,
    derivedBundleCopyVerified: true,
  });

  const suiteRunParent = resolve(repoRoot, "target/test", SUITE_RELATIVE);
  const suiteRunsBefore = await listRunDirectories(suiteRunParent);
  const sourceBefore = await hashRegularFileWithStat(BINARY_SOURCE);
  assert.equal(sourceBefore.sha256, EXPECTED_BINARY_SHA256, "source app-server binary differs from its approved pin before copying");

  const copyDirectory = context.pathInState("immutable-app-server-binary");
  await mkdir(copyDirectory, { recursive: false, mode: 0o700 });
  const binaryCopy = resolve(copyDirectory, "kcoder");
  const copySha256 = await copyExecutableNoFollow(BINARY_SOURCE, binaryCopy, sourceBefore.size);
  assert.equal(copySha256, EXPECTED_BINARY_SHA256, "owned executable copy differs from its approved pin");
  await chmod(binaryCopy, 0o555);
  const copyBefore = await hashRegularFileWithStat(binaryCopy);
  assert.equal(copyBefore.sha256, EXPECTED_BINARY_SHA256);
  assert.equal(copyBefore.mode, 0o555, "owned app-server copy must be immutable mode 0555");
  const sourceAfterCopy = await hashRegularFileWithStat(BINARY_SOURCE);
  assert.equal(sourceAfterCopy.sha256, EXPECTED_BINARY_SHA256, "source app-server binary changed during copy");
  assert.equal(sourceAfterCopy.size, sourceBefore.size);

  await context.writeArtifactJson("binary-copy-preflight.json", {
    status: "PASS",
    nodeVersion: process.version,
    nodeExecutable: process.execPath,
    suiteSourceSha256: EXPECTED_SUITE_SHA256,
    reuseHelperSha256: EXPECTED_REUSE_HELPER_SHA256,
    gatewaySourceSetSha256: gatewaySourceSet.aggregateSha256,
    gatewaySourceFileCount: gatewaySourceSet.files.length,
    gatewaySourceFiles: gatewaySourceSet.files,
    sourceComposition: SOURCE_COMPOSITION_NOTE,
    sourceBinaryPath: BINARY_SOURCE,
    sourceBinarySha256BeforeCopy: sourceBefore.sha256,
    sourceBinarySha256AfterCopy: sourceAfterCopy.sha256,
    ownedCopyRelativePath: relative(context.runRoot, binaryCopy).split(sep).join("/"),
    ownedCopySha256: copyBefore.sha256,
    ownedCopyMode: copyBefore.mode,
    webManifestSha256: EXPECTED_WEB_MANIFEST_SHA256,
    webBundleSha256: EXPECTED_WEB_BUNDLE_SHA256,
    webSourceTreeSha256: EXPECTED_WEB_SOURCE_TREE_SHA256,
    webBundleFileCount: EXPECTED_WEB_FILE_COUNT,
    expectedScenarioNames: EXPECTED_SCENARIO_NAMES,
    expectedScenarioCount: EXPECTED_SCENARIO_NAMES.length,
    modelPolicy: EXPECTED_MODEL_POLICY,
  });

  const env = context.isolatedEnvironment({
    KCODER_E2E_CHROMIUM_NO_SANDBOX: "1",
    KCODER_E2E_KCODER_BIN: binaryCopy,
    KCODER_E2E_EXPECTED_KCODER_SHA256: EXPECTED_BINARY_SHA256,
    KCODER_E2E_HANDOFF_WEB_BUNDLE_ROOT: WEB_BUNDLE_ROOT,
    KCODER_E2E_HANDOFF_WEB_MANIFEST: WEB_MANIFEST_PATH,
    KCODER_E2E_HANDOFF_WEB_SOURCE_TREE_SHA256: EXPECTED_WEB_SOURCE_TREE_SHA256,
    KCODER_E2E_HANDOFF_WEB_MANIFEST_SHA256: EXPECTED_WEB_MANIFEST_SHA256,
    KCODER_E2E_HANDOFF_WEB_BUNDLE_SHA256: EXPECTED_WEB_BUNDLE_SHA256,
    KCODER_E2E_HANDOFF_GATEWAY_SOURCE_SET_SHA256: EXPECTED_GATEWAY_SOURCE_SET_SHA256,
    ...(HANDOFF_CASE_FILTER === undefined ? {} : { KCODER_E2E_HANDOFF_CASE: HANDOFF_CASE_FILTER }),
  });
  const suiteLabel = "handoff-worktree-case-pinned-suite";
  const child = context.spawnOwned(suiteLabel, process.execPath, [suitePath], {
    cwd: repoRoot,
    env,
  });
  const childOwner = context.processes.get(suiteLabel);
  assert.ok(childOwner?.pid === child.pid && childOwner.pgid > 0, "RunContext must own the exact pinned suite subprocess and process group");

  let childOutcome;
  let childFailure = null;
  try {
    childOutcome = await waitForChild(child, 600_000);
  } catch (error) {
    childFailure = error;
  }

  let forcedStopFailure = null;
  if (childFailure) {
    try {
      await context.stopOwned(suiteLabel);
    } catch (error) {
      forcedStopFailure = error;
    }
  }

  const sourceAfterRun = await hashRegularFileWithStat(BINARY_SOURCE);
  const copyAfterRun = await hashRegularFileWithStat(binaryCopy);
  const suiteShaAfterRun = await hashRegularFile(suitePath);
  const helperShaAfterRun = await hashRegularFile(helperPath);
  const gatewaySourcesAfterRun = await hashGatewaySources();
  const webManifestAfterRun = await readRegularFile(WEB_MANIFEST_PATH, 1024 * 1024);
  const webSourceAfterRun = await readPinnedStatic02Export();
  const stagedWebAfterRun = await verifyBundleTreeExact(WEB_BUNDLE_ROOT, webSourceBefore.files);
  const suiteUnchanged = suiteShaAfterRun === EXPECTED_SUITE_SHA256;
  const helperUnchanged = helperShaAfterRun === EXPECTED_REUSE_HELPER_SHA256;
  const gatewaySourcesUnchanged = gatewaySourcesAfterRun.aggregateSha256 === EXPECTED_GATEWAY_SOURCE_SET_SHA256
    && JSON.stringify(gatewaySourcesAfterRun) === JSON.stringify(gatewaySourceSet);
  const webManifestUnchanged = sha256(webManifestAfterRun) === EXPECTED_WEB_MANIFEST_SHA256;
  const webExportInputsUnchanged = webSourceAfterRun.snapshotSha256 === webSourceBefore.snapshotSha256;
  const stagedWebBundleUnchanged = stagedWebAfterRun.aggregateSha256 === EXPECTED_WEB_BUNDLE_SHA256;
  const sourceBinaryUnchanged = sourceAfterRun.sha256 === EXPECTED_BINARY_SHA256;
  const copyUnchanged = copyAfterRun.sha256 === EXPECTED_BINARY_SHA256 && copyAfterRun.mode === 0o555;

  const suiteRunsAfter = await listRunDirectories(suiteRunParent);
  const newSuiteRuns = suiteRunsAfter.filter(name => !suiteRunsBefore.includes(name));
  const suiteRunRoot = newSuiteRuns.length === 1 ? resolve(suiteRunParent, newSuiteRuns[0]) : null;
  let suiteEvidence = null;
  if (suiteRunRoot) suiteEvidence = await readSuiteEvidence(suiteRunRoot);
  const actualScenarioNames = suiteEvidence?.scenarioResults?.map(result => result.name) ?? [];
  const scenarioSelectionMatches = actualScenarioNames.length === EXPECTED_SCENARIO_NAMES.length
    && JSON.stringify(actualScenarioNames) === JSON.stringify(EXPECTED_SCENARIO_NAMES);
  const postflight = {
    status: childFailure || childOutcome?.code !== 0 || !suiteUnchanged || !helperUnchanged
      || !gatewaySourcesUnchanged || !webManifestUnchanged || !webExportInputsUnchanged || !stagedWebBundleUnchanged || !sourceBinaryUnchanged || !copyUnchanged
      || !scenarioSelectionMatches ? "FAIL" : "PASS",
    suiteChildPid: child.pid,
    suiteChildPgid: childOwner.pgid,
    suiteExitCode: childOutcome?.code ?? null,
    suiteSignal: childOutcome?.signal ?? null,
    suiteRunDirectoriesCreated: newSuiteRuns,
    suiteRunRoot,
    innerRunStatus: suiteEvidence?.runStatus ?? null,
    scenarioSelection: "single-case",
    selectedCaseFilter: HANDOFF_CASE_FILTER ?? null,
    expectedScenarioNames: EXPECTED_SCENARIO_NAMES,
    expectedScenarioCount: EXPECTED_SCENARIO_NAMES.length,
    sourceComposition: SOURCE_COMPOSITION_NOTE,
    actualScenarioNames,
    actualScenarioCount: actualScenarioNames.length,
    scenarioSelectionMatches,
    modelPolicy: EXPECTED_MODEL_POLICY,
    scenarioResults: suiteEvidence?.scenarioResults ?? null,
    actualGatewayAndChromiumOwners: suiteEvidence?.owners ?? null,
    actualAppServerProvenance: suiteEvidence?.appServer ?? null,
    suiteUnchanged,
    reuseHelperUnchanged: helperUnchanged,
    gatewaySourceSetUnchanged: gatewaySourcesUnchanged,
    webManifestUnchanged,
    webExportInputsUnchanged,
    webExportManifestSha256: webSourceAfterRun.exportManifestSha256,
    webDerivedProvenanceSha256: webSourceAfterRun.derivedProvenanceSha256,
    webDerivationProofSha256: webSourceAfterRun.derivationProofSha256,
    stagedWebBundleUnchanged,
    stagedWebBundleAggregateSha256: stagedWebAfterRun.aggregateSha256,
    sourceBinarySha256BeforeCopy: sourceBefore.sha256,
    sourceBinarySha256AfterCopy: sourceAfterCopy.sha256,
    sourceBinarySha256AfterSuite: sourceAfterRun.sha256,
    sourceBinaryUnchanged,
    ownedCopySha256BeforeSuite: copyBefore.sha256,
    ownedCopySha256AfterSuite: copyAfterRun.sha256,
    ownedCopyModeBeforeSuite: copyBefore.mode,
    ownedCopyModeAfterSuite: copyAfterRun.mode,
    ownedCopyUnchanged: copyUnchanged,
    gatewaySourceSetSha256: gatewaySourceSet.aggregateSha256,
    gatewaySourceFiles: gatewaySourceSet.files,
    webManifestSha256: EXPECTED_WEB_MANIFEST_SHA256,
    webBundleSha256: EXPECTED_WEB_BUNDLE_SHA256,
    webSourceTreeSha256: EXPECTED_WEB_SOURCE_TREE_SHA256,
    webBundleFileCount: EXPECTED_WEB_FILE_COUNT,
    failureName: childFailure?.name ?? null,
    failureMessage: childFailure?.message ?? null,
    forcedStopFailureName: forcedStopFailure?.name ?? null,
    forcedStopFailureMessage: forcedStopFailure?.message ?? null,
  };
  await context.writeArtifactJson("binary-copy-postflight.json", postflight);
  assert.equal(newSuiteRuns.length, 1, "expected exactly one newly created selected-case RunContext directory");
  if (childFailure) throw childFailure;
  if (forcedStopFailure) throw forcedStopFailure;
  assert.equal(childOutcome.code, 0, `pinned handoff suite exited with code ${childOutcome.code}`);
  assert.equal(sourceBinaryUnchanged, true, "source app-server binary must retain the fixed SHA after the suite run");
  assert.equal(copyUnchanged, true, "owned app-server copy must retain SHA and mode 0555 after the suite run");
  assert.equal(suiteUnchanged, true, "handoff suite source changed during its run");
  assert.equal(helperUnchanged, true, "Mobile export reuse helper changed during its run");
  assert.equal(gatewaySourcesUnchanged, true, "Gateway source files changed during the run");
  assert.equal(webManifestUnchanged && webExportInputsUnchanged && stagedWebBundleUnchanged, true,
    "derived Web manifest, pinned schema-2 source evidence, and staged bundle must remain unchanged during the run");
  assert.equal(suiteEvidence?.runStatus, "passed", "selected-case suite RunContext must finish passed");
  assert.equal(suiteEvidence?.scenarioResults?.length, EXPECTED_SCENARIO_NAMES.length,
    "every expected selected handoff case must be present in suite evidence");
  assert.deepEqual(actualScenarioNames, EXPECTED_SCENARIO_NAMES,
    "suite evidence must contain exactly the expected selected scenario IDs in order");
  assert.ok(suiteEvidence.scenarioResults.every(result => result.status === "PASS"),
    "every selected handoff case must pass");
  assert.equal(suiteEvidence?.owners?.length, 2, "suite evidence must include exact Gateway and Chromium owners");
  assert.ok(suiteEvidence.owners.every(owner => owner.stopped), "suite-owned Gateway and Chromium process groups must be stopped");
  assert.equal(suiteEvidence?.appServer?.configuredPath, binaryCopy, "Gateway must launch the app-server from the immutable copy");
  assert.equal(suiteEvidence?.appServer?.configuredSha256, EXPECTED_BINARY_SHA256);
  assert.equal(suiteEvidence?.appServer?.gatewayPgid, suiteEvidence.owners.find(owner => owner.label === "handoff-review-gateway")?.pgid);
  assert.ok(suiteEvidence.appServer.actualProcesses.some(process => process.sha256 === EXPECTED_BINARY_SHA256
    && process.executablePath === binaryCopy), "actual /proc executable evidence must match the pinned owned copy");

  return {
    status: "PASS",
    scenarioSelection: "single-case",
    selectedCaseFilter: HANDOFF_CASE_FILTER ?? null,
    expectedScenarioNames: EXPECTED_SCENARIO_NAMES,
    expectedScenarioCount: EXPECTED_SCENARIO_NAMES.length,
    modelPolicy: EXPECTED_MODEL_POLICY,
    suiteRunRoot,
    suiteChildPid: child.pid,
    suiteChildPgid: childOwner.pgid,
    scenarioResults: suiteEvidence.scenarioResults.map(({ name, status }) => ({ name, status })),
    appServerBinarySha256: copyAfterRun.sha256,
    appServerBinaryCopyMode: copyAfterRun.mode,
    gatewaySourceSetSha256: gatewaySourceSet.aggregateSha256,
    gatewaySourceFiles: gatewaySourceSet.files,
    sourceComposition: SOURCE_COMPOSITION_NOTE,
    mobileWebManifestSha256: EXPECTED_WEB_MANIFEST_SHA256,
    mobileWebBundleSha256: EXPECTED_WEB_BUNDLE_SHA256,
    mobileWebSourceTreeSha256: EXPECTED_WEB_SOURCE_TREE_SHA256,
    mobileWebBundleFileCount: EXPECTED_WEB_FILE_COUNT,
  };
});

async function hashGatewaySources() {
  const files = [];
  for (const path of GATEWAY_SOURCE_PATHS) {
    const bytes = await readFile(resolve(repoRoot, path));
    files.push({ path, sha256: sha256(bytes), size: bytes.length });
  }
  const aggregateSha256 = sha256(Buffer.from(files.map(file => `${file.path}\0${file.sha256}\n`).join("")));
  return { aggregateSha256, files };
}

async function verifyPinnedStatic03BuildEvidence() {
  const [sourceArchiveBytes, sourceBeforeBytes, sourceAfterBytes, buildManifestBytes, copyProofBytes] = await Promise.all([
    readRegularFile(STATIC03_SOURCE_ARCHIVE_PATH, 1024 * 1024),
    readRegularFile(STATIC03_SOURCE_BEFORE_PATH, 1024 * 1024),
    readRegularFile(STATIC03_SOURCE_AFTER_PATH, 1024 * 1024),
    readRegularFile(STATIC03_BUILD_MANIFEST_PATH, 1024 * 1024),
    readRegularFile(STATIC03_BINARY_COPY_PROOF_PATH, 1024 * 1024),
  ]);
  assert.equal(sha256(sourceArchiveBytes), EXPECTED_STATIC03_SOURCE_ARCHIVE_SHA256,
    "static-03 app-server source archive differs from the approved pin");
  assert.equal(sha256(buildManifestBytes), EXPECTED_STATIC03_BUILD_MANIFEST_SHA256,
    "static-03 app-server build manifest differs from the approved pin");
  assert.equal(sha256(sourceBeforeBytes), EXPECTED_STATIC03_SOURCE_LIST_SHA256,
    "static-03 before-build source inventory differs from its approved pin");
  assert.equal(sha256(sourceAfterBytes), EXPECTED_STATIC03_SOURCE_LIST_SHA256,
    "static-03 after-build source inventory differs from its approved pin");
  assert.equal(sourceBeforeBytes.equals(sourceAfterBytes), true,
    "all 17 pinned app-server sources must have identical before/after build inventories");
  assert.equal(sha256(copyProofBytes), EXPECTED_STATIC03_BINARY_COPY_PROOF_SHA256,
    "static-03 frozen binary copy proof differs from the approved pin");

  const sourceArchive = parseJson(sourceArchiveBytes, "static-03 source archive");
  const buildManifest = parseJson(buildManifestBytes, "static-03 build manifest");
  const copyProof = parseJson(copyProofBytes, "static-03 frozen binary copy proof");
  assert.equal(sourceArchive.sourceDigest, EXPECTED_STATIC03_SOURCE_DIGEST);
  assert.equal(sourceArchive.fileCount, 17);
  assert.equal(sourceArchive.files?.length, 17);
  assert.equal(buildManifest.status, "STATIC_ONLY_NOT_RUN");
  assert.equal(buildManifest.sourceDigest, EXPECTED_STATIC03_SOURCE_DIGEST);
  assert.ok(Array.isArray(buildManifest.files) && buildManifest.files.length === 13,
    "build manifest must preserve its recorded 13-file build-input subset; the separate pinned source archive covers 17 files");

  const archivedFiles = new Map();
  for (const file of sourceArchive.files) {
    assert.ok(file && typeof file.path === "string" && /^[a-f0-9]{64}$/.test(file.sha256)
      && Number.isSafeInteger(file.bytes) && file.bytes >= 0, "static-03 source archive entry is invalid");
    assert.ok(!archivedFiles.has(file.path), "static-03 source archive contains a duplicate path");
    archivedFiles.set(file.path, file);
    const actual = await hashRegularFileWithStat(resolve(repoRoot, file.path));
    assert.equal(actual.sha256, file.sha256, `static-03 source SHA differs for ${file.path}`);
    assert.equal(actual.size, file.bytes, `static-03 source size differs for ${file.path}`);
  }
  for (const file of buildManifest.files) {
    const archived = archivedFiles.get(file.path);
    assert.ok(archived, "build manifest includes a source outside the separately pinned 17-file source archive");
    assert.equal(file.sha256, archived.sha256, `build manifest/source archive SHA differs for ${file.path}`);
    assert.equal(file.bytes, archived.bytes, `build manifest/source archive size differs for ${file.path}`);
  }
  const sourceList = new Map(sourceBeforeBytes.toString("utf8").trimEnd().split("\n").map(line => {
    const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
    assert.ok(match, "static-03 source inventory line is malformed");
    return [match[2], match[1]];
  }));
  assert.equal(sourceList.size, 17, "static-03 before/after source inventories must contain exactly 17 paths");
  for (const file of sourceArchive.files) {
    assert.equal(sourceList.get(file.path), file.sha256,
      `static-03 before/after inventory differs from its 17-file source archive for ${file.path}`);
  }

  assert.equal(copyProof.status, "FROZEN_COPY_PASS");
  assert.equal(copyProof.destinationPath, BINARY_SOURCE);
  assert.equal(copyProof.sourceSize, 465_185_944);
  assert.equal(copyProof.destinationSize, 465_185_944);
  assert.equal(copyProof.sourceMode, "0o700");
  assert.equal(copyProof.destinationMode, "0o555");
  assert.equal(copyProof.destinationDirectoryMode, "0o555");
  for (const field of ["sourcePreSha256", "copyStreamSha256", "sourcePostSha256", "destinationSha256"]) {
    assert.equal(copyProof[field], EXPECTED_BINARY_SHA256, `frozen binary copy proof ${field} differs from the approved binary SHA`);
  }
  const binary = await hashRegularFileWithStat(BINARY_SOURCE);
  assert.equal(binary.sha256, EXPECTED_BINARY_SHA256);
  assert.equal(binary.size, copyProof.destinationSize);
  assert.equal(binary.mode, 0o555);
  return { sourceFiles: sourceArchive.files, buildManifestFiles: buildManifest.files };
}

async function readPinnedStatic02Export() {
  const [exportManifestBytes, derivedProvenanceBytes, derivationProofBytes] = await Promise.all([
    readRegularFile(STATIC02_EXPORT_MANIFEST_PATH, 4 * 1024 * 1024),
    readRegularFile(STATIC02_DERIVED_PROVENANCE_PATH, 4 * 1024 * 1024),
    readRegularFile(STATIC02_DERIVATION_PROOF_PATH, 4 * 1024 * 1024),
  ]);
  const exportManifestSha256 = sha256(exportManifestBytes);
  const derivedProvenanceSha256 = sha256(derivedProvenanceBytes);
  const derivationProofSha256 = sha256(derivationProofBytes);
  assert.equal(exportManifestSha256, EXPECTED_STATIC02_EXPORT_MANIFEST_SHA256,
    "standard New315 schema-2 export manifest differs from its approved pin");
  assert.equal(derivedProvenanceSha256, EXPECTED_STATIC02_DERIVED_PROVENANCE_SHA256,
    "New315 schema-1 derived provenance differs from its approved pin");
  assert.equal(derivationProofSha256, EXPECTED_STATIC02_DERIVATION_PROOF_SHA256,
    "New315 independent derivation proof differs from its approved pin");

  const exportManifest = parseJson(exportManifestBytes, "New315 schema-2 Mobile Web export manifest");
  const derivedProvenance = parseJson(derivedProvenanceBytes, "New315 derived provenance");
  const derivationProof = parseJson(derivationProofBytes, "New315 derivation proof");
  assert.equal(exportManifest.schemaVersion, 2);
  assert.equal(exportManifest.status, "complete");
  assert.equal(exportManifest.failurePhase, null);
  assert.equal(exportManifest.error, null);
  assert.equal(exportManifest.sourceTreeSha256, EXPECTED_WEB_SOURCE_TREE_SHA256);
  assert.equal(exportManifest.sourceHashBefore, EXPECTED_WEB_SOURCE_TREE_SHA256);
  assert.equal(exportManifest.sourceHashAfter, EXPECTED_WEB_SOURCE_TREE_SHA256);
  assert.equal(exportManifest.sourceUnchanged, true);
  assert.equal(exportManifest.snapshotCopyMatchesSource, true);
  assert.equal(exportManifest.snapshotUnchangedDuringExport, true);
  assert.equal(exportManifest.bundleSha256, EXPECTED_WEB_BUNDLE_SHA256);
  assert.equal(exportManifest.bundleFileCount, EXPECTED_WEB_FILE_COUNT);
  assert.equal(exportManifest.bundleFiles?.length, EXPECTED_WEB_FILE_COUNT);
  assert.deepEqual(exportManifest.inputRoots.map(({ name, destination, fileCount }) => ({ name, destination, fileCount })), [
    { name: "mobile", destination: "apps/kcoder-studio/mobile", fileCount: 296 },
    { name: "studio-shared", destination: "apps/kcoder-studio/shared", fileCount: 19 },
  ]);
  assert.deepEqual(derivedProvenance.sourceRoots?.map(({ name, destination, fileCount }) => ({ name, destination, fileCount })), [
    { name: "mobile", destination: "apps/kcoder-studio/mobile", fileCount: 296 },
    { name: "studio-shared", destination: "apps/kcoder-studio/shared", fileCount: 19 },
  ]);
  assert.deepEqual(exportManifest.inputRootsAfter, exportManifest.inputRoots,
    "New315 input roots must match before and after export");
  assert.deepEqual(exportManifest.dependencyProvenance && {
    sourceTreeSha256Before: exportManifest.dependencyProvenance.sourceTreeSha256Before,
    sourceTreeSha256After: exportManifest.dependencyProvenance.sourceTreeSha256After,
    sourceUnchanged: exportManifest.dependencyProvenance.sourceUnchanged,
    copiedTreeSha256: exportManifest.dependencyProvenance.copiedTreeSha256,
    copiedFileCount: exportManifest.dependencyProvenance.copiedFileCount,
    copiedSymlinks: exportManifest.dependencyProvenance.copiedSymlinks,
  }, {
    sourceTreeSha256Before: "d91f89f1237d2139ef31ee75565230105014536dc5c9a8c34bf436d0bcc7340c",
    sourceTreeSha256After: "d91f89f1237d2139ef31ee75565230105014536dc5c9a8c34bf436d0bcc7340c",
    sourceUnchanged: true,
    copiedTreeSha256: "754d1db10bd502faeb0b6e82820d455cae680166008a443f7397457f1ef21d29",
    copiedFileCount: 52_252,
    copiedSymlinks: false,
  }, "New315 dependency source/copy namespaces must match their separately recorded pins");

  const bundleFiles = exportManifest.bundleFiles;
  const paths = new Set();
  for (const file of bundleFiles) {
    assert.ok(file && Object.keys(file).join(",") === "path,size,sha256",
      "standard schema-2 bundle file entry must have the expected path/size/SHA fields");
    assertSafePublicBundlePath(file.path);
    assert.ok(Number.isSafeInteger(file.size) && file.size >= 0, "standard schema-2 bundle file size is invalid");
    assert.ok(/^[a-f0-9]{64}$/.test(file.sha256), "standard schema-2 bundle file SHA is invalid");
    assert.ok(!paths.has(file.path), "standard schema-2 bundle file list contains a duplicate path");
    paths.add(file.path);
  }
  assert.equal(sha256(Buffer.from(JSON.stringify(bundleFiles))), EXPECTED_WEB_BUNDLE_SHA256,
    "schema-2 bundle aggregate must match its exact ordered 37-file table");
  const rootIndex = bundleFiles.filter(file => file.path === "index.html");
  assert.equal(rootIndex.length, 1, "standard schema-2 bundle must include exactly one root index.html");
  assert.equal(rootIndex[0].sha256, exportManifest.indexHtmlSha256);

  assert.equal(derivedProvenance.schemaVersion, 1);
  assert.equal(derivedProvenance.status, "complete");
  assert.equal(derivedProvenance.sourceTreeSha256, EXPECTED_WEB_SOURCE_TREE_SHA256);
  assert.equal(derivedProvenance.candidateDigest, EXPECTED_WEB_SOURCE_TREE_SHA256);
  assert.equal(derivedProvenance.candidateFiles, 315);
  assert.equal(derivedProvenance.sourceCommit, "09d1e88342909b36237a571774d2987fa2a8556c");
  assert.equal(derivedProvenance.bundleSha256, EXPECTED_WEB_BUNDLE_SHA256);
  assert.equal(derivedProvenance.bundleFileCount, EXPECTED_WEB_FILE_COUNT);
  assert.equal(derivedProvenance.bundlePath, STATIC02_EXPORT_BUNDLE_ROOT);
  assert.equal(derivedProvenance.bundleManifest, STATIC02_EXPORT_MANIFEST_PATH);
  assert.equal(derivedProvenance.exportManifestPath, STATIC02_EXPORT_MANIFEST_PATH);
  assert.equal(derivedProvenance.exportManifestSha256, EXPECTED_STATIC02_EXPORT_MANIFEST_SHA256);
  assert.equal(derivedProvenance.overlayManifestSha256, EXPECTED_STATIC02_CANDIDATE_MANIFEST_SHA256);
  assert.equal(derivedProvenance.dependencySourceTreeSha256,
    "d91f89f1237d2139ef31ee75565230105014536dc5c9a8c34bf436d0bcc7340c");
  assert.equal(derivedProvenance.dependencyOwnedTreeSha256,
    "754d1db10bd502faeb0b6e82820d455cae680166008a443f7397457f1ef21d29");
  assert.equal(derivedProvenance.wrapperRun.status, "failed");
  assert.equal(derivedProvenance.wrapperRun.doNotInterpretAsWrapperPass, true);
  assert.equal(derivedProvenance.wrapperRun.derivedExportManifestSha256, EXPECTED_STATIC02_EXPORT_MANIFEST_SHA256);

  assert.equal(derivationProof.status, "verified-derived-inputs");
  assert.equal(derivationProof.sourceRun.status, "failed");
  assert.match(derivationProof.sourceRun.failureCategory, /^EEXIST /);
  assert.equal(derivationProof.sourceRun.originalExportManifestSha256, EXPECTED_STATIC02_EXPORT_MANIFEST_SHA256);
  assert.equal(derivationProof.candidate.sourceDigest, EXPECTED_WEB_SOURCE_TREE_SHA256);
  assert.equal(derivationProof.candidate.fileCount, 315);
  assert.deepEqual(derivationProof.candidate.roots?.map(({ name, destination, fileCount }) => ({ name, destination, fileCount })), [
    { name: "mobile", destination: "apps/kcoder-studio/mobile", fileCount: 296 },
    { name: "studio-shared", destination: "apps/kcoder-studio/shared", fileCount: 19 },
  ]);
  assert.equal(derivationProof.candidate.overlayManifestSha256, EXPECTED_STATIC02_CANDIDATE_MANIFEST_SHA256);
  assert.equal(derivationProof.candidate.overlayNewTsxSha256, EXPECTED_STATIC02_NEW_TSX_SHA256);
  assert.equal(derivationProof.export.builderManifestSchemaVersion, 2);
  assert.equal(derivationProof.export.builderManifestStatus, "complete");
  assert.equal(derivationProof.export.builderManifestSha256, EXPECTED_STATIC02_EXPORT_MANIFEST_SHA256);
  assert.equal(derivationProof.export.sourceTreeSha256, EXPECTED_WEB_SOURCE_TREE_SHA256);
  assert.equal(derivationProof.export.bundleSha256, EXPECTED_WEB_BUNDLE_SHA256);
  assert.equal(derivationProof.export.actualBundleFilesVerified, EXPECTED_WEB_FILE_COUNT);
  assert.equal(derivationProof.export.copiedBundleFilesVerified, EXPECTED_WEB_FILE_COUNT);
  assert.equal(derivationProof.export.copiedBundlePath, STATIC02_EXPORT_BUNDLE_ROOT);
  assert.equal(derivationProof.derivedProvenanceSha256, EXPECTED_STATIC02_DERIVED_PROVENANCE_SHA256);
  assert.equal(derivationProof.boundary.includes("original RunContext result remains failed"), true);
  assert.equal(derivationProof.boundary.includes("not a wrapper PASS"), true);

  const sourceBundle = await verifyBundleTreeExact(STATIC02_EXPORT_BUNDLE_ROOT, bundleFiles);
  const snapshotSha256 = sha256(Buffer.from(JSON.stringify({
    exportManifestSha256,
    derivedProvenanceSha256,
    derivationProofSha256,
    sourceTreeSha256: exportManifest.sourceTreeSha256,
    bundleSha256: exportManifest.bundleSha256,
    files: bundleFiles,
    sourceBundleAggregateSha256: sourceBundle.aggregateSha256,
  })));
  return {
    exportManifestSha256,
    derivedProvenanceSha256,
    derivationProofSha256,
    exportManifest,
    derivedProvenance,
    derivationProof,
    files: bundleFiles,
    sourceBundleAggregateSha256: sourceBundle.aggregateSha256,
    snapshotSha256,
  };
}

async function stagePinnedStatic02Export(context, source) {
  const bundleRoot = context.pathInArtifacts("worktree-static02-source-bundle");
  await assertNoSymlinkPath(context.artifactsDir);
  await mkdir(bundleRoot, { recursive: false, mode: 0o700 });
  for (const file of source.files) await copyPublicBundleFile(STATIC02_EXPORT_BUNDLE_ROOT, bundleRoot, file);
  const copiedBundle = await verifyBundleTreeExact(bundleRoot, source.files);
  assert.equal(copiedBundle.aggregateSha256, EXPECTED_WEB_BUNDLE_SHA256,
    "RunContext-owned derived Mobile Web source copy differs from pinned schema-2 bundle files");

  const reuseManifest = {
    schemaVersion: 1,
    purpose: "derived-compatible-view from the pinned schema-2 Mobile Web export for the existing strict reuse helper",
    sourceCommit: source.derivedProvenance.sourceCommit,
    sourceTreeSha256: source.exportManifest.sourceTreeSha256,
    bundleSha256: source.exportManifest.bundleSha256,
    bundleFileCount: source.exportManifest.bundleFileCount,
    indexHtmlSha256: source.exportManifest.indexHtmlSha256,
    directory: DERIVED_WEB_MANIFEST_DIRECTORY,
    files: source.files.map(({ path, size, sha256: digest }) => ({ path, size, sha256: digest })),
  };
  const manifestPath = await context.writeArtifactJson(DERIVED_WEB_MANIFEST_NAME, reuseManifest);
  const manifestBytes = await readRegularFile(manifestPath, 1024 * 1024);
  assert.deepEqual(new Set(Object.keys(parseJson(manifestBytes, "derived legacy-reuse input"))), new Set([
    "schemaVersion", "purpose", "sourceCommit", "sourceTreeSha256", "bundleSha256", "bundleFileCount", "indexHtmlSha256", "directory", "files",
  ]), "derived-compatible view must match exactly the existing reuse helper's nine-key schema-1 input contract");
  assert.equal(sha256(Buffer.from(JSON.stringify(reuseManifest.files))), EXPECTED_WEB_BUNDLE_SHA256,
    "derived legacy-reuse file table must preserve the pinned schema-2 bundle aggregate");
  assert.equal(sha256(manifestBytes), EXPECTED_DERIVED_REUSE_MANIFEST_SHA256,
    "derived legacy-reuse manifest must match its deterministic local view pin");
  return {
    bundleRoot,
    manifestPath,
    manifestSha256: sha256(manifestBytes),
    copiedBundleAggregateSha256: copiedBundle.aggregateSha256,
  };
}

async function verifyBundleTreeExact(root, files) {
  await assertNoSymlinkPath(root);
  const expectedFiles = new Map(files.map(file => [file.path, file]));
  const expectedDirectories = new Set();
  for (const path of expectedFiles.keys()) {
    const parts = path.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      expectedDirectories.add(parts.slice(0, index).join("/"));
    }
  }
  const actualFiles = [];
  const actualDirectories = [];
  async function walk(directory, relativeDirectory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const absolutePath = resolve(directory, entry.name);
      assert.ok(!entry.isSymbolicLink(), "pinned Mobile Web bundle cannot contain symlinks");
      if (entry.isDirectory()) {
        actualDirectories.push(relativePath);
        await walk(absolutePath, relativePath);
      } else {
        assert.ok(entry.isFile(), "pinned Mobile Web bundle cannot contain special files");
        actualFiles.push(relativePath);
      }
    }
  }
  await walk(root, "");
  actualFiles.sort();
  actualDirectories.sort();
  assert.deepEqual(actualFiles, [...expectedFiles.keys()].sort(), "bundle tree file set differs from the pinned 37-file schema-2 table");
  assert.deepEqual(actualDirectories, [...expectedDirectories].sort(), "bundle tree directory set differs from the pinned schema-2 file table");

  const fileDigests = [];
  let totalBytes = 0;
  for (const file of files) {
    const info = await hashRegularFileWithStat(resolve(root, ...file.path.split("/")));
    assert.equal(info.size, file.size, `pinned bundle file size differs for ${file.path}`);
    assert.equal(info.sha256, file.sha256, `pinned bundle file SHA differs for ${file.path}`);
    totalBytes += info.size;
    assert.ok(totalBytes <= 64 * 1024 * 1024, "pinned public Mobile Web bundle exceeds the existing reuse-helper size bound");
    fileDigests.push(file);
  }
  const aggregateSha256 = sha256(Buffer.from(JSON.stringify(fileDigests)));
  assert.equal(aggregateSha256, EXPECTED_WEB_BUNDLE_SHA256, "pinned bundle files do not produce the approved aggregate");
  return { aggregateSha256, fileCount: fileDigests.length, totalBytes };
}

async function copyPublicBundleFile(sourceRoot, destinationRoot, file) {
  assertSafePublicBundlePath(file.path);
  const sourcePath = resolve(sourceRoot, ...file.path.split("/"));
  const destinationPath = resolve(destinationRoot, ...file.path.split("/"));
  assertContained(sourceRoot, sourcePath, "schema-2 bundle source file escaped its pinned root");
  assertContained(destinationRoot, destinationPath, "derived bundle destination escaped its RunContext artifacts root");
  await assertNoSymlinkPath(sourcePath);
  await createOwnedBundleParentDirectories(destinationRoot, file.path.split("/").slice(0, -1));
  const bytes = await readRegularFile(sourcePath, file.size);
  assert.equal(bytes.length, file.size, `schema-2 source bundle file size differs for ${file.path}`);
  assert.equal(sha256(bytes), file.sha256, `schema-2 source bundle file SHA differs for ${file.path}`);
  const destination = await open(destinationPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    await destination.writeFile(bytes);
    await destination.sync();
  } finally {
    await destination.close();
  }
}

async function createOwnedBundleParentDirectories(root, segments) {
  let current = root;
  for (const segment of segments) {
    current = resolve(current, segment);
    try {
      await mkdir(current, { recursive: false, mode: 0o700 });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    const info = await lstat(current);
    assert.ok(info.isDirectory() && !info.isSymbolicLink(), "derived bundle parents must be owned real directories");
  }
}

function assertSafePublicBundlePath(value) {
  assert.ok(typeof value === "string" && value.length > 0 && value.length <= 1024,
    "schema-2 public bundle path is invalid");
  assert.ok(!value.startsWith("/") && !value.includes("\\") && !value.includes("\0"),
    "schema-2 public bundle path must be relative and POSIX separated");
  const parts = value.split("/");
  assert.ok(parts.every(part => part && part !== "." && part !== ".." && !part.includes(":")),
    "schema-2 public bundle path contains an unsafe segment");
  const lower = value.toLowerCase();
  assert.ok(!/(?:^|[._/-])(?:credential|credentials|secret|secrets|token|tokens|privatekey|private-key|api[-_.]?key)(?:[._/-]|$)/.test(lower),
    "schema-2 public bundle path resembles private credential material");
  assert.ok(!/(?:^|\/)(?:\.env(?:$|[._-])|\.npmrc|\.netrc)/i.test(value),
    "schema-2 public bundle cannot include environment or network credential files");
}

function assertContained(root, candidate, message) {
  const relativePath = relative(resolve(root), resolve(candidate));
  assert.ok(relativePath && relativePath !== ".." && !relativePath.startsWith(`..${sep}`)
    && !relativePath.startsWith(sep), message);
}

async function hashRegularFile(path) {
  return (await hashRegularFileWithStat(path)).sha256;
}

async function hashRegularFileWithStat(path) {
  await assertNoSymlinkPath(path);
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat({ bigint: true });
    assert.ok(info.isFile(), "pinned executable or source input must be a regular file");
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(8 * 1024 * 1024);
    let position = 0;
    while (position < Number(info.size)) {
      const length = Math.min(buffer.length, Number(info.size) - position);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      assert.ok(bytesRead > 0, "file ended before its stat-reported size");
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    assert.equal(position, Number(info.size));
    return {
      sha256: hash.digest("hex"),
      size: Number(info.size),
      mode: Number(info.mode & 0o777n),
      dev: String(info.dev),
      ino: String(info.ino),
      mtimeNs: String(info.mtimeNs),
      ctimeNs: String(info.ctimeNs),
    };
  } finally {
    await handle.close();
  }
}

async function copyExecutableNoFollow(sourcePath, destinationPath, expectedSize) {
  await assertNoSymlinkPath(sourcePath);
  const input = await open(sourcePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  const output = await open(destinationPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    const info = await input.stat({ bigint: true });
    assert.ok(info.isFile(), "binary source must be a regular file");
    assert.equal(Number(info.size), expectedSize, "binary source size changed before copy");
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(8 * 1024 * 1024);
    let position = 0;
    while (position < expectedSize) {
      const length = Math.min(buffer.length, expectedSize - position);
      const { bytesRead } = await input.read(buffer, 0, length, position);
      assert.ok(bytesRead > 0, "binary source ended before its pinned size");
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      let written = 0;
      while (written < bytesRead) {
        const result = await output.write(chunk, written, bytesRead - written, position + written);
        assert.ok(result.bytesWritten > 0, "binary copy made no write progress");
        written += result.bytesWritten;
      }
      position += bytesRead;
    }
    assert.equal(position, expectedSize);
    const sourceAfter = await input.stat({ bigint: true });
    assert.equal(sourceAfter.size, info.size, "binary source size changed while copying");
    assert.equal(sourceAfter.ino, info.ino, "binary source inode changed while copying");
    assert.equal(sourceAfter.dev, info.dev, "binary source device changed while copying");
    assert.equal(sourceAfter.mtimeNs, info.mtimeNs, "binary source modification time changed while copying");
    await output.sync();
    return hash.digest("hex");
  } finally {
    await Promise.all([input.close(), output.close()]);
  }
}

async function readRegularFile(path, maximumBytes) {
  await assertNoSymlinkPath(path);
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    assert.ok(info.isFile() && info.size <= maximumBytes, "pinned artifact must be a bounded regular file");
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function listRunDirectories(path) {
  const entries = await readdir(path, { withFileTypes: true }).catch(error => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  return entries.filter(entry => entry.isDirectory() && !entry.isSymbolicLink()).map(entry => entry.name).sort();
}

async function readSuiteEvidence(suiteRunRoot) {
  const runManifest = parseJson(await readRegularFile(resolve(suiteRunRoot, "manifest.json"), 1024 * 1024), "suite run manifest");
  const suiteSummaryPath = resolve(suiteRunRoot, "artifacts/mobile-workspace-task-handoff-browser-review.json");
  let suiteSummary = null;
  try {
    suiteSummary = parseJson(await readRegularFile(suiteSummaryPath, 4 * 1024 * 1024), "suite summary");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const owners = (runManifest.processes ?? [])
    .filter(process => process.label === "handoff-review-gateway" || process.label === "handoff-review-chromium")
    .map(({ label, pid, pgid, command, stopped }) => ({ label, pid, pgid, command, stopped }));
  let appServer = null;
  try {
    const provenance = parseJson(await readRegularFile(resolve(suiteRunRoot, "artifacts/actual-app-server-provenance.json"), 1024 * 1024), "app-server provenance");
    appServer = {
      configuredPath: provenance.configuredPath,
      gatewayPid: provenance.gatewayPid,
      gatewayPgid: provenance.gatewayPgid,
      configuredSha256: provenance.configuredSha256,
      actualProcesses: (provenance.actualProcesses ?? []).map(({ pid, executablePath, sha256 }) => ({ pid, executablePath, sha256 })),
    };
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return {
    runStatus: runManifest.status,
    scenarioResults: suiteSummary?.scenarioResults ?? null,
    owners,
    appServer,
  };
}

async function waitForChild(child, timeoutMs) {
  let timeout;
  try {
    return await Promise.race([
      new Promise((resolvePromise, rejectPromise) => {
        child.once("error", rejectPromise);
        child.once("exit", (code, signal) => resolvePromise({ code, signal }));
      }),
      new Promise((_, rejectPromise) => {
        timeout = setTimeout(() => rejectPromise(new Error(`pinned handoff suite exceeded ${timeoutMs}ms outer timeout`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function assertNoSymlinkPath(path) {
  const absolute = resolve(path);
  const parts = absolute.split(sep).filter(Boolean);
  let cursor = absolute.startsWith(sep) ? sep : "";
  for (const part of parts) {
    cursor = resolve(cursor || ".", part);
    const info = await lstat(cursor);
    assert.ok(!info.isSymbolicLink(), "pinned executable or artifact path cannot contain symlinks");
  }
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
