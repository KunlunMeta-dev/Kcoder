import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { resolveExistingPrivateGatewaySnapshot } from "./gateway-runtime-snapshot-guard.mjs";

test("accepts an existing complete private snapshot without changing it", async t => {
  const repoRoot = await temporaryRoot(t);
  const snapshotRoot = resolve(repoRoot, "target/private-phone-ux-implementation/nav-gateway-runtime-restored");
  await mkdir(snapshotRoot, { recursive: true });
  const manifestBytes = `${JSON.stringify({
    status: "complete",
    sourceFiles: [],
    dependencyFiles: [],
    sourceTreeSha256: "source-digest",
    dependencyTreeSha256: "dependency-digest",
  })}\n`;
  const manifestPath = resolve(snapshotRoot, "gateway-runtime-freeze.json");
  await writeFile(manifestPath, manifestBytes, { mode: 0o600 });

  const before = await readFile(manifestPath);
  const result = await resolveExistingPrivateGatewaySnapshot(repoRoot, "target/private-phone-ux-implementation/nav-gateway-runtime-restored");
  const after = await readFile(manifestPath);

  assert.equal(result.snapshotRoot, snapshotRoot);
  assert.equal(result.manifestPath, manifestPath);
  assert.deepEqual(after, before);
  assert.deepEqual(await readdir(snapshotRoot), ["gateway-runtime-freeze.json"]);
});

test("rejects a missing private snapshot manifest instead of rebuilding from the workspace", async t => {
  const repoRoot = await temporaryRoot(t);
  await mkdir(resolve(repoRoot, "target/private-phone-ux-implementation/incomplete"), { recursive: true });

  await assert.rejects(
    resolveExistingPrivateGatewaySnapshot(repoRoot, "target/private-phone-ux-implementation/incomplete"),
    error => error?.code === "ENOENT",
  );
});

test("rejects a private snapshot symlink that resolves outside the private root", async t => {
  const repoRoot = await temporaryRoot(t);
  const privateRoot = resolve(repoRoot, "target/private-phone-ux-implementation");
  const externalRoot = resolve(repoRoot, "outside-snapshot");
  await mkdir(privateRoot, { recursive: true });
  await mkdir(externalRoot, { recursive: true });
  await writeFile(resolve(externalRoot, "gateway-runtime-freeze.json"), JSON.stringify({
    status: "complete",
    sourceFiles: [],
    dependencyFiles: [],
    sourceTreeSha256: "source-digest",
    dependencyTreeSha256: "dependency-digest",
  }));
  await symlink(externalRoot, resolve(privateRoot, "escape"), "dir");

  await assert.rejects(
    resolveExistingPrivateGatewaySnapshot(repoRoot, "target/private-phone-ux-implementation/escape"),
    /canonical path escapes/,
  );
});

async function temporaryRoot(t) {
  const root = await mkdtemp(join(tmpdir(), "phone-ux-gateway-snapshot-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
