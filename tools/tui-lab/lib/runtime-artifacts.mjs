import { writeFailureArtifact } from "./failure-artifact.mjs";
import { repoRoot } from "./runtime-paths.mjs";
import { writeFile, chmod } from "node:fs/promises";
import { browserLaunchOptions } from "./runner-options.mjs";
import { platformDescription } from "./platform-adapter.mjs";
import process from "node:process";

export const writeFailureArtifacts = (options) =>
  writeFailureArtifact({ ...options, repoRoot });

export async function writeTextArtifact(file, content) {
  await writeFile(file, content, { mode: 0o644 });
  await chmod(file, 0o644);
}

export async function writeJsonArtifact(file, value) {
  await writeTextArtifact(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function formatError(error) {
  return {
    name: error?.name || "Error",
    message: error?.message || String(error),
    stack: error?.stack || "",
  };
}

export async function writeStartMeta(artifacts, runOptions, command, mode) {
  await writeJsonArtifact(artifacts.startMeta, {
    ok: null,
    mode,
    command,
    cwd: repoRoot,
    runId: artifacts.runId,
    date: artifacts.dateStamp,
    time: artifacts.timeStamp,
    description: artifacts.description,
    dateDir: artifacts.dateDir,
    runLabel: artifacts.runLabel,
    runDir: artifacts.dir,
    workspace: artifacts.workspace,
    workspaceTemplate: artifacts.workspaceTemplate,
    requestsDir: artifacts.requestsDir,
    configHome: artifacts.configHome,
    configDir: artifacts.configDir,
    projectKey: artifacts.projectKey,
    projectDir: artifacts.projectDir,
    message: runOptions.message,
    secondMessage: mode === "two-turn" ? runOptions.secondMessage : undefined,
    scenario: runOptions.scenario,
    cols: runOptions.cols,
    rows: runOptions.rows,
    timeoutMs: runOptions.timeoutMs,
    browserLaunch: browserLaunchOptions(runOptions),
    recordSeconds: mode === "record" ? runOptions.recordSeconds : undefined,
    sampleFps: mode === "record" ? runOptions.sampleFps : undefined,
    videoFps: mode === "record" ? runOptions.videoFps : undefined,
    sendMessage: mode === "record" ? runOptions.sendMessage : undefined,
    startedAt: new Date().toISOString(),
    hostPlatform: platformDescription(process.platform, process.env),
  });
}
