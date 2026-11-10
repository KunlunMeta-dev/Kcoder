import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { createChromiumLauncher } from "./chromium.mjs";

function makePage(source) {
  return {
    source,
    listeners: [],
    closeCalls: 0,
    on(event, listener) { this.listeners.push({ event, listener }); },
    async close() { this.closeCalls += 1; },
  };
}

function makeBrowser() {
  const persistentPageCalls = [];
  const regularPageCalls = [];
  const persistentContext = {
    async newPage(options) {
      persistentPageCalls.push(options);
      return makePage("persistent-default-context");
    },
  };
  const contexts = [persistentContext];
  return {
    persistentContext,
    persistentPageCalls,
    regularPageCalls,
    contexts: () => [...contexts],
    async newPage(options) {
      regularPageCalls.push(options);
      contexts.push({ newPage: async () => makePage("incognito-context") });
      return makePage("incognito-context");
    },
    closeCalls: 0,
    async close() { this.closeCalls += 1; },
  };
}

async function makeHarness(t, { beforeSpawn, afterSpawn, connectedContexts, connectionFailureAt } = {}) {
  const root = await mkdtemp(join(tmpdir(), "kcoder-chromium-profile-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDir = join(root, "state");
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const cleanups = [];
  const processes = new Map();
  const ports = [];
  const profiles = [];
  const browsers = [];
  const connectionAttempts = [];
  const stopCalls = [];
  let spawnCount = 0;
  const context = {
    runRoot: root,
    stateDir,
    cleanups,
    processes,
    ports,
    profiles,
    pathInState(...parts) { return resolve(stateDir, ...parts); },
    registerPort(label, port) { ports.push({ label, port }); },
    registerTemporaryDirectory(label, path) { profiles.push({ label, path }); },
    isolatedEnvironment(overrides = {}) { return overrides; },
    addCleanup(label, callback) { cleanups.push({ label, callback }); },
    async writeArtifactJson() {},
    redactText(value) { return value; },
    spawnOwned(label, command, args) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(label)) {
        throw new Error(`invalid owned process label: ${label}`);
      }
      if (processes.has(label)) throw new Error(`owned process label already registered: ${label}`);
      const number = ++spawnCount;
      const profileArg = args.find(argument => argument.startsWith("--user-data-dir="));
      const profileDir = profileArg.slice("--user-data-dir=".length);
      beforeSpawn?.({ label, profileDir, number });
      const activePortFile = join(profileDir, "DevToolsActivePort");
      const child = createMockOwnedProcess(context, label, number, activePortFile);
      afterSpawn?.({ label, profileDir, activePortFile, number });
      return child;
    },
    async stopOwned(label) {
      const record = processes.get(label);
      if (!record || record.stopped) return;
      stopCalls.push(label);
      record.child.exitCode = 0;
      record.stopped = true;
      record.stopPromise = Promise.resolve();
    },
  };
  const chromiumDriver = {
    async connectOverCDP(endpoint) {
      connectionAttempts.push(endpoint);
      if (connectionAttempts.length === connectionFailureAt) throw new Error("mock WebSocket handshake failure");
      const browser = makeBrowser();
      const selectedContexts = connectedContexts?.(browser) ?? browser.contexts();
      browser.contexts = () => [...selectedContexts];
      browsers.push({ browser, endpoint });
      return browser;
    },
  };
  const launcher = createChromiumLauncher({
    chromiumDriver,
    resolveExecutable: async path => path,
  });
  return { context, launcher, chromiumDriver, browsers, connectionAttempts, stopCalls, ports, stateDir, get spawnCount() { return spawnCount; } };
}

function deferred() {
  let resolveDeferred;
  let rejectDeferred;
  const promise = new Promise((resolve, reject) => {
    resolveDeferred = resolve;
    rejectDeferred = reject;
  });
  return { promise, resolve: resolveDeferred, reject: rejectDeferred };
}

