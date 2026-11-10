import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import { verifyMobileExportManifestEnvelope } from "./mobile-web-export-input.mjs";
import {
  buildExpoExportArguments,
  createSourceMapBundleEvidence,
  makeCoreAttributionRecord,
  mapGeneratedProfilePosition,
  recordScriptUrlIdentity,
  resolveScriptMapBinding,
  resolvePinnedMetroSourcePath,
  sanitizeMappedSourcePath,
  validateCoreAttributionMode,
  verifyPinnedSourceInventoryBytes,
  verifySourceMapBundleEvidence,
} from "./render-profile-attribution-contract.mjs";

function fixtureManifest({ withMap = true } = {}) {
  const bundleFiles = Array.from({ length: 36 }, (_, index) => ({
    path: `asset-${String(index).padStart(2, "0")}.js`,
    size: index + 1,
    sha256: createHash("sha256").update(`asset-${index}`).digest("hex"),
  }));
  bundleFiles.push({
    path: "index.html",
    size: 9,
    sha256: createHash("sha256").update("index-html").digest("hex"),
  });
  if (withMap) bundleFiles.push({
    path: "asset-00.js.map",
    size: 5,
    sha256: createHash("sha256").update("asset-00-map").digest("hex"),
  });
  return {
    bundleFiles,
    bundleSha256: createHash("sha256").update(JSON.stringify(bundleFiles)).digest("hex"),
    indexHtmlSha256: bundleFiles.find((entry) => entry.path === "index.html").sha256,
  };
}

function asExportManifest(bundle, sourceMapEvidence = undefined) {
  return {
    status: "complete",
    bundleFiles: bundle.bundleFiles,
    bundleFileCount: bundle.bundleFiles.length,
    bundleSha256: bundle.bundleSha256,
    indexHtmlSha256: bundle.indexHtmlSha256,
    ...(sourceMapEvidence ? { sourceMapEvidence } : {}),
  };
}

function pinnedSourceFixture() {
  const mobileContent = "export const reducer = (value) => value + 1;\n";
  const sharedContent = "export const Badge = () => null;\n";
  const sourceRoots = [
    {
      name: "mobile",
      sourceRoot: "/frozen/apps/kcoder-studio/mobile",
      destination: "apps/kcoder-studio/mobile",
      sha256: "1".repeat(64),
      fileCount: 1,
    },
    {
      name: "studio-shared",
      sourceRoot: "/frozen/apps/kcoder-studio/shared",
      destination: "apps/kcoder-studio/shared",
      sha256: "2".repeat(64),
      fileCount: 1,
    },
  ];
  const files = [
    {
      root: "mobile",
      path: "src/runtime/task-runtime/snapshotReducer.ts",
      size: Buffer.byteLength(mobileContent),
      sha256: createHash("sha256").update(mobileContent).digest("hex"),
    },
    {
      root: "studio-shared",
      path: "components/Badge.tsx",
      size: Buffer.byteLength(sharedContent),
      sha256: createHash("sha256").update(sharedContent).digest("hex"),
    },
  ];
  const inventory = {
    schemaVersion: 1,
    status: "derived-post-export-exact-source-inventory",
    sourceTreeSha256: "a".repeat(64),
    fileCount: files.length,
    sourceRoots,
    files,
  };
  const inventoryBytes = Buffer.from(JSON.stringify(inventory));
  const candidateDigest = createHash("sha256").update(inventoryBytes).digest("hex");
  const verified = verifyPinnedSourceInventoryBytes({
    inventoryBytes,
    candidateDigest,
    candidateFiles: files.length,
    sourceTreeSha256: inventory.sourceTreeSha256,
    sourceRoots,
    inputRoots: sourceRoots,
  });
  return { mobileContent, sharedContent, sourceRoots, files, inventory, inventoryBytes, candidateDigest, verified };
}

test("default source map option records no maps and does not alter the bundle evidence", () => {
  const bundle = fixtureManifest({ withMap: false });
  assert.equal(createSourceMapBundleEvidence(false, bundle.bundleFiles, bundle.bundleSha256), null);
  const manifest = asExportManifest(bundle);
  const bytes = Buffer.from(JSON.stringify(manifest));
  assert.equal(verifyMobileExportManifestEnvelope(manifest, bytes, createHash("sha256").update(bytes).digest("hex"), "default"), undefined);
});

