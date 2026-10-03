import { access, stat } from "node:fs/promises";
import { basename, delimiter, isAbsolute, join, resolve } from "node:path";
import { constants } from "node:fs";
import { appRoot } from "./run-context.mjs";
import { startOwnedDisplay } from "./ai-verify-gateway.mjs";
import {
  createResourceOwner,
  stopProcess,
  stopProcessGroup,
} from "../../renderer/e2e/desktop/process-lifecycle.mjs";
import { parseTaskFlowArgs } from "../../renderer/e2e/desktop/task-flow-args.mjs";

async function exists(path, mode = constants.F_OK) {
  return access(path, mode).then(
    () => true,
    () => false,
  );
}

async function executable(name, env, platform) {
  if (!name) return false;
  const suffixes = platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
  const candidates =
    isAbsolute(name) || /[/\\]/.test(name)
      ? [resolve(name)]
      : (env.PATH || "")
          .split(delimiter)
          .flatMap((directory) =>
            suffixes.map((suffix) => join(directory, name + suffix)),
          );
  for (const candidate of candidates)
    if (
      (await exists(candidate, constants.X_OK)) &&
      (await stat(candidate).then(
        (info) => info.isFile(),
        () => false,
      ))
    )
      return true;
  return false;
}

// This check is read-only. Missing legacy software is never replaced with a mock
// or with the incompatible current app-server binary.
export async function inspectLegacyDesktopPrerequisites({
  env = process.env,
  root = appRoot,
  platform = process.platform,
  argv = process.argv,
} = {}) {
  const flags = parseTaskFlowArgs(argv, env);
  const missing = [];
  if (
    !(await executable(
      env.CODEX_BIN || env.CODEX_BINARY_PATH || "codex",
      env,
      platform,
    ))
  ) {
    missing.push("Codex executable (CODEX_BIN or CODEX_BINARY_PATH)");
  }
  if (env.KCODER_STUDIO_E2E_EXECUTOR_BIN) {
    if (!(await executable(env.KCODER_STUDIO_E2E_EXECUTOR_BIN, env, platform)))
      missing.push("configured compatible legacy executor");
  } else if (!(await exists(join(root, "executor/Cargo.toml")))) {
    missing.push(
      "legacy executor/Cargo.toml or KCODER_STUDIO_E2E_EXECUTOR_BIN",
    );
  }
  if (
    env.KCODER_STUDIO_E2E_APP_BIN &&
    !(await executable(env.KCODER_STUDIO_E2E_APP_BIN, env, platform))
  ) {
    missing.push("configured Tauri application");
  }
  if (flags.cloudOnly) {
    if (!(await exists(join(root, "backend/pyproject.toml"))))
      missing.push("legacy backend/pyproject.toml");
    for (const name of ["uv", "redis-server"])
      if (!(await executable(name, env, platform))) missing.push(name);
  }
  if (platform === "win32")
    missing.push("legacy desktop matrix currently supports Unix hosts only");
  if (platform === "linux" && !(await exists("/usr/bin/Xvfb", constants.X_OK)))
    missing.push("owned Xvfb display");
  return { available: missing.length === 0, missing, flags };
}

export function unmetLegacyPrerequisite(report) {
  const error = new Error(
    `UNMET_PREREQUISITE: ${report.missing.join("; ")}. The original desktop scenario matrix has not run.`,
  );
  error.code = "UNMET_PREREQUISITE";
  return error;
}

// Reuse the original deadline/command/cleanup implementation, but attribute each
// subprocess to the shared RunContext before it can emit output.
export function createRunContextDesktopOwner(context, options = {}) {
  let sequence = 0;
  const labels = new WeakMap();
  const registerEnvironmentSecrets = (env) => {
    for (const [key, value] of Object.entries(env || {})) {
      if (
        /token|secret|credential|password|api.?key/i.test(key) &&
        typeof value === "string"
      )
        context.registerSecret(value);
    }
  };
  const owner = createResourceOwner({
    ...options,
    spawn(command, args, spawnOptions) {
      registerEnvironmentSecrets(spawnOptions.env);
      const label = `legacy-${++sequence}-${basename(command)
        .replace(/[^a-zA-Z0-9._-]/g, "-")
        .slice(0, 70)}`;
      const child = context.spawnOwned(label, command, args, {
        ...spawnOptions,
        stdin: spawnOptions.stdio?.[0] || "ignore",
      });
      labels.set(child, label);
      return child;
    },
    stopGroup: async (child, options) => {
      await stopProcessGroup(child, options);
      await context.stopOwned(labels.get(child));
    },
    stopSingle: async (child, options) => {
      await stopProcess(child, options);
      await context.stopOwned(labels.get(child));
    },
  });
  context.addCleanup("legacy desktop resource owner", () => owner.cleanup());
  return owner;
}

export async function executeLegacyDesktopTaskFlow(context) {
  const deadlineAt = Date.now() + 2 * 60 * 60 * 1_000;
  const prerequisite = await inspectLegacyDesktopPrerequisites();
  await context.writeArtifactJson("legacy-prerequisites.json", prerequisite);
  if (!prerequisite.available) {
    const error = unmetLegacyPrerequisite(prerequisite);
    error.message += `\nDiagnostics: ${context.runRoot}`;
    throw error;
  }
  const configuration =
    await import("../../renderer/e2e/desktop/task-flow/config.mjs");
  configuration.setOwnedPaths(context.artifactsDir, context.stateDir);
  const display =
    process.platform === "linux" ? await startOwnedDisplay(context) : null;
  const { main } =
    await import("../../renderer/e2e/desktop/task-flow/runner.mjs");
  await main(context, display, deadlineAt);
  return { legacyMatrixExecuted: true, selectedFlags: prerequisite.flags };
}

export async function withLegacyExitSignals(operation) {
  let interruptedSignal;
  const onInterrupt = () => {
    interruptedSignal ||= "SIGINT";
  };
  const onTerminate = () => {
    interruptedSignal ||= "SIGTERM";
  };
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onTerminate);
  try {
    return await operation();
  } finally {
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onTerminate);
    // The operation's RunContext has finished before the original signal is re-raised.
    if (interruptedSignal) {
      process.kill(process.pid, interruptedSignal);
      await new Promise(() => {});
    }
  }
}