async function observePromiseWithin(promise, timeoutMs = 100) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve(promise).then(value => ({ value }), error => ({ error })),
      new Promise(resolveTimeout => {
        timer = setTimeout(() => resolveTimeout({ timedOut: true }), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function createMockOwnedProcess(context, label, number, activePortFile) {
  const child = { pid: 4000 + number, exitCode: null };
  const record = { label, child, stopped: false, stopPromise: null };
  context.processes.set(label, record);
  context.addCleanup(`stop process ${label}`, () => context.stopOwned(label));
  const port = 42_000 + number;
  const wsId = `owned-${number}`;
  writeFileSync(activePortFile, `${port}\n/devtools/browser/${wsId}\n`, { mode: 0o600 });
  return child;
}

test("reuses one captured default context while legacy newPage remains isolated", async t => {
  const harness = await makeHarness(t);
  const browser = await harness.launcher(harness.context, {
    label: "cold-open-a",
    profileName: "shared-profile",
    noSandbox: true,
  });
  assert.equal(browser.profileDir, harness.context.pathInState("chromium", "shared-profile-profile"));
  assert.equal(harness.connectionAttempts[0], "ws://127.0.0.1:42001/devtools/browser/owned-1");
  assert.equal(harness.ports[0].label, "chromium-cdp", "the default CDP port label remains compatible");
  const regularPage = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const persistentPage = await browser.newPersistentPage();

  assert.equal(harness.browsers[0].browser.regularPageCalls.length, 1);
  assert.equal(harness.browsers[0].browser.persistentPageCalls.length, 1);
  assert.equal(harness.browsers[0].browser.persistentPageCalls[0], undefined, "BrowserContext.newPage is called without unsupported options");
  assert.equal(regularPage.source, "incognito-context");
  assert.equal(persistentPage.source, "persistent-default-context", "newPersistentPage must retain the captured default context after newPage creates incognito state");
  assert.ok(regularPage.listeners.length > 0);
  assert.ok(persistentPage.listeners.length > 0);
  const wrapperCleanup = harness.context.cleanups.find(item => item.label === "close cold-open-a CDP client");
  assert.ok(wrapperCleanup, "the RunContext cleanup must use the browser wrapper close callback");
  await wrapperCleanup.callback();
  assert.equal(harness.context.processes.get("cold-open-a")?.stopped, true);
  await browser.close();
});

test("a timed-out WebSocket handshake leaves the peer profile owned and the failed profile retryable", async t => {
  const harness = await makeHarness(t, { connectionFailureAt: 2 });
  const peer = await harness.launcher(harness.context, {
    label: "ws-peer-owner",
    profileName: "ws-peer-profile",
    noSandbox: true,
  });
  const peerRecord = harness.context.processes.get("ws-peer-owner");

  await assert.rejects(harness.launcher(harness.context, {
    label: "ws-failed-owner",
    profileName: "ws-failed-profile",
    noSandbox: true,
    startTimeoutMs: 1,
  }), /CDP endpoint never became ready/);
  assert.deepEqual(harness.connectionAttempts.slice(0, 2), [
    "ws://127.0.0.1:42001/devtools/browser/owned-1",
    "ws://127.0.0.1:42002/devtools/browser/owned-2",
  ]);
  assert.strictEqual(harness.context.processes.get("ws-peer-owner"), peerRecord);
  assert.equal(peerRecord.stopped, false, "a failed WebSocket connection must not stop its peer owner");
  assert.equal(harness.context.processes.get("ws-failed-owner")?.stopped, true,
    "the timeout must stop only the child owned by the failed launch");
  await assert.rejects(harness.launcher(harness.context, {
    label: "ws-peer-replacement",
    profileName: "ws-peer-profile",
    noSandbox: true,
  }), /profile.*already owned/i);

  const retry = await harness.launcher(harness.context, {
    label: "ws-failed-retry",
    profileName: "ws-failed-profile",
    noSandbox: true,
  });
  assert.equal(harness.connectionAttempts[2], "ws://127.0.0.1:42003/devtools/browser/owned-3");
  assert.equal(peerRecord.stopped, false);
  await retry.close();
  await peer.close();
});

test("a never-settling CDP connect has a deadline and stops only its exact owner", async t => {
  const harness = await makeHarness(t);
  const peer = await harness.launcher(harness.context, {
    label: "hung-connect-peer",
    profileName: "hung-connect-peer-profile",
    noSandbox: true,
  });
  const peerRecord = harness.context.processes.get("hung-connect-peer");
  const normalConnect = harness.chromiumDriver.connectOverCDP;
  harness.chromiumDriver.connectOverCDP = endpoint => {
    harness.connectionAttempts.push(endpoint);
    return new Promise(() => {});
  };

  const outcome = await observePromiseWithin(harness.launcher(harness.context, {
    label: "hung-connect-owner",
    profileName: "hung-connect-profile",
    noSandbox: true,
    startTimeoutMs: 10,
  }));

  assert.equal(outcome.timedOut, undefined, "a hung CDP connect must not defeat the startup deadline");
  assert.ok(outcome.error, "a timed-out CDP connect must fail startup");
  assert.match(outcome.error.message, /CDP endpoint never became ready/);
  assert.deepEqual(harness.stopCalls, ["hung-connect-owner"]);
  assert.equal(harness.context.processes.get("hung-connect-owner")?.stopped, true);
  assert.strictEqual(harness.context.processes.get("hung-connect-peer"), peerRecord);
  assert.equal(peerRecord.stopped, false, "a connect timeout must leave the peer process alive");

  harness.chromiumDriver.connectOverCDP = normalConnect;
  const retry = await harness.launcher(harness.context, {
    label: "hung-connect-retry",
    profileName: "hung-connect-profile",
    noSandbox: true,
  });
  await retry.close();
  await peer.close();
});

test("a late CDP browser is closed after timeout cleanup", async t => {
  const harness = await makeHarness(t);
  const pendingBrowser = deferred();
  const lateBrowser = makeBrowser();
  const browserClosed = deferred();
  lateBrowser.close = async () => {
    lateBrowser.closeCalls += 1;
    browserClosed.resolve();
  };
  harness.chromiumDriver.connectOverCDP = endpoint => {
    harness.connectionAttempts.push(endpoint);
    return pendingBrowser.promise;
  };

  const outcome = await observePromiseWithin(harness.launcher(harness.context, {
    label: "late-connect-owner",
    profileName: "late-connect-profile",
    noSandbox: true,
    startTimeoutMs: 10,
  }));
  assert.equal(outcome.timedOut, undefined, "the connect deadline must stop waiting for an unsettled browser handle");
  assert.ok(outcome.error, "the pending connect must time out");
  assert.deepEqual(harness.stopCalls, ["late-connect-owner"]);
  assert.equal(harness.context.processes.get("late-connect-owner")?.stopped, true);

  pendingBrowser.resolve(lateBrowser);
  const lateClose = await observePromiseWithin(browserClosed.promise);
  assert.equal(lateClose.timedOut, undefined, "the late browser handle must be closed");
  assert.equal(lateBrowser.closeCalls, 1);
});

for (const pageMethod of ["newPage", "newPersistentPage"]) {
  test(`${pageMethod} has a deadline, cleans only its owner, and closes a late page`, async t => {
    const harness = await makeHarness(t);
    const browser = await harness.launcher(harness.context, {
      label: `${pageMethod}-owner`,
      profileName: `${pageMethod}-profile`,
      noSandbox: true,
      pageTimeoutMs: 10,
      closeTimeoutMs: 10,
    });
    const record = harness.context.processes.get(`${pageMethod}-owner`);
    const pendingPage = deferred();
    const latePage = makePage(`late-${pageMethod}`);
    const latePageClosed = deferred();
    latePage.close = async () => {
      latePage.closeCalls += 1;
      latePageClosed.resolve();
    };
    const browserRecord = harness.browsers[0].browser;
    if (pageMethod === "newPage") browserRecord.newPage = () => pendingPage.promise;
    else browserRecord.persistentContext.newPage = () => pendingPage.promise;

    const outcome = await observePromiseWithin(browser[pageMethod]());
    assert.equal(outcome.timedOut, undefined, `${pageMethod} must not wait forever for page creation`);
    assert.ok(outcome.error, `${pageMethod} must reject when its deadline expires`);
    assert.match(outcome.error.message, /timed out/i);
    assert.deepEqual(harness.stopCalls, [`${pageMethod}-owner`]);
    assert.equal(record.stopped, true);

    pendingPage.resolve(latePage);
    const lateClose = await observePromiseWithin(latePageClosed.promise);
    assert.equal(lateClose.timedOut, undefined, `a page returned after ${pageMethod} timeout must be closed`);
    assert.equal(latePage.closeCalls, 1);
  });
}

test("a never-settling Browser.close is bounded and still stops the owned process", async t => {
  const harness = await makeHarness(t);
  const browser = await harness.launcher(harness.context, {
    label: "hung-close-owner",
    profileName: "hung-close-profile",
    noSandbox: true,
    closeTimeoutMs: 10,
  });
  const record = harness.context.processes.get("hung-close-owner");
  harness.browsers[0].browser.close = () => new Promise(() => {});

  const outcome = await observePromiseWithin(browser.close());
  assert.equal(outcome.timedOut, undefined, "a hung Browser.close must not block owned process cleanup");
  assert.ok(outcome.error, "a bounded Browser.close timeout must stay visible");
  assert.match(outcome.error.message, /timed out/i);
  assert.deepEqual(harness.stopCalls, ["hung-close-owner"]);
  assert.equal(record.stopped, true, "owned process cleanup must run after Browser.close times out");

  const retry = await harness.launcher(harness.context, {
    label: "hung-close-retry",
    profileName: "hung-close-profile",
    noSandbox: true,
  });
  await retry.close();
});

test("late owned cleanup refuses to stop a replacement process record with the same label", async t => {
  const harness = await makeHarness(t);
  const browser = await harness.launcher(harness.context, {
    label: "aba-owner",
    profileName: "aba-profile",
    noSandbox: true,
  });
  const originalRecord = harness.context.processes.get("aba-owner");
  const replacementRecord = {
    label: "aba-owner",
    child: { pid: 4999, exitCode: null, signalCode: null },
    stopped: false,
    stopPromise: null,
  };
  harness.context.processes.set("aba-owner", replacementRecord);

  const outcome = await observePromiseWithin(browser.close());
  assert.ok(outcome.error, "cleanup must reject when the label now points to a different owner");
  assert.match(outcome.error.message, /record changed|identity changed|exact owner/i);
  assert.strictEqual(harness.context.processes.get("aba-owner"), replacementRecord);
  assert.equal(replacementRecord.stopped, false, "cleanup must not stop a replacement record by label");
  assert.deepEqual(harness.stopCalls, [], "stopOwned must not run for a mismatched record");
  await assert.rejects(harness.launcher(harness.context, {
    label: "aba-profile-retry",
    profileName: "aba-profile",
    noSandbox: true,
  }), /profile.*already owned/i);

  harness.context.processes.set("aba-owner", originalRecord);
  await browser.close();
});

test("an owned persistent profile cannot launch twice until its exact owner closes", async t => {
  const harness = await makeHarness(t);
  const first = await harness.launcher(harness.context, {
    label: "first-label",
    profileName: "same-profile",
    noSandbox: true,
  });
  await assert.rejects(
    harness.launcher(harness.context, {
      label: "second-label",
      profileName: "same-profile",
      noSandbox: true,
    }),
    /profile.*already owned/i,
  );
  assert.equal(harness.spawnCount, 1);

  await first.close();
  const second = await harness.launcher(harness.context, {
    label: "second-label",
    profileName: "same-profile",
    noSandbox: true,
  });
  assert.equal(harness.spawnCount, 2);
  await second.close();
});

test("a failed owned-process stop keeps the profile lease and reports cleanup failure", async t => {
  const harness = await makeHarness(t);
  const browser = await harness.launcher(harness.context, {
    label: "stop-fails",
    profileName: "leased-profile",
    noSandbox: true,
  });
  harness.context.stopOwned = async label => {
    const record = harness.context.processes.get(label);
    record.stopped = true;
    record.stopPromise = Promise.reject(new Error("owned tree exit unconfirmed"));
    await record.stopPromise;
  };

  await assert.rejects(browser.close(), /owned tree exit unconfirmed/);
  await assert.rejects(
    harness.launcher(harness.context, {
      label: "replacement-label",
      profileName: "leased-profile",
      noSandbox: true,
    }),
    /profile.*already owned/i,
  );
  assert.equal(harness.spawnCount, 1);
});

test("a signal-terminated child releases its profile after RunContext confirms tree exit", async t => {
  const harness = await makeHarness(t);
  const browser = await harness.launcher(harness.context, {
    label: "signal-stopped-owner",
    profileName: "signal-stopped-profile",
    noSandbox: true,
  });
  harness.context.stopOwned = async label => {
    const record = harness.context.processes.get(label);
    record.child.exitCode = null;
    record.child.signalCode = "SIGTERM";
    record.stopped = true;
    record.stopPromise = Promise.resolve();
  };

  await browser.close();
  const retry = await harness.launcher(harness.context, {
    label: "signal-stopped-retry",
    profileName: "signal-stopped-profile",
    noSandbox: true,
  });
  assert.equal(harness.spawnCount, 2);
  await retry.close();
});

test("a duplicate owned-process label does not stop its peer or strand a profile lease", async t => {
  const harness = await makeHarness(t);
  const peer = await harness.launcher(harness.context, {
    label: "already-owned-label",
    profileName: "peer-profile",
    noSandbox: true,
  });
  const peerRecord = harness.context.processes.get("already-owned-label");

  await assert.rejects(
    harness.launcher(harness.context, {
      label: "already-owned-label",
      profileName: "retryable-profile",
      noSandbox: true,
    }),
    /owned process label already registered/,
  );
  assert.strictEqual(harness.context.processes.get("already-owned-label"), peerRecord);
  assert.equal(peerRecord.stopped, false, "a failed duplicate attempt must not stop another owner's process");

  const retry = await harness.launcher(harness.context, {
    label: "retry-after-duplicate",
    profileName: "retryable-profile",
    noSandbox: true,
  });
  assert.equal(harness.spawnCount, 2, "the profile lease is released after the rejected synchronous spawn");
  assert.equal(peerRecord.stopped, false, "retrying a different profile owner must leave the peer alive");
  await retry.close();
  await peer.close();
});

test("external stopOwned does not release a persistent profile before wrapper cleanup", async t => {
  const harness = await makeHarness(t);
  const first = await harness.launcher(harness.context, {
    label: "external-stop-owner",
    profileName: "externally-stopped-profile",
    noSandbox: true,
  });
  await harness.context.stopOwned("external-stop-owner");
  await assert.rejects(
    harness.launcher(harness.context, {
      label: "must-still-be-locked",
      profileName: "externally-stopped-profile",
      noSandbox: true,
    }),
    /profile.*already owned/i,
  );
  await first.close();
  const next = await harness.launcher(harness.context, {
    label: "after-wrapper-close",
    profileName: "externally-stopped-profile",
    noSandbox: true,
  });
  await next.close();
});

test("a transport close error stays visible and can be retried after the owned tree stops", async t => {
  const harness = await makeHarness(t);
  const first = await harness.launcher(harness.context, {
    label: "transport-retry-owner",
    profileName: "transport-retry-profile",
    noSandbox: true,
  });
  let closeAttempts = 0;
  harness.browsers[0].browser.close = async () => {
    closeAttempts += 1;
    if (closeAttempts === 1) throw new Error("CDP close transport failed");
  };

  await assert.rejects(first.close(), /CDP close transport failed/);
  assert.equal(harness.context.processes.get("transport-retry-owner")?.stopped, true);
  await first.close();
  assert.equal(closeAttempts, 2);
});

test("stale owned DevToolsActivePort is removed before a different process label starts", async t => {
  const spawnObservations = [];
  const harness = await makeHarness(t, {
    beforeSpawn({ profileDir, number }) {
      const hasActivePort = existsSync(join(profileDir, "DevToolsActivePort"));
      spawnObservations.push({ number, hasActivePort });
      assert.equal(hasActivePort, false, "stale DevToolsActivePort must be removed before spawn");
      return profileDir;
    },
  });
  const first = await harness.launcher(harness.context, {
    label: "first-owner",
    profileName: "durable-profile",
    noSandbox: true,
  });
  const activePortFile = join(first.profileDir, "DevToolsActivePort");
  await first.close();
  assert.match(await readFile(activePortFile, "utf8"), /devtools\/browser\/owned-1/);

  const second = await harness.launcher(harness.context, {
    label: "second-owner",
    profileName: "durable-profile",
    noSandbox: true,
  });
  assert.equal(spawnObservations.length, 2);
  assert.match(await readFile(activePortFile, "utf8"), /devtools\/browser\/owned-2/);
  await second.close();
});

test("rejects a symlinked stale DevToolsActivePort without launching Chromium", async t => {
  const harness = await makeHarness(t);
  const profileDir = harness.context.pathInState("chromium", "unsafe-profile-profile");
  await mkdir(profileDir, { recursive: true, mode: 0o700 });
  await writeFile(join(profileDir, "outside-target"), "43000\n/devtools/browser/external\n", { mode: 0o600 });
  await rm(join(profileDir, "DevToolsActivePort"), { force: true });
  await symlink(join(profileDir, "outside-target"), join(profileDir, "DevToolsActivePort"));

  await assert.rejects(
    harness.launcher(harness.context, {
      label: "reject-symlink",
      profileName: "unsafe-profile",
      noSandbox: true,
    }),
    /unsafe.*DevToolsActivePort|symbolic link/i,
  );
  assert.equal(harness.spawnCount, 0, "an unsafe stale endpoint must be rejected before launch");
});

test("rejects a symlinked DevToolsActivePort during readiness and stops the exact owned child", async t => {
  const harness = await makeHarness(t, {
    afterSpawn({ profileDir, activePortFile }) {
      const target = join(profileDir, "outside-active-port");
      writeFileSync(target, "43001\n/devtools/browser/foreign\n", { mode: 0o600 });
      unlinkSync(activePortFile);
      symlinkSync(target, activePortFile);
    },
  });
  await assert.rejects(
    harness.launcher(harness.context, {
      label: "read-symlink",
      profileName: "read-symlink-profile",
      noSandbox: true,
    }),
    /unsafe.*DevToolsActivePort|symbolic link/i,
  );
  assert.equal(harness.spawnCount, 1);
  assert.equal(harness.context.processes.get("read-symlink")?.stopped, true, "the startup failure must stop only its own child");
});

test("profile names cannot select an arbitrary filesystem path", async t => {
  const harness = await makeHarness(t);
  await assert.rejects(
    harness.launcher(harness.context, {
      label: "path-traversal",
      profileName: "../outside",
      noSandbox: true,
    }),
    /safe RunContext profile slug/,
  );
  assert.equal(harness.spawnCount, 0);
});

test("fails closed when the connected browser has more than one initial context", async t => {
  const harness = await makeHarness(t, {
    connectedContexts: browser => [...browser.contexts(), { newPage: async () => makePage() }],
  });
  await assert.rejects(
    harness.launcher(harness.context, {
      label: "ambiguous-default-context",
      profileName: "ambiguous-profile",
      noSandbox: true,
    }),
    /exactly one default context/i,
  );
  assert.equal(harness.context.processes.get("ambiguous-default-context")?.stopped, true);
});