test("source maps are an opt-in Expo flag and the default argument vector stays byte-compatible", () => {
  assert.deepEqual(buildExpoExportArguments("expo-cli", "owned-output", false), [
    "expo-cli", "export", "--platform", "web", "--output-dir", "owned-output",
  ]);
  assert.deepEqual(buildExpoExportArguments("expo-cli", "owned-output", false, "android"), [
    "expo-cli", "export", "--platform", "android", "--output-dir", "owned-output",
  ]);
  assert.deepEqual(buildExpoExportArguments("expo-cli", "owned-output", true), [
    "expo-cli", "export", "--platform", "web", "--output-dir", "owned-output", "--source-maps",
  ]);
  assert.throws(() => buildExpoExportArguments("expo-cli", "owned-output", 1), /explicit boolean/);
  assert.throws(() => buildExpoExportArguments("expo-cli", "owned-output", false, "windows"), /platform must be/);
});

test("source maps are listed as an exact subset bound to the whole bundle digest", () => {
  const bundle = fixtureManifest();
  const evidence = createSourceMapBundleEvidence(true, bundle.bundleFiles, bundle.bundleSha256);
  assert.equal(evidence.mapFileCount, 1);
  assert.equal(evidence.bundleSha256, bundle.bundleSha256);
  assert.equal(verifySourceMapBundleEvidence(evidence, bundle), true);
  const manifest = asExportManifest(bundle, evidence);
  const bytes = Buffer.from(JSON.stringify(manifest));
  assert.equal(verifyMobileExportManifestEnvelope(manifest, bytes, createHash("sha256").update(bytes).digest("hex"), "source-map"), undefined);
});

test("source-map evidence fails closed for missing maps, changed bundle digest, or altered map entry", () => {
  const noMap = fixtureManifest({ withMap: false });
  const noMapEvidence = createSourceMapBundleEvidence(true, noMap.bundleFiles, noMap.bundleSha256);
  assert.throws(() => verifySourceMapBundleEvidence(noMapEvidence, noMap), /at least one source map/);

  const bundle = fixtureManifest();
  const evidence = createSourceMapBundleEvidence(true, bundle.bundleFiles, bundle.bundleSha256);
  assert.throws(() => verifySourceMapBundleEvidence({ ...evidence, bundleSha256: "0".repeat(64) }, bundle), /bind to the full bundle digest/);
  assert.throws(() => verifySourceMapBundleEvidence({
    ...evidence,
    mapFiles: [{ ...evidence.mapFiles[0], sha256: "f".repeat(64) }],
  }, bundle), /exactly match the full bundle inventory/);
});

test("core attribution mode is one after/500 burst and rejects overlapping diagnostic modes", () => {
  const valid = {
    enabled: true,
    sampleCount: 1,
    sourceNames: ["after"],
    messageCounts: [500],
    captureStackDiagnostic: false,
    captureSeedUiDomTrace: false,
    runtimeConsumerDiagnostic: false,
    followGestureRegression: false,
    tailWindowDiagnostic: false,
  };
  assert.equal(validateCoreAttributionMode(valid).performanceDistributionEligible, false);
  assert.throws(() => validateCoreAttributionMode({ ...valid, sampleCount: 30 }), /one diagnostic burst/);
  assert.throws(() => validateCoreAttributionMode({ ...valid, captureStackDiagnostic: true }), /cannot add a second stack burst/);
});

test("core attribution output is explicitly diagnostic and excluded from performance distribution", () => {
  const record = makeCoreAttributionRecord({
    source: "after",
    requestedMessages: 500,
    panelState: "mounted-hidden",
    bundleSha256: "a".repeat(64),
    profile: { sampleCount: 8 },
    burst: { ok: true },
  });
  assert.equal(record.classification, "DIAGNOSTIC_ONLY");
  assert.equal(record.performanceSample, false);
  assert.equal(record.performanceDistributionEligible, false);
  assert.equal(record.profileScope.includes("actual core"), true);
  assert.equal(record.coreBurstStatus, "PASS");
});

test("generated V8 positions map to a TSX source position with the pinned trace-mapping library", () => {
  const mobileRequire = createRequire(resolve(process.cwd(), "apps/kcoder-studio/mobile/package.json"));
  const traceMapping = mobileRequire("@jridgewell/trace-mapping");
  const traceMap = new traceMapping.TraceMap({
    version: 3,
    file: "index.js",
    sources: ["src/TaskTranscript.tsx"],
    names: ["TaskTranscript"],
    mappings: "AAAAA",
  });
  assert.deepEqual(mapGeneratedProfilePosition(traceMap, { lineNumber: 0, columnNumber: 0 }, traceMapping), {
    status: "MAPPED",
    source: "src/TaskTranscript.tsx",
    sourcePathStatus: "RELATIVE_SOURCE",
    line: 1,
    column: 0,
    name: "TaskTranscript",
  });
  assert.equal(mapGeneratedProfilePosition(traceMap, { lineNumber: null, columnNumber: 0 }, traceMapping).status, "MISSING_GENERATED_POSITION");
});

