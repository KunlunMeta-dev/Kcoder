import assert from "node:assert/strict";
import { lstat, mkdir, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { prepareSuiteArtifacts, runCli, runNode, runSuites } from "../run-all.mjs";

test("help prints selectors without preparing artifacts, spawning suites, or creating state", async () => {
  const stateRoot = join(tmpdir(), `kcoder-e2e-help-${randomUUID()}`);
  const output = [];
  let preparations = 0;
  let suiteRuns = 0;
  try {
    for (const flag of ["--help", "-h"]) {
      assert.equal(await runCli([flag], {
        output: line => output.push(line),
        prepare: async () => { preparations += 1; await mkdir(stateRoot, { recursive: true }); },
        executeSuites: async () => { suiteRuns += 1; return []; },
      }), 0);
    }
    assert.match(output.join("\n"), /--suite <selector>/);
    assert.match(output.join("\n"), /--kind <integration\|e2e>/);
    assert.equal(preparations, 0);
    assert.equal(suiteRuns, 0);
    await assert.rejects(lstat(stateRoot), { code: "ENOENT" });
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test('frozen Windows migration acceptance does not rebuild unrelated source artifacts', async () => {
  await prepareSuiteArtifacts(['../integration/gateway/windows-migration.integration.mjs'], {
    run: async () => assert.fail('a frozen Windows installer must retain its actual binaries'),
  });
});

test('Windows migration child receives only explicit frozen package inputs', async () => {
  const expected = { KCODER_E2E_WINDOWS_PAYLOAD_ARCHIVE: '/owned/app.7z',
    KCODER_E2E_WINDOWS_PAYLOAD_SHA256: 'c'.repeat(64), KCODER_E2E_WINDOWS_SSH_TARGET: 'owned-host',
    KCODER_E2E_WINDOWS_NODE: 'D:\\Node\\node.exe', KCODER_E2E_WINDOWS_PROBE_PARENT: 'D:\\',
    KCODER_E2E_WINDOWS_EXPECTED_COMMIT: 'a'.repeat(40), KCODER_E2E_WINDOWS_EXPECTED_CLI_SHA256: 'b'.repeat(64),
    AWS_SECRET_ACCESS_KEY: 'must-not-pass' };
  const child = new EventEmitter(); child.pid = 4242;
  let environment;
  const result = runNode('../integration/gateway/windows-migration.integration.mjs', { environment: expected,
    buildEnvironment: names => Object.fromEntries(names.filter(name => expected[name]).map(name => [name, expected[name]])),
    spawnChild: (_command, _args, options) => { environment = options.env; return child; },
    identityFactory: () => ({ pid: 4242 }), signalTarget: new EventEmitter(), treeAlive: async () => false });
  child.emit('exit', 0, null); assert.equal(await result, 0);
  for (const [name, value] of Object.entries(expected))
    assert.equal(environment[name], name === 'AWS_SECRET_ACCESS_KEY' ? undefined : value);
});

test("native widget IPC fixture needs its recorded production sources, not an unrelated CLI/renderer rebuild", async () => {
  await prepareSuiteArtifacts(["suites/browser/electron-widget-controller.e2e.mjs"], { run: async () => assert.fail("unrelated artifact build in native widget acceptance") });
});

test("prepares current Rust and renderer artifacts before running suites", async () => {
  const commands = [];
  await prepareSuiteArtifacts(["suites/browser/search-keyboard.e2e.mjs"], {
    run: async (command, args, cwd) => commands.push({ command, args, cwd }),
  });
  assert.deepEqual(commands.map(item => item.command), ["cargo", process.execPath, process.execPath]);
});

test("stopping waits for tree cleanup after leader exit and coalesces repeated stop requests", async () => {
  const child = new EventEmitter();
  child.pid = 4242;
  const signals = new EventEmitter();
  let cleanupResolve;
  let cleanupCalls = 0;
  let spawnedEnvironment;
  const cleanup = new Promise(resolveCleanup => { cleanupResolve = resolveCleanup; });
  const result = runNode("../integration/model/real-model-task.integration.mjs", {
    environment: {
      KCODER_E2E_SUITE_TIMEOUT_MS: "60000",
      KCODER_E2E_MODEL_CREDENTIAL_ENV: "CUSTOM_API_KEY",
      KCODER_E2E_MODEL_CREDENTIAL_VALUE: "custom-secret-value",
    },
    buildEnvironment: () => ({
      KCODER_E2E_MODEL_CREDENTIAL_ENV: "CUSTOM_API_KEY",
      KCODER_E2E_MODEL_CREDENTIAL_VALUE: "custom-secret-value",
    }),
    spawnChild: (_command, _args, options) => {
      spawnedEnvironment = options.env;
      return child;
    },
    identityFactory: () => ({ pid: 4242 }),
    signalTarget: signals,
    stopTree: async () => {
      cleanupCalls += 1;
      await cleanup;
    },
  });
  let settled = false;
  void result.then(() => { settled = true; });

  signals.emit("SIGTERM");
  await new Promise(resolveImmediate => setImmediate(resolveImmediate));
  child.emit("exit", 0, null);
  signals.emit("SIGINT");
  await new Promise(resolveImmediate => setImmediate(resolveImmediate));

  assert.equal(cleanupCalls, 1);
  assert.equal(settled, false);
  assert.equal(spawnedEnvironment.CUSTOM_API_KEY, "custom-secret-value");
  assert.equal(spawnedEnvironment.KCODER_E2E_MODEL_CREDENTIAL_VALUE, undefined);

  cleanupResolve();
  assert.equal(await result, 1);
});

test("runSuites does not start the next suite before the current cleanup settles", async () => {
  let finishFirst;
  const first = new Promise(resolveFirst => { finishFirst = resolveFirst; });
  const started = [];
  const result = runSuites(["first", "second"], {
    keepGoing: true,
    run: source => {
      started.push(source);
      return source === "first" ? first : Promise.resolve(0);
    },
  });

  await new Promise(resolveImmediate => setImmediate(resolveImmediate));
  assert.deepEqual(started, ["first"]);
  finishFirst(1);
  await new Promise(resolveImmediate => setImmediate(resolveImmediate));
  assert.deepEqual(started, ["first", "second"]);
  assert.deepEqual((await result).map(item => item.code), [1, 0]);
});

test("keep-going records a proven unstarted suite and continues without exposing the spawn error", async () => {
  const child = new EventEmitter();
  const started = [];
  const result = runSuites(["first", "second"], {
    keepGoing: true,
    run: source => {
      started.push(source);
      return source === "first" ? runNode("fixture", {
        spawnChild: () => child,
        identityFactory: () => ({ pid: null }),
        signalTarget: new EventEmitter(),
      }) : Promise.resolve(0);
    },
  });
  child.emit("error", new Error("PRIVATE_SPAWN_CANARY"));
  const rows = await result;
  assert.deepEqual(started, ["first", "second"]);
  assert.deepEqual(rows.map(({ source, code, failure }) => ({ source, code, failure })), [
    { source: "first", code: 1, failure: "not_started" },
    { source: "second", code: 0, failure: undefined },
  ]);
  assert.doesNotMatch(JSON.stringify(rows), /PRIVATE_SPAWN_CANARY/);
});

test("unconfirmed suite cleanup is summarized and prevents subsequent suites", async () => {
  const started = [];
  const rows = await runSuites(["first", "second"], {
    keepGoing: true,
    run: async source => { started.push(source); throw new Error("PRIVATE_CLEANUP_CANARY"); },
  });
  assert.deepEqual(started, ["first"]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].code, 1);
  assert.equal(rows[0].failure, "ownership_unconfirmed");
  assert.doesNotMatch(JSON.stringify(rows), /PRIVATE_CLEANUP_CANARY/);
});

test("keep-going continues after an actual child spawn ENOENT", async () => {
  const started = [];
  const missingCwd = join(tmpdir(), `kcoder-missing-suite-${randomUUID()}`);
  const rows = await runSuites(["first", "second"], {
    keepGoing: true,
    run: source => {
      started.push(source);
      return source === "first" ? runNode("fixture", {
        spawnChild: () => spawn(process.execPath, [], { cwd: missingCwd, stdio: "ignore" }),
        signalTarget: new EventEmitter(),
      }) : Promise.resolve(0);
    },
  });
  assert.deepEqual(started, ["first", "second"]);
  assert.deepEqual(rows.map(({ code, failure }) => ({ code, failure })), [
    { code: 1, failure: "not_started" }, { code: 0, failure: undefined },
  ]);
});

test("a post-spawn error waits for owned cleanup before keep-going", async () => {
  const child = new EventEmitter(); child.pid = 4242;
  const started = []; let releaseCleanup; let cleanups = 0;
  const cleanup = new Promise(resolveCleanup => { releaseCleanup = resolveCleanup; });
  const results = runSuites(["first", "second"], {
    keepGoing: true,
    run: source => {
      started.push(source);
      return source === "first" ? runNode("fixture", {
        spawnChild: () => child,
        identityFactory: () => ({ pid: 4242 }),
        signalTarget: new EventEmitter(),
        stopTree: async () => { cleanups++; await cleanup; },
      }) : Promise.resolve(0);
    },
  });
  child.emit("error", new Error("PRIVATE_POST_SPAWN_CANARY"));
  await new Promise(resolveImmediate => setImmediate(resolveImmediate));
  assert.deepEqual(started, ["first"]);
  assert.equal(cleanups, 1);
  releaseCleanup();
  assert.deepEqual((await results).map(row => row.code), [1, 0]);
  assert.deepEqual(started, ["first", "second"]);
});

test("failed owned cleanup stops keep-going and preserves a bounded failure summary", async () => {
  const child = new EventEmitter(); child.pid = 4242;
  const started = [];
  const results = runSuites(["first", "second"], {
    keepGoing: true,
    run: source => {
      started.push(source);
      return runNode("fixture", {
        spawnChild: () => child,
        identityFactory: () => ({ pid: 4242 }),
        signalTarget: new EventEmitter(),
        stopTree: async () => { throw new Error("PRIVATE_CLEANUP_CANARY"); },
      });
    },
  });
  child.emit("error", new Error("PRIVATE_POST_SPAWN_CANARY"));
  const rows = await results;
  assert.deepEqual(started, ["first"]);
  assert.equal(rows[0].failure, "ownership_unconfirmed");
  assert.doesNotMatch(JSON.stringify(rows), /PRIVATE_/);
});

test("runSuites retries only an explicitly classified transient failure and records attempts", async () => {
  const calls = [];
  const result = await runSuites(["network", "product"], {
    keepGoing: true,
    run: async source => {
      calls.push(source);
      return source === "network" && calls.filter(item => item === source).length > 1 ? 0 : 1;
    },
    shouldRetry: async source => source === "network",
  });

  assert.deepEqual(calls, ["network", "network", "product"]);
  assert.deepEqual(result.map(({ source, code, attempts }) => ({ source, code, attempts })), [
    { source: "network", code: 0, attempts: 2 },
    { source: "product", code: 1, attempts: undefined },
  ]);
});

test("a failed retry classification is reported without leaking or retrying", async () => {
  const started = [];
  const rows = await runSuites(["first", "second"], {
    keepGoing: true,
    run: async source => { started.push(source); return source === "first" ? 1 : 0; },
    shouldRetry: async () => { throw new Error("PRIVATE_RETRY_CANARY"); },
  });
  assert.deepEqual(started, ["first", "second"]);
  assert.equal(rows[0].failure, "retry_check_failed");
  assert.doesNotMatch(JSON.stringify(rows), /PRIVATE_RETRY_CANARY/);
});

test("a clean leader exit with a surviving descendant is cleaned before the next suite starts", async () => {
  const child = new EventEmitter();
  child.pid = 4343;
  const signals = new EventEmitter();
  let cleanupResolve;
  const cleanup = new Promise(resolveCleanup => { cleanupResolve = resolveCleanup; });
  const started = [];
  const first = runNode("../integration/gateway/auth-multitarget.integration.mjs", {
    environment: { KCODER_E2E_SUITE_TIMEOUT_MS: "60000" },
    buildEnvironment: () => ({}),
    spawnChild: () => child,
    identityFactory: () => ({ pid: 4343 }),
    signalTarget: signals,
    treeAlive: async () => true,
    stopTree: async () => cleanup,
  });
  const result = runSuites(["first", "second"], {
    keepGoing: true,
    run: source => {
      started.push(source);
      return source === "first" ? first : Promise.resolve(0);
    },
  });

  child.emit("exit", 0, null);
  await new Promise(resolveImmediate => setImmediate(resolveImmediate));
  assert.deepEqual(started, ["first"]);

  cleanupResolve();
  await new Promise(resolveImmediate => setImmediate(resolveImmediate));
  assert.deepEqual(started, ["first", "second"]);
  assert.deepEqual((await result).map(item => item.code), [1, 0]);
});

test("packaged acceptance never rebuilds an unrelated development runtime",async()=>{
  await prepareSuiteArtifacts(["suites/browser/packaged-desktop-smoke.e2e.mjs"],{run:async()=>assert.fail("development build in artifact acceptance")});
});

test("CA suite prepares only its owned probe and respects an explicit existing binary", async () => {
  const commands = [];
  const suite = "../integration/gateway/plugin-target-ca.integration.mjs";
  const run = async (command, args) => commands.push([command, args]);
  await prepareSuiteArtifacts([suite], { run, environment: {} });
  assert.deepEqual(commands, [["cargo", ["build", "-p", "kcoder_plugins", "--example", "plugin_target_ca_probe"]]]);
  await prepareSuiteArtifacts([suite], { run, environment: { KCODER_E2E_PLUGIN_CA_PROBE_BIN: "/owned/probe" } });
  assert.equal(commands.length, 1);
});

test("migration acceptance builds its native legacy fixture unless a fixed helper is supplied", async () => {
  const commands = [];
  const run = async (command, args) => commands.push([command, args]);
  const suite = "suites/browser/migration.e2e.mjs";
  await prepareSuiteArtifacts([suite], { run, environment: {} });
  assert.ok(commands.some(([command, args]) => command === "cargo" && args.includes("history_reinterpretation_fixture")));
  commands.length = 0;
  await prepareSuiteArtifacts([suite], { run, environment: { KCODER_MIGRATION_FIXTURE_BINARY: "/owned/frozen-helper" } });
  assert.ok(!commands.some(([, args]) => args.includes("history_reinterpretation_fixture")));
});

test("Windows identity requirements and the CA probe reach only their suite child", async () => {
  const expected = { KCODER_E2E_WINDOWS_EXPECTED_COMMIT: "a".repeat(40), KCODER_E2E_WINDOWS_EXPECTED_CLI_SHA256: "b".repeat(64), KCODER_E2E_PLUGIN_CA_PROBE_BIN: "/owned/probe", AWS_SECRET_ACCESS_KEY: "must-not-pass" };
  for (const suite of ["../integration/gateway/windows-installer-lifecycle.integration.mjs", "../integration/gateway/plugin-target-ca.integration.mjs"]) {
    const child = new EventEmitter(); child.pid = 4242;
    let environment;
    const result = runNode(suite, {
      environment: expected,
      buildEnvironment: names => Object.fromEntries(names.filter(name => expected[name]).map(name => [name, expected[name]])),
      spawnChild: (_command, _args, options) => { environment = options.env; return child; },
      identityFactory: () => ({ pid: 4242 }), signalTarget: new EventEmitter(), treeAlive: async () => false,
    });
    child.emit("exit", 0, null); assert.equal(await result, 0);
    const windows = suite.includes("windows-installer");
    assert.equal(environment.KCODER_E2E_WINDOWS_EXPECTED_COMMIT, windows ? expected.KCODER_E2E_WINDOWS_EXPECTED_COMMIT : undefined);
    assert.equal(environment.KCODER_E2E_WINDOWS_EXPECTED_CLI_SHA256, windows ? expected.KCODER_E2E_WINDOWS_EXPECTED_CLI_SHA256 : undefined);
    assert.equal(environment.KCODER_E2E_PLUGIN_CA_PROBE_BIN, windows ? undefined : "/owned/probe");
    assert.equal(environment.AWS_SECRET_ACCESS_KEY, undefined);
  }
});

test('matrix interruption waits for cleanup and prevents further suites even with keepGoing', async () => {
  const signals = new EventEmitter();
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const started = [];
  const result = runSuites(['first','second'], {
    keepGoing:true,signalTarget:signals,
    run:source=>{started.push(source);return pending;},
    shouldRetry:async()=>assert.fail('interrupted suites must not be retried'),
  });
  signals.emit('SIGTERM');
  assert.deepEqual(started,['first']);
  finish(1);
  assert.equal((await result).length,1);
  assert.deepEqual(started,['first']);
  assert.equal(signals.listenerCount('SIGTERM'),0);
  assert.equal(signals.listenerCount('SIGINT'),0);
});
