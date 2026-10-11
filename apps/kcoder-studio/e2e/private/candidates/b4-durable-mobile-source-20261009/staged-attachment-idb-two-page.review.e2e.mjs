// Private B4 browser evidence only. Two pages share one real Chromium storage
// partition (IndexedDB, localStorage, and Web Locks). The Mobile product
// snapshot is static02; ensureGatewayAuthorization is a no-op and React Native's
// platform selector is pinned to Web. GatewayRpcClient, WebSocket, uploader,
// profile fence, IndexedDB backend, and browser transactions are real. A loopback
// peer scripts protocol replies; it is not production Gateway/Relay/app-server.
// One-shot local Chromium invocation; RunContext owns browser and local peer cleanup:
// KCODER_E2E_CHROMIUM_NO_SANDBOX=1 /home/hyf/.local/opt/node-v22.17.0-linux-x64/bin/node apps/kcoder-studio/e2e/private/candidates/b4-durable-mobile-source-20261009/staged-attachment-idb-two-page.review.e2e.mjs
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import { startChromium } from "../../../harness/chromium.mjs";
import { appRoot, repoRoot, runE2E } from "../../../harness/run-context.mjs";

const suitePath = fileURLToPath(import.meta.url);
const suiteDir = dirname(suitePath);
const EXPECTED_NODE = "/home/hyf/.local/opt/node-v22.17.0-linux-x64/bin/node";
const EXPECTED_BROWSER = "/opt/cft/chrome-linux64/chrome";
const EXPECTED_BROWSER_SHA256 = "0b20b130e7edd9dd51873be867761295fe0cfad490c2b9a64f95bd3cfc08fa71";
if (process.execPath !== EXPECTED_NODE || process.version !== "v22.17.0") {
  throw new Error("This private B4 browser candidate requires the pinned Node 22.17.0 executable");
}
const snapshotDir = resolve(suiteDir, "source-snapshot");
const snapshotRepoRoot = resolve(snapshotDir, "apps/kcoder-studio");
const mobileSourceRoot = resolve(snapshotRepoRoot, "mobile/src");
const inputsPath = resolve(snapshotDir, "inputs.json");
const staticManifestPath = resolve(suiteDir, "static02-manifest.json");
const staticDiffPath = resolve(suiteDir, "static02-products.diff");
const INPUTS_JSON_SHA256 = "6aaef0bba4b1ed3dd4c37b4ea07d981018194d037043dc90f678c53bc8456138";
const STATIC_MANIFEST_SHA256 = "d33d56bf0bbecac72f66e4551054c80ef5c41d018fc00d03f6ef92f92ab6213d";
const STATIC_DIFF_SHA256 = "02660e5014de895ed2c142e96a23abbf446070da0efef495e94c072cd58e117f";
const STATIC_SOURCE_DIGEST = "9780dd897ff6c3f5028bcbe058ee9d4c376b8408761b2829999ce005ee649a91";
const STATIC_PRODUCT_COUNT = 9;
const STATIC_REVISION = "static02";
const RETENTION_CAPABILITY = "stagedAttachmentRetentionReceiptsV1";
const ADMISSION = Object.freeze({ version: 1, rootNamespace: "b4_idb_fixture", admissionEpoch: 7 });
const SCOPE_ID = "a".repeat(64);
const DB_NAME = "kcoder-staged-attachments-v1";
const MIB = 1024 * 1024;
const LARGE_QUOTA_HEADROOM = 120 * MIB;

const supportPins = {
  "apps/kcoder-studio/mobile/src/gateway/types.ts": "eb2caf2ca041feaddf9c4eb6c297040c89e24d60dba203b0308819d85a2b5310",
  "apps/kcoder-studio/mobile/src/storage/context-lock.ts": "ae31282aef0cacb618303086b2d3f6f7790857db8022c92ee3c2a60a0a0d7163",
  "apps/kcoder-studio/mobile/src/storage/profile-state-removal.ts": "8705ccae24e58a4638df652678c8584619dacf34380cbae69cd01ca6e4eee5dd",
  "apps/kcoder-studio/mobile/src/storage/profile-store.ts": "45b8eb54d5de2b36cb6580056cf972db73611156b05915a12017bb6151f2c413",
  "apps/kcoder-studio/mobile/src/storage/secure.ts": "f396c1b36594b8e6e2fe84ad775fa816d748d6e6e19ea095a0b2e519bfde04b6",
  "apps/kcoder-studio/mobile/src/storage/workspace-profile-fence.ts": "58c461e9272cfd7380b5bf0938b422812af3e6135a306a5791e187c6714e2ca0",
  "apps/kcoder-studio/shared/gatewayConnectionBudget.ts": "00384ebd57aa88952ae877a50850225d112d19a8167171b2a64a47b31e080bf2",
  "apps/kcoder-studio/shared/gatewayRequestDeadline.js": "04bf06e144fb2f430d5b7ace78d8e7157b7a8f3308a6dfc77d859c007c6d95b2",
};
const harnessPins = {
  "apps/kcoder-studio/e2e/harness/chromium.mjs": "6da43f71496317e00098780ab7e8c3bf0874e4b925c6add4e4c0e87bdf7b504c",
  "apps/kcoder-studio/e2e/harness/run-context.mjs": "94f0c27306f8944cbd10f1835227a408c51a0b558981d846832bb297c5e5cf11",
  "apps/kcoder-studio/e2e/private/candidates/b4-durable-mobile-source-20261009/support/react-native-web.ts": "e1154d6e49cffd446666818bf9b2c4ac1297e0093ca23b360262ac36691114a9",
  "apps/kcoder-studio/e2e/private/candidates/b4-durable-mobile-source-20261009/support/gateway-http.ts": "7656f933141fcb0604afdb8d9693c3b91a03134acd703b21991af10ed499740b",
};
// package.json is only the createRequire anchor here. The hosting commit changed
// its build:web script, which this test never invokes. Pin the actual dependency
// locks and resolved bundler/Playwright entry files instead of coupling this test
// to unrelated package metadata.
const runtimeDependencyPins = {
  "apps/kcoder-studio/mobile/package-lock.json": "848076f520f165128b601b27d96d4d32cf25e8929ee54b672f198b9a4c224e26",
  "apps/kcoder-studio/renderer/pnpm-lock.yaml": "f6128644c058f2dfa579c55f2ebca8384d0f63335b9c930bbf991fe1d83ca586",
  "mobile/esbuild/package.json": "d55d1d19fcc5b6079e4a71dd4111340c79c682bc36835ac7058a0c364c7db58a",
  "mobile/esbuild/lib/main.js": "8331fe1d8b3a07381f33cc425fcfaa94776e263113653f80ec3ba433e9657e73",
  "mobile/@esbuild/linux-x64/package.json": "2332dc7d04175b16730f136b5bf32b31203eecea5be03b66e9453a4658b3d971",
  "mobile/@esbuild/linux-x64/bin/esbuild": "0c6588b092a2c291a72bab90659f3c9e0e25e0fe59c9ac12b4dae4d945e5548c",
  "mobile/ws/package.json": "016343bb47f77f08486ed7e064d0ac2f368b48843e868a221ed8d03254003c82",
  "mobile/ws/index.js": "c2b0c9905540a51acb276523bb024ef3c11bd118b03a90d92962080ebd07fec9",
  "mobile/ws/lib/websocket-server.js": "3bd03b64aba897817d62ed2af0a53a3ac945af507d6599e3a31e1016ef1b76ad",
  "mobile/ws/lib/websocket.js": "10ecafae6de649f86d26c60425b35941eaf60d60df9437a2f0d8d6e3702544e7",
  "mobile/ws/lib/receiver.js": "3c871e67f057544c5cc1a5a41d7a4a6d777dffae74650c195ef377815734ee92",
  "mobile/ws/lib/sender.js": "6a712c13b94ba77bf33a06859a86f3db5513943cef65997587f096796822e627",
  "mobile/ws/lib/validation.js": "257923e54135f38ba66cf9129c02765c448efa2272e710844b3923b879605e18",
  "renderer/@playwright/test/package.json": "351697e1ef6a68a63557ffedf1992955a2d8979b11e0bf9f175820956951c65b",
  "renderer/@playwright/test/index.mjs": "ec8997c2e5cea26befc76e7bf990750e96babb16977673a9ff3b5c0575d01e48",
  "renderer/playwright/package.json": "638ab746b40d3986e16e13b08418beaa2262c47e8bc843b745589af15dead35b",
  "renderer/playwright/test.mjs": "1deb265617d0e87b6d05bf8b3d5bf73cd4b788665c249c609a01b94ceff2eea1",
  "renderer/playwright-core/package.json": "4556ebbf21a31c5e8dabb49c991ec291c5f00ffcad8b18cda45e4070b8a473bd",
  "renderer/playwright/test.js": "b97fa53a6ab864f51c9c48b5e4647d0acae45ba2948c5d78e38bfeb56755d974",
  "renderer/playwright/index.js": "4e98f65f0a9d9bcab8cffc0c5cfdd87fd3f5b0be74fc494ff166a466b204cd44",
  "renderer/playwright-core/index.js": "a58fb2cec4293e7dcf73c58a179898a4f3986666451a19da4e731fa3af63265b",
  "renderer/playwright-core/lib/bootstrap.js": "4637f4dbfef9cfc01baeb5f5d2cb63fa0901522c96915ea2227290558d27123e",
  "renderer/playwright-core/lib/coreBundle.js": "3258d1cf334c6afc95f22aa9c292436cb976b391e0437f1359c83b84f0cb9d66",
};

