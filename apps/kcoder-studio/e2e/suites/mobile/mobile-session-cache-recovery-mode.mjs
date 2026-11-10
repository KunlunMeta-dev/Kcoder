import assert from "node:assert/strict";

/** Preserve the existing recovery modes independently of Browser lifecycle wiring. */
export function parseMobileSessionCacheRecoveryMode(suppliedArguments = []) {
  const cacheTimingSmoke = suppliedArguments.includes("--cache-timing-smoke");
  const cacheTimingMatrix = suppliedArguments.includes("--cache-timing-matrix");
  const cacheTimingDirectRelay = suppliedArguments.includes("--cache-timing-direct-relay");
  const setupSmoke = suppliedArguments.includes("--setup-smoke");
  const cacheUiVisualSmoke = suppliedArguments.includes("--cache-ui-visual-smoke");
  const productionMobileMount = suppliedArguments.includes("--production-mobile-mount");
  const confirmedAbsenceSmoke = suppliedArguments.includes("--confirmed-absence-smoke");
  const coldProcessSmoke = suppliedArguments.includes("--cold-process-smoke");
  const trustedAnchorSetupSmoke = suppliedArguments.includes("--trusted-anchor-setup-smoke");
  const cacheTimingDelays = cacheTimingSmoke || cacheTimingMatrix;
  const corruptJsonSmoke = suppliedArguments.includes("--cache-corruption-json-smoke");
  const unsupportedSchemaSmoke = suppliedArguments.includes("--cache-corruption-schema-smoke");
  const agentListCausalSmoke = suppliedArguments.includes("--cache-agent-list-causal-smoke");
  const transactionAbortSmoke = suppliedArguments.includes("--cache-transaction-abort-smoke");
  const quotaSmoke = suppliedArguments.includes("--cache-quota-smoke");
  const multitabWritersSmoke = suppliedArguments.includes("--cache-multitab-writers-smoke");
  const ownerHandoffRollbackSmoke = suppliedArguments.includes("--owner-handoff-rollback-smoke");
  const cacheCorruptionKind = corruptJsonSmoke ? "invalid-json" : unsupportedSchemaSmoke ? "unsupported-schema" : null;
  const allowedArguments = new Set([
    "--cache-timing-smoke", "--cache-timing-matrix", "--setup-smoke", "--cache-ui-visual-smoke",
    "--cache-timing-direct-relay", "--production-mobile-mount", "--confirmed-absence-smoke", "--cold-process-smoke",
    "--trusted-anchor-setup-smoke",
    "--cache-corruption-json-smoke", "--cache-corruption-schema-smoke", "--cache-agent-list-causal-smoke",
    "--cache-transaction-abort-smoke",
    "--cache-quota-smoke",
    "--cache-multitab-writers-smoke",
    "--owner-handoff-rollback-smoke",
  ]);
  assert.equal(new Set(suppliedArguments).size, suppliedArguments.length,
    "suite arguments must not be repeated");
  assert.deepEqual(suppliedArguments.filter(argument => !allowedArguments.has(argument)), [],
    "suite received an unsupported argument");
  assert.ok(!(cacheTimingSmoke && cacheTimingMatrix), "cache timing smoke and matrix modes are mutually exclusive");
  assert.ok(!cacheTimingDirectRelay || productionMobileMount,
    "direct/Relay paired timing requires --production-mobile-mount");
  assert.ok(!cacheTimingDirectRelay || cacheTimingSmoke || cacheTimingMatrix,
    "direct/Relay pairing is only valid with a cache timing smoke or matrix");
  assert.ok(!(setupSmoke && (cacheTimingSmoke || cacheTimingMatrix)),
    "setup smoke and cache timing modes are mutually exclusive");
  assert.ok(!cacheUiVisualSmoke || suppliedArguments.length === 1,
    "cached-session UI visual smoke requires its own Browser owner run");
  assert.ok(!confirmedAbsenceSmoke || productionMobileMount,
    "confirmed absence smoke requires --production-mobile-mount");
  assert.ok(!(confirmedAbsenceSmoke && (setupSmoke || cacheTimingSmoke || cacheTimingMatrix)),
    "confirmed absence smoke is mutually exclusive with setup and cache timing modes");
  assert.ok(!coldProcessSmoke || productionMobileMount,
    "cold process smoke requires --production-mobile-mount");
  assert.ok(!(coldProcessSmoke && (setupSmoke || cacheTimingSmoke || cacheTimingMatrix || confirmedAbsenceSmoke)),
    "cold process smoke is mutually exclusive with setup, cache timing, and confirmed absence modes");
  assert.ok(!trustedAnchorSetupSmoke || productionMobileMount,
    "trusted anchor setup smoke requires --production-mobile-mount");
  assert.ok(!(trustedAnchorSetupSmoke && (setupSmoke || cacheTimingSmoke || cacheTimingMatrix ||
    confirmedAbsenceSmoke || coldProcessSmoke)),
  "trusted anchor setup smoke is mutually exclusive with other setup, timing, and recovery modes");
  assert.ok(!(corruptJsonSmoke && unsupportedSchemaSmoke), "cache corruption variants are mutually exclusive");
  assert.ok(!cacheCorruptionKind || productionMobileMount, "cache corruption requires --production-mobile-mount");
  assert.ok(!cacheCorruptionKind || !(cacheTimingDelays || setupSmoke || confirmedAbsenceSmoke ||
    coldProcessSmoke || trustedAnchorSetupSmoke), "cache corruption cannot share another recovery mode");
  assert.ok(!agentListCausalSmoke || productionMobileMount, "agent/list causal smoke requires --production-mobile-mount");
  assert.ok(!agentListCausalSmoke || !(cacheCorruptionKind || cacheTimingDelays || setupSmoke ||
    confirmedAbsenceSmoke || coldProcessSmoke || trustedAnchorSetupSmoke || cacheTimingDirectRelay),
  "agent/list causal smoke requires its own Direct Browser owner run");
  assert.ok(!transactionAbortSmoke || productionMobileMount,
    "native transaction abort smoke requires --production-mobile-mount");
  assert.ok(!transactionAbortSmoke || !(cacheCorruptionKind || agentListCausalSmoke || cacheTimingDelays ||
    setupSmoke || confirmedAbsenceSmoke || coldProcessSmoke || trustedAnchorSetupSmoke || cacheTimingDirectRelay || quotaSmoke),
  "native transaction abort smoke requires its own Direct Browser owner run");
  assert.ok(!quotaSmoke || productionMobileMount, "native quota smoke requires --production-mobile-mount");
  assert.ok(!quotaSmoke || !(cacheCorruptionKind || agentListCausalSmoke || cacheTimingDelays ||
    setupSmoke || confirmedAbsenceSmoke || coldProcessSmoke || trustedAnchorSetupSmoke ||
    cacheTimingDirectRelay || ownerHandoffRollbackSmoke || multitabWritersSmoke),
  "native quota smoke requires its own Direct Browser owner run");
  assert.ok(!multitabWritersSmoke || productionMobileMount,
    "multitab writers smoke requires --production-mobile-mount");
  assert.ok(!multitabWritersSmoke || !(transactionAbortSmoke || quotaSmoke || cacheCorruptionKind ||
    agentListCausalSmoke || cacheTimingDelays || setupSmoke || confirmedAbsenceSmoke || coldProcessSmoke ||
    trustedAnchorSetupSmoke || cacheTimingDirectRelay || ownerHandoffRollbackSmoke),
  "multitab writers smoke requires its own Direct Browser owner run");
  assert.ok(!ownerHandoffRollbackSmoke || productionMobileMount,
    "owner-handoff rollback smoke requires --production-mobile-mount");
  assert.ok(!ownerHandoffRollbackSmoke || !(transactionAbortSmoke || quotaSmoke || cacheCorruptionKind || agentListCausalSmoke ||
    cacheTimingDelays || setupSmoke || confirmedAbsenceSmoke || coldProcessSmoke || trustedAnchorSetupSmoke || cacheTimingDirectRelay),
  "owner-handoff rollback smoke requires its own Direct Browser owner run");
  return Object.freeze({
    cacheTimingSmoke, cacheTimingMatrix, cacheTimingDirectRelay, setupSmoke, cacheUiVisualSmoke, productionMobileMount,
    confirmedAbsenceSmoke, coldProcessSmoke, trustedAnchorSetupSmoke, cacheCorruptionKind, agentListCausalSmoke,
    transactionAbortSmoke, quotaSmoke, multitabWritersSmoke, ownerHandoffRollbackSmoke,
    testId: agentListCausalSmoke
      ? "mobile-session-cache-production-mobile-mount-agent-list-causal-smoke"
      : transactionAbortSmoke
      ? "mobile-session-cache-production-mobile-mount-transaction-abort-smoke"
      : quotaSmoke
      ? "mobile-session-cache-production-mobile-mount-quota-smoke"
      : multitabWritersSmoke
      ? "mobile-session-cache-production-mobile-mount-multitab-writers-smoke"
      : ownerHandoffRollbackSmoke
      ? "mobile-session-cache-production-mobile-mount-owner-handoff-rollback-smoke"
      : cacheCorruptionKind
      ? `mobile-session-cache-production-mobile-mount-cache-${cacheCorruptionKind}-smoke`
      : trustedAnchorSetupSmoke
      ? "mobile-session-cache-production-mobile-mount-trusted-anchor-setup-smoke"
      : cacheUiVisualSmoke
      ? "mobile-session-cache-live-ui-visual-matrix"
      : coldProcessSmoke
      ? "mobile-session-cache-production-mobile-mount-cold-process-smoke"
      : confirmedAbsenceSmoke
        ? "mobile-session-cache-production-mobile-mount-confirmed-absence-smoke"
      : setupSmoke
        ? productionMobileMount ? "mobile-session-cache-production-mobile-mount-setup-smoke" : "mobile-session-cache-setup-smoke"
      : cacheTimingDelays
        ? `mobile-session-cache${productionMobileMount ? "-production-mobile-mount" : ""}-real-ui-timing-${cacheTimingMatrix ? "matrix" : "pilot"}${cacheTimingDirectRelay ? "-direct-relay" : ""}`
        : "mobile-web-session-transcript-cache-recovery",
    tier: "full-integration",
    modelPolicy: agentListCausalSmoke
      ? "model-independent real production-mounted Mobile Web/Gateway/Rust app-server Direct request gate; real UI cache and unchanged authority/composer before forwarding exact agent/list; no network RTT, native or model-performance claim"
      : transactionAbortSmoke
      ? "model-independent real production-mounted Mobile Web/Gateway/Rust app-server native IndexedDB ConstraintError request error, atomic transaction abort, real UI anchor retry; no quota, disk-full, native-device or model claim"
      : quotaSmoke
      ? "model-independent real production-mounted Mobile Web/Gateway/Rust app-server CDP origin quota override and native IndexedDB QuotaExceededError transaction abort, atomic rollback, verified reset and real UI retry; no physical disk-full, native-device or model claim"
      : multitabWritersSmoke
      ? "model-independent real production-mounted Mobile Web/Gateway/Rust app-server two-Page native IndexedDB anchor writers under one standard WebLock barrier; no native-device or model claim"
      : ownerHandoffRollbackSmoke
      ? "model-independent real production-mounted Mobile Web/Gateway/Rust app-server same-Page reconnect after legal actor rollback; two UI deterministic turns, full idle authority and exact owner handoff; no external Provider or phone claim"
      : cacheCorruptionKind
      ? "model-independent real production-mounted Mobile Web/Gateway/Rust app-server; UI-seeded cache JSON/schema fault, owned same-profile cold Chromium restart, unchanged online authority and unsent composer draft; no pending-intent, transaction-failure, quota, native or model claim"
      : trustedAnchorSetupSmoke
      ? "model-independent production-mounted Mobile Web/Gateway/Rust app-server setup gate with one deterministic local full turn, one measured trusted inverted-list wheel, exact user-anchor IndexedDB persistence, and no cold-recovery claim; no external Provider or model call"
      : cacheUiVisualSmoke
      ? "model-independent real Mobile Web/Gateway/Rust app-server, one deterministic local full turn, eight sequential same-thread cache-to-live Browser viewports/locales/themes, exact owner draft and detached anchor; no external Provider or model call"
      : coldProcessSmoke
      ? "model-independent real pinned production-mounted Mobile Web/Gateway/Rust app-server cold Chromium process restart with naturally installed service-worker assets, persistent IndexedDB transcript/read-anchor recovery, offline read-only UI and unchanged authoritative resume; no external Provider or model call"
      : confirmedAbsenceSmoke
        ? "model-independent real production-mounted Mobile Web/Gateway/Rust app-server smoke with deterministic local full turn, independent authorized Node RPC delete/presence observation, cached-view reload and real Mobile confirmed-absence recovery; no external Provider or model call"
      : setupSmoke
        ? "model-independent setup-only Mobile Web/Gateway/Rust app-server smoke with deterministic local full-turn scenario and cache persistence readback; no external Provider or model call"
      : cacheTimingDelays
        ? "model-independent real Mobile Web/Gateway/Rust app-server timing run with one deterministic local full turn, a trusted user wheel, and the real Mobile jump-to-latest action persisted to IndexedDB; timing-only branch does not run default detached-anchor restore assertions; no external Provider or model call"
        : "model-independent real Mobile Web/Gateway/Rust app-server with deterministic local full-turn scenario; no external Provider or model call; the final resume page is altered only by this test's WebSocket bridge",
  });
}
