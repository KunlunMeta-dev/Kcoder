import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { repoRoot } from "./run-context.mjs";

// Versioned metadata only; no historical artifact, Git read, browser or service is opened.
export function readPrivateCandidateSplitPlans() {
  const entries = JSON.parse(readFileSync(new URL("./private-candidate-split-plans.json", import.meta.url), "utf8"));
  return entries.map(entry => {
    assert.match(entry, /^private-candidate-modules\/[a-z0-9-]+\/plan\.json$/);
    return JSON.parse(readFileSync(new URL(entry, import.meta.url), "utf8"));
  });
}

export function readPrivateCandidateSourceClosure(key) {
  const plan = readPrivateCandidateSplitPlans().find(plan => plan.key === key);
  assert.ok(plan, "unknown separated candidate");
  return [plan.root, ...plan.groups.map(group => group.path)]
    .map(path => readFileSync(resolve(repoRoot, path), "utf8")).join("\n");
}
