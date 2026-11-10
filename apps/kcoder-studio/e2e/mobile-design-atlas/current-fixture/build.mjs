import assert from "node:assert/strict";
import { cp, mkdir, symlink, readFile, writeFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { repoRoot, waitFor } from "../../harness/run-context.mjs";
import { captureMobileExportSourceSnapshot } from "../../harness/mobile-export-source-snapshot.mjs";
import { materializeOwnedDependencies } from "../../harness/owned-dependencies.mjs";

export const fixturePrefix = "/fixtures/mobile-send-recovery-v3";

/** Export actual Mobile presentation from frozen inputs without production routing. */
export async function buildCurrentFixture(run) {
  const frozen = run.pathInState("frozen-source");
  const relative = "apps/kcoder-studio/e2e/mobile-design-atlas/current-fixture";
  const source = await captureMobileExportSourceSnapshot({ snapshotRoot: frozen, layout: "preflight-source-root", freezeFiles: true,
    sourceRoots: [
      { name: "mobile", path: resolve(repoRoot, "apps/kcoder-studio/mobile"), destination: "apps/kcoder-studio/mobile" },
      { name: "studio-shared", path: resolve(repoRoot, "apps/kcoder-studio/shared"), destination: "apps/kcoder-studio/shared" },
    ] });
  await run.writeArtifactJson("frozen-mobile-source.json", source);
  const fixture = resolve(frozen, relative);
  await cp(resolve(repoRoot, relative), fixture, { recursive: true, filter: path => !path.split("/").includes("node_modules") });
  const fixtureFiles = [];
  for (const name of await readdir(fixture, { recursive: true })) {
    try { const bytes = await readFile(resolve(fixture, name)); fixtureFiles.push({ path: name, sha256: createHash("sha256").update(bytes).digest("hex") }); }
    catch (error) { if (error.code !== "EISDIR") throw error; }
  }
  await run.writeArtifactJson("frozen-fixture-source.json", fixtureFiles);
  const dependencies = await materializeOwnedDependencies(run, {
    sourceRoot: resolve(repoRoot, "apps/kcoder-studio/mobile/node_modules"),
    destination: resolve(frozen, "apps/kcoder-studio/mobile/node_modules"), label: "recovery-fixture-dependencies",
  });
  await symlink(dependencies.root, resolve(fixture, "node_modules"));
  const site = run.pathInArtifacts("site");
  const output = resolve(site, fixturePrefix.slice(1));
  await mkdir(output, { recursive: true });
  const env = run.isolatedEnvironment({ PATH: `${dirname(process.execPath)}:${process.env.PATH}`,
    EXPO_OFFLINE: "1", EXPO_NO_TELEMETRY: "1", EXPO_NO_TYPESCRIPT_SETUP: "1", EXPO_NO_DOTENV: "1",
    EXPO_HOME: run.pathInState("expo-home"), TMPDIR: run.pathInState("tmp"),
    XDG_CACHE_HOME: run.pathInState("cache") });
  for (const path of [env.EXPO_HOME, env.TMPDIR, env.XDG_CACHE_HOME]) await mkdir(path, { recursive: true, mode: 0o700 });
  const child = run.spawnOwned("fixture-export", process.execPath,
    [resolve(dependencies.root, "expo/bin/cli"), "export", "--platform", "web", "--output-dir", output, "--max-workers", "2"], { cwd: fixture, env });
  await waitFor(() => child.exitCode !== null, 300_000, "static recovery fixture export", 500);
  assert.equal(child.exitCode, 0, "Fixture export failed; inspect fixture-export.log");
  const indexFile = resolve(output, "index.html");
  const html = await readFile(indexFile, "utf8");
  assert.ok(html.includes(`${fixturePrefix}/_expo/`), "Static resources must use the fixture mount");
  await writeFile(indexFile, html.replace("</head>", '<link rel="icon" href="data:,"></head>'));
  const files = [];
  for (const name of await readdir(output, { recursive: true })) {
    try {
      const bytes = await readFile(resolve(output, name));
      files.push({ path: name, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
    } catch (error) { if (error.code !== "EISDIR") throw error; }
  }
  await run.writeArtifactJson("static-files.json", files.sort((a, b) => a.path.localeCompare(b.path)));
  return { site, output, source };
}
