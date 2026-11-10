import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstat, readFile, realpath, readdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { repoRoot as defaultRepoRoot, retainedE2EArtifactBoundary } from "./run-context.mjs";
import { inspectOfficialMobileStaticDist } from "./mobile-static-dist-input.mjs";

const roots = ["apps/kcoder-studio/mobile", "apps/kcoder-studio/shared"];
const approvedGit992Snapshot = "target/private-official-export-receipt-wiring-20261009/source-adapter-9925461c";
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const digest = value => assert.match(value, /^[a-f0-9]{64}$/);

/** No input preserves each caller's historical, strictly pinned default branch. */
export function officialMobileExportReceiptFromEnv(env = process.env) {
  const values = [env.KCODER_E2E_OFFICIAL_EXPORT_RECEIPT, env.KCODER_E2E_OFFICIAL_EXPORT_RECEIPT_SHA256,
    env.KCODER_E2E_OFFICIAL_EXPORT_RUN_MANIFEST_SHA256];
  if (values.every(value => value === undefined)) return null;
  assert.ok(values.every(value => typeof value === "string" && value.length > 0), "official export requires receipt path, receipt SHA and completed RunContext manifest SHA");
  assert.ok(isAbsolute(values[0]) && resolve(values[0]) === values[0]); digest(values[1]); digest(values[2]);
  return { receiptPath: values[0], receiptSha256: values[1], runManifestSha256: values[2] };
}

/** Cleanup callbacks revalidate inputs without using active-only artifact writers. */
export function addOfficialMobileExportPostflight(context, input, before, options) {
  context.addCleanup("verify completed official export input after run", async () => {
    const after = await readOfficialMobileExportReceipt(input, options);
    assert.equal(after.sourceDist.resourceTableSha256, before.sourceDist.resourceTableSha256);
  });
}

/** Read the existing official-mobile-web-export-*.json/result/manifest contracts. */
export async function readOfficialMobileExportReceipt(input, {
  repoRoot = defaultRepoRoot,
  sourceSnapshotRoot,
  sourceSnapshotManifestSha256,
} = {}) {
  const receipt = await readJson(input.receiptPath, input.receiptSha256);
  const match = input.receiptPath.match(/\/artifacts\/official-mobile-web-export-([a-f0-9]{8})\.json$/);
  assert.ok(match, "expected an existing official export receipt artifact");
  const runRoot = dirname(dirname(input.receiptPath));
  assertContained(retainedE2EArtifactBoundary(runRoot, repoRoot), runRoot);
  const manifest = await readJson(resolve(runRoot, "manifest.json"), input.runManifestSha256);
  assert.equal(manifest.status, "passed"); assert.equal(manifest.error, null);
  assert.ok(typeof manifest.endedAt === "string" && Number.isFinite(Date.parse(manifest.endedAt)));
  assert.ok(Array.isArray(manifest.processes) && manifest.processes.length > 0 && manifest.processes.every(row => row.stopped === true && row.spawnError === null));
  assert.ok(Array.isArray(manifest.cleanupSteps) && manifest.cleanupSteps.every(row => row.status === "completed"));
  assert.ok(manifest.cleanupErrors === undefined || Array.isArray(manifest.cleanupErrors) && manifest.cleanupErrors.length === 0);
  assert.ok(Array.isArray(manifest.ports) && manifest.ports.length === 0);
  assert.equal(manifest.source, `apps/kcoder-studio/e2e/private/mobile-web-export-${match[1]}.once.e2e.mjs`);
  const result = await readJson(resolve(runRoot, "artifacts/result.json"));
  assert.equal(result.status, "passed"); assert.equal(result.testId, manifest.testId); assert.deepEqual(result.result, receipt);
  assert.equal(receipt.exportPerformedOnce, true); assert.equal(receipt.sourceSnapshotFromGitArchive, true);
  assert.ok(receipt.source.commit.startsWith(match[1]));
  assert.equal(receipt.source.sourceUnchangedOutsideGeneratedHtml, true);
  assert.equal(receipt.dependencies.sourceUnchanged, true);
  assert.equal(receipt.dependencies.sourceTreeSha256Before, receipt.dependencies.sourceTreeSha256After);
  digest(receipt.source.sourceTreeSha256); digest(receipt.source.packageLockSha256);
  const builderSourceProvenance = await verifyBuilderSourceProvenance(receipt.source, {
    repoRoot,
    sourceSnapshotRoot,
    sourceSnapshotManifestSha256,
  });
  const builderSourceParity = builderSourceProvenance.mode === "currentTreeParity" ? builderSourceProvenance : null;
  const freeze = await readJson(resolve(runRoot, `artifacts/source-freeze-${match[1]}.json`), receipt.source.freezeManifestSha256);
  assert.equal(freeze.sourceCommit, receipt.source.commit);
  assert.equal(freeze.mobilePackageLockSha256, receipt.source.packageLockSha256);
  assert.deepEqual(freeze.sourceRoots.map(row => [row.path, row.gitTree]), [[roots[0], receipt.source.mobileTree], [roots[1], receipt.source.sharedTree]]);
  const deployment = receipt.officialDeployment;
  assert.equal(deployment.resourceCount, 37); assert.equal(deployment.physicalFileCount, 38);
  const distRoot = artifactPath(runRoot, deployment.directory);
  assert.equal(artifactPath(runRoot, deployment.manifestPath), resolve(distRoot, "kcoder-mobile-web.json"));
  const sourceDist = await inspectOfficialMobileStaticDist({ distRoot, expectedManifestSha256: deployment.manifestSha256 });
  const official = await readJson(sourceDist.manifestPath, deployment.manifestSha256);
  const files = official.files.map(({ path, size, sha256 }) => ({ path, size, sha256 }));
  assert.equal(sha256(Buffer.from(JSON.stringify(files))), deployment.bundleSha256);
  assert.equal(files.find(row => row.path === "index.html")?.sha256, deployment.indexHtmlSha256);
  const reuse = await readJson(artifactPath(runRoot, receipt.reuseInput.manifestPath), receipt.reuseInput.manifestSha256);
  assert.equal(reuse.sourceCommit, receipt.source.commit); assert.equal(reuse.sourceTreeSha256, receipt.source.sourceTreeSha256);
  assert.equal(reuse.bundleSha256, deployment.bundleSha256); assert.equal(reuse.bundleFileCount, 37); assert.deepEqual(reuse.files, files);
  assert.equal(receipt.reuseInput.bundleSha256, deployment.bundleSha256);
  return { receipt, receiptPath: input.receiptPath, receiptSha256: input.receiptSha256, runManifestSha256: input.runManifestSha256,
    distRoot, sourceDist, manifestSha256: deployment.manifestSha256, builderCommit: receipt.source.commit,
    builderSourceParity, builderSourceProvenance };
}

