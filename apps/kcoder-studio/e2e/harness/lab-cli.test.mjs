import assert from "node:assert/strict";
import test from "node:test";
import { parseLabArgs } from "../lab.mjs";

test("lab CLI selects safe startup defaults and bounded timeout", () => {
  assert.deepEqual(parseLabArgs(["start"]), { command: "start", options: { timeoutMs: 7_200_000 } });
  assert.deepEqual(parseLabArgs(["start", "--scenario", "tool-call-reconnect", "--template", "minimal", "--timeout-ms", "90000"]), {
    command: "start",
    options: { timeoutMs: 90_000, scenarioId: "tool-call-reconnect", templateId: "minimal" },
  });
  assert.throws(() => parseLabArgs(["start", "--timeout-ms", "86400001"]), /between 1 and/);
  assert.throws(() => parseLabArgs(["start", "--unknown", "value"]), /Unknown lab start option/);
});

test("lab CLI scopes state and frame controls to the supplied run and request identities", () => {
  assert.deepEqual(parseLabArgs(["status", "20261122-010203.004Z"]), { command: "status", runId: "20261122-010203.004Z" });
  assert.deepEqual(parseLabArgs(["stop", "20261122-010203.004Z"]), { command: "stop", runId: "20261122-010203.004Z" });
  assert.deepEqual(parseLabArgs(["wait", "20261122-010203.004Z", "initial"]), {
    command: "wait", runId: "20261122-010203.004Z", requestId: "initial", timeoutMs: 600_000,
  });
  assert.deepEqual(parseLabArgs(["wait", "20261122-010203.004Z", "initial", "90000"]), {
    command: "wait", runId: "20261122-010203.004Z", requestId: "initial", timeoutMs: 90_000,
  });
  assert.throws(() => parseLabArgs(["wait", "20261122-010203.004Z", "initial", "3600001"]), /request wait timeout/);
  assert.deepEqual(parseLabArgs(["release", "20261122-010203.004Z", "initial", "all"]), {
    command: "release", runId: "20261122-010203.004Z", requestId: "initial", frames: "all",
  });
  assert.deepEqual(parseLabArgs(["release", "20261122-010203.004Z", "initial", "5"]), {
    command: "release", runId: "20261122-010203.004Z", requestId: "initial", frames: 5,
  });
  assert.deepEqual(parseLabArgs(["disconnect", "20261122-010203.004Z", "initial"]), {
    command: "disconnect", runId: "20261122-010203.004Z", requestId: "initial",
  });
  assert.throws(() => parseLabArgs(["release", "bad", "../../other-run", "all"]), /request ID is invalid/);
  assert.throws(() => parseLabArgs(["release", "20261122-010203.004Z", "initial", "0"]), /positive integer/);
});
