import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { basename } from "node:path";
import test from "node:test";
import { createMobileRefreshSourceInputs } from "./mobile-refresh-source-inputs.mjs";
import { createMobileRefreshFaultScenarios } from "./mobile-refresh-fault-scenarios.mjs";

const sha256 = value => createHash("sha256").update(value).digest("hex");

test("creating formal refresh mechanisms performs no snapshot copy, browser action or authentication", () => {
  const fail = () => assert.fail("mechanism construction must remain resource-free");
  const inputs = createMobileRefreshSourceInputs({ assert, readFile: fail, cp: fail, mkdir: fail });
  const scenarios = createMobileRefreshFaultScenarios({ assert, readFile: fail, newMobilePage: fail });
  assert.equal(Object.keys(inputs).length, 36);
  assert.equal(Object.keys(scenarios).length, 8);
  assert.ok(Object.values(inputs).every(value => typeof value === "function"));
  assert.ok(Object.values(scenarios).every(value => typeof value === "function"));
});

test("snapshot selectors retain dependency credentials and generated-directory exclusions", () => {
  const inputs = createMobileRefreshSourceInputs({ assert, basename });
  for (const path of ["/fixture/.env", "/fixture/.env.local", "/fixture/cert.pem", "/fixture/private.key"])
    assert.equal(inputs.sourceSnapshotFilter(path), false);
  for (const path of ["/fixture/.env.example", "/fixture/source.mjs", "/fixture/public.json"])
    assert.equal(inputs.sourceSnapshotFilter(path), true);
  for (const name of ["credentials.json", "account_credentials.json", ".npmrc", "auth-secret.json", "tls.pfx"])
    assert.equal(inputs.dependencySnapshotExcluded(name, false), true);
  assert.equal(inputs.dependencySnapshotExcluded(".cache", true), true);
  assert.equal(inputs.sourceSnapshotExcluded("target", true), true);
  assert.equal(inputs.sourceSnapshotExcluded("source.mjs", false), false);
});

test("Gateway runtime comparison keeps source, dependency, binary and runtime input identity distinct", () => {
  const inputs = createMobileRefreshSourceInputs({ assert });
  const before = { sourceDigest: "source", dependencyDigest: "deps", nodeExecutable: "owned-node",
    nodeVersion: "owned-version", kcoderBinaryPath: "owned-native", kcoderBinaryStat: { inode: 1 }, runtimeInputs: ["owned-runtime"] };
  assert.equal(inputs.gatewayRuntimeStable(before, structuredClone(before)), true);
  for (const field of ["sourceDigest", "dependencyDigest", "nodeExecutable", "nodeVersion", "kcoderBinaryPath"])
    assert.equal(inputs.gatewayRuntimeStable(before, { ...before, [field]: "changed" }), false, field);
  assert.equal(inputs.gatewayRuntimeStable(before, { ...before, kcoderBinaryStat: { inode: 2 } }), false);
  assert.equal(inputs.gatewayRuntimeStable(before, { ...before, runtimeInputs: ["other-runtime"] }), false);
});

test("owned auth observation accepts its POST event, registers the synthetic secret and releases its listener", async () => {
  const page = new EventEmitter(), secrets = new Set();
  const scenarios = createMobileRefreshFaultScenarios({ assert, sha256, safePath: value => new URL(value).pathname });
  const observation = scenarios.observeOwnedMobileAuth(page, { registerSecret(value) { secrets.add(value); } });
  const response = (method, path) => ({ request: () => ({ method: () => method }), url: () => "http://127.0.0.1:55001" + path,
    status: () => 200, json: async () => ({ accessToken: "SYNTHETIC_OWNED_FIXTURE_ONLY", deviceId: "owned-device",
      capabilities: { mobileRefreshV1: true } }) });
  page.emit("response", response("GET", "/api/mobile/session"));
  page.emit("response", response("POST", "/unrelated"));
  assert.equal(observation.getPair(), null);
  page.emit("response", response("POST", "/api/mobile/session"));
  const pair = await observation.waitForPair();
  assert.equal(pair.mobileRefreshV1, true);
  assert.equal(pair.deviceFingerprint, sha256("owned-device").slice(0, 16));
  assert.equal(secrets.size, 1);
  observation.dispose();
  assert.equal(page.listenerCount("response"), 0);
});
