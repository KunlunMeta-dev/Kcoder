import assert from "node:assert/strict";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { repoRoot } from "./run-context.mjs";
import { readPrivateCandidateSplitPlans } from "./private-candidate-source-closure.mjs";

// Construction contracts need no historical Git objects, baseline artifact, browser or model.
const plans = readPrivateCandidateSplitPlans();
const groups = new Map();
for (const plan of plans) for (const group of plan.groups) groups.set(group.path, group);
for (const group of groups.values()) test(`${group.factory}: construction preserves actual original function references without IO`, async () => {
  let calls = 0;
  const dependencies = new Proxy({}, { get() { return () => { calls++; assert.fail("construction must not start resources"); }; } });
  const module = await import(pathToFileURL(resolve(repoRoot, group.path)).href);
  const functions = module[group.factory](dependencies);
  assert.deepEqual(Object.keys(functions), group.names);
  assert.ok(Object.values(functions).every(value => typeof value === "function"));
  assert.equal(calls, 0);
});

test("samples-only source exclusions retain the original private-value boundary", async () => {
  const group = plans.find(plan => plan.key === "home-samples-r2").groups.find(group => group.key === "inputs");
  const module = await import(pathToFileURL(resolve(repoRoot, group.path)).href);
  const source = module[group.factory]({ assert, basename });
  assert.equal(source.sourceSnapshotFilter("/owned/.env"), false);
  assert.equal(source.dependencySnapshotExcluded("credentials.json", false), true);
  assert.equal(source.gatewayRuntimeStable({ sourceDigest: "a" }, { sourceDigest: "b" }), false);
});
