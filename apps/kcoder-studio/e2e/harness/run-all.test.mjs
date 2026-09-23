import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { prepareSuiteArtifacts, runNode, runSuites } from "../run-all.mjs";

test("prepares current Rust and renderer artifacts before running suites", async () => {
  const commands = [];
  await prepareSuiteArtifacts(["suites/mobile/mobile-real-thread-lifecycle.e2e.mjs"], {
    run: async (command, args, cwd) => commands.push({ command, args, cwd }),
  });
  assert.deepEqual(commands.map(item => [item.command, item.args]), [
    ["cargo", ["build", "-p", "kcoder_cli", "--bin", "kcoder"]],
    [process.execPath, ["node_modules/typescript/bin/tsc", "-b"]],
    [process.execPath, ["node_modules/vite/bin/vite.js", "build"]],
    ["npm", ["run", "build:web"]],
  ]);

  commands.length = 0;
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
  const result = runNode("suites/model/real-model-task.e2e.mjs", {
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

test("a clean leader exit with a surviving descendant is cleaned before the next suite starts", async () => {
  const child = new EventEmitter();
  child.pid = 4343;
  const signals = new EventEmitter();
  let cleanupResolve;
  const cleanup = new Promise(resolveCleanup => { cleanupResolve = resolveCleanup; });
  const started = [];
  const first = runNode("suites/gateway/auth-multitarget.e2e.mjs", {
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
  const suite = "suites/gateway/plugin-target-ca.e2e.mjs";
  const run = async (command, args) => commands.push([command, args]);
  await prepareSuiteArtifacts([suite], { run, environment: {} });
  assert.deepEqual(commands, [["cargo", ["build", "-p", "kcoder_plugins", "--example", "plugin_target_ca_probe"]]]);
  await prepareSuiteArtifacts([suite], { run, environment: { KCODER_E2E_PLUGIN_CA_PROBE_BIN: "/owned/probe" } });
  assert.equal(commands.length, 1);
});

test("Windows identity requirements and the CA probe reach only their suite child", async () => {
  const expected = { KCODER_E2E_WINDOWS_EXPECTED_COMMIT: "a".repeat(40), KCODER_E2E_WINDOWS_EXPECTED_CLI_SHA256: "b".repeat(64), KCODER_E2E_PLUGIN_CA_PROBE_BIN: "/owned/probe", AWS_SECRET_ACCESS_KEY: "must-not-pass" };
  for (const suite of ["suites/gateway/windows-installer-lifecycle.e2e.mjs", "suites/gateway/plugin-target-ca.e2e.mjs"]) {
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
