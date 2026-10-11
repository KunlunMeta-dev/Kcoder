// Model-independent browser integration for the Mobile V2 workspace receipt
// consumer. Two pages share a real Chromium origin, Web Locks, localStorage,
// and AsyncStorage's installed Web implementation. A loopback ws.Server
// implements only the Gateway RPC frames used by this review; it is not a
// product Gateway or Rust backend.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { startChromium } from "../../harness/chromium.mjs";
import { appRoot, repoRoot, runE2E } from "../../harness/run-context.mjs";

const requireFromMobile = createRequire(resolve(appRoot, "mobile/package.json"));
const { build } = requireFromMobile("esbuild");
// ws 7 exposes the server as `Server`; WebSocketServer is the v8+ named export.
const WebSocketServer = requireFromMobile("ws").Server;

const candidateRootInput = process.env.PHONE_WORKSPACE_FENCE_CANDIDATE_ROOT;
const candidateDigest = process.env.PHONE_WORKSPACE_FENCE_CANDIDATE_DIGEST;
const candidateCount = Number(process.env.PHONE_WORKSPACE_FENCE_CANDIDATE_COUNT ?? 0);
const candidateManifestSha256 = process.env.PHONE_WORKSPACE_FENCE_CANDIDATE_MANIFEST_SHA256;
const V2_SCOPE = "runtime.workspaces.operation/scopeV2";
const V2_READ = "runtime.workspaces.operation/readV2";
const V2_OPEN = "runtime.workspaces.openV2";

const requiredCandidateFiles = [
  "apps/kcoder-studio/mobile/src/gateway/rpc.ts",
  "apps/kcoder-studio/mobile/src/protocol/workspace-operation-receipts-v2.ts",
  "apps/kcoder-studio/mobile/src/storage/pending-workspace-operation-v2.ts",
  "apps/kcoder-studio/mobile/src/storage/pending-workspace-operation.ts",
  "apps/kcoder-studio/mobile/src/state/profile-coordinator.ts",
  "apps/kcoder-studio/mobile/src/state/remove-gateway-profile.ts",
];

const candidatePin = {
  relativeRoot: "target/workspace-receipts-v2-foundation-20261008/mobile-family-fresh-static-04",
  sourceDigest: "201b0ad8eb9980ec84c0f8482f9748f62a31fd5d1b690d8c5f788e3f87fabc1e",
  manifestSha256: "911bdc44015b71b473fe6c50bbf12f2db5f1b3e90c1cb109fb2cd4becdf29f30",
  fileCount: 14,
  changedCount: 9,
};

// Unchanged support modules are still exact inputs. If a later candidate
// includes one of these files, its candidate manifest entry takes precedence.
const pinnedSupportInputs = {
  "apps/kcoder-studio/mobile/src/storage/workspace-profile-fence.ts": "58c461e9272cfd7380b5bf0938b422812af3e6135a306a5791e187c6714e2ca0",
  "apps/kcoder-studio/mobile/src/storage/context-lock.ts": "ae31282aef0cacb618303086b2d3f6f7790857db8022c92ee3c2a60a0a0d7163",
  "apps/kcoder-studio/mobile/src/storage/profile-store.ts": "45b8eb54d5de2b36cb6580056cf972db73611156b05915a12017bb6151f2c413",
  "apps/kcoder-studio/mobile/src/storage/secure.ts": "f396c1b36594b8e6e2fe84ad775fa816d748d6e6e19ea095a0b2e519bfde04b6",
  "apps/kcoder-studio/mobile/src/storage/profile-state-removal.ts": "8705ccae24e58a4638df652678c8584619dacf34380cbae69cd01ca6e4eee5dd",
  "apps/kcoder-studio/mobile/src/storage/pending-thread-creation.ts": "becd59941dcfebca27d1bf518cb1cf39be9a34677981e00cb921dd56df0e864c",
  "apps/kcoder-studio/mobile/src/state/profile-removal-effects.ts": "e2135d63fab83f7f7eb3f2a2b87d14ba4db2cfb484171f7d57d7e2a844afface",
  "apps/kcoder-studio/shared/gatewayConnectionBudget.ts": "00384ebd57aa88952ae877a50850225d112d19a8167171b2a64a47b31e080bf2",
  "apps/kcoder-studio/shared/gatewayRequestDeadline.js": "04bf06e144fb2f430d5b7ace78d8e7157b7a8f3308a6dfc77d859c007c6d95b2",
  "apps/kcoder-studio/mobile/src/runtime/task-runtime/connectionFactory.ts": "9134e0834aed695a5e40efe8cb6ffbc3400049a6a34454f9c3ed2cb8530a5d13",
  "apps/kcoder-studio/mobile/src/runtime/scoped-read-cache.ts": "928ff3c377b3e32f6a3d408c10565bfde9b3bbaf93987f9a5562524e870089eb",
  "apps/kcoder-studio/mobile/src/runtime/task-runtime/normalizers.ts": "2f12ee72dc4263c15aab273f04dd4578ee80e5f461150562873c2aa6f6e5f61b",
  "apps/kcoder-studio/mobile/src/protocol/normalizers.ts": "9bcaa29541cda864d41c88386eedb9db7fa48a8d8b7615b64a727945fead0d09",
  "apps/kcoder-studio/shared/turnMessageStatus.ts": "5be3188fd7e00a20897ccdb00ee8d308cdf0467152ccc31cbcf5c299feaac429",
  "apps/kcoder-studio/shared/toolCallStatus.ts": "f99fc7b362e88e84144d2183f69089c0013c4d8c47417156506784a43bbfa1ff",
  "apps/kcoder-studio/shared/providerFailure.ts": "4c109bc7fcab554a677136d055bcb1637d91a85d46065c903153f3c08e1b37ff",
  "apps/kcoder-studio/shared/generated/contracts.ts": "406728bde4f9636b266ebaf1391e7ca72883a80da95e65348836be1c1cd09678",
  "apps/kcoder-studio/shared/generated/validator.mjs": "52ed715826cd2552bf405dcae0dbe44287ce8c9b1c75c7fce7b7461f94e04be3",
};

