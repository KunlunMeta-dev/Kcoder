import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { basename } from "node:path";
import test from "node:test";
import { createPrivateRefreshSourceInputs } from "./private-mobile-refresh-source-inputs.mjs";
import { createPrivateMatrixRefreshNetwork } from "./private-mobile-refresh-matrix-network.mjs";
import { createPrivateRelativeRefreshNetwork } from "./private-mobile-refresh-relative-network.mjs";
import { createPrivateMatrixRefreshFaults } from "./private-mobile-refresh-matrix-faults.mjs";
import { createPrivateRelativeRefreshFaults } from "./private-mobile-refresh-relative-faults.mjs";

// Synthetic routing/events verify mechanism contracts; these are not Browser or historical performance evidence.
const sha256 = value => createHash("sha256").update(value).digest("hex");
const variants = [["matrix", createPrivateMatrixRefreshNetwork, createPrivateMatrixRefreshFaults],
  ["relative", createPrivateRelativeRefreshNetwork, createPrivateRelativeRefreshFaults]];

test("private candidate factories retain separate closures and start no owned resource", () => {
  let calls = 0;
  const dependencies = new Proxy({}, { get() { return () => { calls++; assert.fail("construction cannot start resources"); }; } });
  assert.equal(Object.keys(createPrivateRefreshSourceInputs(dependencies)).length, 30);
  for (const [, network, faults] of variants) {
    assert.equal(Object.keys(network(dependencies)).length, 10);
    assert.equal(Object.keys(faults(dependencies)).length, 12);
  }
  assert.equal(calls, 0);
});

test("shared private snapshot inputs preserve original credential/generated exclusions and runtime identity", () => {
  const inputs = createPrivateRefreshSourceInputs({ assert, basename });
  for (const path of ["/fixture/.env", "/fixture/cert.pem", "/fixture/private.key"])
    assert.equal(inputs.sourceSnapshotFilter(path), false);
  for (const name of ["credentials.json", "account_credentials.json", ".npmrc", "auth-secret.json"])
    assert.equal(inputs.dependencySnapshotExcluded(name, false), true);
  assert.equal(inputs.sourceSnapshotExcluded("target", true), true);
  const before = { sourceDigest: "source", dependencyDigest: "deps", nodeExecutable: "owned-node",
    nodeVersion: "owned-version", kcoderBinaryPath: "owned-native", kcoderBinaryStat: { inode: 1 }, runtimeInputs: ["owned-runtime"] };
  assert.equal(inputs.gatewayRuntimeStable(before, structuredClone(before)), true);
  assert.equal(inputs.gatewayRuntimeStable(before, { ...before, dependencyDigest: "changed" }), false);
  assert.equal(inputs.gatewayRuntimeStable(before, { ...before, kcoderBinaryStat: { inode: 2 } }), false);
});

for (const [name, networkFactory, faultsFactory] of variants) {
  test(`${name} request observation settles only the matching socket and omits arbitrary payloads`, () => {
    const network = networkFactory({ sanitizeGatewayPath: value => value.split("?")[0] });
    const event = (routeSocketId, direction, atEpochMs) => ({ routeSocketId, direction, atEpochMs,
      method: "thread/read", hasId: true, rpcIdFingerprint: "same-request-id", path: "/route?ignored=private",
      requestBody: "SYNTHETIC_OWNED_BODY_MUST_NOT_APPEAR" });
    const state = { rpcEvents: [event("first", "request", 1), event("peer", "request", 2)],
      routedWebSocketCloseEvents: [{ routeSocketId: "first", atEpochMs: 3 }] };
    const pending = network.pendingRouteRequestsAt(state, 3);
    assert.equal(pending.length, 1); assert.equal(pending[0].routeSocketId, "peer");
    assert.equal(pending[0].path, "/route"); assert.ok(!JSON.stringify(pending).includes("SYNTHETIC_OWNED_BODY"));
    state.rpcEvents.push(event("peer", "response-dropped", 4));
    assert.deepEqual(network.pendingRouteRequestsAt(state, 4), []);
  });

  test(`${name} auth observer ignores unrelated responses and releases only its own listener`, async () => {
    const page = new EventEmitter(), peer = () => {}, secrets = new Set();
    page.on("response", peer);
    const faults = faultsFactory({ assert, sha256, safePath: value => new URL(value).pathname });
    const observer = faults.observeOwnedMobileAuth(page, { registerSecret(value) { secrets.add(value); } });
    const response = (method, path) => ({ request: () => ({ method: () => method }), url: () => "http://127.0.0.1:55001" + path,
      status: () => 200, json: async () => ({ accessToken: "SYNTHETIC_OWNED_ONLY", deviceId: "owned-device",
        capabilities: { mobileRefreshV1: true } }) });
    page.emit("response", response("GET", "/api/mobile/session"));
    page.emit("response", response("POST", "/unrelated"));
    assert.equal(observer.getPair(), null);
    page.emit("response", response("POST", "/api/mobile/session"));
    const pair = await observer.waitForPair();
    assert.equal(pair.mobileRefreshV1, true); assert.equal(pair.deviceFingerprint, sha256("owned-device").slice(0, 16));
    assert.equal(secrets.size, 1);
    observer.dispose(); assert.equal(page.listenerCount("response"), 1); assert.equal(page.listeners("response")[0], peer);
    page.off("response", peer);
  });
}
