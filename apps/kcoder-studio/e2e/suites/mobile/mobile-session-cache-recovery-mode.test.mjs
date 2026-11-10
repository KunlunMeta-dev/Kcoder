import assert from "node:assert/strict";
import test from "node:test";
import { parseMobileSessionCacheRecoveryMode as parseMode } from "./mobile-session-cache-recovery-mode.mjs";

const mount = "--production-mobile-mount";
const legacyModes = [
  [[], "mobile-web-session-transcript-cache-recovery", "final resume page is altered"],
  [[mount], "mobile-web-session-transcript-cache-recovery", "final resume page is altered"],
  [["--setup-smoke"], "mobile-session-cache-setup-smoke", "setup-only"],
  [[mount, "--setup-smoke"], "mobile-session-cache-production-mobile-mount-setup-smoke", "setup-only"],
  [[mount, "--confirmed-absence-smoke"], "mobile-session-cache-production-mobile-mount-confirmed-absence-smoke", "authorized Node RPC delete"],
  [[mount, "--cold-process-smoke"], "mobile-session-cache-production-mobile-mount-cold-process-smoke", "cold Chromium process restart"],
  [[mount, "--trusted-anchor-setup-smoke"], "mobile-session-cache-production-mobile-mount-trusted-anchor-setup-smoke", "no cold-recovery claim"],
  [["--cache-timing-smoke"], "mobile-session-cache-real-ui-timing-pilot", "timing run"],
  [["--cache-timing-matrix"], "mobile-session-cache-real-ui-timing-matrix", "timing run"],
  [[mount, "--cache-timing-smoke"], "mobile-session-cache-production-mobile-mount-real-ui-timing-pilot", "timing run"],
  [[mount, "--cache-timing-matrix", "--cache-timing-direct-relay"], "mobile-session-cache-production-mobile-mount-real-ui-timing-matrix-direct-relay", "timing run"],
];
for (const [args, testId, policy] of legacyModes) {
  test(`legacy mode keeps its identity and boundary: ${args.join(" ") || "default"}`, () => {
    const mode = parseMode(args);
    assert.equal(mode.testId, testId);
    assert.equal(mode.tier, "full-integration");
    assert.ok(mode.modelPolicy.includes(policy));
    assert.equal(Object.isFrozen(mode), true);
  });
}

test("legacy unknown, duplicate and incompatible flags still reject", () => {
  for (const args of [
    ["--unknown"], [mount, mount], ["--cache-timing-smoke", "--cache-timing-matrix"],
    ["--cache-timing-direct-relay"], [mount, "--cache-timing-direct-relay"],
    ["--cache-timing-smoke", "--setup-smoke"], ["--confirmed-absence-smoke"],
    [mount, "--confirmed-absence-smoke", "--setup-smoke"], ["--cold-process-smoke"],
    [mount, "--cold-process-smoke", "--confirmed-absence-smoke"], ["--trusted-anchor-setup-smoke"],
    [mount, "--trusted-anchor-setup-smoke", "--cold-process-smoke"],
  ]) assert.throws(() => parseMode(args), `must reject ${args.join(" ")}`);
});

test("owner-handoff rollback has one isolated production Mobile boundary", () => {
  const mode = parseMode([mount, "--owner-handoff-rollback-smoke"]);
  assert.equal(mode.ownerHandoffRollbackSmoke, true);
  assert.equal(mode.testId, "mobile-session-cache-production-mobile-mount-owner-handoff-rollback-smoke");
  assert.ok(mode.modelPolicy.includes("same-Page reconnect"));
  assert.throws(() => parseMode(["--owner-handoff-rollback-smoke"]));
  for (const other of ["--setup-smoke", "--cache-agent-list-causal-smoke", "--cache-transaction-abort-smoke",
    "--cache-corruption-json-smoke", "--cache-timing-smoke"]) {
    assert.throws(() => parseMode([mount, "--owner-handoff-rollback-smoke", other]));
  }
});

