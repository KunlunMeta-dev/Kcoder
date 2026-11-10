import assert from "node:assert/strict";
import test from "node:test";
import { setupCacheTimingSamplePage } from "./mobile-cache-timing-sample-setup.mjs";

function setupFixture({ bridgeError = null } = {}) {
  const order = [];
  const listeners = new Map();
  const browserErrors = [];
  const protocol = { owner: "fixture-protocol" };
  const context = { redactText: value => `[redacted] ${value}` };
  const key = new Uint8Array(32).fill(19);
  const traffic = { dispose: async () => order.push("dispose-traffic") };
  const routeOptions = [];
  const bridgeArgs = [];
  const page = {
    async setViewportSize(size) { order.push(["viewport", size]); },
    on(event, listener) { listeners.set(event, listener); order.push(["listener", event]); },
    async route(pattern, handler) {
      order.push(["route", pattern]);
      routeOptions.push(handler);
      await handler({ continue: async () => order.push("continue") });
    },
    async goto(url) { order.push(["goto", url]); },
  };
  const resources = { page: null, traffic: null };
  const dependencies = {
    createSamplePage: async () => { order.push("persistent-page-factory"); return page; },
    onPage: value => { resources.page = value; order.push("own-page"); },
    onTraffic: value => { resources.traffic = value; order.push("own-traffic"); },
    context,
    browserErrors,
    protocol,
    promptMarker: "PROMPT-MARKER",
    replacementMarker: "REPLACEMENT-MARKER",
    clientMessageIdHashKey: key,
    tailMarker: "TAIL-MARKER",
    installTelemetry: async (actualPage, options) => {
      assert.strictEqual(actualPage, page);
      assert.deepEqual(options, { tailMarker: "TAIL-MARKER" });
      order.push("install-telemetry");
      return traffic;
    },
    installResumeBridge: async (...args) => {
      bridgeArgs.push(args);
      order.push("install-resume-bridge");
      if (bridgeError) throw bridgeError;
    },
  };
  return { order, listeners, browserErrors, protocol, context, key, traffic, routeOptions, bridgeArgs, page, resources, dependencies };
}

test("sets up an owned persistent sample page and forwards the per-run HMAC key before navigation", async () => {
  const fixture = setupFixture();
  const returnedPage = await setupCacheTimingSamplePage(fixture.dependencies);
  await returnedPage.goto("http://gateway.test/mobile/");

  assert.strictEqual(returnedPage, fixture.page);
  assert.strictEqual(fixture.resources.page, fixture.page);
  assert.strictEqual(fixture.resources.traffic, fixture.traffic);
  assert.deepEqual(fixture.order.map(entry => Array.isArray(entry) ? entry[0] : entry), [
    "persistent-page-factory", "own-page", "viewport", "listener", "listener", "route", "continue",
    "install-telemetry", "own-traffic", "install-resume-bridge", "goto",
  ]);
  assert.deepEqual(fixture.order.find(entry => Array.isArray(entry) && entry[0] === "viewport")[1], { width: 390, height: 844 });
  assert.deepEqual(fixture.order.find(entry => Array.isArray(entry) && entry[0] === "route"), ["route", "**/*"]);
  assert.equal(fixture.routeOptions.length, 1);
  assert.strictEqual(fixture.bridgeArgs[0][0], fixture.page);
  assert.strictEqual(fixture.bridgeArgs[0][1], fixture.protocol);
  assert.equal(fixture.bridgeArgs[0][2], "PROMPT-MARKER");
  assert.equal(fixture.bridgeArgs[0][3], "REPLACEMENT-MARKER");
  assert.strictEqual(fixture.bridgeArgs[0][4], fixture.context);
  assert.strictEqual(fixture.bridgeArgs[0][5], fixture.key);
  assert.strictEqual(fixture.bridgeArgs[0][6], fixture.traffic);

  fixture.listeners.get("pageerror")(new Error("page secret"));
  fixture.listeners.get("console")({ type: () => "error", text: () => "console secret" });
  fixture.listeners.get("console")({ type: () => "log", text: () => "ignored" });
  assert.deepEqual(fixture.browserErrors, ["[redacted] page secret", "[redacted] console secret"]);
});

test("publishes page and telemetry ownership before bridge setup can fail", async () => {
  const expected = new Error("bridge setup failure");
  const fixture = setupFixture({ bridgeError: expected });
  await assert.rejects(setupCacheTimingSamplePage(fixture.dependencies), error => error === expected);
  assert.strictEqual(fixture.resources.page, fixture.page);
  assert.strictEqual(fixture.resources.traffic, fixture.traffic);
  assert.ok(fixture.order.indexOf("own-page") < fixture.order.indexOf("install-telemetry"));
  assert.ok(fixture.order.indexOf("own-traffic") < fixture.order.indexOf("install-resume-bridge"));
});