async function verifyBuilderSourceProvenance(source, { repoRoot, sourceSnapshotRoot, sourceSnapshotManifestSha256 }) {
  const snapshotRequested = sourceSnapshotRoot !== undefined || sourceSnapshotManifestSha256 !== undefined;
  if (!snapshotRequested) {
    return { mode: "currentTreeParity", ...verifyOfficialMobileSourceParity(source, { repoRoot }) };
  }

  assert.ok(typeof sourceSnapshotRoot === "string" && isAbsolute(sourceSnapshotRoot), "immutable source validation requires an absolute approved snapshot root");
  assert.equal(resolve(sourceSnapshotRoot), sourceSnapshotRoot, "source snapshot root must be canonical");
  const approvedRoot = resolve(repoRoot, approvedGit992Snapshot);
  assert.equal(sourceSnapshotRoot, approvedRoot, "immutable source validation is limited to the approved Git 992 snapshot");
  const rootInfo = await lstat(sourceSnapshotRoot);
  assert.ok(rootInfo.isDirectory() && !rootInfo.isSymbolicLink(), "source snapshot root must be a real directory");
  assert.equal(await realpath(sourceSnapshotRoot), sourceSnapshotRoot, "source snapshot root must not traverse symlinks");
  digest(sourceSnapshotManifestSha256);
  await readJson(resolve(sourceSnapshotRoot, "sha256.json"), sourceSnapshotManifestSha256);
  const snapshot = await verifyOfficialMobileSourceSnapshot(sourceSnapshotRoot, source.commit, { repoRoot });
  return {
    mode: "immutableSnapshot",
    sourceSnapshotPath: approvedGit992Snapshot,
    sourceSnapshotManifestSha256,
    ...snapshot,
  };
}

export function verifyOfficialMobileSourceParity(source, { repoRoot = defaultRepoRoot } = {}) {
  assert.match(source.commit, /^[a-f0-9]{40}$/);
  const git = args => execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  assert.equal(git(["rev-parse", `${source.commit}:${roots[0]}`]), source.mobileTree);
  assert.equal(git(["rev-parse", `${source.commit}:${roots[1]}`]), source.sharedTree);
  const lock = execFileSync("git", ["show", `${source.commit}:${roots[0]}/package-lock.json`], { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });
  assert.equal(sha256(lock), source.packageLockSha256);
  const currentHead = git(["rev-parse", "HEAD"]);
  git(["diff", "--quiet", source.commit, currentHead, "--", ...roots]);
  git(["diff", "--quiet", "HEAD", "--", ...roots]);
  assert.equal(git(["ls-files", "--others", "--exclude-standard", "--", ...roots]), "", "Mobile/Shared has untracked source outside this official export");
  return { builderCommit: source.commit, currentHead, comparedPaths: roots, mobileTree: source.mobileTree, sharedTree: source.sharedTree,
    packageLockSha256: source.packageLockSha256, commitTreeEqual: true, worktreeTrackedClean: true, untrackedSources: 0 };
}

