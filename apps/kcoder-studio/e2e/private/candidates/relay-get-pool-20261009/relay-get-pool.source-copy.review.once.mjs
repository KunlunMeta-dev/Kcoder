// Static-only smoke for the candidate's pinned source verification and owned
// runtime-copy helpers. It imports no Relay module and opens no listener.
// Run only with the pinned Node 22.17.0 executable after source review.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { repoRoot } from "../../../harness/run-context.mjs";

const EXPECTED_NODE = "/home/hyf/.local/opt/node-v22.17.0-linux-x64/bin/node";
const COPY_SMOKE_FLAG = "KCODER_E2E_PRIVATE_RELAY_GET_POOL_COPY_SMOKE";
const RUN_FLAG = "KCODER_E2E_PRIVATE_RELAY_GET_POOL";
const CANDIDATE_RELATIVE_PATH = "apps/kcoder-studio/e2e/private/candidates/relay-get-pool-20261009/relay-get-pool.review.once.mjs";
const EXPECTED_CANDIDATE_SHA256 = "18e7bdb2bad9c788f49f805a5ab1dbc27262b4f8b286ee140090c229c287e66c";
const EVIDENCE_ROOT = resolve(repoRoot, "target/private-phone-ux-validation/relay-get-pool-copy-smoke-20261009");
const FROZEN_MANIFEST_SHA256 = "88b2ee8f2a98efbf0f623124af496e2d4c8955558e291940c4906a54a33d37b3";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

assert.equal(process.execPath, EXPECTED_NODE, "copy smoke requires the pinned Node executable");
assert.equal(process.version, "v22.17.0", "copy smoke requires Node 22.17.0");
assert.notEqual(process.env[RUN_FLAG], "1", "copy smoke must not start the Relay black-box run");

const candidatePath = resolve(repoRoot, CANDIDATE_RELATIVE_PATH);
const candidateBytes = await readFile(candidatePath);
const candidateSha256 = sha256(candidateBytes);
assert.equal(candidateSha256, EXPECTED_CANDIDATE_SHA256, "copy smoke is pinned to the reviewed candidate source");
process.env[COPY_SMOKE_FLAG] = "1";
const { captureRuntimeCopy } = await import(pathToFileURL(candidatePath).href);

await mkdir(EVIDENCE_ROOT, { recursive: true, mode: 0o700 });
const evidenceStat = await lstat(EVIDENCE_ROOT);
assert.equal(evidenceStat.isDirectory(), true);
assert.equal(evidenceStat.isSymbolicLink(), false);
await chmod(EVIDENCE_ROOT, 0o700);
const scratchRoot = await mkdtemp(join(EVIDENCE_ROOT, "run-"));
await chmod(scratchRoot, 0o700);
const stateRoot = join(scratchRoot, "state");
await mkdir(stateRoot, { mode: 0o700 });

let result;
try {
  result = await captureRuntimeCopy({
    pathInState(...parts) {
      assert.equal(parts[0], "relay-runtime", "copy helper uses only its owned runtime subtree");
      return join(stateRoot, ...parts);
    },
  });
  assert.equal(result.frozen.manifestSha256, FROZEN_MANIFEST_SHA256);
  assert.deepEqual(result.after, result.before, "static inputs remain unchanged across verification and copy");
  assert.ok(result.ownedRuntime["apps/kcoder-relay/package.json"],
    "owned copy records support inputs under canonical manifest-relative keys");
  assert.ok(result.ownedRuntime["apps/kcoder-relay/src/server.mjs"],
    "owned copy records the overlaid server under its canonical manifest-relative key");
  assert.ok(result.ownedRuntime["apps/kcoder-relay/src/http-get-pool.mjs"],
    "owned copy records the pool module under its canonical manifest-relative key");
  console.log(JSON.stringify({
    status: "STATIC_COPY_SMOKE_PASS",
    candidateSha256,
    manifestSha256: result.frozen.manifestSha256,
    frozenInputEntryCounts: {
      overlay: Object.keys(result.frozen.productOverlay).length,
      baseline: Object.keys(result.frozen.baseline).length,
      support: Object.keys(result.frozen.support).length,
      reviewTest: Object.keys(result.frozen.tests).length,
    },
    copiedEntryCount: Object.keys(result.ownedRuntime).length,
    wsRuntime: result.before.wsRuntime,
    network: "NOT_STARTED",
    cleanup: "temporary owned runtime removed in finally",
  }));
} finally {
  await rm(scratchRoot, { recursive: true, force: true });
}