async function verifyRuntimeDependencies(context) {
  check(process.platform === "linux" && process.arch === "x64", "B4 dependency pins target Linux x64");
  const mobileRequire = createRequire(resolve(appRoot, "mobile/package.json"));
  const rendererRequire = createRequire(resolve(appRoot, "renderer/package.json"));
  const playwrightTestPackage = rendererRequire.resolve("@playwright/test/package.json");
  const playwrightTestRequire = createRequire(playwrightTestPackage);
  const playwrightPackage = playwrightTestRequire.resolve("playwright/package.json");
  const playwrightRequire = createRequire(playwrightPackage);
  const playwrightCorePackage = playwrightRequire.resolve("playwright-core/package.json");
  const esbuildPackage = mobileRequire.resolve("esbuild/package.json");
  const wsPackage = mobileRequire.resolve("ws/package.json");
  const resolvedFiles = {
    "apps/kcoder-studio/mobile/package-lock.json": resolve(repoRoot, "apps/kcoder-studio/mobile/package-lock.json"),
    "apps/kcoder-studio/renderer/pnpm-lock.yaml": resolve(repoRoot, "apps/kcoder-studio/renderer/pnpm-lock.yaml"),
    "mobile/esbuild/package.json": esbuildPackage,
    "mobile/esbuild/lib/main.js": mobileRequire.resolve("esbuild"),
    "mobile/@esbuild/linux-x64/package.json": mobileRequire.resolve("@esbuild/linux-x64/package.json"),
    "mobile/@esbuild/linux-x64/bin/esbuild": mobileRequire.resolve("@esbuild/linux-x64/bin/esbuild"),
    "mobile/ws/package.json": wsPackage,
    "mobile/ws/index.js": mobileRequire.resolve("ws"),
    "mobile/ws/lib/websocket-server.js": resolve(dirname(wsPackage), "lib/websocket-server.js"),
    "mobile/ws/lib/websocket.js": resolve(dirname(wsPackage), "lib/websocket.js"),
    "mobile/ws/lib/receiver.js": resolve(dirname(wsPackage), "lib/receiver.js"),
    "mobile/ws/lib/sender.js": resolve(dirname(wsPackage), "lib/sender.js"),
    "mobile/ws/lib/validation.js": resolve(dirname(wsPackage), "lib/validation.js"),
    "renderer/@playwright/test/package.json": playwrightTestPackage,
    "renderer/@playwright/test/index.mjs": resolve(dirname(playwrightTestPackage), "index.mjs"),
    "renderer/playwright/package.json": playwrightPackage,
    "renderer/playwright/test.mjs": resolve(dirname(playwrightPackage), "test.mjs"),
    "renderer/playwright/test.js": resolve(dirname(playwrightPackage), "test.js"),
    "renderer/playwright/index.js": resolve(dirname(playwrightPackage), "index.js"),
    "renderer/playwright-core/package.json": playwrightCorePackage,
    "renderer/playwright-core/index.js": resolve(dirname(playwrightCorePackage), "index.js"),
    "renderer/playwright-core/lib/bootstrap.js": resolve(dirname(playwrightCorePackage), "lib/bootstrap.js"),
    "renderer/playwright-core/lib/coreBundle.js": resolve(dirname(playwrightCorePackage), "lib/coreBundle.js"),
  };
  const importedPlaywrightEntry = resolve(appRoot, "renderer/node_modules/@playwright/test/index.mjs");
  check(
    await realpath(importedPlaywrightEntry) === await realpath(resolvedFiles["renderer/@playwright/test/index.mjs"]),
    "harness static import no longer resolves to the pinned @playwright/test entry",
  );
  check(JSON.parse(await readFile(esbuildPackage, "utf8")).version === "0.28.1", "resolved esbuild version changed");
  check(JSON.parse(await readFile(wsPackage, "utf8")).version === "7.5.13", "resolved loopback WebSocket peer version changed");
  check(JSON.parse(await readFile(playwrightTestPackage, "utf8")).version === "1.62.0", "resolved @playwright/test version changed");
  check(JSON.parse(await readFile(playwrightPackage, "utf8")).version === "1.62.0", "resolved Playwright version changed");
  check(JSON.parse(await readFile(playwrightCorePackage, "utf8")).version === "1.62.0", "resolved Playwright Core version changed");
  const verified = {};
  for (const [path, expected] of Object.entries(runtimeDependencyPins)) {
    const actual = await hashFile(resolvedFiles[path]);
    check(actual === expected, `B4 runtime dependency changed: ${path}`);
    verified[path] = actual;
  }
  const browserDigest = await hashFile(EXPECTED_BROWSER);
  check(browserDigest === EXPECTED_BROWSER_SHA256, "pinned Chrome for Testing binary changed");
  await context.writeArtifactJson("b4-runtime-inputs.json", {
    nodeVersion: process.version,
    browser: { path: EXPECTED_BROWSER, version: "151.0.7922.34", sha256: browserDigest },
    mobilePackageJsonRole: "createRequire anchor only; hosting build:web script is not executed",
    resolvedVersions: { esbuild: "0.28.1", ws: "7.5.13", playwright: "1.62.0", playwrightCore: "1.62.0" },
    files: verified,
  });
  return { browserDigest, resolvedVersions: { esbuild: "0.28.1", ws: "7.5.13", playwright: "1.62.0", playwrightCore: "1.62.0" } };
}