/** Home's after adapter remains a separate input; an old adapter cannot claim current source. */
export async function verifyOfficialMobileSourceSnapshot(snapshotRoot, sourceCommit, { repoRoot = defaultRepoRoot } = {}) {
  const hashes = await readJson(resolve(snapshotRoot, "sha256.json"));
  assert.ok(hashes && typeof hashes === "object" && !Array.isArray(hashes), "source snapshot hash manifest must be an object");
  const inventory = execFileSync("git", ["ls-tree", "-rz", "--full-tree", sourceCommit, "--", ...roots], { cwd: repoRoot }).toString().split("\0").filter(Boolean);
  const names = [];
  for (const row of inventory) {
    const match = row.match(/^100(?:644|755) blob ([a-f0-9]{40})\t(.+)$/); assert.ok(match, "source snapshot must use regular Git blobs");
    const [, expectedBlob, path] = match; names.push(path);
    const info = await lstat(resolve(snapshotRoot, path)); assert.ok(info.isFile() && !info.isSymbolicLink());
    assert.equal(await realpath(resolve(snapshotRoot, path)), resolve(snapshotRoot, path), "source adapter must not traverse symlinks");
    const bytes = await readFile(resolve(snapshotRoot, path));
    assert.equal(sha256(bytes), hashes[path], `source adapter hash mismatch: ${path}`);
    assert.equal(createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex"), expectedBlob, `source adapter differs from official export commit: ${path}`);
  }
  const physicalNames = [];
  for (const root of roots) await collectSnapshotFiles(snapshotRoot, root, physicalNames);
  assert.deepEqual(physicalNames.sort(), names.slice().sort(), "source snapshot file set differs from official Git inventory");
  assert.deepEqual(Object.keys(hashes).sort(), names.slice().sort(), "source snapshot hash manifest differs from official Git inventory");
  return { sourceCommit, verifiedGitBlobs: names.length, exactScopedSnapshot: true };
}

async function collectSnapshotFiles(snapshotRoot, sourceRoot, files) {
  const absoluteRoot = resolve(snapshotRoot, sourceRoot);
  const rootInfo = await lstat(absoluteRoot);
  assert.ok(rootInfo.isDirectory() && !rootInfo.isSymbolicLink(), `source snapshot root is not a regular directory: ${sourceRoot}`);
  assert.equal(await realpath(absoluteRoot), absoluteRoot, "source snapshot directory must not traverse symlinks");
  const walk = async (directory, relativeDirectory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolutePath = join(directory, entry.name);
      const info = await lstat(absolutePath);
      assert.ok(info.isDirectory() || info.isFile(), "source snapshot contains a symlink or special file");
      assert.equal(await realpath(absolutePath), absolutePath, "source snapshot file must not traverse symlinks");
      const relativePath = `${relativeDirectory}/${entry.name}`;
      if (info.isDirectory()) await walk(absolutePath, relativePath);
      else files.push(relativePath);
    }
  };
  await walk(absoluteRoot, sourceRoot);
}

function artifactPath(runRoot, value) {
  assert.ok(typeof value === "string" && value.startsWith("artifacts/") && !value.includes("\\"));
  assert.ok(value.split("/").every(part => part && part !== "." && part !== ".."));
  const path = resolve(runRoot, value); assertContained(resolve(runRoot, "artifacts"), path); return path;
}
function assertContained(root, path) { const rel = relative(root, path); assert.ok(rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)); }
async function readJson(path, expectedSha256) {
  const info = await lstat(path); assert.ok(info.isFile() && !info.isSymbolicLink() && info.size <= 2 * 1024 * 1024);
  assert.equal(await realpath(path), path, "receipt path must not traverse symlinks");
  const bytes = await readFile(path); assert.ok(bytes.length <= 2 * 1024 * 1024);
  if (expectedSha256 !== undefined) { digest(expectedSha256); assert.equal(sha256(bytes), expectedSha256, "official export evidence SHA changed"); }
  return JSON.parse(bytes.toString("utf8"));
}