test("script URL must match the approved served origin and exact bundle path; query and hash do not change the asset identity", () => {
  const mapPaths = ["assets/index.js.map", "vendor/index.js.map"];
  const currentUrl = recordScriptUrlIdentity(
    "http://127.0.0.1:41731/assets/index.js?platform=web&dev=false#entry",
    "http://127.0.0.1:41731/",
  );
  assert.deepEqual(currentUrl, { status: "APPROVED_SERVED_ORIGIN", bundlePath: "assets/index.js" });
  assert.deepEqual(resolveScriptMapBinding(currentUrl, mapPaths), {
    status: "EXACT_BUNDLE_PATH_MATCH",
    mapPath: "assets/index.js.map",
    generatedPath: "assets/index.js",
  });

  const sameNameForeignUrl = recordScriptUrlIdentity(
    "https://foreign.example/assets/index.js?platform=web#entry",
    "http://127.0.0.1:41731/",
  );
  assert.deepEqual(sameNameForeignUrl, { status: "FOREIGN_SCRIPT_ORIGIN", bundlePath: null });
  assert.deepEqual(resolveScriptMapBinding(sameNameForeignUrl, mapPaths), {
    status: "SCRIPT_URL_IDENTITY_UNVERIFIED",
    mapPath: null,
    generatedPath: null,
  });

  const sameOriginDifferentPath = recordScriptUrlIdentity(
    "http://127.0.0.1:41731/chunks/index.js?platform=web",
    "http://127.0.0.1:41731/",
  );
  assert.equal(resolveScriptMapBinding(sameOriginDifferentPath, mapPaths).status, "NO_EXACT_BUNDLE_PATH_MAP");
});

test("trusted static mount strips one exact path prefix before exact source-map lookup", () => {
  const mapPath = "_expo/static/js/web/entry-abc.js.map";
  const mountPath = "/__kcoder_mobile_mount_v1__";
  const identity = recordScriptUrlIdentity(
    `http://127.0.0.1:41731${mountPath}/_expo/static/js/web/entry-abc.js?platform=web&dev=false`,
    "http://127.0.0.1:41731/",
  );
  assert.deepEqual(resolveScriptMapBinding(identity, [mapPath], { trustedMountPath: mountPath }), {
    status: "EXACT_BUNDLE_PATH_MATCH",
    mapPath,
    generatedPath: mapPath.slice(0, -4),
    mountNormalization: "EXACT_TRUSTED_MOUNT_PREFIX_STRIPPED",
    servedBundlePath: "__kcoder_mobile_mount_v1__/_expo/static/js/web/entry-abc.js",
  });

  const wrongMountIdentity = recordScriptUrlIdentity(
    "http://127.0.0.1:41731/not-the-approved-mount/_expo/static/js/web/entry-abc.js",
    "http://127.0.0.1:41731/",
  );
  assert.equal(resolveScriptMapBinding(wrongMountIdentity, [mapPath], { trustedMountPath: mountPath }).status, "SERVED_PATH_OUTSIDE_TRUSTED_MOUNT");
  assert.equal(resolveScriptMapBinding(identity, [mapPath], { trustedMountPath: "/__kcoder_mobile_mount_v1__/nested" }).status, "SERVED_PATH_OUTSIDE_TRUSTED_MOUNT");
  assert.equal(resolveScriptMapBinding(identity, [mapPath], { trustedMountPath: "/__kcoder_mobile_mount_v1__/../outside" }).status, "INVALID_TRUSTED_MOUNT_PATH");
  assert.equal(resolveScriptMapBinding({ status: "APPROVED_SERVED_ORIGIN", bundlePath: "__kcoder_mobile_mount_v1__/../_expo/entry.js" }, [mapPath], { trustedMountPath: mountPath }).status, "INVALID_SERVED_BUNDLE_PATH");
  assert.equal(resolveScriptMapBinding(identity, [mapPath, "nested/_expo/static/js/web/entry-abc.js.map"], { trustedMountPath: mountPath }).status, "EXACT_BUNDLE_PATH_MATCH");

  const foreign = recordScriptUrlIdentity(
    "https://foreign.example/__kcoder_mobile_mount_v1__/_expo/static/js/web/entry-abc.js",
    "http://127.0.0.1:41731/",
  );
  assert.equal(resolveScriptMapBinding(foreign, [mapPath], { trustedMountPath: mountPath }).status, "SCRIPT_URL_IDENTITY_UNVERIFIED");
});