for (const [flag, kind] of [
  ["--cache-corruption-json-smoke", "invalid-json"],
  ["--cache-corruption-schema-smoke", "unsupported-schema"],
]) {
  test(`cache corruption has a separate production-only boundary: ${kind}`, () => {
    const mode = parseMode([mount, flag]);
    assert.equal(mode.cacheCorruptionKind, kind);
    assert.equal(mode.testId, `mobile-session-cache-production-mobile-mount-cache-${kind}-smoke`);
    assert.ok(mode.modelPolicy.includes("no pending-intent"));
    assert.throws(() => parseMode([flag]));
    assert.throws(() => parseMode([mount, flag, "--setup-smoke"]));
    assert.throws(() => parseMode([mount, flag, "--cache-timing-smoke"]));
  });
}

test("corruption variants cannot share one owner run", () => {
  assert.throws(() => parseMode([mount, "--cache-corruption-json-smoke", "--cache-corruption-schema-smoke"]));
});

test("agent/list request gate owns a separate production Direct preflight", () => {
  const mode = parseMode([mount, "--cache-agent-list-causal-smoke"]);
  assert.equal(mode.agentListCausalSmoke, true);
  assert.equal(mode.testId, "mobile-session-cache-production-mobile-mount-agent-list-causal-smoke");
  assert.ok(mode.modelPolicy.includes("before forwarding exact agent/list"));
  assert.throws(() => parseMode(["--cache-agent-list-causal-smoke"]));
  for (const flag of ["--setup-smoke", "--cache-timing-smoke", "--cache-corruption-json-smoke",
    "--cold-process-smoke", "--confirmed-absence-smoke", "--trusted-anchor-setup-smoke"]) {
    assert.throws(() => parseMode([mount, "--cache-agent-list-causal-smoke", flag]));
  }
});

test("native transaction abort owns a separate production Direct preflight", () => {
  const flag = "--cache-transaction-abort-smoke";
  const mode = parseMode([mount, flag]);
  assert.equal(mode.transactionAbortSmoke, true);
  assert.equal(mode.testId, "mobile-session-cache-production-mobile-mount-transaction-abort-smoke");
  assert.ok(mode.modelPolicy.includes("ConstraintError"));
  assert.ok(mode.modelPolicy.includes("no quota"));
  assert.throws(() => parseMode([flag]));
  for (const other of ["--cache-corruption-json-smoke", "--cache-corruption-schema-smoke",
    "--cache-agent-list-causal-smoke", "--setup-smoke", "--cache-timing-smoke",
    "--cold-process-smoke", "--confirmed-absence-smoke", "--trusted-anchor-setup-smoke"]) {
    assert.throws(() => parseMode([mount, flag, other]));
  }
});

test("native quota preflight is production-only and cannot share another recovery owner", () => {
  const flag = "--cache-quota-smoke";
  const mode = parseMode([mount, flag]);
  assert.equal(mode.quotaSmoke, true);
  assert.equal(mode.testId, "mobile-session-cache-production-mobile-mount-quota-smoke");
  assert.ok(mode.modelPolicy.includes("QuotaExceededError"));
  assert.throws(() => parseMode([flag]));
  for (const other of ["--cache-transaction-abort-smoke", "--cache-corruption-json-smoke",
    "--cache-agent-list-causal-smoke", "--owner-handoff-rollback-smoke", "--setup-smoke",
    "--cache-timing-smoke", "--cold-process-smoke", "--confirmed-absence-smoke"]) {
    assert.throws(() => parseMode([mount, flag, other]));
  }
});

test("multitab writers have one isolated production Direct owner", () => {
  const flag = "--cache-multitab-writers-smoke";
  const mode = parseMode([mount, flag]);
  assert.equal(mode.multitabWritersSmoke, true);
  assert.equal(mode.testId, "mobile-session-cache-production-mobile-mount-multitab-writers-smoke");
  assert.ok(mode.modelPolicy.includes("two-Page native IndexedDB anchor writers"));
  assert.throws(() => parseMode([flag]));
  for (const other of ["--cache-quota-smoke", "--cache-transaction-abort-smoke",
    "--cache-corruption-json-smoke", "--cache-agent-list-causal-smoke",
    "--owner-handoff-rollback-smoke", "--setup-smoke", "--cache-timing-smoke",
    "--cold-process-smoke", "--confirmed-absence-smoke", "--trusted-anchor-setup-smoke"]) {
    assert.throws(() => parseMode([mount, flag, other]));
  }
});
