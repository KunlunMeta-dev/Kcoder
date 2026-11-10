import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import { chromium } from "../../renderer/node_modules/@playwright/test/index.mjs";
import { sandboxedIframeIsolationArgs, startChromium } from "./chromium.mjs";
import { RunContext } from "./run-context.mjs";

const chromiumAvailable = process.platform === "linux" && process.env.KCODER_E2E_CHROMIUM_NO_SANDBOX === "1";

test("sandboxed iframe isolation test flags are a fixed whitelist and preserve the default", () => {
  assert.deepEqual(sandboxedIframeIsolationArgs(), []);
  assert.deepEqual(sandboxedIframeIsolationArgs("disabled-for-test"), ["--disable-features=IsolateSandboxedIframes"]);
  assert.deepEqual(sandboxedIframeIsolationArgs("per-document"), ["--enable-features=IsolateSandboxedIframes:grouping/per-document"]);
  for (const invalid of ["--no-sandbox", "default --disable-web-security", ["per-document"], true, null]) {
    assert.throws(() => sandboxedIframeIsolationArgs(invalid), /sandboxedIframeIsolation/);
  }
});

test("Chromium startup fault injection fails in the correct phase and stops only its owner", async t => {
  const context = await RunContext.create(import.meta.url, {
    testId: "chromium-startup-fault-injection",
    modelPolicy: "model-independent simulated process/CDP lifecycle failures; no real browser",
  });
  let failure;
  try {
    const cases = [
      { label: "spawn-error", eventError: new Error("EACCES injected spawn failure"), expected: /failed to spawn: EACCES/ },
      { label: "signal-exit", signalCode: "SIGKILL", expected: /signal SIGKILL/ },
      { label: "exit-code", exitCode: 7, expected: /code 7/ },
      { label: "invalid-port", portFile: "65536\n/devtools/browser/test-id", expected: /Timed out waiting/ },
      { label: "invalid-path", portFile: "43210\n/devtools/browser/test-id?redirect=1", expected: /Timed out waiting/ },
      { label: "connect-error", portFile: "43210\n/devtools/browser/test-id", connectError: true, expected: /injected CDP timeout/ },
      { label: "evidence-error", exitCode: 8, evidenceError: true, expected: /code 8.*evidence or cleanup also failed/s },
    ];
    for (const scenario of cases) {
      await t.test(scenario.label, async subtest => {
        try {
          const stopped = [];
          let child;
          subtest.mock.method(context, "spawnOwned", () => {
            child = Object.assign(new EventEmitter(), {
              exitCode: scenario.exitCode ?? null,
              signalCode: scenario.signalCode ?? null,
            });
            if (scenario.portFile) {
              const profile = context.pathInState("chromium", `${scenario.label}-profile`);
              mkdirSync(profile, { recursive: true, mode: 0o700 });
              writeFileSync(`${profile}/DevToolsActivePort`, scenario.portFile, { mode: 0o600 });
            }
            if (scenario.eventError) queueMicrotask(() => child.emit("error", scenario.eventError));
            return child;
          });
          subtest.mock.method(context, "stopOwned", async label => { stopped.push(label); });
          if (scenario.evidenceError) subtest.mock.method(context, "writeArtifactJson", async () => { throw new Error("injected evidence failure"); });
          const connect = subtest.mock.method(chromium, "connectOverCDP", async (endpoint, options) => {
            assert.equal(endpoint, "ws://127.0.0.1:43210/devtools/browser/test-id");
            assert.equal(options.timeout, 75);
            throw new Error("injected CDP timeout");
          });
          await assert.rejects(startChromium(context, {
            executablePath: process.execPath,
            noSandbox: true,
            label: scenario.label,
            portLabel: scenario.label,
            startTimeoutMs: 100,
            connectTimeoutMs: 75,
          }), scenario.expected);
          assert.deepEqual(stopped, [scenario.label]);
          assert.equal(child.listenerCount("error"), 0);
          assert.equal(connect.mock.callCount(), scenario.connectError ? 1 : 0);
          if (!scenario.evidenceError) {
            const evidence = JSON.parse(await readFile(context.pathInArtifacts(`${scenario.label}-startup.json`), "utf8"));
            assert.equal(evidence.phase, scenario.connectError ? "connect" : "endpoint");
            assert.match(evidence.error, scenario.expected);
          }
        } catch (error) {
          failure ??= error;
          throw error;
        }
      });
    }
    await t.test("a stalled CDP close stops its process group and retains all observed page errors", async subtest => {
      try {
        const stopped = [];
        const page = new EventEmitter();
        context.registerSecret("DUMMY_BROWSER_SECRET");
        const longSecret = `DUMMY_LONG_BROWSER_SECRET_${"x".repeat(2200)}`;
        context.registerSecret(longSecret);
        subtest.mock.method(context, "spawnOwned", () => {
          const profile = context.pathInState("chromium", "stalled-close-profile");
          mkdirSync(profile, { recursive: true, mode: 0o700 });
          writeFileSync(`${profile}/DevToolsActivePort`, "43211\n/devtools/browser/test-close", { mode: 0o600 });
          return Object.assign(new EventEmitter(), { exitCode: null, signalCode: null });
        });
        subtest.mock.method(context, "stopOwned", async label => { stopped.push(label); });
        subtest.mock.method(chromium, "connectOverCDP", async () => ({
          version: () => "simulated lifecycle only",
          newPage: async () => page,
          close: () => new Promise(() => {}),
        }));
        const browser = await startChromium(context, {
          executablePath: process.execPath, noSandbox: true, label: "stalled-close", portLabel: "stalled-close",
        });
        await browser.newPage();
        page.emit("pageerror", new Error(`first DUMMY_BROWSER_SECRET ${longSecret}`));
        page.emit("pageerror", new Error("second error"));
        page.emit("crash");
        subtest.mock.timers.enable({ apis: ["setTimeout"] });
        const close = browser.close();
        subtest.mock.timers.tick(5_001);
        await close;
        await browser.close();
        assert.deepEqual(stopped, ["stalled-close"]);
        const errors = JSON.parse(await readFile(context.pathInArtifacts("stalled-close-page-errors.json"), "utf8"));
        assert.equal(errors.length, 3);
        assert.match(errors[0].message, /first \[REDACTED\]/);
        assert.equal(errors[0].message.includes("DUMMY_LONG_BROWSER_SECRET"), false);
        assert.ok(errors[1].message.startsWith("Error: second error\n"));
        assert.ok(errors[1].message.includes("chromium.test.mjs"));
        assert.ok(errors.every(error => error.message.length <= 2000));
        assert.equal(errors[2].kind, "crash");
      } catch (error) {
        failure ??= error;
        throw error;
      }
    });
    await t.test("unbounded startup budgets are rejected before spawning", async subtest => {
      try {
        const spawn = subtest.mock.method(context, "spawnOwned", () => { throw new Error("must not spawn"); });
        for (const value of [0, -1, Infinity, NaN]) {
          await assert.rejects(startChromium(context, { connectTimeoutMs: value }), /positive finite number/);
          await assert.rejects(startChromium(context, { startTimeoutMs: value }), /positive finite number/);
        }
        assert.equal(spawn.mock.callCount(), 0);
      } catch (error) {
        failure ??= error;
        throw error;
      }
    });
  } catch (error) {
    failure = error;
  } finally {
    await context.finish(failure ? "failed" : "passed", { verified: !failure }, failure);
  }
  if (failure) throw failure;
});