test("pinned source inventory must match raw digest, export roots, counts, and unique safe entries", () => {
  const fixture = pinnedSourceFixture();
  assert.equal(fixture.verified.status, "PINNED_CANDIDATE_SOURCE_INVENTORY");
  assert.equal(fixture.verified.files.length, 2);
  assert.throws(() => verifyPinnedSourceInventoryBytes({
    inventoryBytes: fixture.inventoryBytes,
    candidateDigest: "f".repeat(64),
    candidateFiles: 2,
    sourceTreeSha256: fixture.inventory.sourceTreeSha256,
    sourceRoots: fixture.sourceRoots,
    inputRoots: fixture.sourceRoots,
  }), /bytes differ from their pinned digest/);
  assert.throws(() => verifyPinnedSourceInventoryBytes({
    inventoryBytes: fixture.inventoryBytes,
    candidateDigest: fixture.candidateDigest,
    candidateFiles: 2,
    sourceTreeSha256: fixture.inventory.sourceTreeSha256,
    sourceRoots: fixture.sourceRoots,
    inputRoots: fixture.sourceRoots.map((root) => root.name === "studio-shared" ? { ...root, destination: "apps/kcoder-studio/studio-shared" } : root),
  }), /differ from the actual export input roots/);

  const duplicate = { ...fixture.inventory, files: [...fixture.files, { ...fixture.files[0] }], fileCount: 3 };
  const duplicateBytes = Buffer.from(JSON.stringify(duplicate));
  assert.throws(() => verifyPinnedSourceInventoryBytes({
    inventoryBytes: duplicateBytes,
    candidateDigest: createHash("sha256").update(duplicateBytes).digest("hex"),
    candidateFiles: 3,
    sourceTreeSha256: duplicate.sourceTreeSha256,
    sourceRoots: fixture.sourceRoots,
    inputRoots: fixture.sourceRoots,
  }), /duplicate file path/);
});

test("Metro source aliases require approved root pins, exact file inventory, and matching sourcesContent SHA", () => {
  const fixture = pinnedSourceFixture();
  const sources = ["/src/runtime/task-runtime/snapshotReducer.ts", "/../shared/components/Badge.tsx"];
  const content = [fixture.mobileContent, fixture.sharedContent];
  assert.deepEqual(resolvePinnedMetroSourcePath(sources[0], {
    sourceRoots: fixture.verified.sourceRoots,
    candidateSourceFiles: fixture.verified.files,
    sourceMapSources: sources,
    sourcesContent: content,
  }), {
    status: "PINNED_METRO_SOURCE",
    source: "apps/kcoder-studio/mobile/src/runtime/task-runtime/snapshotReducer.ts",
    root: "mobile",
    sourceSha256: fixture.files[0].sha256,
  });
  assert.deepEqual(resolvePinnedMetroSourcePath(sources[1], {
    sourceRoots: fixture.verified.sourceRoots,
    candidateSourceFiles: fixture.verified.files,
    sourceMapSources: sources,
    sourcesContent: content,
  }), {
    status: "PINNED_METRO_SOURCE",
    source: "apps/kcoder-studio/shared/components/Badge.tsx",
    root: "studio-shared",
    sourceSha256: fixture.files[1].sha256,
  });
  assert.equal(resolvePinnedMetroSourcePath(sources[0], {
    sourceRoots: fixture.verified.sourceRoots,
    candidateSourceFiles: fixture.verified.files,
    sourceMapSources: sources,
    sourcesContent: ["changed", fixture.sharedContent],
  }).status, "SOURCE_CONTENT_SHA256_MISMATCH");
  assert.equal(resolvePinnedMetroSourcePath(sources[0], {
    candidateSourceFiles: fixture.verified.files,
    sourceMapSources: sources,
    sourcesContent: content,
  }).status, "PINNED_SOURCE_INVENTORY_MISSING");
  assert.equal(resolvePinnedMetroSourcePath("/src/../outside.ts", {
    sourceRoots: fixture.verified.sourceRoots,
    candidateSourceFiles: fixture.verified.files,
    sourceMapSources: ["/src/../outside.ts"],
    sourcesContent: ["x"],
  }).status, "INVALID_METRO_SOURCE_ALIAS");
  assert.equal(resolvePinnedMetroSourcePath("/../shared/../outside.ts", {
    sourceRoots: fixture.verified.sourceRoots,
    candidateSourceFiles: fixture.verified.files,
    sourceMapSources: ["/../shared/../outside.ts"],
    sourcesContent: ["x"],
  }).status, "INVALID_METRO_SOURCE_ALIAS");
  assert.equal(resolvePinnedMetroSourcePath("/src/app?ctx=virtual", {
    sourceRoots: fixture.verified.sourceRoots,
    candidateSourceFiles: fixture.verified.files,
    sourceMapSources: ["/src/app?ctx=virtual"],
    sourcesContent: ["x"],
  }).status, "INVALID_METRO_SOURCE_ALIAS");
  assert.equal(resolvePinnedMetroSourcePath("/../elsewhere/Badge.tsx", {
    sourceRoots: fixture.verified.sourceRoots,
    candidateSourceFiles: fixture.verified.files,
    sourceMapSources: ["/../elsewhere/Badge.tsx"],
    sourcesContent: ["x"],
  }).status, "NOT_PINNED_METRO_ALIAS");
});