const asyncStoragePackagePin = {
  version: "2.2.0",
  packageSha256: "6346a7c16602136ed46fc0aadd02c388ab160540dc32c1c5ad877d7152750d30",
  webImplementationSha256: "3b8afc3e15d9a4bdd5fd08e43ede4ff8252311681286fc440a7fdb1fd1cf7766",
};

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function toPosix(value) {
  return value.split(sep).join("/");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => [key, canonicalJson(item)]));
  }
  return value;
}

function digestRpcParams(method, params) {
  return sha256(JSON.stringify([method, canonicalJson(params)]));
}

async function hashFile(path) {
  return sha256(await readFile(path));
}

async function readCandidateManifest(candidateRoot) {
  const manifestPath = join(candidateRoot, "manifest.json");
  const manifestStat = await lstat(manifestPath);
  check(manifestStat.isFile() && !manifestStat.isSymbolicLink() && await realpath(manifestPath) === manifestPath, "candidate manifest must be a canonical regular file");
  const raw = await readFile(manifestPath);
  const manifest = JSON.parse(raw.toString("utf8"));
  check(Array.isArray(manifest.files), "candidate diff manifest must enumerate source files");
  const hashes = Object.fromEntries(manifest.files.map(file => [file.path, file.sha256]));
  check(Object.keys(hashes).length === manifest.files.length, "candidate manifest has duplicate file paths");
  return { sourceDigest: manifest.sourceDigest, count: manifest.count, changedCount: manifest.changedCount, files: manifest.files, hashes, manifestSha256: sha256(raw), status: manifest.status ?? null };
}

async function verifyCandidate(context) {
  check(typeof candidateRootInput === "string" && isAbsolute(candidateRootInput), "set PHONE_WORKSPACE_FENCE_CANDIDATE_ROOT to an absolute frozen source path");
  check(/^[a-f0-9]{64}$/.test(candidateDigest ?? ""), "set PHONE_WORKSPACE_FENCE_CANDIDATE_DIGEST to the frozen source digest");
  check(Number.isInteger(candidateCount) && candidateCount > 0, "set PHONE_WORKSPACE_FENCE_CANDIDATE_COUNT to the frozen file count");
  check(/^[a-f0-9]{64}$/.test(candidateManifestSha256 ?? ""), "set PHONE_WORKSPACE_FENCE_CANDIDATE_MANIFEST_SHA256 to the exact diff manifest hash");
  const candidateRoot = resolve(candidateRootInput);
  check(candidateRoot === resolve(repoRoot, candidatePin.relativeRoot), "candidate root differs from the pinned static-04 source location");
  const candidateStat = await lstat(candidateRoot);
  check(candidateStat.isDirectory() && !candidateStat.isSymbolicLink(), "candidate root must be a real directory, not a symlink");
  check(await realpath(candidateRoot) === candidateRoot, "candidate root must be canonical");
  const manifest = await readCandidateManifest(candidateRoot);
  check(manifest.status === "STATIC_ONLY_NOT_TESTED", "candidate is not an explicitly static-only diff manifest");
  check(candidateDigest === candidatePin.sourceDigest && candidateCount === candidatePin.fileCount && candidateManifestSha256 === candidatePin.manifestSha256,
    "explicit candidate environment pins differ from reviewed static-04 pins");
  check(manifest.manifestSha256 === candidateManifestSha256, "candidate manifest hash does not match the explicit pin");
  check(manifest.sourceDigest === candidateDigest && manifest.count === candidateCount, "candidate digest/count do not match the explicit pins");
  check(manifest.changedCount === candidatePin.changedCount, "candidate changed-file count differs from the reviewed static-04 manifest");
  const entries = Object.entries(manifest.hashes ?? {});
  check(entries.length === candidateCount, "candidate hash manifest count mismatch");
  for (const [relativePath, expected] of entries) {
    check(typeof relativePath === "string" && !isAbsolute(relativePath) && !relativePath.split(/[\\/]+/).includes(".."), "candidate manifest contains an unsafe path");
    const path = resolve(repoRoot, relativePath);
    check(path.startsWith(repoRoot + sep), "candidate source path escaped the integration worktree");
    const stat = await lstat(path);
    check(stat.isFile() && !stat.isSymbolicLink() && await realpath(path) === path, `candidate source is not a canonical regular file: ${relativePath}`);
    check(stat.size === manifest.files.find(file => file.path === relativePath)?.bytes, `candidate source size mismatch: ${relativePath}`);
    check(await hashFile(path) === expected, `integration source does not match static candidate: ${relativePath}`);
  }
  for (const relativePath of requiredCandidateFiles) {
    check(Object.hasOwn(manifest.hashes, relativePath), `candidate is missing required Mobile input ${relativePath}`);
  }
  await context.writeArtifactJson("candidate-source-verification.json", {
    candidateDigest,
    candidateManifestSha256,
    candidateRoot,
    candidateFileCount: candidateCount,
    sourceMode: "integration-worktree-files-matched-to-static-diff-manifest; no copied full source tree claimed",
    manifestStatus: manifest.status,
    changedFileCount: manifest.changedCount,
    requiredProductInputs: requiredCandidateFiles,
    verifiedCandidateInputCount: entries.length,
  });
  return { candidateRoot, manifest, candidateHashes: manifest.hashes, candidateManifestSha256 };
}