test("Chromium cleanup persists page errors during RunContext.finish", async t => {
  const context = await RunContext.create(import.meta.url, {
    testId: "chromium-page-errors-during-finish",
    modelPolicy: "model-independent simulated CDP cleanup; no real browser",
  });
  const page = new EventEmitter();
  try {
    t.mock.method(context, "spawnOwned", () => {
      const profile = context.pathInState("chromium", "finish-page-errors-profile");
      mkdirSync(profile, { recursive: true, mode: 0o700 });
      writeFileSync(`${profile}/DevToolsActivePort`, "43212\n/devtools/browser/finish-page-errors", { mode: 0o600 });
      return Object.assign(new EventEmitter(), { exitCode: null, signalCode: null });
    });
    t.mock.method(context, "stopOwned", async () => {});
    t.mock.method(chromium, "connectOverCDP", async () => ({
      version: () => "simulated lifecycle only",
      newPage: async () => page,
      close: async () => {},
    }));

    const browser = await startChromium(context, {
      executablePath: process.execPath,
      noSandbox: true,
      label: "finish-page-errors",
      portLabel: "finish-page-errors",
    });
    await browser.newPage();
    const pageErrorSecret = "DUMMY_FINISH_PAGE_ERROR_SECRET";
    context.registerSecret(pageErrorSecret);
    page.emit("pageerror", new Error(`finish-time page error ${pageErrorSecret} evidence`));
    const resultPath = context.pathInArtifacts("result.json");
    const pageErrorsPath = context.pathInArtifacts("finish-page-errors-page-errors.json");
    const manifestPath = `${context.runRoot}/manifest.json`;

    let finishError;
    try {
      await context.finish("passed", { verified: true });
    } catch (error) {
      finishError = error;
    }
    assert.equal(finishError, undefined, "cleanup should persist page-error evidence without failing the run");

    const result = JSON.parse(await readFile(resultPath, "utf8"));
    assert.equal(result.status, "passed");
    assert.deepEqual(result.cleanupErrors, []);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    assert.equal(manifest.cleanupSteps.find(step => step.label === "close finish-page-errors CDP client")?.status, "completed");
    const errors = JSON.parse(await readFile(pageErrorsPath, "utf8"));
    assert.equal(errors.length, 1);
    assert.equal(errors[0].kind, "pageerror");
    assert.ok(errors[0].message.startsWith("Error: finish-time page error [REDACTED] evidence"));
    assert.ok(errors[0].message.includes("chromium.test.mjs"));
    assert.equal(JSON.stringify(errors).includes(pageErrorSecret), false, "retained page-error evidence must stay redacted");
  } finally {
    if (!context.finished) {
      await context.finish("failed", null, new Error("test interrupted before RunContext.finish completed")).catch(() => {});
    }
  }
});

