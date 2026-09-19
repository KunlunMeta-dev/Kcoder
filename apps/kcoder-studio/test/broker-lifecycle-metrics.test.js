import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("lifecycle metrics module keeps fixed private numeric state and immutable final time", async () => {
  const module = await import("../src/broker-lifecycle-metrics.js").catch(() => ({}));
  assert.equal(typeof module.BrokerLifecycleMetrics, "function");
  let now = 10;
  const metrics = new module.BrokerLifecycleMetrics(() => now);
  const before = metrics.snapshot();
  assert.equal(before.initializeMs, null);
  assert.equal(before.lifetimeMs, null);
  assert.equal(before.resumeSuccessMsMax, null);
  assert.equal(before.resumeErrorMsMax, null);
  assert.equal(before.clientFreeMsMax, null);
  assert.deepEqual(Object.keys(metrics), []);
  now = 15;
  metrics.initialize(false);
  now = 20;
  metrics.initialize(true);
  now = 25;
  metrics.initialize(true);
  assert.equal(metrics.snapshot().initializeMs, 10);
  assert.equal(metrics.snapshot().initializeFailureCount, 1);
  for (let i = 0; i < 10_000; i += 1) metrics.attach(false);
  const snapshot = metrics.snapshot();
  assert.equal(snapshot.attachCount, 10_000);
  assert.equal(Object.keys(snapshot).length, Object.keys(before).length);
  snapshot.attachCount = -1;
  assert.equal(metrics.snapshot().attachCount, 10_000);
  assert.equal(metrics.close(), true);
  now = 100;
  assert.equal(metrics.close(), false);
  assert.equal(metrics.snapshot().lifetimeMs, 15);
  assert.ok(Object.values(metrics.snapshot()).every(v => v === null || Number.isFinite(v)));
});

test("lifecycle metrics Gateway close observer writes one redacted stderr JSON summary", async () => {
  // Execute only the composition-root callback, never the server startup module.
  const source = await readFile(new URL("../dev-server.mjs", import.meta.url), "utf8");
  const callback = source.match(/onLifecycleMetrics: \(metrics\) => \{([\s\S]*?)\n    \},\n    onRestart:/);
  assert.ok(callback, "Gateway must connect the internal lifecycle observer");
  for (const transport of ["local", "ssh"]) {
    const lines = [];
    const observer = new Function("metrics", "target", "workspaceAppServerBrokers", "process", callback[1]);
    observer({ initializeMs: null, attachCount: 2, closedCount: 1 },
      { transport, id: "secret-server", endpoint: "secret-endpoint", workspace: "/secret", pid: 999, token: "secret-token" },
      new Map([["secret-a", new Set([{}, {}])], ["secret-b", new Set([{}])]]),
      { stderr: { write: line => lines.push(line) } });
    assert.equal(lines.length, 1);
    assert.equal(lines[0].split("\n").length, 2);
    assert.deepEqual(JSON.parse(lines[0]), {
      event: "broker-lifecycle", transport, brokerCount: 3,
      initializeMs: null, attachCount: 2, closedCount: 1,
    });
    assert.doesNotMatch(lines[0], /secret|endpoint|serverId|workspace|pid|token/i);
  }
});
