import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { repoRoot, runE2E } from "../../harness/run-context.mjs";

await runE2E(import.meta.url, {
  testId: "runtime-target-local-protocol",
  tier: "full-integration",
  modelPolicy: "model-independent-deterministic-provider",
}, async (context) => {
  const stateDir = context.pathInState("runtime-target-local");
  const artifactDir = context.pathInArtifacts("runtime-target-local");
  await Promise.all([mkdir(stateDir, { recursive: true }), mkdir(artifactDir, { recursive: true })]);
  const runner = resolve(fileURLToPath(new URL("./runtime-target-local-runner.mjs", import.meta.url)));
  const child = context.spawnOwned("runtime-target-local-runner", process.execPath, [runner], {
    cwd: repoRoot,
    env: context.isolatedEnvironment({
      KCODER_E2E_OWNED_STATE_DIR: stateDir,
      KCODER_E2E_OWNED_ARTIFACT_DIR: artifactDir,
      KCODER_STUDIO_CAPTURE: "0",
    }),
  });
  const exit = await childExit(child);
  if (exit.code !== 0) throw new Error(`runtime target local runner failed: ${JSON.stringify(exit)}`);
  const assertions = JSON.parse(await readFile(resolve(artifactDir, "assertions.json"), "utf8"));
  const meta = JSON.parse(await readFile(resolve(artifactDir, "meta.json"), "utf8"));
  context.registerPort("gateway", meta.port);
  if (assertions.ok !== true) throw new Error("runtime target local assertions did not pass");
  return { assertions, eventCount: meta.eventCount };
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
