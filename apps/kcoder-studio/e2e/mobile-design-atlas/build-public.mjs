import assert from "node:assert/strict";
import { mkdir, cp } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runE2E, waitFor } from "../harness/run-context.mjs";

process.umask(0o077);
await runE2E(import.meta.url, { testId: "design-atlas-public-auth-build", tier: "manual-live", retainSuccessLogs: true,
  modelPolicy: "Offline Go standard-library authentication boundary tests; no live Gateway or model" }, async run => {
  const go = process.env.KCODER_ATLAS_GO || "/usr/local/go/bin/go";
  const cwd = dirname(fileURLToPath(import.meta.url));
  const cache = run.pathInState("go-cache"), temp = run.pathInState("go-tmp");
  await mkdir(cache, { recursive: true }); await mkdir(temp, { recursive: true });
  const env = run.isolatedEnvironment({ PATH: `${dirname(go)}:${process.env.PATH}`, GOCACHE: cache, GOTMPDIR: temp, GO111MODULE: "off", CGO_ENABLED: "0", GOPROXY: "off", GOTOOLCHAIN: "local" });
  const test = run.spawnOwned("atlas-public-auth-tests", go, ["test", "-v", "public-server.go", "public-server_test.go"], { cwd, env });
  await waitFor(() => test.exitCode !== null, 180_000, "atlas encrypted access unit tests"); assert.equal(test.exitCode, 0);
  const binary = run.pathInArtifacts("atlas-public-server");
  const build = run.spawnOwned("atlas-public-static-binary", go, ["build", "-trimpath", "-ldflags=-s -w", "-o", binary, "public-server.go"], { cwd, env });
  await waitFor(() => build.exitCode !== null, 180_000, "atlas public server build"); assert.equal(build.exitCode, 0);
  const destination = process.env.KCODER_ATLAS_BINARY_OUT;
  if (destination) { assert.ok(resolve(destination).startsWith("/home/hyf/.codex/visualizations/")); await cp(binary, resolve(destination)); }
  return { binary, authTests: 5, standardLibraryOnly: true };
});
