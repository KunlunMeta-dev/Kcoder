import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { remoteRecoveryTransactionPython } from "./public-recovery-transaction-agent.mjs";

const python = "/usr/bin/python3.12";

test("single remote recovery transaction preserves safe action order and terminal proof", () => {
  const source = String.raw`
import copy, json, re, time
STATIC_ROOT = "/tmp/kc-r4/mobile-web-root"
REMOTE_PARENT = "/tmp/kc-r4"
REMOTE_PORT = 32552
${remoteRecoveryTransactionPython}

OWNER = "0123456789abcdef"
ROOT = STATIC_ROOT
STAGE = STATIC_ROOT + ".stage-" + OWNER
PROBE_LEFT = STATIC_ROOT + ".exchange-probe-" + OWNER + "-a"
PROBE_RIGHT = STATIC_ROOT + ".exchange-probe-" + OWNER + "-b"

def file_row(path, digest):
    return {"path": path, "mode": 0o600, "uid": 1001, "gid": 1001, "size": 1, "sha256": digest}

def tree(name, marker_owner=None):
    digest = {"original": "a", "replacement": "b", "foreign": "c"}[name] * 64
    files = [file_row("index.html", digest)]
    if marker_owner is not None:
        files.append(file_row(".kc-e2e-owner", "d" * 64))
    value = {
        "root": {"path": ".", "mode": 0o700, "uid": 1001, "gid": 1001},
        "directories": [],
        "files": files,
    }
    if marker_owner is not None:
        value["markerOwner"] = marker_owner
    return value

ORIGINAL = tree("original")
REPLACEMENT = tree("replacement")
ORIGINAL_PROJECTION = {
    "root": {"mode": 0o700, "uid": 1001, "gid": 1001},
    "directories": [],
    "files": [file_row("index.html", "a" * 64)],
}
REPLACEMENT_PROJECTION = {
    "root": {"mode": 0o700, "uid": 1001, "gid": 1001},
    "directories": [],
    "files": [file_row("index.html", "b" * 64)],
}
EXPECTED_FILES = [{"path": "index.html", "size": 1, "sha256": "b" * 64}]

def request():
    return {
        "action": "restore-owned-static-transaction",
        "staticRoot": ROOT,
        "stagePath": STAGE,
        "probeLeft": PROBE_LEFT,
        "probeRight": PROBE_RIGHT,
        "owner": OWNER,
        "remoteForwardPort": REMOTE_PORT,
        "originalProjection": ORIGINAL_PROJECTION,
        "replacementProjection": REPLACEMENT_PROJECTION,
        "expectedBundleFiles": EXPECTED_FILES,
    }

class Fixture:
    def __init__(self, root, stage, *, fail_exchange=False, lose_exchange_ack=False,
                 lose_remove_ack=False, fail_final_root=False, fail_initial_root=False,
                 change_stage_before_removal=False, port_free=True):
        self.root = copy.deepcopy(root)
        self.stage = copy.deepcopy(stage)
        self.fail_exchange = fail_exchange
        self.lose_exchange_ack = lose_exchange_ack
        self.lose_remove_ack = lose_remove_ack
        self.fail_final_root = fail_final_root
        self.fail_initial_root = fail_initial_root
        self.change_stage_before_removal = change_stage_before_removal
        self.port_free = port_free
        self.root_manifest_count = 0
        self.stage_manifest_count = 0
        self.calls = []

    def dispatch(self, action):
        self.calls.append(action["action"])
        name = action["action"]
        if name == "cleanup-probe-exchange":
            assert action["left"] == PROBE_LEFT and action["right"] == PROBE_RIGHT
            assert action["owner"] == OWNER
            return {"removed": True, "remaining": False}
        if name == "port-status":
            assert action["port"] == REMOTE_PORT
            return {"free": self.port_free, "listeners": [] if self.port_free else [{"owner": "other"}]}
        if name == "manifest":
            if action["path"] == ROOT:
                self.root_manifest_count += 1
                if self.fail_initial_root and self.root_manifest_count == 1:
                    raise TimeoutError("diagnostic-only injected initial read failure")
                if self.fail_final_root and self.root_manifest_count >= 2:
                    raise TimeoutError("diagnostic-only injected read failure")
                return {"tree": copy.deepcopy(self.root)}
            assert action["path"] == STAGE
            self.stage_manifest_count += 1
            if self.change_stage_before_removal and self.stage_manifest_count >= 2:
                self.stage = tree("foreign")
            return {"tree": copy.deepcopy(self.stage)}
        if name == "exchange":
            assert action["left"] == ROOT and action["right"] == STAGE
            if self.fail_exchange:
                raise OSError("diagnostic-only injected exchange failure")
            self.root, self.stage = self.stage, self.root
            if self.lose_exchange_ack:
                raise TimeoutError("diagnostic-only injected lost exchange acknowledgement")
            return {"exchanged": True}
        if name == "remove-stage":
            assert action["path"] == STAGE and action["owner"] == OWNER
            owner_marker_matches = self.stage is not None and any(
                row["path"] == ".kc-e2e-owner" for row in self.stage["files"]
            ) and self.stage.get("markerOwner") == OWNER
            files = [] if self.stage is None else [
                {key: row[key] for key in ("path", "size", "sha256")}
                for row in self.stage["files"]
            ]
            if not owner_marker_matches and files != action["expectedFiles"]:
                raise RuntimeError("diagnostic-only injected ownership refusal")
            self.stage = None
            if self.lose_remove_ack:
                raise TimeoutError("diagnostic-only injected lost remove acknowledgement")
            return {"removed": True, "by": "owner-marker" if owner_marker_matches else "verified-bundle-manifest"}
        raise AssertionError("unexpected action: " + name)

def run_case(name, fixture):
    result = run_recovery_transaction(request(), fixture.dispatch)
    return {
        "name": name,
        "result": result,
        "calls": fixture.calls,
        "finalStagePresent": fixture.stage is not None,
    }

cases = [
    run_case("original-root-replacement-stage", Fixture(ORIGINAL, REPLACEMENT)),
    run_case("replacement-root-original-stage", Fixture(REPLACEMENT, ORIGINAL)),
    run_case("original-root-no-stage", Fixture(ORIGINAL, None)),
    run_case("foreign-stage", Fixture(ORIGINAL, tree("foreign"))),
    run_case("foreign-owner-marker-stage", Fixture(ORIGINAL, tree("foreign", marker_owner="fedcba9876543210"))),
    run_case("exact-owner-marker-stage", Fixture(ORIGINAL, tree("foreign", marker_owner=OWNER))),
    run_case("ambiguous-root", Fixture(tree("foreign"), ORIGINAL)),
    run_case("initial-static-root-read-failure", Fixture(ORIGINAL, REPLACEMENT, fail_initial_root=True)),
    run_case("stage-changed-before-removal", Fixture(ORIGINAL, REPLACEMENT, change_stage_before_removal=True)),
    run_case("exchange-failure", Fixture(REPLACEMENT, ORIGINAL, fail_exchange=True)),
    run_case("remote-forward-still-listening", Fixture(REPLACEMENT, ORIGINAL, port_free=False)),
    run_case("exchange-ack-lost-terminal-readback", Fixture(REPLACEMENT, ORIGINAL, lose_exchange_ack=True)),
    run_case("final-read-failure", Fixture(ORIGINAL, None, fail_final_root=True)),
    run_case("remove-ack-lost-terminal-readback", Fixture(ORIGINAL, REPLACEMENT, lose_remove_ack=True)),
]
print(json.dumps(cases, separators=(",", ":")))
`;
  const run = spawnSync(python, ["-B", "-c", source], {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  assert.equal(run.error, undefined, `Python transaction test should start: ${run.error?.message}`);
  assert.equal(run.status, 0, `Python transaction test should pass: ${run.stderr}`);
  const cases = JSON.parse(run.stdout);
  const byName = new Map(cases.map(row => [row.name, row]));
  const lastChecks = result => result.steps.slice(-4).map(step => step.label);
  const actionStep = (result, action) => {
    const matches = result.steps.filter(step => step.action === action);
    assert.equal(matches.length, 1, `expected exactly one ${action} receipt`);
    return matches[0];
  };
  const assertSkipped = (result, action, reason) => {
    const receipt = actionStep(result, action);
    assert.equal(receipt.status, "skipped");
    assert.deepEqual(receipt.receipt, { reason });
    assert.equal(typeof receipt.label, "string");
  };
  const terminalSuffix = [
    "final-owned-probe-check",
    "final-stage-readback",
    "final-static-root-readback",
    "final-forward-port-check",
  ];

  for (const row of cases) assert.deepEqual(lastChecks(row.result), terminalSuffix, row.name);

  const oldNew = byName.get("original-root-replacement-stage").result;
  assert.equal(oldNew.restored, true);
  assert.equal(oldNew.checks.exchangeAcknowledged, "not-attempted");
  assert.equal(oldNew.checks.stageRemovalAcknowledged, "acknowledged");
  assertSkipped(oldNew, "exchange", "root-already-original");
  assert.equal(byName.get("original-root-replacement-stage").calls.includes("exchange"), false);

  const newOld = byName.get("replacement-root-original-stage").result;
  assert.equal(newOld.restored, true);
  assert.equal(newOld.checks.exchangeAcknowledged, "acknowledged");
  assert.equal(newOld.checks.stageRemovalAcknowledged, "acknowledged");
  assert.equal(actionStep(newOld, "exchange").status, "completed");
  assert.equal(actionStep(newOld, "remove-stage").status, "completed");

  const noStage = byName.get("original-root-no-stage").result;
  assert.equal(noStage.restored, true);
  assert.equal(noStage.checks.stageRemovalAcknowledged, "not-needed");
  assertSkipped(noStage, "exchange", "root-already-original");
  assertSkipped(noStage, "remove-stage", "stage-absent");
  assert.equal(byName.get("original-root-no-stage").calls.includes("remove-stage"), false);

  for (const name of ["foreign-stage", "foreign-owner-marker-stage", "ambiguous-root", "initial-static-root-read-failure", "stage-changed-before-removal", "exchange-failure", "remote-forward-still-listening"]) {
    assert.equal(byName.get(name).result.restored, false, name);
  }
  for (const name of ["foreign-stage", "ambiguous-root"]) {
    const result = byName.get(name).result;
    assertSkipped(result, "exchange", "state-ambiguous-or-foreign");
    assertSkipped(result, "remove-stage", "state-ambiguous-or-foreign");
  }
  const foreignOwnerMarker = byName.get("foreign-owner-marker-stage").result;
  assertSkipped(foreignOwnerMarker, "exchange", "root-already-original");
  assert.equal(actionStep(foreignOwnerMarker, "remove-stage").status, "failed");
  const initialReadFailure = byName.get("initial-static-root-read-failure");
  assertSkipped(initialReadFailure.result, "exchange", "initial-readback-unavailable");
  assertSkipped(initialReadFailure.result, "remove-stage", "initial-readback-unavailable");
  assert.equal(initialReadFailure.calls.includes("exchange"), false);
  assert.equal(initialReadFailure.calls.includes("remove-stage"), false);
  const changedStage = byName.get("stage-changed-before-removal");
  assertSkipped(changedStage.result, "exchange", "root-already-original");
  assertSkipped(changedStage.result, "remove-stage", "pre-removal-ownership-not-proven");
  assert.equal(changedStage.calls.includes("remove-stage"), false);
  assert.equal(byName.get("foreign-stage").calls.includes("remove-stage"), false);
  assert.equal(byName.get("foreign-owner-marker-stage").finalStagePresent, true);
  assert.equal(byName.get("foreign-owner-marker-stage").result.checks.stageRemovalAcknowledged, "unknown");
  assert.equal(byName.get("ambiguous-root").calls.includes("exchange"), false);
  assert.equal(byName.get("ambiguous-root").calls.includes("remove-stage"), false);
  assert.equal(byName.get("exchange-failure").calls.includes("remove-stage"), false);
  assert.equal(byName.get("remote-forward-still-listening").calls.includes("exchange"), false);
  assert.equal(byName.get("remote-forward-still-listening").calls.includes("remove-stage"), false);
  assertSkipped(byName.get("remote-forward-still-listening").result, "exchange", "forward-port-not-free");
  assertSkipped(byName.get("remote-forward-still-listening").result, "remove-stage", "forward-port-not-free");

  const exchangeFailure = byName.get("exchange-failure").result;
  assert.equal(actionStep(exchangeFailure, "exchange").status, "failed");
  assertSkipped(exchangeFailure, "remove-stage", "post-exchange-ownership-not-proven");

  const ownerMarked = byName.get("exact-owner-marker-stage").result;
  assert.equal(ownerMarked.restored, true);
  assert.equal(ownerMarked.checks.stageRemovalAcknowledged, "acknowledged");

  const lostExchangeAck = byName.get("exchange-ack-lost-terminal-readback").result;
  assert.equal(lostExchangeAck.restored, true);
  assert.equal(lostExchangeAck.checks.exchangeAcknowledged, "unknown");
  assert.equal(lostExchangeAck.checks.finalStaticRootContentMatches, true);
  assert.equal(lostExchangeAck.checks.stageRemovalAcknowledged, "acknowledged");

  assert.equal(byName.get("final-read-failure").result.restored, false);

  const lostRemoveAck = byName.get("remove-ack-lost-terminal-readback").result;
  assert.equal(lostRemoveAck.restored, true);
  assert.equal(lostRemoveAck.checks.stageRemovalAcknowledged, "unknown");
  assert.equal(lostRemoveAck.checks.finalStageAbsent, true);
  assert.equal(lostRemoveAck.checks.finalStaticRootContentMatches, true);
});