test("generated Metro positions expose only a source pinned by the exact candidate inventory and map content", () => {
  const fixture = pinnedSourceFixture();
  const mobileSource = "/src/runtime/task-runtime/snapshotReducer.ts";
  const traceMapping = createRequire(resolve(process.cwd(), "apps/kcoder-studio/mobile/package.json"))("@jridgewell/trace-mapping");
  const traceMap = new traceMapping.TraceMap({
    version: 3,
    file: "entry.js",
    sources: [mobileSource],
    sourcesContent: [fixture.mobileContent],
    names: ["snapshotReducer"],
    mappings: "AAAAA",
  });
  const sourceEvidence = {
    sourceRoots: fixture.verified.sourceRoots,
    candidateSourceFiles: fixture.verified.files,
    sourceMapSources: [mobileSource],
    sourcesContent: [fixture.mobileContent],
  };
  assert.deepEqual(mapGeneratedProfilePosition(traceMap, { lineNumber: 0, columnNumber: 0 }, traceMapping, sourceEvidence), {
    status: "MAPPED",
    source: "apps/kcoder-studio/mobile/src/runtime/task-runtime/snapshotReducer.ts",
    sourcePathStatus: "PINNED_METRO_SOURCE",
    line: 1,
    column: 0,
    name: "snapshotReducer",
  });
  assert.equal(mapGeneratedProfilePosition(traceMap, { lineNumber: 0, columnNumber: 0 }, traceMapping).status, "PINNED_SOURCE_INVENTORY_MISSING");

  const virtualMap = new traceMapping.TraceMap({
    version: 3,
    file: "entry.js",
    sources: ["/src/app?ctx=virtual"],
    sourcesContent: ["virtual"],
    names: [],
    mappings: "AAAA",
  });
  const virtualPosition = mapGeneratedProfilePosition(virtualMap, { lineNumber: 0, columnNumber: 0 }, traceMapping, {
    ...sourceEvidence,
    sourceMapSources: ["/src/app?ctx=virtual"],
    sourcesContent: ["virtual"],
  });
  assert.equal(virtualPosition.status, "INVALID_METRO_SOURCE_ALIAS");
  assert.equal(virtualPosition.source, null);
});

test("mapped source paths are repository-scoped or redacted, and source content is never returned", () => {
  assert.deepEqual(sanitizeMappedSourcePath("/private/build/apps/kcoder-studio/mobile/src/TaskTranscript.tsx"), {
    status: "SCOPED_ABSOLUTE_SOURCE",
    source: "apps/kcoder-studio/mobile/src/TaskTranscript.tsx",
  });
  assert.deepEqual(sanitizeMappedSourcePath("src/TaskTranscript.tsx"), {
    status: "RELATIVE_SOURCE",
    source: "src/TaskTranscript.tsx",
  });
  assert.deepEqual(sanitizeMappedSourcePath("/private/build/secrets/src/TaskTranscript.tsx"), {
    status: "UNSCOPED_ABSOLUTE_SOURCE_REDACTED",
    source: null,
  });
  assert.deepEqual(sanitizeMappedSourcePath("/private/notapps/kcoder-studio/mobile/src/TaskTranscript.tsx"), {
    status: "UNSCOPED_ABSOLUTE_SOURCE_REDACTED",
    source: null,
  });
  assert.deepEqual(sanitizeMappedSourcePath("../outside/TaskTranscript.tsx"), {
    status: "UNSCOPED_RELATIVE_SOURCE_REDACTED",
    source: null,
  });
});
