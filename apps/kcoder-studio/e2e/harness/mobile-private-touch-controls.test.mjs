import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createMobilePrivateTouchControls } from "./mobile-private-touch-controls.mjs";

// These are in-memory routing/lifecycle contracts, not browser gesture evidence.
const MOBILE_PAGE_OPTIONS = Object.freeze({ viewport: Object.freeze({ width: 390, height: 844 }),
  deviceScaleFactor: 3, isMobile: true, hasTouch: true, locale: "zh-CN" });
function controls(overrides = {}) {
  return createMobilePrivateTouchControls({ MOBILE_PAGE_OPTIONS,
    NESTED_TOUCH_CONTROL_SOURCE: Object.freeze({}),
    NESTED_TOUCH_SCROLL_CONTROL_PATH: "/owned-nested-control", TOUCH_SCROLL_CONTROL_PATH: "/owned-touch-control",
    dispatchTrustedTouchGesture: () => assert.fail("no browser gesture may run in this routing contract"),
    hashBytes: value => createHash("sha256").update(value).digest("hex"),
    safeErrorName: error => error.name,
    ...overrides,
  });
}

test("creating historical touch helpers starts no browser, filesystem build or control gesture", () => {
  let calls = 0;
  const helpers = controls({ dispatchTrustedTouchGesture() { calls++; }, hashBytes() { calls++; } });
  assert.deepEqual(Object.keys(helpers).sort(), ["buildSamePageRnwTouchControl", "measureSamePageRnwTouchControl",
    "proveOwnedNestedTouchScrollControl", "proveOwnedTouchScrollControl"]);
  assert.ok(Object.values(helpers).every(value => typeof value === "function"));
  assert.equal(calls, 0);
});

for (const [method, path] of [["proveOwnedTouchScrollControl", "/owned-touch-control"],
  ["proveOwnedNestedTouchScrollControl", "/owned-nested-control"]]) {
  test(`${method} registers its owner before navigation and serves only one exact credential-free GET`, async () => {
    const events = [], cleanups = [], navigationFailure = new Error("injected owned page navigation failure");
    let routeHandler, closed = false;
    const page = {
      isClosed: () => closed,
      async close() { closed = true; events.push("close"); },
      context: () => ({ async clearCookies() { events.push("clear-cookies"); } }),
      async route(pattern, handler) { assert.equal(pattern, "**/*"); routeHandler = handler; events.push("route"); },
      async goto(url) { assert.equal(url, "http://127.0.0.1:55001" + path); events.push("goto"); throw navigationFailure; },
    };
    const context = { addCleanup(label, action) { assert.match(label, /owned.*control page/); events.push("register-cleanup"); cleanups.push(action); } };
    const chromium = { async newPage(options) { assert.equal(options, MOBILE_PAGE_OPTIONS); events.push("new-page"); return page; } };
    await assert.rejects(controls()[method](context, chromium, { baseUrl: "http://127.0.0.1:55001/" }), error => error === navigationFailure);
    assert.deepEqual(events, ["new-page", "register-cleanup", "clear-cookies", "route", "goto"]);
    const request = async (url, verb, headers) => {
      let aborted = false, fulfilled = null;
      await routeHandler({ request: () => ({ url: () => url, method: () => verb, headers: () => headers }),
        async abort(reason) { assert.equal(reason, "blockedbyclient"); aborted = true; },
        async fulfill(value) { fulfilled = value; },
      });
      return { aborted, fulfilled };
    };
    for (const [url, verb, headers] of [["https://foreign.invalid" + path, "GET", {}],
      ["http://127.0.0.1:55001" + path, "POST", {}],
      ["http://127.0.0.1:55001" + path, "GET", { authorization: "synthetic-fixture-only" }],
      ["http://127.0.0.1:55001" + path, "GET", { cookie: "synthetic-fixture-only" }]]) {
      assert.deepEqual(await request(url, verb, headers), { aborted: true, fulfilled: null });
    }
    const accepted = await request("http://127.0.0.1:55001" + path, "GET", {});
    assert.equal(accepted.aborted, false);
    assert.equal(accepted.fulfilled.status, 200);
    assert.equal(accepted.fulfilled.contentType, "text/html; charset=utf-8");
    assert.match(accepted.fulfilled.body, /<!doctype html>/);
    assert.equal(cleanups.length, 1);
    await cleanups[0]();
    assert.equal(closed, true);
  });
}

test("RNW control rejects another page origin before reading or injecting any fixture bundle", async () => {
  const artifacts = [];
  let evaluations = 0;
  const page = {
    url: () => "https://foreign.invalid/sessions",
    async evaluate() { evaluations++; return evaluations === 1 ? "https://foreign.invalid" : undefined; },
    async route() { assert.fail("a foreign page cannot receive the control script route"); },
    async addScriptTag() { assert.fail("a foreign page cannot receive the control bundle"); },
  };
  const result = await controls().measureSamePageRnwTouchControl({
    async writeArtifactJson(name, value) { artifacts.push({ name, value }); },
  }, page, { bundlePath: "/nonexistent-owned-bundle-never-read", evidence: {} }, {}, {}, {}, "http://127.0.0.1:55001/");
  assert.equal(result.status, "error");
  assert.equal(result.errorName, "AssertionError");
  assert.equal(result.pageIdentity.originMatchesOwnedGateway, false);
  assert.equal(result.fixtureScriptRoute.requestCount, 0);
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0].name, "same-page-rnw-sessions-touch-control.json");
});
