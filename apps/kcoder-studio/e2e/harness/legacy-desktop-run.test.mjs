import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { RunContext } from "./run-context.mjs";
import {
  createRunContextDesktopOwner,
  inspectLegacyDesktopPrerequisites,
  unmetLegacyPrerequisite,
} from "./legacy-desktop-run.mjs";

const source = import.meta.url;

test("legacy prerequisites are read-only and do not silently replace a missing executor", async () => {
  const root = await mkdtemp(join(tmpdir(), "kcoder-legacy-prerequisites-"));
  try {
    const before = await readdir(root);
    const report = await inspectLegacyDesktopPrerequisites({
      root,
      platform: "linux",
      argv: ["node", "entry", "--plugins-only"],
      env: { CODEX_BIN: process.execPath, PATH: "" },
    });
    assert.equal(report.available, false);
    assert.ok(
      report.missing.some((value) => value.includes("legacy executor")),
    );
    assert.equal(report.flags.pluginsOnly, true);
    assert.deepEqual(await readdir(root), before);
    assert.equal(unmetLegacyPrerequisite(report).code, "UNMET_PREREQUISITE");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cloud checks retain their separate backend prerequisites even with an explicit executor", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "kcoder-legacy-cloud-prerequisites-"),
  );
  try {
    const env = {
      CODEX_BIN: process.execPath,
      KCODER_STUDIO_E2E_EXECUTOR_BIN: process.execPath,
      PATH: "",
    };
    const report = await inspectLegacyDesktopPrerequisites({
      root,
      env,
      platform: "linux",
      argv: ["node", "entry", "--cloud-only"],
    });
    assert.ok(report.missing.includes("legacy backend/pyproject.toml"));
    assert.ok(report.missing.includes("uv"));
    assert.ok(report.missing.includes("redis-server"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("owned desktop commands register secrets before output and leave no state or process", async () => {
  const context = await RunContext.create(source, {
    testId: "legacy-owner-command-contract",
    tier: "unit",
    retainSuccessLogs: true,
    evidenceReason: "Verify fixture-secret redaction",
  });
  const token = "legacy-owner-unit-secret-42";
  let failure;
  try {
    const owner = createRunContextDesktopOwner(context, {
      deadlineAt: Date.now() + 15_000,
    });
    const output = await owner.runCommand(
      process.execPath,
      ["-e", "process.stdout.write(process.env.UNIT_SECRET)"],
      {
        env: context.isolatedEnvironment({ UNIT_SECRET: token }),
      },
    );
    assert.equal(output.stdout, token);
    await owner.cleanup();
    await context.finish("passed", { commandExited: true });
    const manifest = JSON.parse(
      await readFile(join(context.runRoot, "manifest.json"), "utf8"),
    );
    assert.ok(manifest.processes.length > 0);
    assert.ok(manifest.processes.every((process) => process.stopped));
    const logs = await readdir(context.logsDir);
    for (const name of logs)
      assert.ok(
        !(await readFile(join(context.logsDir, name), "utf8")).includes(token),
      );
    await assert.rejects(readdir(context.stateDir), { code: "ENOENT" });
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    if (!context.finished)
      await context.finish(
        "failed",
        null,
        failure || new Error("test did not finish"),
      );
  }
});

test("owned desktop owner cleans a running child after a primary failure", async () => {
  const context = await RunContext.create(source, {
    testId: "legacy-owner-failure-contract",
    tier: "unit",
  });
  const owner = createRunContextDesktopOwner(context, {
    deadlineAt: Date.now() + 15_000,
  });
  try {
    let child;
    await assert.rejects(
      owner.runOperation(async () => {
        child = await owner.spawnProcess(
          process.execPath,
          ["-e", "setInterval(() => {}, 1000)"],
          { env: context.isolatedEnvironment() },
        );
        throw new Error("expected primary failure");
      }),
      /expected primary failure/,
    );
    assert.ok(child.pid);
    await owner.cleanup();
    await context.finish("passed", { failureCleanup: true });
    assert.ok(child.exitCode !== null || child.signalCode !== null);
    await assert.rejects(readdir(context.stateDir), { code: "ENOENT" });
  } finally {
    if (!context.finished)
      await context.finish(
        "failed",
        null,
        new Error("cleanup test did not finish"),
      );
  }
});

async function runPublicCli(context, flags) {
  const entry = fileURLToPath(
    new URL("../../renderer/e2e/desktop/task-flow.e2e.mjs", import.meta.url),
  );
  const child = context.spawnOwned(
    "legacy-public-cli",
    process.execPath,
    [entry, ...flags],
    {
      env: context.isolatedEnvironment({
        CODEX_BIN: process.execPath,
        KCODER_STUDIO_E2E_EXECUTOR_BIN: context.pathInState(
          "absent-legacy-executor",
        ),
      }),
    },
  );
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const code = await new Promise((resolveExit, reject) => {
    child.once("exit", resolveExit);
    child.once("error", reject);
  });
  return { code, stdout, stderr };
}

test("public desktop CLI help is offline and retains the original flag names", async () => {
  const context = await RunContext.create(source, {
    testId: "legacy-public-help",
  });
  try {
    const output = await runPublicCli(context, ["--help"]);
    assert.equal(output.code, 0);
    for (const flag of [
      "--cloud-only",
      "--plugins-only",
      "--memory-only",
      "--goal-restart-only",
      "--queue-navigation-only",
    ])
      assert.ok(output.stdout.includes(flag));
    assert.ok(!output.stdout.includes("E2E passed"));
    assert.equal(output.stderr, "");
    await context.finish("passed", { help: true });
  } finally {
    if (!context.finished)
      await context.finish("failed", null, new Error("help contract failed"));
  }
});

test("public desktop CLI reports unmet prerequisites as failure and cleans its own run", async () => {
  const context = await RunContext.create(source, {
    testId: "legacy-public-prerequisite-failure",
  });
  try {
    const output = await runPublicCli(context, ["--plugins-only"]);
    assert.equal(output.code, 1);
    assert.match(output.stderr, /UNMET_PREREQUISITE/);
    assert.ok(!output.stdout.includes("E2E passed"));
    const diagnostic = output.stderr.match(/Diagnostics: ([^\r\n]+)/)?.[1];
    assert.ok(diagnostic);
    const manifest = JSON.parse(
      await readFile(join(diagnostic, "manifest.json"), "utf8"),
    );
    assert.equal(manifest.status, "failed");
    assert.equal(manifest.processes.length, 0);
    const prerequisite = JSON.parse(
      await readFile(
        join(diagnostic, "artifacts/legacy-prerequisites.json"),
        "utf8",
      ),
    );
    assert.equal(prerequisite.available, false);
    assert.equal(prerequisite.flags.pluginsOnly, true);
    await assert.rejects(readdir(join(diagnostic, "state")), {
      code: "ENOENT",
    });
    await context.finish("passed", {
      negativeCliContract: true,
      legacyMatrixExecuted: false,
    });
  } finally {
    if (!context.finished)
      await context.finish(
        "failed",
        null,
        new Error("prerequisite contract failed"),
      );
  }
});

test("the CI harness imports every extracted phase through the existing orchestration graph", async () => {
  const { main } =
    await import("../../renderer/e2e/desktop/task-flow/runner.mjs");
  const configuration =
    await import("../../renderer/e2e/desktop/task-flow/config.mjs");
  const runtime =
    await import("../../renderer/e2e/desktop/task-flow/runtime.mjs");
  assert.equal(typeof main, "function");
  assert.deepEqual(configuration.MODEL_PROTOCOLS, [
    "responses",
    "chat",
    "anthropic",
  ]);
  assert.equal(
    configuration.MODEL_PROTOCOL_MATRIX_TOTAL,
    configuration.MODEL_PROTOCOL_MATRIX_CASES.length * 2,
  );
  const controller = new AbortController();
  const reason = new Error("owned CI cancellation");
  runtime.setOperationSignal(controller.signal);
  controller.abort(reason);
  try {
    await assert.rejects(
      runtime.abortable(Promise.resolve("unused")),
      (error) => error === reason,
    );
  } finally {
    runtime.setOperationSignal(undefined);
  }
  assert.equal(await runtime.abortable(Promise.resolve("reset")), "reset");
});

test("registered legacy suite forwards only its binary/scenario controls", async () => {
  const { suiteEnvironmentNames } = await import("./runner-options.mjs");
  const names = suiteEnvironmentNames(
    "suites/desktop/legacy-task-flow.e2e.mjs",
    {},
  );
  for (const name of [
    "CODEX_BIN",
    "KCODER_STUDIO_E2E_EXECUTOR_BIN",
    "KCODER_STUDIO_E2E_APP_BIN",
    "KCODER_STUDIO_E2E_DESKTOP_SCENARIO_MODULE",
  ])
    assert.ok(names.includes(name));
  for (const name of [
    "CODEX_HOME",
    "MINIMAX_API_KEY",
    "KCODER_CONFIG_DIR",
    "WEGENT_AUTH_TOKEN",
  ])
    assert.ok(!names.includes(name));
});

test(
  "legacy Unix signal exit is preserved after manifest and resource cleanup",
  { skip: process.platform === "win32" },
  async () => {
    const context = await RunContext.create(source, {
      testId: "legacy-signal-exit-contract",
    });
    try {
      const fixture = fileURLToPath(
        new URL("./fixtures/legacy-exit-signal.mjs", import.meta.url),
      );
      const child = context.spawnOwned(
        "legacy-signal-fixture",
        process.execPath,
        [fixture],
        { env: context.isolatedEnvironment() },
      );
      let output = "";
      child.stdout.on("data", (chunk) => {
        output += chunk;
      });
      const deadline = Date.now() + 5000;
      while (!output.includes("SIGNAL_READY")) {
        assert.ok(
          Date.now() < deadline && child.exitCode === null,
          "signal fixture did not become ready",
        );
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const exited = new Promise((resolve) =>
        child.once("exit", (code, signal) => resolve({ code, signal })),
      );
      child.kill("SIGTERM");
      assert.deepEqual(await exited, { code: null, signal: "SIGTERM" });
      const run = output.match(/RUN_ROOT:([^\r\n]+)/)[1];
      const manifest = JSON.parse(
        await readFile(join(run, "manifest.json"), "utf8"),
      );
      assert.equal(manifest.status, "failed");
      assert.ok(
        manifest.cleanupSteps.every((step) => step.status === "completed"),
      );
      assert.deepEqual(
        JSON.parse(
          await readFile(join(run, "artifacts/cleanup-proof.json"), "utf8"),
        ),
        { cleanupRan: true },
      );
      await assert.rejects(readdir(join(run, "state")), { code: "ENOENT" });
      await context.finish("passed", { signalPreserved: true });
    } catch (error) {
      await context.finish("failed", null, error).catch(() => {});
      throw error;
    }
  },
);