function check(value, message) {
  if (!value) throw new Error(message);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function hashFile(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function sourceSnapshotPath(repositoryRelativePath) {
  return resolve(snapshotDir, repositoryRelativePath);
}

async function verifyFrozenInputs(context) {
  const inputBytes = await readFile(inputsPath);
  check(sha256(inputBytes) === INPUTS_JSON_SHA256, "B4 browser input pins changed");
  const pins = JSON.parse(inputBytes.toString("utf8"));
  check(pins.status === "FROZEN_TEST_INPUTS_NOT_PRODUCT_APPLIED", "B4 source snapshot is not marked as test-only input");
  check(pins.candidate.revision === STATIC_REVISION && pins.candidate.sourceDigest === STATIC_SOURCE_DIGEST && pins.candidate.fileCount === STATIC_PRODUCT_COUNT,
    "B4 static02 candidate identity changed");
  check(await hashFile(staticManifestPath) === STATIC_MANIFEST_SHA256, "B4 static02 manifest changed");
  check(await hashFile(staticDiffPath) === STATIC_DIFF_SHA256, "B4 static02 full product diff changed");
  const manifest = JSON.parse(await readFile(staticManifestPath, "utf8"));
  check(manifest.status === "PRIVATE_STATIC_ONLY_NOT_RUN" && manifest.revision === STATIC_REVISION, "B4 candidate status/revision changed");
  check(manifest.sourceDigest === STATIC_SOURCE_DIGEST && manifest.productCount === STATIC_PRODUCT_COUNT && manifest.files.length === STATIC_PRODUCT_COUNT,
    "B4 candidate manifest product inventory changed");
  const products = new Map(manifest.files.map(file => [file.path, file.after]));
  check(products.size === STATIC_PRODUCT_COUNT && pins.candidate.fileCount === products.size, "B4 candidate manifest has duplicate/missing products");
  for (const [path, digest] of Object.entries(pins.sourceFiles)) {
    const actual = await hashFile(sourceSnapshotPath(path));
    check(actual === digest, `B4 source snapshot changed: ${path}`);
    if (products.has(path)) check(products.get(path) === digest, `B4 snapshot does not match static02 after source: ${path}`);
  }
  for (const [path, digest] of products) {
    check(pins.sourceFiles[path] === digest, `B4 static02 product source is not pinned: ${path}`);
  }
  check(Object.keys(pins.sourceFiles).length === STATIC_PRODUCT_COUNT + Object.keys(supportPins).length,
    "B4 source closure count changed");
  for (const [path, digest] of Object.entries(supportPins)) {
    check(pins.sourceFiles[path] === digest, `B4 runtime support pin changed: ${path}`);
  }
  for (const [path, digest] of Object.entries(harnessPins)) {
    check(await hashFile(resolve(repoRoot, path)) === digest, `B4 browser harness/platform shim pin changed: ${path}`);
  }
  const runtimeInputs = await verifyRuntimeDependencies(context);
  await context.writeArtifactJson("b4-frozen-inputs.json", {
    candidateRevision: STATIC_REVISION,
    candidateSourceDigest: STATIC_SOURCE_DIGEST,
    candidateManifestSha256: STATIC_MANIFEST_SHA256,
    candidateProductsDiffSha256: STATIC_DIFF_SHA256,
    productInputCount: STATIC_PRODUCT_COUNT,
    supportInputCount: Object.keys(supportPins).length,
    sourceSnapshotInputCount: Object.keys(pins.sourceFiles).length,
    testHarnessAndShimPinCount: Object.keys(harnessPins).length,
    sourceSnapshotSha256: INPUTS_JSON_SHA256,
    productApplyClaimed: false,
    runtimeDependencyPins: Object.keys(runtimeDependencyPins).length,
    browserSha256: runtimeInputs.browserDigest,
  });
  return { pins, manifest };
}

async function buildBrowserEntry(context) {
  const requireFromMobile = createRequire(resolve(appRoot, "mobile/package.json"));
  const { build } = requireFromMobile("esbuild");
  const shimRoot = resolve(suiteDir, "support");
  const rpcPath = resolve(mobileSourceRoot, "gateway/rpc.ts");
  const retentionPath = resolve(mobileSourceRoot, "protocol/attachment-retention.ts");
  const uploaderPath = resolve(mobileSourceRoot, "storage/retained-attachment-upload.ts");
  const storePath = resolve(mobileSourceRoot, "storage/staged-attachment-store.ts");
  const profileStorePath = resolve(mobileSourceRoot, "storage/profile-store.ts");
  const secureFencePath = resolve(mobileSourceRoot, "storage/workspace-profile-fence.ts");
  const entryPath = context.pathInState("b4-idb-two-page-entry.js");
  const entrySource = `
import { GatewayRpcClient } from ${JSON.stringify(rpcPath)};
import { RETENTION_CAPABILITY } from ${JSON.stringify(retentionPath)};
import { RetainedAttachmentUploader } from ${JSON.stringify(uploaderPath)};
import { StagedAttachmentStore } from ${JSON.stringify(storePath)};
import { loadProfiles, persistProfiles } from ${JSON.stringify(profileStorePath)};
import { captureWorkspaceProfileIdentity, withWorkspaceProfileWrite } from ${JSON.stringify(secureFencePath)};

const DATABASE = ${JSON.stringify(DB_NAME)};
const admission = ${JSON.stringify(ADMISSION)};
const server = { id: "b4-idb-target", label: "B4 local fixture", description: "loopback protocol fixture", runtime: "kcoder", transport: "local", workspacePath: "/b4/workspace" };
const workspacePath = "/b4/workspace";
let active = null;
let casExpected = null;
const resumeResults = Object.create(null);

function contextFor(profile) { return { profile, server, workspacePath, isCurrent: () => true }; }
function patternedBlob(size, byte = 0) {
  const bytes = new Uint8Array(size);
  if (byte !== 0) bytes.fill(byte);
  const blob = new Blob([bytes.buffer], { type: "application/octet-stream" });
  bytes.fill(0);
  return blob;
}
function durableSource(blob) {
  return { size: blob.size, blob, async read(offset, length) { return new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer()); } };
}
async function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => { request.result.createObjectStore("rows", { keyPath: "id" }); request.result.createObjectStore("bytes"); };
    request.onerror = () => reject(request.error || new Error("idb-open"));
    request.onblocked = () => reject(new Error("idb-blocked"));
    request.onsuccess = () => resolve(request.result);
  });
}
async function rawInspect(id) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(["rows", "bytes"], "readonly");
    const rowRequest = tx.objectStore("rows").get(id);
    const blobRequest = tx.objectStore("bytes").get(id);
    let row;
    let blob;
    rowRequest.onsuccess = () => { row = rowRequest.result?.value; };
    blobRequest.onsuccess = () => { blob = blobRequest.result; };
    tx.oncomplete = () => {
      db.close();
      resolve({
        rowExists: !!row,
        phase: row?.phase ?? null,
        revision: row?.revision ?? null,
        wireMethod: row?.wire?.method ?? null,
        wireRevision: row?.wire?.revision ?? null,
        scopeIdPresent: typeof row?.scopeId === "string",
        confirmedBytes: row?.confirmedBytes ?? null,
        scopeGeneration: row?.scope?.profile?.authorizationGeneration ?? null,
        rowSize: row?.size ?? null,
        blobExists: blob instanceof Blob,
        blobSize: blob instanceof Blob ? blob.size : null,
      });
    };
    tx.onabort = () => { db.close(); reject(tx.error || new Error("idb-inspect-abort")); };
  });
}
async function rawAggregate() {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(["rows", "bytes"], "readonly");
    const rowRequest = tx.objectStore("rows").getAll();
    const blobRequest = tx.objectStore("bytes").getAll();
    let rows = [];
    let blobs = [];
    rowRequest.onsuccess = () => { rows = rowRequest.result || []; };
    blobRequest.onsuccess = () => { blobs = blobRequest.result || []; };
    tx.oncomplete = () => {
      db.close();
      resolve({
        rowCount: rows.length,
        blobCount: blobs.length,
        blobBytes: blobs.reduce((sum, blob) => sum + (blob instanceof Blob ? blob.size : 0), 0),
        rows: rows.map(entry => ({ filename: entry.value?.filename ?? "invalid", size: entry.value?.size ?? -1, phase: entry.value?.phase ?? "invalid", cleanup: entry.value?.cleanup ?? "invalid" })),
      });
    };
    tx.onabort = () => { db.close(); reject(tx.error || new Error("idb-aggregate-abort")); };
  });
}
function makeActive(profile, client) {
  const context = contextFor(profile);
  const store = new StagedAttachmentStore();
  const uploader = client ? new RetainedAttachmentUploader(context, client, store) : null;
  active = { profile, context, store, client, uploader };
}
async function connectSaved(profileId) {
  if (active?.client) { try { active.client.close(); } catch {} }
  const snapshot = await loadProfiles();
  const profile = snapshot.profiles.find(item => item.id === profileId);
  if (!profile) throw new Error("fixture-profile-not-found");
  const client = await GatewayRpcClient.connect(profile, server, workspacePath);
  makeActive(profile, client);
  return { connected: true, retentionCapability: client.supportsExperimental(RETENTION_CAPABILITY), admissionPresent: !!client.getAttachmentUploadAdmission() };
}
async function preparePattern(filename, size, byte = 0) {
  try {
    if (!active?.uploader) throw new Error("fixture-client-not-connected");
    const row = await active.uploader.prepare(filename, durableSource(patternedBlob(size, byte)));
    return { ok: true, id: row.id, revision: row.revision, size: row.size, phase: row.phase };
  } catch (error) {
    return { ok: false, errorName: error instanceof Error ? error.name : "Error" };
  }
}
async function loadForCas(id) {
  if (!active) throw new Error("fixture-context-not-connected");
  casExpected = await active.store.load(active.context, id);
  return casExpected ? { found: true, revision: casExpected.revision } : { found: false, revision: null };
}
async function commitCas() {
  if (!active || !casExpected) return { ok: false, errorName: "MissingExpectedRecord" };
  try {
    const next = await active.store.update(active.context, casExpected, row => ({ ...row }));
    casExpected = next;
    return { ok: true, revision: next.revision };
  } catch (error) { return { ok: false, errorName: error instanceof Error ? error.name : "Error" }; }
}
async function discardPrepared(id) {
  if (!active) throw new Error("fixture-context-not-connected");
  const row = await active.store.load(active.context, id);
  if (!row) return { found: false };
  const next = await active.store.discardSource(active.context, row);
  return { found: true, cleanup: next.cleanup, phase: next.phase };
}
async function listCurrentScope(profileId) {
  const snapshot = await loadProfiles();
  const profile = snapshot.profiles.find(item => item.id === profileId);
  if (!profile) return { count: -1 };
  const store = new StagedAttachmentStore();
  const rows = await store.listUnresolved(contextFor(profile));
  return { count: rows.length, filenames: rows.map(row => row.filename) };
}
async function rotateStoredScope(profileId, authorizationGeneration, deviceId, accessToken, rpcToken) {
  const snapshot = await loadProfiles();
  const current = snapshot.profiles.find(item => item.id === profileId);
  if (!current) throw new Error("fixture-profile-not-found");
  const identity = captureWorkspaceProfileIdentity(current);
  const next = { ...current, authorizationGeneration, deviceId, accessToken, rpcToken };
  const profiles = snapshot.profiles.map(item => item.id === profileId ? next : item);
  await withWorkspaceProfileWrite(identity, () => persistProfiles(profiles, snapshot.activeId));
  return { committed: true, generationChanged: next.authorizationGeneration !== identity.authorizationGeneration, deviceChanged: next.deviceId !== identity.deviceId };
}
function resumeCapture(id, key) {
  if (!active?.uploader) throw new Error("fixture-client-not-connected");
  resumeResults[key] = null;
  active.uploader.resume(id).then(handle => {
    resumeResults[key] = { ok: true, sealed: handle.stageRef?.revision > 0, size: handle.size };
  }, error => {
    resumeResults[key] = { ok: false, errorName: error instanceof Error ? error.name : "Error", unknownDelivery: error?.delivery === "unknown" };
  });
  return { scheduled: true };
}
async function resumeAndWait(id) {
  if (!active?.uploader) throw new Error("fixture-client-not-connected");
  try {
    const handle = await active.uploader.resume(id);
    return { ok: true, sealed: handle.stageRef?.revision > 0, size: handle.size };
  } catch (error) { return { ok: false, errorName: error instanceof Error ? error.name : "Error" }; }
}
function armReadwriteAbort() {
  const prototype = IDBDatabase.prototype;
  const original = prototype.transaction;
  let armed = true;
  const wrapped = function(storeNames, mode, options) {
    const tx = arguments.length > 2 ? original.call(this, storeNames, mode, options) : original.call(this, storeNames, mode);
    if (armed && this.name === DATABASE && mode === "readwrite") {
      armed = false;
      queueMicrotask(() => { try { tx.abort(); } catch {} });
    }
    return tx;
  };
  prototype.transaction = wrapped;
  return {
    armed: () => armed,
    restore: () => { if (prototype.transaction === wrapped) prototype.transaction = original; },
  };
}
function storageEstimate() { return navigator.storage?.estimate ? navigator.storage.estimate() : Promise.resolve(null); }

window.__b4 = {
  prerequisites: () => ({ indexedDb: typeof indexedDB !== "undefined", webLocks: typeof navigator.locks?.request === "function", secureContext: window.isSecureContext }),
  async seedAndConnect(profile) { await persistProfiles([profile], profile.id); return connectSaved(profile.id); },
  connectSaved,
  closeClient() { if (active?.client) { active.client.close(); active.client = null; active.uploader = null; } },
  preparePattern,
  loadForCas,
  commitCas,
  discardPrepared,
  rawInspect,
  rawAggregate,
  listCurrentScope,
  rotateStoredScope,
  resumeCapture,
  resumeAndWait,
  resumeResult(key) { return resumeResults[key] ?? null; },
  armReadwriteAbort,
  storageEstimate,
};
`;
  await writeFile(entryPath, entrySource, { mode: 0o600, flag: "wx" });
  const shimReactNative = resolve(suiteDir, "support/react-native-web.ts");
  const shimGatewayHttp = resolve(suiteDir, "support/gateway-http.ts");
  const result = await build({
    absWorkingDir: repoRoot,
    entryPoints: [entryPath],
    bundle: true,
    platform: "browser",
    format: "iife",
    target: ["es2022"],
    alias: { "@": mobileSourceRoot },
    write: false,
    metafile: true,
    plugins: [{
      name: "b4-private-source-snapshot-resolver",
      setup(builder) {
        builder.onResolve({ filter: /^react-native$/ }, () => ({ path: shimReactNative }));
        builder.onResolve({ filter: /^\.\/http$/ }, args => args.importer.endsWith("/gateway/rpc.ts") ? { path: shimGatewayHttp } : null);
      },
    }],
  });
  check(result.outputFiles.length === 1, "B4 browser bundle did not produce exactly one artifact");
  const bundleInputs = Object.keys(result.metafile.inputs).map(path => path.split(sep).join("/"));
  check(bundleInputs.some(path => path.endsWith("/storage/staged-attachment-bytes.web.ts")), "actual candidate Web IndexedDB backend is not bundled");
  check(!bundleInputs.some(path => path.endsWith("/storage/staged-attachment-bytes.native.ts")), "Native filesystem backend leaked into the Web test bundle");
  check(bundleInputs.some(path => path.endsWith("/storage/retained-attachment-upload.ts")) && bundleInputs.some(path => path.endsWith("/gateway/rpc.ts")),
    "actual candidate uploader or GatewayRpcClient is not bundled");
  for (const relativeSource of ["protocol/attachment-retention.ts", "protocol/sha256-stream.ts"]) {
    check(bundleInputs.some(path => path.endsWith(`/mobile/src/${relativeSource}`)),
      `B4 snapshot alias did not resolve ${relativeSource} from the frozen Mobile source tree`);
  }
  const bundle = result.outputFiles[0].contents;
  await context.writeArtifactJson("b4-browser-bundle-provenance.json", {
    bundleSha256: sha256(bundle),
    bundleBytes: bundle.byteLength,
    bundledWebBackend: true,
    bundledNativeBackend: false,
    actualGatewayRpcClient: true,
    actualRetainedUploader: true,
    productionAuthorizationHelperShimmed: true,
    reactNativePlatformSelectorStubbedForWeb: true,
    productionRpcUploaderProfileFenceAndIdbNotStubbed: true,
    inputCount: bundleInputs.length,
    inputs: bundleInputs.map(path => relative(repoRoot, path.startsWith("/") ? path : resolve(repoRoot, path)).split(sep).join("/")).sort(),
  });
  return bundle;
}

function makeLoopbackPeer(httpServer, tokens) {
  const WebSocketServer = createRequire(resolve(appRoot, "mobile/package.json"))("ws").Server;
  const wss = new WebSocketServer({ server: httpServer, path: "/rpc" });
  const events = new EventEmitter();
  const requests = [];
  const remotes = new Map();
  const sockets = new Set();
  let dropNextStart = false;
  let holdNextStart = false;
  let heldStart = null;
  const protocolVersion = "2026-07-27";
  const summaryId = value => sha256(Buffer.from(String(value))).slice(0, 16);
  const keyOf = (ownerId, uploadId) => `${ownerId}\n${uploadId}`;
  const responseFor = remote => ({
    clientOwnerRequestId: remote.ownerId,
    clientUploadId: remote.uploadId,
    scopeId: remote.scopeId,
    lookup: {
      outcome: "present",
      filename: remote.filename,
      size: remote.size,
      contentSha256: remote.contentSha256,
      recovery: {
        rootNamespace: ADMISSION.rootNamespace,
        epoch: ADMISSION.admissionEpoch,
        state: remote.state,
        confirmedBytes: remote.confirmedBytes,
        ...(remote.stageRef ? { stageRef: remote.stageRef } : {}),
      },
    },
  });
  const send = (socket, id, result) => {
    if (socket.readyState === 1) socket.send(JSON.stringify({ jsonrpc: "2.0", id, result }));
  };
  const sendError = (socket, id) => {
    if (socket.readyState === 1) socket.send(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: "fixture protocol mismatch" } }));
  };
  const record = (summary) => { requests.push(summary); events.emit("request", summary); };
  wss.on("connection", (socket, request) => {
    sockets.add(socket);
    socket.once("close", () => { sockets.delete(socket); events.emit("socket-closed"); });
    const requestUrl = new URL(request.url ?? "/rpc", "http://127.0.0.1");
    if (!tokens.has(requestUrl.searchParams.get("token"))) { socket.close(1008, "fixture token rejected"); return; }
    socket.on("message", raw => {
      let frame;
      try { frame = JSON.parse(Buffer.from(raw).toString("utf8")); } catch { socket.close(1002, "invalid JSON-RPC"); return; }
      if (frame.method === "initialized") return;
      if (frame.method === "initialize" && Number.isSafeInteger(frame.id)) {
        record({ method: "initialize", disposition: "replied" });
        send(socket, frame.id, {
          protocolVersion,
          capabilities: { experimental: { [RETENTION_CAPABILITY]: true } },
          attachmentUploadAdmission: ADMISSION,
        });
        return;
      }
      if (!Number.isSafeInteger(frame.id) || typeof frame.method !== "string" || !frame.method.startsWith("attachment/retention/upload/")) return;
      const mode = frame.method.slice("attachment/retention/upload/".length);
      const params = frame.params ?? {};
      const ownerId = params.ownerRequest?.clientOwnerRequestId;
      const uploadId = params.clientUploadId;
      if (typeof ownerId !== "string" || typeof uploadId !== "string") { sendError(socket, frame.id); return; }
      const key = keyOf(ownerId, uploadId);
      const summary = { method: frame.method, ownerFingerprint: summaryId(ownerId), uploadFingerprint: summaryId(uploadId) };
      let remote = remotes.get(key);
      if (mode === "start") {
        if (!remote) {
          remote = { ownerId, uploadId, filename: params.filename, size: params.size, contentSha256: params.contentSha256, scopeId: SCOPE_ID, confirmedBytes: 0, state: "uploading", stageRef: null };
          remotes.set(key, remote);
        } else if (remote.filename !== params.filename || remote.size !== params.size || remote.contentSha256 !== params.contentSha256) { sendError(socket, frame.id); return; }
        summary.length = params.size;
        if (dropNextStart) {
          dropNextStart = false;
          summary.disposition = "remote-state-committed-then-connection-closed-before-response";
          record(summary);
          socket.close(1011, "controlled lost-ACK fixture");
          return;
        }
        if (holdNextStart) {
          holdNextStart = false;
          summary.disposition = "response-held-after-remote-state-commit";
          heldStart = { socket, frameId: frame.id, remote };
          record(summary);
          events.emit("held-start");
          return;
        }
      } else if (mode === "read") {
        summary.disposition = remote ? "lookup-present" : "lookup-absent";
        record(summary);
        send(socket, frame.id, remote ? responseFor(remote) : {
          clientOwnerRequestId: ownerId, clientUploadId: uploadId, scopeId: SCOPE_ID, lookup: { outcome: "absent" },
        });
        return;
      } else if (mode === "chunk") {
        if (!remote || remote.state !== "uploading" || params.offset !== remote.confirmedBytes || !Number.isSafeInteger(params.length)) { sendError(socket, frame.id); return; }
        const decoded = Buffer.from(String(params.contentBase64 ?? ""), "base64");
        const matches = decoded.byteLength === params.length && sha256(decoded) === params.chunkSha256;
        if (!matches) { sendError(socket, frame.id); return; }
        remote.confirmedBytes += decoded.byteLength;
        summary.offset = params.offset;
        summary.length = params.length;
        summary.decodedLength = decoded.byteLength;
        summary.chunkHashValid = matches;
        summary.contiguous = true;
      } else if (mode === "finish") {
        if (!remote || remote.confirmedBytes !== remote.size) { sendError(socket, frame.id); return; }
        remote.state = "sealed";
        remote.stageRef = { rootNamespace: ADMISSION.rootNamespace, epoch: ADMISSION.admissionEpoch, ownerId: "b4-fixture-owner", entryId: `entry-${uploadId.slice(-12)}`, revision: 1, path: "/b4-fixture/staged" };
      } else { sendError(socket, frame.id); return; }
      summary.disposition ??= "replied";
      record(summary);
      send(socket, frame.id, responseFor(remote));
    });
  });
  return {
    requests,
    retentionRequests: () => requests.filter(item => item.method.startsWith("attachment/retention/upload/")),
    setDropNextStart() { dropNextStart = true; },
    setHoldNextStart() { holdNextStart = true; },
    async waitFor(method, ordinal = 1, timeoutMs = 15_000) {
      const find = () => requests.filter(item => item.method === method)[ordinal - 1];
      const found = find();
      if (found) return found;
      return new Promise((resolveWait, rejectWait) => {
        const timer = setTimeout(() => { events.off("request", check); rejectWait(new Error("loopback fixture request deadline")); }, timeoutMs);
        const check = () => { const item = find(); if (item) { clearTimeout(timer); events.off("request", check); resolveWait(item); } };
        events.on("request", check);
      });
    },
    async waitHeldStart(timeoutMs = 15_000) {
      if (heldStart) return;
      await new Promise((resolveWait, rejectWait) => {
        const timer = setTimeout(() => { events.off("held-start", done); rejectWait(new Error("loopback start hold deadline")); }, timeoutMs);
        const done = () => { clearTimeout(timer); events.off("held-start", done); resolveWait(); };
        events.on("held-start", done);
      });
    },
    releaseHeldStart() {
      const held = heldStart;
      heldStart = null;
      if (!held) throw new Error("no held start response");
      send(held.socket, held.frameId, responseFor(held.remote));
    },
    async waitForOpenSockets(count, timeoutMs = 5_000) {
      if (sockets.size === count) return;
      await new Promise((resolveWait, rejectWait) => {
        const timer = setTimeout(() => { events.off("socket-closed", check); rejectWait(new Error("loopback socket-close deadline")); }, timeoutMs);
        const check = () => { if (sockets.size === count) { clearTimeout(timer); events.off("socket-closed", check); resolveWait(); } };
        events.on("socket-closed", check);
        check();
      });
    },
    openSocketCount() { return sockets.size; },
    safeSummary() {
      return requests.map(item => ({
        method: item.method,
        disposition: item.disposition,
        ownerFingerprint: item.ownerFingerprint,
        uploadFingerprint: item.uploadFingerprint,
        ...(item.offset !== undefined ? { offset: item.offset } : {}),
        ...(item.length !== undefined ? { length: item.length } : {}),
        ...(item.decodedLength !== undefined ? { decodedLength: item.decodedLength } : {}),
        ...(item.chunkHashValid !== undefined ? { chunkHashValid: item.chunkHashValid } : {}),
        ...(item.contiguous !== undefined ? { contiguous: item.contiguous } : {}),
      }));
    },
    async close() {
      if (heldStart?.socket?.readyState === 1) heldStart.socket.terminate();
      heldStart = null;
      for (const socket of sockets) { try { socket.terminate(); } catch {} }
      await new Promise(resolveClose => wss.close(() => resolveClose()));
    },
  };
}

