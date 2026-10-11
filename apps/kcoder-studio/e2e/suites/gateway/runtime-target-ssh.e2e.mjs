import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { repoRoot, runE2E } from "../../harness/run-context.mjs";

await runE2E(import.meta.url, {
  testId: "runtime-target-ssh-protocol",
  tier: "full-integration",
  modelPolicy: "model-independent-deterministic-provider",
}, async (context) => {
  const stateDir = context.pathInState("runtime-target-ssh");
  const artifactDir = context.pathInArtifacts("runtime-target-ssh");
  await Promise.all([mkdir(stateDir, { recursive: true }), mkdir(artifactDir, { recursive: true })]);
  const runner = resolve(fileURLToPath(new URL("./runtime-target-ssh-runner.mjs", import.meta.url)));
  const child = context.spawnOwned("runtime-target-ssh-runner", process.execPath, [runner], {
    cwd: repoRoot,
    env: context.isolatedEnvironment({
      KCODER_CHROMIUM_BIN: process.env.KCODER_E2E_CHROMIUM_BIN || "/usr/bin/chromium",
      KCODER_E2E_CHROMIUM_NO_SANDBOX: process.env.KCODER_E2E_CHROMIUM_NO_SANDBOX,
      KCODER_E2E_REQUIRE_CHROMIUM_SANDBOX: process.env.KCODER_E2E_REQUIRE_CHROMIUM_SANDBOX,
      KCODER_E2E_OWNED_STATE_DIR: stateDir,
      KCODER_E2E_OWNED_ARTIFACT_DIR: artifactDir,
    }),
  });
  const exit = await childExit(child);
  if (exit.code !== 0) throw new Error(`runtime target SSH runner failed: ${JSON.stringify(exit)}`);
  const report = JSON.parse(await readFile(resolve(artifactDir, "ssh-result.json"), "utf8"));
  for (const [label, port] of Object.entries(report.ports ?? {})) context.registerPort(label, port);
  if (report.ok !== true) {
    throw new Error("runtime target SSH assertions did not pass");
  }
  return report;
});

function childExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
}