async function verifyAsyncStoragePin() {
  const packagePath = resolve(appRoot, "mobile/node_modules/@react-native-async-storage/async-storage/package.json");
  const implementationPath = resolve(appRoot, "mobile/node_modules/@react-native-async-storage/async-storage/lib/module/AsyncStorage.js");
  const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
  check(packageJson.version === asyncStoragePackagePin.version, "installed AsyncStorage package version changed");
  check(await hashFile(packagePath) === asyncStoragePackagePin.packageSha256, "installed AsyncStorage package metadata changed");
  check(await hashFile(implementationPath) === asyncStoragePackagePin.webImplementationSha256, "installed AsyncStorage Web implementation changed");
  const mergePackagePath = resolve(appRoot, "mobile/node_modules/merge-options/package.json");
  const mergeImplementationPath = resolve(appRoot, "mobile/node_modules/merge-options/index.js");
  const mergePackage = JSON.parse(await readFile(mergePackagePath, "utf8"));
  check(mergePackage.version === "3.0.4", "installed AsyncStorage merge dependency version changed");
  check(await hashFile(mergePackagePath) === "547dad7ef7ef15cb23256d1ee855e4b1ba95ceef55d33ec35f24e0c5dcbd8196", "installed AsyncStorage merge dependency metadata changed");
  check(await hashFile(mergeImplementationPath) === "4de9094c06f4baf4878a91e4488d63943ec124ab1a08f02619ef5b99b0ec95c3", "installed AsyncStorage merge dependency implementation changed");
  return { packagePath, implementationPath, mergePackagePath, mergeImplementationPath, version: packageJson.version, mergeVersion: mergePackage.version };
}

function possibleLogicalFiles(repositoryRelativePath) {
  const extension = ["", ".ts", ".tsx", ".js", ".jsx", ".json"];
  return extension.map(suffix => `${repositoryRelativePath}${suffix}`);
}

