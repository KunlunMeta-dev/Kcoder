import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { canonicalSuiteId, canonicalTestSource, isIntegrationSuite, suiteMigrations, suiteSourceAliases } from "./suite-sources.mjs";
import { selectSuites, suiteEnvironmentNames } from "./runner-options.mjs";
import { registeredSuites } from "../suite-registry.mjs";
import { artifactSourceRoot, repoRoot, retainedArtifactRunRoot, runE2E, runIntegration, runTest } from "./run-context.mjs";
import { planRetention } from "./retention.mjs";

const e2eRoot = resolve(import.meta.dirname, "..");
const oldId = "suites/gateway/model-stream-stdio.e2e.mjs";
const newId = "../integration/gateway/model-stream-stdio.integration.mjs";

test("each migrated suite has one physical source and an unambiguous previous selector", async () => {
  assert.equal(new Set(Object.values(suiteMigrations)).size, Object.keys(suiteMigrations).length);
  for (const [previous, current] of Object.entries(suiteMigrations)) {
    await access(resolve(e2eRoot, current));
    await assert.rejects(access(resolve(e2eRoot, previous)), { code: "ENOENT" });
    assert.ok(registeredSuites.includes(current), current);
    assert.deepEqual(selectSuites(registeredSuites, ["--real-model", "--suite", previous], { KCODER_E2E_REAL_MODEL: "1" }), [current]);
  }
  assert.equal(canonicalSuiteId("toString"), "toString");
});

test("kind selection partitions the existing pool without dropping or duplicating coverage", () => {
  const args = ["--real-model"], env = { KCODER_E2E_REAL_MODEL: "1" };
  const integration = selectSuites(registeredSuites, [...args, "--kind", "integration"], env);
  const e2e = selectSuites(registeredSuites, [...args, "--kind", "e2e"], env);
  assert.deepEqual([...integration, ...e2e].sort(), [...registeredSuites].sort());
  assert.ok(integration.every(id => isIntegrationSuite(id) && id.endsWith(".integration.mjs")));
  assert.ok(e2e.every(id => !isIntegrationSuite(id) && id.endsWith(".e2e.mjs")));
  assert.throws(() => selectSuites(registeredSuites, ["--kind", "unknown"]), /--kind/);
  assert.throws(() => selectSuites(registeredSuites, ["--kind", "e2e", "--suite", oldId]), /uniquely select/);
});

test("controlled SSE is classified by product entry rather than model substitution", () => {
  assert.deepEqual(selectSuites(registeredSuites, ["--kind", "integration", "--suite", "model-stream-stdio"]), [newId]);
  assert.deepEqual(selectSuites(registeredSuites, ["--kind", "e2e", "--suite", "manual-model-stream-reconnect"]), ["suites/browser/manual-model-stream-reconnect.e2e.mjs"]);
  assert.equal(runIntegration, runTest);
  assert.equal(runE2E, runTest);
});

test("migration preserves live-model consent and suite-specific environment boundaries", () => {
  const previous = "suites/model/real-model-task.e2e.mjs";
  assert.throws(() => selectSuites(registeredSuites, ["--kind", "integration", "--suite", previous]), /real-model/);
  assert.throws(() => selectSuites(registeredSuites, ["--real-model", "--suite", previous], {}), /both explicit consents/);
  assert.ok(suiteEnvironmentNames(previous).includes("KCODER_E2E_REAL_MODEL"));
  assert.deepEqual(suiteEnvironmentNames("suites/gateway/windows-keyring-account.e2e.mjs"),
    suiteEnvironmentNames("../integration/gateway/windows-keyring-account.integration.mjs"));
});

test("source mapping preserves the shared boundary and legacy evidence lookup identities", () => {
  const date = new Date("2026-11-23T10:00:00.000Z"), runId = "20261123-100000.000Z";
  const current = resolve(e2eRoot, newId), previous = resolve(e2eRoot, oldId);
  assert.equal(artifactSourceRoot(current, date), resolve(repoRoot, "target/e2e/2026/11/23/integration/gateway/model-stream-stdio.integration.mjs"));
  assert.equal(artifactSourceRoot(previous, date), resolve(repoRoot, "target/e2e/2026/11/23", oldId));
  assert.deepEqual(suiteSourceAliases(current), [current, previous]);
  assert.deepEqual(suiteSourceAliases(previous), [current, previous]);
  assert.equal(retainedArtifactRunRoot(previous, runId, "boundary-check"), resolve(artifactSourceRoot(current, date), "boundary-check", runId));
  assert.throws(() => artifactSourceRoot(resolve(repoRoot, "target/not-a-test.mjs")), /escaped/);
  assert.throws(() => artifactSourceRoot(resolve(e2eRoot, "../integration/../../outside.mjs")), /escaped/);
});

test("old and new evidence group together without mutating recorded sources or variants", () => {
  const previous = "apps/kcoder-studio/e2e/" + oldId;
  const current = "apps/kcoder-studio/integration/gateway/model-stream-stdio.integration.mjs";
  assert.equal(canonicalTestSource(previous), current);
  const runs = [
    { source: previous, path: "/old", status: "failed", endedAtMs: 1 },
    { source: current, path: "/new", status: "passed", endedAtMs: 2 },
    { source: previous, path: "/quiet", variantId: "quiet", status: "passed", endedAtMs: 0 },
  ];
  assert.deepEqual(planRetention(runs).map(run => run.path), ["/old"]);
  assert.equal(runs[0].source, previous);
});
