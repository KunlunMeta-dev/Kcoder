import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { repoRoot } from "../harness/run-context.mjs";
import { readOriginalPrivateCandidate, privateCandidateOriginals } from "../harness/private-candidate-original-source.mjs";
import { verifyExtraction } from "./candidate-extraction.review-support.mjs";
import { readPrivateCandidateSplitPlans } from "../harness/private-candidate-source-closure.mjs";

const plans = readPrivateCandidateSplitPlans();
for (const plan of plans) test(`${plan.key}: exact Git bytes, closure cells, function identities and launcher gates are reconstructable`, () => {
  assert.deepEqual(plan.original, privateCandidateOriginals[plan.key]);
  verifyExtraction(readOriginalPrivateCandidate(plan.key), plan);
});

test("each separated source closure stays within the original observer budget", () => {
  for (const plan of plans) {
    assert.ok(plan.groups.length + 1 <= 15);
    for (const group of plan.groups) assert.ok(readFileSync(resolve(repoRoot, group.path), "utf8").length > 0);
  }
});