async function buildReviewBundle(context, candidate) {
  const sourceAudit = new Map();
  async function sourcePath(repositoryRelativePath) {
    const candidates = possibleLogicalFiles(repositoryRelativePath);
    for (const logical of candidates) {
      const candidateHash = candidate.candidateHashes[logical];
      if (candidateHash) {
        const matchedPath = resolve(repoRoot, logical);
        check(await hashFile(matchedPath) === candidateHash, `static candidate module changed while resolving: ${logical}`);
        sourceAudit.set(logical, {sha256: candidateHash, source: "integration-source-matched-to-static-diff"});
        return matchedPath;
      }
      const supportHash = pinnedSupportInputs[logical];
      if (!supportHash) continue;
      const livePath = resolve(repoRoot, logical);
      check(await hashFile(livePath) === supportHash, `unpinned support input changed: ${logical}`);
      sourceAudit.set(logical, {sha256: supportHash, source: "pinned-support"});
      return livePath;
    }
    throw new Error(`no frozen or pinned support source for ${repositoryRelativePath}`);
  }

  const productPaths = {
    rpc: await sourcePath("apps/kcoder-studio/mobile/src/gateway/rpc.ts"),
    protocol: await sourcePath("apps/kcoder-studio/mobile/src/protocol/workspace-operation-receipts-v2.ts"),
    operationV1: await sourcePath("apps/kcoder-studio/mobile/src/storage/pending-workspace-operation.ts"),
    operationV2: await sourcePath("apps/kcoder-studio/mobile/src/storage/pending-workspace-operation-v2.ts"),
    fence: await sourcePath("apps/kcoder-studio/mobile/src/storage/workspace-profile-fence.ts"),
    profileStore: await sourcePath("apps/kcoder-studio/mobile/src/storage/profile-store.ts"),
    profileCoordinator: await sourcePath("apps/kcoder-studio/mobile/src/state/profile-coordinator.ts"),
    removeProfile: await sourcePath("apps/kcoder-studio/mobile/src/state/remove-gateway-profile.ts"),
    profileRemovalEffects: await sourcePath("apps/kcoder-studio/mobile/src/state/profile-removal-effects.ts"),
    contextLock: await sourcePath("apps/kcoder-studio/mobile/src/storage/context-lock.ts"),
  };
  const entry = context.pathInState("workspace-profile-fence-review-entry.ts");
  const entrySource = `
import { GatewayRpcClient } from ${JSON.stringify(productPaths.rpc)};
import { WORKSPACE_RECEIPTS_V2, WORKSPACE_SCOPE_V2, WORKSPACE_READ_V2, workspaceScopeV2 } from ${JSON.stringify(productPaths.protocol)};
import { recoverableWorkspaceOperationV2, pendingWorkspaceOperationPrefixV2 } from ${JSON.stringify(productPaths.operationV2)};
import { loadConfirmedWorkspaceOperationReceipt, acknowledgeConfirmedWorkspaceOperation } from ${JSON.stringify(productPaths.operationV1)};
import { captureWorkspaceProfileIdentity, startWorkspaceProfileRpc } from ${JSON.stringify(productPaths.fence)};
import { loadProfiles, persistProfiles, PROFILE_INDEX_KEY } from ${JSON.stringify(productPaths.profileStore)};
import { ProfileCoordinator } from ${JSON.stringify(productPaths.profileCoordinator)};
import { removeGatewayProfile } from ${JSON.stringify(productPaths.removeProfile)};
import { withLocalIdentityLock } from ${JSON.stringify(productPaths.contextLock)};
import AsyncStorage from "@react-native-async-storage/async-storage/lib/module/AsyncStorage";

const PROFILE_ID = "review-profile-primary";
const SERVER = { id: "target-review-fixture", label: "Review target", description: "loopback fixture", runtime: "kcoder", transport: "local", workspacePath: "/workspace/review" };
const receipts = new Map();
let coordinator;
function profileView(profile) {
  return profile ? { id: profile.id, baseUrl: profile.baseUrl, deviceId: profile.deviceId, authorizationGeneration: profile.authorizationGeneration, authMode: profile.authMode } : null;
}
function createCoordinator() {
  return new ProfileCoordinator({
    reload: loadProfiles,
    serialize: operation => withLocalIdentityLock("gateway-profile-index", async () => operation()),
  });
}
async function activeCoordinator() {
  if (!coordinator) {
    coordinator = createCoordinator();
    coordinator.hydrate(await loadProfiles());
  }
  return coordinator;
}
async function primaryProfile() {
  const snapshot = await loadProfiles();
  return snapshot.profiles.find(profile => profile.id === PROFILE_ID) ?? null;
}
function serializeProfileFixtures(baseUrl) {
  const primary = {
    id: PROFILE_ID, label: "Review primary", baseUrl, authMode: "device",
    deviceId: "review-device-generation-a", authorizationGeneration: "review-auth-generation-a",
    accessToken: "review-access-a", rpcToken: "review-rpc-a", refreshToken: "a".repeat(64),
    expiresAt: Date.now() + 120000, refreshExpiresAt: Date.now() + 3600000, accessTtlMs: 120000,
  };
  const alternate = {
    id: "review-profile-alternate", label: "Review alternate", baseUrl: baseUrl.replace("/g/review", "/g/alternate"),
    authMode: "legacy", accessToken: "review-access-alt", rpcToken: "review-rpc-alt", expiresAt: Date.now() + 120000,
  };
  return [primary, alternate];
}
async function seed(baseUrl) {
  const profiles = serializeProfileFixtures(baseUrl);
  await persistProfiles(profiles, PROFILE_ID);
  coordinator = createCoordinator();
  coordinator.hydrate(await loadProfiles());
  return { profileCount: profiles.length, primaryIdPresent: true, storageKeyPresent: Boolean(localStorage.getItem(PROFILE_INDEX_KEY)) };
}
async function openWorkspace(path, intent = path) {
  const profile = await primaryProfile();
  if (!profile) throw new Error("fixture profile missing");
  const client = await GatewayRpcClient.connect(profile, SERVER, SERVER.workspacePath);
  try {
    if (client.supportsExperimental(WORKSPACE_RECEIPTS_V2) !== true) throw new Error("fixture RPC did not negotiate V2");
    const authorization = captureWorkspaceProfileIdentity(profile);
    const started = await startWorkspaceProfileRpc(authorization, () => client.request(WORKSPACE_SCOPE_V2, {}));
    const scope = workspaceScopeV2(await started.response);
    const completed = await recoverableWorkspaceOperationV2({
      profile, server: SERVER, scope, path, kind: "open", intent,
      phases: () => [{ method: "runtime.workspaces.openV2", params: { workspacePath: path, label: "Review workspace" } }],
      request: (method, params, timeoutMs) => client.request(method, params, timeoutMs),
    });
    receipts.set(completed.receipt.id, completed.receipt);
    return { path: completed.path, receiptId: completed.receipt.id, completedAtPresent: completed.receipt.completedAt > 0 };
  } finally {
    client.close();
  }
}
async function activate(id) {
  const current = await activeCoordinator();
  const snapshot = await current.activate(id, persistProfiles);
  const durable = await loadProfiles();
  return { activeId: snapshot.activeId, storedActiveId: durable.activeId };
}
async function replaceGeneration() {
  const current = await activeCoordinator();
  await current.synchronize();
  const before = current.getSnapshot().profiles.find(item => item.id === PROFILE_ID);
  if (!before) throw new Error("primary profile disappeared before replacement");
  const next = {
    ...before, label: "Review primary replaced",
    deviceId: "review-device-generation-b", authorizationGeneration: "review-auth-generation-b",
    accessToken: "review-access-b", rpcToken: "review-rpc-b", refreshToken: "b".repeat(64),
    expiresAt: Date.now() + 120000, refreshExpiresAt: Date.now() + 3600000,
  };
  const intent = current.beginConnection();
  const result = await current.commitConnection(intent, next, persistProfiles);
  const after = result.snapshot.profiles.find(item => item.id === PROFILE_ID);
  return { committed: result.committed, sameProfileId: after?.id === PROFILE_ID, before: profileView(before), after: profileView(after) };
}
async function loadReceipt(receiptId, sourcePath, expectedResult) {
  const profile = await primaryProfile();
  if (!profile) throw new Error("fixture profile missing during receipt load");
  const receipt = await loadConfirmedWorkspaceOperationReceipt(profile, SERVER,
    { version: 2, receiptId, kind: "open", sourcePath }, expectedResult);
  if (receipt) receipts.set(receiptId, receipt);
  return { found: Boolean(receipt), consumed: receipt?.consumed === true };
}
async function acknowledgeReceipt(receiptId) {
  const receipt = receipts.get(receiptId);
  if (!receipt) throw new Error("receipt was not loaded in this page realm");
  const profile = await primaryProfile();
  if (!profile) throw new Error("fixture profile missing during acknowledge");
  const outcome = await acknowledgeConfirmedWorkspaceOperation(receipt, { profile, server: SERVER });
  return { outcome };
}
async function removePrimary() {
  const current = await activeCoordinator();
  try {
    const result = await removeGatewayProfile(PROFILE_ID, {
      coordinator: current,
      persist: persistProfiles,
      cleanupProfileState: async () => {},
      revokeSession: async () => {},
      effects: {
        setProfiles() {}, setActiveId() {}, removeProfileRuntimes() {}, clearRuntime() {},
        markProfileStateRemoval() { return 1; },
      },
    });
    return { rejected: false, removed: result.removed };
  } catch (error) {
    return { rejected: true, errorName: error instanceof Error ? error.name : "UnknownError" };
  }
}
async function operationSnapshot() {
  const prefix = pendingWorkspaceOperationPrefixV2(PROFILE_ID);
  const rows = [];
  for (const key of await AsyncStorage.getAllKeys()) {
    if (!key.startsWith(prefix)) continue;
    const raw = await AsyncStorage.getItem(key);
    if (!raw) continue;
    const record = JSON.parse(raw);
    rows.push({
      consumed: record.consumed === true,
      resultPresent: typeof record.result === "string",
      generation: record.authorization?.authorizationGeneration ?? null,
      dispatchedPhaseCount: Array.isArray(record.phases) ? record.phases.filter(phase => phase.dispatched === true).length : 0,
    });
  }
  return rows;
}
async function profileSnapshot() {
  const value = await loadProfiles();
  return { activeId: value.activeId, profiles: value.profiles.map(profileView) };
}
async function webPrerequisites() {
  return {
    origin: location.origin,
    webLocks: typeof navigator.locks?.request === "function",
    localStorageAvailable: typeof localStorage?.getItem === "function",
  };
}
globalThis.__workspaceProfileFenceReview = {
  seed, openWorkspace, activate, replaceGeneration, loadReceipt, acknowledgeReceipt,
  removePrimary, operationSnapshot, profileSnapshot, webPrerequisites,
};
`;
  await writeFile(entry, entrySource, { mode: 0o600 });
  const buildResult = await build({
    entryPoints: [entry], bundle: true, write: false, platform: "browser", format: "iife", target: ["es2022"],
    nodePaths: [resolve(appRoot, "mobile/node_modules")],
    metafile: true,
    tsconfigRaw: { compilerOptions: {} },
    plugins: [{
      name: "pinned-mobile-review-inputs",
      setup(esbuild) {
        esbuild.onResolve({ filter: /^react-native$/ }, () => ({ path: "react-native-review", namespace: "workspace-review-stub" }));
        esbuild.onResolve({ filter: /^@\/gateway\/http$/ }, () => ({ path: "gateway-http-review", namespace: "workspace-review-stub" }));
        esbuild.onResolve({ filter: /^\.\/?http$/ }, args => {
          if (args.importer.replaceAll("\\", "/").endsWith("/gateway/rpc.ts") || args.importer.replaceAll("\\", "/").endsWith("/state/remove-gateway-profile.ts"))
            return { path: "gateway-http-review", namespace: "workspace-review-stub" };
          return undefined;
        });
        esbuild.onResolve({ filter: /^@\// }, async args => {
          const logical = `apps/kcoder-studio/mobile/src/${args.path.slice(2)}`;
          return { path: await sourcePath(logical) };
        });
        esbuild.onResolve({ filter: /^\.\.?\// }, async args => {
          const importer = resolve(args.importer);
          const liveRelative = relative(repoRoot, importer);
          if (liveRelative === ".." || liveRelative.startsWith(`..${sep}`) || isAbsolute(liveRelative)) return undefined;
          const importerLogical = toPosix(liveRelative);
          const logical = toPosix(normalize(join(dirname(importerLogical), args.path)));
          if (logical === "apps/kcoder-studio/mobile/src/gateway/http.ts" || logical === "apps/kcoder-studio/mobile/src/gateway/http")
            return { path: "gateway-http-review", namespace: "workspace-review-stub" };
          return { path: await sourcePath(logical) };
        });
        esbuild.onLoad({ filter: /.*/, namespace: "workspace-review-stub" }, args => ({
          loader: "js",
          contents: args.path === "react-native-review"
            ? 'export const Platform={OS:"web",select:value=>value.web??value.default??value};'
            : 'export async function ensureGatewayAuthorization(){return;} export class GatewaySessionExpiredError extends Error { constructor(){super("fixture session expired");this.name="GatewaySessionExpiredError";} }',
        }));
      },
    }],
  });
  const usedInputs = Object.keys(buildResult.metafile.inputs).map(value => value.replaceAll("\\", "/"));
  check(usedInputs.some(value => value.endsWith("storage/pending-workspace-operation-v2.ts")), "test bundle did not include the actual V2 storage consumer");
  check(usedInputs.some(value => value.endsWith("storage/workspace-profile-fence.ts")), "test bundle did not include the actual workspace profile fence");
  const dependency = await verifyAsyncStoragePin();
  const sourceEntries = [...sourceAudit.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([path, info]) => ({ path, ...info }));
  const output = buildResult.outputFiles[0].text;
  return {
    bundle: output,
    sourceEntries,
    dependency,
    bundleSha256: sha256(output),
    buildInputs: usedInputs.map(value => {
      const normalized = value.startsWith("..") ? value : toPosix(relative(repoRoot, resolve(value)));
      return normalized;
    }).sort(),
  };
}

