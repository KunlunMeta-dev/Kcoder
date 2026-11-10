import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import test from "node:test";
import { createPrivateMinuteBoundarySourceInputs } from "./private-mobile-minute-boundary-source-inputs.mjs";
import { createPrivateMinuteBoundaryNetwork } from "./private-mobile-minute-boundary-network.mjs";
import { createPrivateMinuteBoundaryFaultScenarios } from "./private-mobile-minute-boundary-fault-scenarios.mjs";

// Pure mechanism checks need no historical Git object, private artifact, browser or Provider.
const plan = JSON.parse(readFileSync(new URL("./private-mobile-minute-boundary-split-plan.json", import.meta.url), "utf8"));
const factories = [createPrivateMinuteBoundarySourceInputs, createPrivateMinuteBoundaryNetwork, createPrivateMinuteBoundaryFaultScenarios];

test("minute-boundary factories start no resource and expose the original function references", () => {
  let calls = 0;
  const dependencies = new Proxy({}, { get() { return () => { calls++; assert.fail("construction must not start any resource"); }; } });
  for (const [index, factory] of factories.entries()) {
    const selected = factory(dependencies);
    assert.deepEqual(Object.keys(selected), plan.groups[index].names);
    assert.ok(Object.values(selected).every(value => typeof value === "function"));
  }
  assert.equal(calls, 0);
});

test("minute-boundary source exclusions and runtime identity retain their private boundaries", () => {
  const inputs = createPrivateMinuteBoundarySourceInputs({ assert, basename });
  for (const path of ["/owned/.env", "/owned/tls.key", "/owned/client.pem"]) assert.equal(inputs.sourceSnapshotFilter(path), false);
  for (const name of ["credentials.json", "account_credentials.json", ".npmrc"]) assert.equal(inputs.dependencySnapshotExcluded(name, false), true);
  const before = { sourceDigest: "source", dependencyDigest: "dependencies", nodeExecutable: "owned", nodeVersion: "fixed",
    kcoderBinaryPath: "owned-native", kcoderBinaryStat: { inode: 1 }, runtimeInputs: ["exact-owned-runtime"] };
  assert.equal(inputs.gatewayRuntimeStable(before, structuredClone(before)), true);
  assert.equal(inputs.gatewayRuntimeStable(before, { ...before, kcoderBinaryStat: { inode: 2 } }), false);
});

test("minute-boundary network correlation settles only its exact socket and omits arbitrary bodies", () => {
  const network = createPrivateMinuteBoundaryNetwork({ sanitizeGatewayPath: value => value.split("?")[0] });
  const event = (routeSocketId, direction, atEpochMs) => ({ routeSocketId, direction, atEpochMs,
    method: "thread/read", hasId: true, rpcIdFingerprint: "matching", path: "/route?private=omitted", body: "SYNTHETIC_BODY_MUST_NOT_APPEAR" });
  const state = { rpcEvents: [event("owned", "request", 1), event("peer", "request", 2)],
    routedWebSocketCloseEvents: [{ routeSocketId: "owned", atEpochMs: 3 }] };
  const pending = network.pendingRouteRequestsAt(state, 3);
  assert.equal(pending.length, 1); assert.equal(pending[0].routeSocketId, "peer");
  assert.equal(pending[0].path, "/route"); assert.ok(!JSON.stringify(pending).includes("SYNTHETIC_BODY"));
  state.rpcEvents.push(event("peer", "response-dropped", 4));
  assert.deepEqual(network.pendingRouteRequestsAt(state, 4), []);
});
