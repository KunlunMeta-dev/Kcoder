import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { repoRoot } from "../harness/run-context.mjs";
import { readPrivateCandidateSplitPlans } from "../harness/private-candidate-source-closure.mjs";
import { parseSource } from "./candidate-extraction.review-support.mjs";
import { readFileSync } from "node:fs";

for (const plan of readPrivateCandidateSplitPlans()) test(`${plan.key}: original invalid-sample gate rejects before a run is created`, t => {
  const root = resolve(repoRoot, plan.root), source = readFileSync(root, "utf8");
  const missing = parseSource(source).body.filter(node => node.type === "ImportDeclaration"
    && node.source.value.startsWith(".")).map(node => resolve(dirname(root), node.source.value))
    .filter(path => !existsSync(path));
  if (missing.length) {
    t.skip("UNMET_PREREQUISITE: original launcher relative imports unavailable: " + missing.map(path => path.slice(repoRoot.length + 1)).join(", "));
    return;
  }
  const runRoot = resolve(repoRoot, "target/test", plan.root);
  const before = existsSync(runRoot) ? readdirSync(runRoot).sort() : [];
  const result = spawnSync(process.execPath, [root, "--samples=0"], {
    cwd: repoRoot, timeout: 10_000, encoding: "utf8", env: { PATH: process.env.PATH || "" },
  });
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--samples must be between 1 and 100/);
  assert.deepEqual(existsSync(runRoot) ? readdirSync(runRoot).sort() : [], before,
    "an invalid sample selector cannot create a run, owned profile, browser or service");
});