function deferred() {
  let resolvePromise;
  let rejectPromise;
  const promise = new Promise((resolve, reject) => { resolvePromise = resolve; rejectPromise = reject; });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function safeScope(generation) {
  return {
    version: 2,
    rootId: sha256("review-root"),
    scopeId: sha256(`review-account-scope-${generation}`),
    familyId: sha256("review-verified-private-namespace:target-review-fixture"),
  };
}

async function startLoopbackFixture(context, bundle) {
  const http = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (pathname === "/review/") {
      const body = '<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><title>workspace profile fence review</title><script src="/review.js"></script>';
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-length": Buffer.byteLength(body) });
      response.end(body);
      return;
    }
    if (pathname === "/review.js") {
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store", "content-length": Buffer.byteLength(bundle) });
      response.end(bundle);
      return;
    }
    response.writeHead(404, { "cache-control": "no-store" });
    response.end();
  });
  await new Promise((resolvePromise, rejectPromise) => {
    http.once("error", rejectPromise);
    http.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = http.address();
  check(address && typeof address === "object", "loopback fixture did not bind an ephemeral port");
  context.registerPort("workspace-profile-review-http-ws", address.port);

  const wss = new WebSocketServer({ noServer: true });
  http.on("upgrade", (request, socket, head) => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (pathname !== "/g/review/rpc") { socket.destroy(); return; }
    wss.handleUpgrade(request, socket, head, webSocket => wss.emit("connection", webSocket, request));
  });
  const requests = [];
  const holdQueues = new Map();
  const pendingHolds = new Set();
  const remoteReceipts = new Map();
  let connectionCount = 0;
  let responseCount = 0;
  let closed = false;
  const scopeByToken = new Map([
    ["review-rpc-a", safeScope("a")],
    ["review-rpc-b", safeScope("b")],
    ["review-rpc-alt", safeScope("alternate")],
  ]);

  function writeFrame(socket, frame) {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame));
  }
  function responseFor(frame, scope) {
    const method = frame.method;
    const params = frame.params ?? {};
    if (method === "initialize") return { jsonrpc: "2.0", id: frame.id, result: {
      protocolVersion: "2026-07-27",
      capabilities: { experimental: { workspaceOperationReceiptsV2: true } },
    } };
    if (method === V2_SCOPE) return { jsonrpc: "2.0", id: frame.id, result: scope };
    if (method === V2_READ) {
      const id = String(params.clientRequestId ?? "");
      return { jsonrpc: "2.0", id: frame.id, result: remoteReceipts.get(id) ?? { scope, receipt: null } };
    }
    if (method === V2_OPEN) {
      const requestId = String(params.clientRequestId ?? "");
      const workspacePath = typeof params.workspacePath === "string" ? params.workspacePath : "/workspace/review";
      const paramsDigest = digestRpcParams(method, params);
      const receipt = { clientRequestId: requestId, method, paramsDigest, status: "ready", workspacePath };
      const result = { scope, receipt, result: { workspacePath } };
      remoteReceipts.set(requestId, { scope, receipt });
      return { jsonrpc: "2.0", id: frame.id, result };
    }
    return { jsonrpc: "2.0", id: frame.id, error: { code: -32601, message: "review fixture method not found" } };
  }
  wss.on("connection", (socket, request) => {
    connectionCount += 1;
    const parsed = new URL(request.url ?? "/", "http://127.0.0.1");
    // The token is used only to select an in-memory synthetic scope. It is never
    // copied to requests, diagnostics, artifacts, or process arguments.
    const token = parsed.searchParams.get("token") ?? "";
    const scope = scopeByToken.get(token) ?? safeScope("unknown");
    socket.on("message", raw => {
      let frame;
      try { frame = JSON.parse(String(raw)); } catch { return; }
      if (frame.method === "initialized") return;
      if (typeof frame.method !== "string" || frame.id === undefined) return;
      const requestRecord = { method: frame.method, requestId: String(frame.id), hasParams: Boolean(frame.params && typeof frame.params === "object") };
      requests.push(requestRecord);
      const response = responseFor(frame, scope);
      const queue = holdQueues.get(frame.method) ?? [];
      const hold = queue.shift();
      if (!queue.length) holdQueues.delete(frame.method);
      if (hold) {
        hold.frame = response;
        hold.socket = socket;
        pendingHolds.add(hold);
        hold.release.resolve({ method: frame.method, requestId: String(frame.id) });
        return;
      }
      responseCount += 1;
      writeFrame(socket, response);
    });
  });

  function holdNext(method) {
    const release = deferred();
    const held = { frame: null, socket: null, responded: false, release };
    const queue = holdQueues.get(method) ?? [];
    queue.push(held);
    holdQueues.set(method, queue);
    return {
      entered: release.promise,
      get responded() { return held.responded; },
      respond() {
        check(held.frame && held.socket, `no held ${method} response is available`);
        check(!held.responded, `held ${method} response already released`);
        held.responded = true;
        pendingHolds.delete(held);
        responseCount += 1;
        writeFrame(held.socket, held.frame);
      },
    };
  }
  async function close() {
    if (closed) return;
    closed = true;
    for (const held of pendingHolds) {
      if (held.responded || !held.frame || !held.socket) continue;
      held.responded = true;
      responseCount += 1;
      writeFrame(held.socket, held.frame);
    }
    pendingHolds.clear();
    holdQueues.clear();
    for (const client of wss.clients) client.close(1000, "review fixture cleanup");
    await new Promise(resolvePromise => wss.close(() => resolvePromise()));
    await new Promise(resolvePromise => http.close(() => resolvePromise()));
  }
  context.addCleanup("close loopback workspace WebSocket fixture", close);
  return {
    origin: `http://127.0.0.1:${address.port}`,
    primaryBaseUrl: `http://127.0.0.1:${address.port}/g/review`,
    holdNext,
    get safeSummary() {
      const methods = {};
      for (const request of requests) methods[request.method] = (methods[request.method] ?? 0) + 1;
      return { connectionCount, responseCount, methods };
    },
    close,
  };
}