async function waitForPageResult(page, key, timeoutMs = 15_000) {
  await page.waitForFunction(keyName => window.__b4?.resumeResult(keyName) !== null, key, { timeout: timeoutMs });
  return page.evaluate(keyName => window.__b4.resumeResult(keyName), key);
}

await runE2E(import.meta.url, {
  testId: "b4-durable-attachment-two-page-idb-review",
  tier: "model-independent",
  privateCandidate: true,
  modelPolicy: "real Chromium two-page IndexedDB/Web Locks plus static02 Mobile upload modules; loopback scripted RPC protocol only; no production Gateway/Rust/Relay/Provider or external network",
}, async context => {
  const { pins } = await verifyFrozenInputs(context);
  const bundle = await buildBrowserEntry(context);
  if (process.env.KCODER_B4_BUILD_ONLY === "1") {
    return { status: "BUNDLE_PREFLIGHT_ONLY_NOT_BROWSER_EVIDENCE", bundleBytes: bundle.byteLength };
  }
  const allowedTokens = new Set();
  const accessTokenA = randomBytes(24).toString("hex");
  const rpcTokenA = randomBytes(24).toString("hex");
  const accessTokenB = randomBytes(24).toString("hex");
  const rpcTokenB = randomBytes(24).toString("hex");
  for (const token of [accessTokenA, rpcTokenA, accessTokenB, rpcTokenB]) { context.registerSecret(token); allowedTokens.add(token); }

  const html = Buffer.from("<!doctype html><meta charset=utf-8><title>B4 private IDB fixture</title><body>Private B4 protocol fixture<script src=/bundle.js></script>");
  const httpServer = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (request.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }); response.end(html); return;
    }
    if (request.method === "GET" && pathname === "/bundle.js") {
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" }); response.end(bundle); return;
    }
    response.writeHead(404, { "content-length": "0", "cache-control": "no-store" }); response.end();
  });
  await new Promise((resolveListen, rejectListen) => { httpServer.once("error", rejectListen); httpServer.listen(0, "127.0.0.1", resolveListen); });
  const address = httpServer.address();
  assert.ok(address && typeof address === "object" && Number.isInteger(address.port));
  const origin = `http://127.0.0.1:${address.port}`;
  context.registerPort("b4-two-page-idb-loopback", address.port);
  context.addCleanup("close B4 two-page loopback HTTP origin", async () => new Promise(resolveClose => httpServer.close(() => resolveClose())));
  const peer = makeLoopbackPeer(httpServer, allowedTokens);
  context.addCleanup("close B4 controlled WebSocket peer", () => peer.close());

  const chromium = await startChromium(context, { label: "b4-two-page-idb-chromium", executablePath: EXPECTED_BROWSER });
  const browserContext = await chromium.browser.newContext({ viewport: { width: 1024, height: 768 } });
  context.addCleanup("close B4 same-origin BrowserContext", () => browserContext.close());
  const pageA = await browserContext.newPage();
  const pageB = await browserContext.newPage({ viewport: { width: 1024, height: 768 } });
  const pageErrors = [];
  for (const page of [pageA, pageB]) {
    page.on("pageerror", error => { if (pageErrors.length < 16) pageErrors.push(error?.name || "Error"); });
  }
  await Promise.all([pageA.goto(origin), pageB.goto(origin)]);
  await Promise.all([
    pageA.waitForFunction(() => !!window.__b4),
    pageB.waitForFunction(() => !!window.__b4),
  ]);
  const prerequisites = await Promise.all([pageA.evaluate(() => window.__b4.prerequisites()), pageB.evaluate(() => window.__b4.prerequisites())]);
  assert.ok(prerequisites.every(value => value.indexedDb && value.webLocks && value.secureContext), "UNMET_PREREQUISITE: two same-origin pages require IndexedDB, Web Locks, and a trustworthy loopback context");
  const realmIds = await Promise.all([
    pageA.evaluate(() => { const id = crypto.randomUUID(); Object.defineProperty(window, "__b4RealmId", { value: id }); return id; }),
    pageB.evaluate(() => { const id = crypto.randomUUID(); Object.defineProperty(window, "__b4RealmId", { value: id }); return id; }),
  ]);
  assert.notEqual(realmIds[0], realmIds[1], "the two pages must execute in distinct JavaScript realms");

  const profile = {
    id: "b4-two-page-profile", label: "private B4 fixture", baseUrl: origin,
    accessToken: accessTokenA, expiresAt: 9_999_999_999_999, rpcToken: rpcTokenA,
    authorizationGeneration: "b4-auth-generation-a", deviceId: "b4-device-a", authMode: "device",
  };
  const seedResult = await pageA.evaluate(value => window.__b4.seedAndConnect(value), profile);
  assert.deepEqual(seedResult, { connected: true, retentionCapability: true, admissionPresent: true }, "static02 client must negotiate the scripted retention fixture");
  const pageBConnect = await pageB.evaluate(profileId => window.__b4.connectSaved(profileId), profile.id);
  assert.deepEqual(pageBConnect, seedResult, "second page must load the same persisted profile and connect with the same initialized owner");

  const phaseResults = {};
  const retentionBeforePrepare = peer.retentionRequests().length;
  const abortResult = await pageA.evaluate(async () => {
    const hook = window.__b4.armReadwriteAbort();
    let result;
    try { result = await window.__b4.preparePattern("idb-abort.bin", 32, 11); }
    finally { hook.restore(); }
    return { result, stillArmed: hook.armed() };
  });
  assert.equal(abortResult.result.ok, false, "an actual IndexedDB readwrite abort must reject prepare");
  assert.equal(abortResult.stillArmed, false, "abort injection must hit the actual candidate write transaction");
  const afterAbort = await pageB.evaluate(() => window.__b4.rawAggregate());
  assert.equal(afterAbort.rowCount, 0, "aborted candidate transaction must not leave a row");
  assert.equal(afterAbort.blobCount, 0, "aborted candidate transaction must not leave source bytes");
  assert.equal(peer.retentionRequests().length, retentionBeforePrepare, "local prepare/abort must issue zero retention RPCs");
  phaseResults.transactionAbort = { attempted: true, errorName: abortResult.result.errorName, rows: afterAbort.rowCount, blobs: afterAbort.blobCount, retentionRpcDelta: 0 };

  const casPrepared = await pageA.evaluate(() => window.__b4.preparePattern("idb-cas.bin", 32, 21));
  assert.equal(casPrepared.ok, true, "actual IndexedDB prepare must succeed before the CAS race");
  const sharedFromSecondPage = await pageB.evaluate(id => window.__b4.rawInspect(id), casPrepared.id);
  assert.equal(sharedFromSecondPage.rowExists, true, "second page must observe the first page's persisted row");
  assert.equal(sharedFromSecondPage.blobExists, true, "second page must observe the first page's persisted Blob");
  const loadedExpected = await Promise.all([pageA.evaluate(id => window.__b4.loadForCas(id), casPrepared.id), pageB.evaluate(id => window.__b4.loadForCas(id), casPrepared.id)]);
  assert.deepEqual(loadedExpected, [{ found: true, revision: 1 }, { found: true, revision: 1 }], "both pages must race from the same actual durable revision");
  const casOutcome = await Promise.all([pageA.evaluate(() => window.__b4.commitCas()), pageB.evaluate(() => window.__b4.commitCas())]);
  assert.equal(casOutcome.filter(result => result.ok).length, 1, "exactly one cross-page revision CAS must commit");
  assert.equal(casOutcome.filter(result => !result.ok && result.errorName === "AttachmentStoreConflict").length, 1, "the stale cross-page revision must fail closed");
  const casAfter = await pageA.evaluate(id => window.__b4.rawInspect(id), casPrepared.id);
  assert.equal(casAfter.revision, 2, "cross-page CAS must increment exactly once");
  phaseResults.crossPageCas = { bothLoadedRevision: 1, winners: 1, staleConflicts: 1, finalRevision: casAfter.revision, sharedIdbAndBlob: true };

  const estimate = await pageA.evaluate(() => window.__b4.storageEstimate());
  assert.ok(estimate && Number.isFinite(estimate.quota) && Number.isFinite(estimate.usage) && estimate.quota - estimate.usage >= LARGE_QUOTA_HEADROOM,
    "UNMET_PREREQUISITE: 120 MiB browser storage headroom is required for real 40+40+15+15 MiB quota contenders");
  const size40 = 40 * MIB;
  const size15 = 15 * MIB;
  const quotaA = await pageA.evaluate(size => window.__b4.preparePattern("quota-40-a.bin", size, 0), size40);
  const quotaB = await pageA.evaluate(size => window.__b4.preparePattern("quota-40-b.bin", size, 0), size40);
  assert.equal(quotaA.ok, true, "first real 40 MiB source must fit local candidate cap");
  assert.equal(quotaB.ok, true, "second real 40 MiB source must fit local candidate cap");
  const quotaRace = await Promise.all([
    pageA.evaluate(size => window.__b4.preparePattern("quota-15-a.bin", size, 0), size15),
    pageB.evaluate(size => window.__b4.preparePattern("quota-15-b.bin", size, 0), size15),
  ]);
  assert.equal(quotaRace.filter(result => result.ok).length, 1, "real Blob quota race must admit exactly one 15 MiB contender under the 100 MiB store cap");
  assert.equal(quotaRace.filter(result => !result.ok && result.errorName === "AttachmentStoreConflict").length, 1, "losing quota transaction must fail with the candidate's capacity conflict");
  const quotaState = await pageB.evaluate(() => window.__b4.rawAggregate());
  const activeQuotaRows = quotaState.rows.filter(row => row.filename.startsWith("quota-") && row.cleanup !== "finished");
  assert.equal(activeQuotaRows.length, 3, "exactly two 40 MiB rows plus one 15 MiB row must be durably admitted");
  assert.equal(activeQuotaRows.reduce((sum, row) => sum + row.size, 0), 95 * MIB, "admitted source bytes must be real exact 95 MiB");
  assert.equal(quotaState.blobBytes, 95 * MIB + 32, "IndexedDB must hold actual Blob bytes for the admitted race winners and CAS row");
  for (const item of activeQuotaRows) {
    const ownerPage = item.filename === "quota-15-b.bin" && quotaRace[1].ok ? pageB : pageA;
    const id = item.filename === "quota-40-a.bin" ? quotaA.id : item.filename === "quota-40-b.bin" ? quotaB.id : (quotaRace[0].ok ? quotaRace[0].id : quotaRace[1].id);
    const raw = await ownerPage.evaluate(value => window.__b4.rawInspect(value), id);
    assert.equal(raw.rowExists && raw.blobExists, true, "each admitted quota row must have its real Blob before cleanup");
    assert.equal(raw.blobSize, item.size, "each admitted Blob must match its actual declared bytes");
  }
  const quotaIds = [quotaA.id, quotaB.id, quotaRace[0].ok ? quotaRace[0].id : quotaRace[1].id, casPrepared.id];
  const cleanupResults = await pageA.evaluate(async ids => Promise.all(ids.map(id => window.__b4.discardPrepared(id))), quotaIds);
  assert.ok(cleanupResults.every(result => result.found && result.cleanup === "finished"), "explicit unsent local discard must finish for the exact admitted source IDs");
  const quotaAfterCleanup = await pageB.evaluate(() => window.__b4.rawAggregate());
  assert.equal(quotaAfterCleanup.blobBytes, 0, "discard must remove all exact local Blob bytes");
  assert.equal(peer.retentionRequests().length, retentionBeforePrepare, "all abort/CAS/quota staging and explicit local discard must remain zero-RPC operations");
  phaseResults.twoPageQuota = {
    storageHeadroomBytes: Math.floor(estimate.quota - estimate.usage),
    admittedSourceBytes: 95 * MIB,
    contenders: 2,
    admittedContenders: 1,
    rejectedAsStoreCapacity: 1,
    blobsRemovedByExplicitDiscard: true,
  };

  const retentionBeforeUpload = peer.retentionRequests().length;
  const lostAckPrepared = await pageA.evaluate(size => window.__b4.preparePattern("lost-start-ack.bin", size, 37), 300 * 1024);
  assert.equal(lostAckPrepared.ok, true, "lost-ACK fixture source must be locally prepared");
  assert.equal(peer.retentionRequests().length, retentionBeforeUpload, "prepare must persist local bytes without sending a retention RPC");
  peer.setDropNextStart();
  await pageA.evaluate(({ id }) => window.__b4.resumeCapture(id, "lost-start"), { id: lostAckPrepared.id });
  await peer.waitFor("attachment/retention/upload/start", 1);
  const sentIntent = await pageB.evaluate(id => window.__b4.rawInspect(id), lostAckPrepared.id);
  assert.equal(sentIntent.rowExists && sentIntent.blobExists, true, "second page must observe source and row when the first start reaches the peer");
  assert.equal(sentIntent.wireMethod, "attachment/retention/upload/start", "durable exact wire intent must precede the first server-visible start");
  assert.equal(sentIntent.wireRevision, sentIntent.revision, "wire intent revision must match its durable row revision");
  assert.equal(sentIntent.blobSize, 300 * 1024, "the source bytes must be durable before start dispatch");
  const lostAckResult = await waitForPageResult(pageA, "lost-start");
  assert.equal(lostAckResult.ok, false, "the client must treat a closed connection after remote state commit as an unknown start outcome");
  assert.equal(lostAckResult.unknownDelivery, true, "lost start acknowledgement must remain an unknown delivery result");
  const afterLostAck = await pageA.evaluate(id => window.__b4.rawInspect(id), lostAckPrepared.id);
  assert.equal(afterLostAck.wireMethod, "attachment/retention/upload/start", "unknown start must preserve the original wire method and ID");
  await pageB.evaluate(profileId => window.__b4.connectSaved(profileId), profile.id);
  const recovered = await pageB.evaluate(id => window.__b4.resumeAndWait(id), lostAckPrepared.id);
  assert.deepEqual(recovered, { ok: true, sealed: true, size: 300 * 1024 }, "same-scope reconnect must read back the original upload and finish it");
  const resumeMethods = peer.retentionRequests().slice(retentionBeforeUpload).map(item => item.method);
  assert.deepEqual(resumeMethods, [
    "attachment/retention/upload/start",
    "attachment/retention/upload/read",
    "attachment/retention/upload/chunk",
    "attachment/retention/upload/finish",
  ], "same-ID recovery must read first, never issue a second allocation start");
  const resumedIdentities = peer.safeSummary().filter(item => item.method.startsWith("attachment/retention/upload/")).slice(-4);
  assert.equal(new Set(resumedIdentities.map(item => item.ownerFingerprint)).size, 1, "owner ID must survive lost-ACK recovery");
  assert.equal(new Set(resumedIdentities.map(item => item.uploadFingerprint)).size, 1, "upload ID must survive lost-ACK recovery");
  const chunkEvidence = resumedIdentities.find(item => item.method.endsWith("/chunk"));
  assert.equal(chunkEvidence?.offset, 0, "recovered chunk must begin at the exact confirmed offset");
  assert.equal(chunkEvidence?.length, 300 * 1024, "recovered chunk must transfer the exact pending byte range");
  assert.equal(chunkEvidence?.decodedLength, 300 * 1024, "loopback peer must verify the decoded chunk bytes");
  assert.equal(chunkEvidence?.chunkHashValid && chunkEvidence?.contiguous, true, "recovered chunk must match its hash and contiguous offset");
  phaseResults.lostAckRecovery = { firstStartOutcome: "unknown-after-server-state-commit", recoveryOrder: ["read", "chunk", "finish"], sameOwnerAndUploadIds: true, finalState: "sealed" };

  await pageA.evaluate(profileId => window.__b4.connectSaved(profileId), profile.id);
  const lateStartSize = 300 * 1024;
  const latePrepared = await pageA.evaluate(size => window.__b4.preparePattern("late-scope-ack.bin", size, 53), lateStartSize);
  assert.equal(latePrepared.ok, true, "scope-race row must be locally prepared");
  peer.setHoldNextStart();
  const retentionBeforeScopeRace = peer.retentionRequests().length;
  await pageA.evaluate(id => window.__b4.resumeCapture(id, "scope-late"), latePrepared.id);
  await peer.waitFor("attachment/retention/upload/start", 2);
  await peer.waitHeldStart();
  const scopeIntent = await pageB.evaluate(id => window.__b4.rawInspect(id), latePrepared.id);
  assert.equal(scopeIntent.wireMethod, "attachment/retention/upload/start", "held start must already have a durable intent");
  assert.equal(scopeIntent.blobExists && scopeIntent.blobSize === lateStartSize, true, "held start source must remain durable");
  const rotated = await pageB.evaluate(({ profileId, generation, deviceId, accessToken, rpcToken }) =>
    window.__b4.rotateStoredScope(profileId, generation, deviceId, accessToken, rpcToken), {
    profileId: profile.id,
    generation: "b4-auth-generation-b",
    deviceId: "b4-device-b",
    accessToken: accessTokenB,
    rpcToken: rpcTokenB,
  });
  assert.deepEqual(rotated, { committed: true, generationChanged: true, deviceChanged: true }, "profile metadata must change through the actual cross-page profile-index fence");
  const newScopeRows = await pageB.evaluate(profileId => window.__b4.listCurrentScope(profileId), profile.id);
  assert.deepEqual(newScopeRows, { count: 0, filenames: [] }, "new full scope must not list the old scope's unknown upload row");
  peer.releaseHeldStart();
  const lateAckResult = await waitForPageResult(pageA, "scope-late");
  assert.equal(lateAckResult.ok, false, "old-scope response must not be published after the stored owner changes");
  assert.equal(lateAckResult.errorName, "WorkspaceProfileFenceError", "old response must fail at the real persisted profile fence");
  const lateAfter = await pageA.evaluate(id => window.__b4.rawInspect(id), latePrepared.id);
  assert.equal(lateAfter.rowExists && lateAfter.blobExists, true, "late old-scope response must preserve the original row and bytes");
  assert.equal(lateAfter.scopeGeneration, "b4-auth-generation-a", "late response must not rewrite the source owner scope");
  assert.equal(lateAfter.wireMethod, "attachment/retention/upload/start", "late response must not clear the unconfirmed original wire intent");
  assert.equal(lateAfter.scopeIdPresent, false, "late old-scope response must not bind a remote scope ID to the stale local row");
  assert.equal(lateAfter.confirmedBytes, 0, "late start ACK must not advance old-scope confirmation state");
  assert.equal(peer.retentionRequests().length - retentionBeforeScopeRace, 1, "scope mutation and late response must not trigger retry or a second RPC");
  phaseResults.scopeChangedLateAck = { responseRejected: true, oldRowAndBytesPreserved: true, newScopeVisibleUnresolvedRows: 0, rpcRetryCount: 0 };

  await Promise.all([pageA.evaluate(() => window.__b4.closeClient()), pageB.evaluate(() => window.__b4.closeClient())]);
  await peer.waitForOpenSockets(0);
  assert.equal(peer.openSocketCount(), 0, "all owned GatewayRpcClient sockets must close before the fixture exits");
  assert.deepEqual(pageErrors, [], "B4 browser pages must have no uncaught page errors");
  const rpcSummary = peer.safeSummary();
  await context.writeArtifactJson("b4-two-page-idb-summary.json", {
    evidenceBoundary: "real Chromium same-origin two-page IndexedDB/Web Locks and actual static02 Web product modules; loopback scripted RPC peer only",
    candidateRevision: STATIC_REVISION,
    candidateSourceDigest: pins.candidate.sourceDigest,
    candidateManifestSha256: STATIC_MANIFEST_SHA256,
    sourceSnapshotSha256: INPUTS_JSON_SHA256,
    browserPageCount: 2,
    nodeVersion: process.version,
    chromiumExecutable: chromium.executablePath,
    actualBrowserStorage: "IndexedDB Blob+row transactions and Web Locks",
    serverBoundary: "one owned loopback HTTP origin and scripted WebSocket protocol peer; not Rust/Gateway/Relay/Provider",
    capabilityDeploymentClaimed: false,
    phases: phaseResults,
    rpcSummary,
    ownedSocketsAfterClientsClosed: peer.openSocketCount(),
    uncaughtPageErrorCount: pageErrors.length,
  });
  return {
    status: "PRIVATE_BROWSER_CANDIDATE_EXECUTED_PASSED",
    inputSourceCount: Object.keys(pins.sourceFiles).length,
    phases: Object.keys(phaseResults),
    loopbackRpcFrames: rpcSummary.length,
  };
});
