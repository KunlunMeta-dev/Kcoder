import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import {
  captureMobileExportSourceSnapshot,
  createMobileSessionCacheSourceSnapshotManifest,
} from "../harness/mobile-export-source-snapshot.mjs";
import { runE2E } from "../harness/run-context.mjs";

const args = process.argv.slice(2);
assert.deepEqual(args, ["--execute"], "Mobile source snapshot requires the explicit --execute flag");
process.umask(0o077);

await runE2E(import.meta.url, {
  testId: "mobile-session-cache-source-snapshot-preflight",
  tier: "manual-preflight",
  modelPolicy: "Pinned Mobile/shared source snapshot as data only; no Expo export, Gateway, Browser, Rust app-server, Provider, or model call",
}, async context => {
  const mobileRoot = requiredAbsolutePath("KCODER_E2E_MOBILE_SOURCE_ROOT");
  const sourceRoots = [
    { name: "mobile", path: mobileRoot, destination: "apps/kcoder-studio/mobile" },
    { name: "studio-shared", path: resolve(mobileRoot, "../shared"), destination: "apps/kcoder-studio/shared" },
  ];
  const snapshotRoot = context.pathInArtifacts("mobile-source-snapshot");
  const snapshot = await captureMobileExportSourceSnapshot({
    sourceRoots,
    snapshotRoot,
    layout: "preflight-source-root",
    freezeFiles: true,
  });
  const head = context.gitCommit;
  const manifest = createMobileSessionCacheSourceSnapshotManifest({ snapshot, snapshotRoot, head });
  const manifestPath = await context.writeArtifactJson("mobile-session-cache-source-snapshot-manifest.json", manifest);
  const manifestSha256 = createHash("sha256").update(await readFile(manifestPath)).digest("hex");
  const result = {
    schemaVersion: 1,
    kind: "mobile-session-cache-source-snapshot-preflight",
    status: "PASS_SOURCE_SNAPSHOT",
    snapshotRoot,
    manifestPath,
    manifestSha256,
    sourceTreeSha256: snapshot.sourceTreeSha256,
    fileCount: snapshot.fileCount,
    byteCount: snapshot.byteCount,
    gitHead: head,
    gitHeadSemantics: "commit baseline only; exact dirty source identity is the copied file table and SHA-256 pins",
    retention: "RunContext-owned artifact; retained under this run root until normal artifact retention removes the run",
    snapshotMode: "regular files chmod 0400; directories chmod 0700; content remains hash-verified rather than filesystem-immutable",
  };
  await context.writeArtifactJson("mobile-session-cache-source-snapshot-provenance.json", result);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result;
});

function requiredAbsolutePath(name) {
  const value = process.env[name];
  assert.ok(typeof value === "string" && isAbsolute(value), `${name} must be an explicit absolute input path`);
  return resolve(value);
}