test("system Chromium uses a run-owned profile, OS-selected CDP port and owned process group", {
  skip: chromiumAvailable ? false : "需要在隔离 VM 中显式设置 KCODER_E2E_CHROMIUM_NO_SANDBOX=1",
}, async () => {
  const context = await RunContext.create(import.meta.url, {
    testId: "chromium-harness-lifecycle",
    modelPolicy: "model-independent browser lifecycle check",
  });
  let failure;
  try {
    const browser = await startChromium(context);
    assert.equal(browser.executablePath, process.env.KCODER_E2E_CHROMIUM_BIN || "/usr/bin/chromium");
    const defaultArgv = (await readFile(`/proc/${browser.child.pid}/cmdline`)).toString("utf8").split("\0").filter(Boolean);
    assert.equal(defaultArgv.some(argument => argument.startsWith("--window-size=")), false);
    assert.ok(Number.isInteger(browser.cdpPort) && browser.cdpPort > 0);
    assert.equal(context.ports.find(port => port.label === "chromium-cdp")?.port, browser.cdpPort);
    assert.ok(browser.profileDir.startsWith(context.stateDir));
    const startup = JSON.parse(await readFile(context.pathInArtifacts("chromium-startup.json"), "utf8"));
    assert.equal(startup.phase, "ready");
    assert.ok(startup.version.length > 0);
    assert.ok(startup.connectedMs >= startup.endpointReadyMs);

    const page = await browser.newPage();
    await page.setContent("<main id='probe'>真实 Chromium</main><button type='button'>Run probe</button><output id='probe-result'></output><script>document.querySelector('button').addEventListener('click', () => { document.querySelector('#probe-result').textContent = 'clicked'; });</script>");
    assert.equal(await page.locator("#probe").textContent(), "真实 Chromium");
    const probeButton = page.getByRole("button", { name: "Run probe", exact: true });
    assert.equal(await probeButton.count(), 1, "the literal fixture must expose one exact probe button");
    await probeButton.click();
    assert.equal(await page.locator("#probe-result").textContent(), "clicked", "the trusted browser click must update the fixture result");
    await browser.close();
  } catch (error) {
    failure = error;
  }
  await context.finish(failure ? "failed" : "passed", { verified: !failure }, failure);
  if (failure) throw failure;

  const manifest = JSON.parse(await readFile(`${context.runRoot}/manifest.json`, "utf8"));
  assert.equal(manifest.status, "passed");
  assert.equal(manifest.processes.find(process => process.label === "chromium")?.stopped, true);
  await assert.rejects(access(`${context.runRoot}/state`));
});

test("system Chromium accepts a bounded windowSize without changing mobile viewport settings", {
  skip: chromiumAvailable ? false : "需要在隔离 VM 中显式设置 KCODER_E2E_CHROMIUM_NO_SANDBOX=1",
}, async () => {
  const context = await RunContext.create(import.meta.url, {
    testId: "chromium-explicit-window-size-contract",
    modelPolicy: "model-independent browser window-size launch argument contract",
  });
  let failure;
  try {
    await assert.rejects(
      startChromium(context, { label: "invalid-window-size", windowSize: { width: 0, height: 844 } }),
      /integers from 1 through 8192/,
    );
    assert.equal(context.processes.size, 0, "invalid windowSize must fail before an owned process is started");

    const browser = await startChromium(context, {
      label: "chromium-window-size",
      windowSize: { width: 390, height: 844 },
    });
    const argv = (await readFile(`/proc/${browser.child.pid}/cmdline`)).toString("utf8").split("\0").filter(Boolean);
    assert.equal(argv.filter(argument => argument.startsWith("--window-size=")).length, 1);
    assert.ok(argv.includes("--window-size=390,844"));

    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
    });
    await page.setContent('<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1">');
    assert.deepEqual(await page.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio,
      maxTouchPoints: navigator.maxTouchPoints,
    })), { width: 390, height: 844, devicePixelRatio: 3, maxTouchPoints: 1 });
    await browser.close();
  } catch (error) {
    failure = error;
  }
  await context.finish(failure ? "failed" : "passed", { verified: !failure }, failure);
  if (failure) throw failure;

  const manifest = JSON.parse(await readFile(`${context.runRoot}/manifest.json`, "utf8"));
  assert.equal(manifest.status, "passed");
  assert.equal(manifest.processes.find(process => process.label === "chromium-window-size")?.stopped, true);
  await assert.rejects(access(`${context.runRoot}/state`));
});