async function pageBridge(page, method, ...args) {
  return page.evaluate(async ({ methodName, argumentsList }) => {
    const bridge = globalThis.__workspaceProfileFenceReview;
    if (!bridge || typeof bridge[methodName] !== "function") throw new Error(`review bridge method unavailable: ${methodName}`);
    return bridge[methodName](...argumentsList);
  }, { methodName: method, argumentsList: args });
}

async function within(promise, milliseconds, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

await runE2E(import.meta.url, {
  testId: "mobile-v2-workspace-profile-fence-real-web-locks-two-pages",
  tier: "full-integration",
  modelPolicy: "no model or Provider; two same-origin Chromium pages, actual Mobile storage/fence modules, loopback scripted Gateway WebSocket only",
  retainSuccessLogs: true,
  bodyAbortTimeoutMs: 5000,
}, async context => {
  let failure;
  let browser;
  let pageA;
  let pageB;
  let fixture;
  let result = {
    candidateDigest,
    candidateCount,
    candidateManifestSha256,
    classification: "NOT_RUN",
    webLocks: false,
    sameOriginPages: false,
    scenarios: [],
    cleanup: { pagesClosed: false, chromiumClosed: false, fixtureClosed: false },
  };
  const secrets = [
    "review-access-a", "review-access-b", "review-access-alt", "review-rpc-a", "review-rpc-b", "review-rpc-alt",
    "a".repeat(64), "b".repeat(64),
  ];
  for (const secret of secrets) context.registerSecret(secret);
  try {
    const candidate = await verifyCandidate(context);
    const bundle = await buildReviewBundle(context, candidate);
    fixture = await startLoopbackFixture(context, bundle.bundle);
    await context.writeArtifactJson("module-load-provenance.json", {
      candidateDigest,
      candidateCount,
      candidateManifestSha256,
      sourceEntries: bundle.sourceEntries,
      asyncStorage: {
        version: bundle.dependency.version,
        webImplementationSha256: asyncStoragePackagePin.webImplementationSha256,
        mergeOptionsVersion: bundle.dependency.mergeVersion,
      },
      bundleSha256: bundle.bundleSha256,
      buildInputCount: bundle.buildInputs.length,
      buildInputs: bundle.buildInputs,
      mockGateway: "loopback ws.Server; protocol frames only; no product Gateway/Relay/Provider",
    });

    browser = await startChromium(context, { label: "workspace-profile-fence-web-chromium", noSandbox: true });
    const browserContext = browser.browser.contexts()[0];
    assert.ok(browserContext, "startChromium must provide its owned default browser context");
    pageA = await browserContext.newPage();
    pageB = await browserContext.newPage();
    await pageA.setViewportSize({ width: 390, height: 844 });
    await pageB.setViewportSize({ width: 390, height: 844 });
    await Promise.all([pageA.goto(`${fixture.origin}/review/`, { waitUntil: "domcontentloaded" }), pageB.goto(`${fixture.origin}/review/`, { waitUntil: "domcontentloaded" })]);
    const [prereqA, prereqB] = await Promise.all([pageBridge(pageA, "webPrerequisites"), pageBridge(pageB, "webPrerequisites")]);
    assert.equal(prereqA.origin, prereqB.origin, "both pages must share one exact origin");
    assert.equal(prereqA.webLocks, true, "Chromium must expose the real Web Locks API");
    assert.equal(prereqB.webLocks, true);
    assert.equal(prereqA.localStorageAvailable, true);
    result.webLocks = true;
    result.sameOriginPages = true;
    const seed = await pageBridge(pageA, "seed", fixture.primaryBaseUrl);
    assert.deepEqual(seed, { profileCount: 2, primaryIdPresent: true, storageKeyPresent: true });
    await pageBridge(pageB, "profileSnapshot"); // Force the second page to read the same real Web AsyncStorage index.

    // First create a durable completed operation that a following attempt must
    // read under the same stable operation ID.
    const firstOpen = await pageBridge(pageA, "openWorkspace", "/workspace/held-read", "intent-held-read");
    assert.equal(firstOpen.path, "/workspace/held-read");
    assert.equal(firstOpen.completedAtPresent, true);

    // Hold the actual scopeV2 response, then the actual readV2 response. In each
    // interval page B commits a real active-profile change through its own
    // ProfileCoordinator and the shared browser's real gateway-profile-index
    // Web Lock. No response is released until the other page's commit completes.
    const scopeHold = fixture.holdNext(V2_SCOPE);
    const heldReadOperation = pageBridge(pageA, "openWorkspace", "/workspace/held-read", "intent-held-read");
    await scopeHold.entered;
    assert.equal(scopeHold.responded, false);
    const activateAlternate = await pageBridge(pageB, "activate", "review-profile-alternate");
    assert.equal(activateAlternate.storedActiveId, "review-profile-alternate", "another tab must commit through the shared lock while scope response is held");
    const readHold = fixture.holdNext(V2_READ);
    scopeHold.respond();
    await readHold.entered;
    assert.equal(readHold.responded, false);
    const activatePrimary = await pageBridge(pageB, "activate", "review-profile-primary");
    assert.equal(activatePrimary.storedActiveId, "review-profile-primary", "another tab must commit through the shared lock while read response is held");
    readHold.respond();
    const recovered = await heldReadOperation;
    assert.equal(recovered.path, "/workspace/held-read");
    assert.equal(recovered.receiptId, firstOpen.receiptId, "recovery must preserve the original operation ID");
    result.scenarios.push({ id: "scope-and-read-responses-release-index-lock", status: "PASS", receiptIdStable: true });
    const firstHandle = await pageBridge(pageA, "loadReceipt", firstOpen.receiptId, "/workspace/held-read", firstOpen.path);
    assert.equal(firstHandle.found, true);
    assert.deepEqual(await pageBridge(pageA, "acknowledgeReceipt", firstOpen.receiptId), { outcome: "consumed" });

    // A mutation whose response is withheld must already have a durable
    // dispatched record. Removal from page B must reject without awaiting that
    // response; after its release page A can finish the same operation.
    const mutationHold = fixture.holdNext(V2_OPEN);
    const pendingMutation = pageBridge(pageA, "openWorkspace", "/workspace/held-mutation", "intent-held-mutation");
    await mutationHold.entered;
    const dispatched = await pageBridge(pageA, "operationSnapshot");
    assert.ok(dispatched.some(record => record.dispatchedPhaseCount > 0 && !record.resultPresent), "the local record must say dispatched before the WS response arrives");
    assert.equal(mutationHold.responded, false);
    const removal = await within(pageBridge(pageB, "removePrimary"), 2_000, "profile removal waited for the held WebSocket response");
    assert.equal(removal.rejected, true, "unresolved durable operation must refuse profile removal");
    assert.equal(mutationHold.responded, false, "removal refusal must occur before the held response is released");
    mutationHold.respond();
    const completedMutation = await pendingMutation;
    assert.equal(completedMutation.path, "/workspace/held-mutation");
    const mutationHandle = await pageBridge(pageA, "loadReceipt", completedMutation.receiptId, "/workspace/held-mutation", completedMutation.path);
    assert.equal(mutationHandle.found, true);
    assert.deepEqual(await pageBridge(pageA, "acknowledgeReceipt", completedMutation.receiptId), { outcome: "consumed" });
    result.scenarios.push({ id: "remove-refuses-pending-dispatch-without-waiting-for-ack", status: "PASS", responseHeldDuringRefusal: true });

    // Obtain an actual V2 receipt in page B, begin its remote scope check, and
    // replace the same profile ID from page A. The late old-scope response must
    // not consume the durable receipt under the new authorization generation.
    const ackOperation = await pageBridge(pageA, "openWorkspace", "/workspace/late-ack", "intent-late-ack");
    const loaded = await pageBridge(pageB, "loadReceipt", ackOperation.receiptId, "/workspace/late-ack", ackOperation.path);
    assert.equal(loaded.found, true, "second page must load the actual stored V2 receipt");
    assert.equal(loaded.consumed, false);
    const staleScopeHold = fixture.holdNext(V2_SCOPE);
    const pendingAck = pageBridge(pageB, "acknowledgeReceipt", ackOperation.receiptId);
    await staleScopeHold.entered;
    assert.equal(staleScopeHold.responded, false);
    const replaced = await pageBridge(pageA, "replaceGeneration");
    assert.equal(replaced.committed, true);
    assert.equal(replaced.sameProfileId, true, "replacement must preserve the real profile ID");
    assert.notEqual(replaced.before.authorizationGeneration, replaced.after.authorizationGeneration);
    assert.notEqual(replaced.before.deviceId, replaced.after.deviceId);
    staleScopeHold.respond();
    const ack = await pendingAck;
    assert.equal(ack.outcome, "unverified", "late authorization-scoped ACK must report unverified after generation replacement");
    const remaining = await pageBridge(pageA, "operationSnapshot");
    assert.ok(remaining.some(record => record.resultPresent && !record.consumed && record.generation === replaced.before.authorizationGeneration), "the old durable receipt must remain unconsumed and unchanged");
    const finalProfiles = await pageBridge(pageB, "profileSnapshot");
    assert.ok(finalProfiles.profiles.some(profile => profile.id === "review-profile-primary" && profile.authorizationGeneration === replaced.after.authorizationGeneration));
    result.scenarios.push({ id: "late-ack-cannot-consume-after-same-id-generation-replacement", status: "PASS", sameProfileId: true, oldReceiptStillUnconsumed: true });

    result.classification = "PASS_BROWSER_MODULE_INTEGRATION_MOCK_GATEWAY";
    result.rpcFixture = fixture.safeSummary;
    result.chromium = { executablePath: browser.executablePath, headless: browser.headless, noSandbox: browser.noSandbox };
  } catch (error) {
    failure = error;
    result.classification = "FAIL_BROWSER_MODULE_INTEGRATION";
    result.failure = context.redactText(error instanceof Error ? error.stack ?? error.message : String(error));
    if (fixture) result.rpcFixture = fixture.safeSummary;
  } finally {
    const pageCloseResults = await Promise.allSettled([pageA?.close(), pageB?.close()].filter(Boolean));
    result.cleanup.pagesClosed = pageCloseResults.every(item => item.status === "fulfilled");
    try {
      if (browser) await browser.close();
      result.cleanup.chromiumClosed = true;
    } catch (error) {
      result.cleanup.chromiumClosed = false;
      result.cleanup.chromiumCloseError = context.redactText(error instanceof Error ? error.message : String(error));
    }
    let fixtureCloseOk = true;
    try { await fixture?.close(); } catch (error) { fixtureCloseOk = false; result.cleanup.fixtureCloseError = context.redactText(error instanceof Error ? error.message : String(error)); }
    result.cleanup.fixtureClosed = fixtureCloseOk;
    result.cleanup.ownedChromiumPid = browser?.child?.pid ?? null;
    await context.writeArtifactJson("workspace-profile-fence-two-page-result.json", result);
    if (!result.cleanup.pagesClosed || !result.cleanup.chromiumClosed || !result.cleanup.fixtureClosed) failure ??= new Error("owned browser fixture cleanup failed");
  }
  if (failure) throw failure;
  return result;
});
