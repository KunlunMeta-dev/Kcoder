import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createMobileRenderProfileSourceInputs } from "./mobile-render-profile-source-inputs.mjs";
import { createMobileRenderProfileFollowScenarios } from "./mobile-render-profile-follow-scenarios.mjs";
import { createMobileRenderProfileMeasurements } from "./mobile-render-profile-measurements.mjs";

// These are source/notification contracts with synthetic observations, not real gesture or performance evidence.
test("creating separated render-profile mechanisms starts no source command, browser or trace", () => {
  let calls = 0;
  const dependencies = new Proxy({}, { get() { return () => { calls++; assert.fail("creation cannot start resources"); }; } });
  assert.equal(Object.keys(createMobileRenderProfileSourceInputs(dependencies)).length, 13);
  assert.equal(Object.keys(createMobileRenderProfileFollowScenarios(dependencies)).length, 26);
  assert.equal(Object.keys(createMobileRenderProfileMeasurements(dependencies)).length, 21);
  assert.equal(calls, 0);
});

test("pinned Git inputs retain canonical regular modes, UTF-8 paths and blob identities", () => {
  const { parsePinnedGitTreeRows, gitBlobSha1 } = createMobileRenderProfileSourceInputs({ assert, createHash });
  const body = Buffer.from("owned synthetic source\n");
  const oid = createHash("sha1").update(`blob ${body.length}\0`).update(body).digest("hex");
  assert.equal(gitBlobSha1(body), oid);
  assert.deepEqual(parsePinnedGitTreeRows(Buffer.from(`100755 blob ${oid}\tz.mjs\0` + `100644 blob ${oid}\ta.md\0`), "owned"), [
    { mode: "100644", objectId: oid, path: "a.md" }, { mode: "100755", objectId: oid, path: "z.mjs" },
  ]);
  for (const row of [`100644 blob ${oid}\tfile`, `120000 blob ${oid}\tlink\0`, `160000 commit ${oid}\tsubmodule\0`,
    `100644 blob ${oid}\ta\\b\0`]) assert.throws(() => parsePinnedGitTreeRows(Buffer.from(row), "owned"));
});

test("touch evidence remains unverified when missing and fails for lost events or a timed-out observation", () => {
  const { evaluateScrollCausalityTouchEvidence } = createMobileRenderProfileMeasurements({});
  assert.equal(evaluateScrollCausalityTouchEvidence({}).status, "UNVERIFIED");
  const sample = { result: { scrollDeltaPx: 12 }, waitError: null,
    trace: { trustedCounts: { touchstart: 1, touchmove: 2, touchend: 1, listScroll: 1 }, droppedDuringMeasurement: 0 } };
  assert.equal(evaluateScrollCausalityTouchEvidence(sample).status, "PASS");
  assert.equal(evaluateScrollCausalityTouchEvidence({ ...sample, waitError: new Error("owned timeout") }).status, "FAIL");
  assert.equal(evaluateScrollCausalityTouchEvidence({ ...sample, trace: { ...sample.trace, droppedDuringMeasurement: 1 } }).status, "FAIL");
  assert.equal(evaluateScrollCausalityTouchEvidence({ ...sample, result: { scrollDeltaPx: 0 } }).status, "FAIL");
});

test("synthetic notifications retain their owned socket route and strictly ordered terminal sequence", async () => {
  const { emitSyntheticTaskSnapshot } = createMobileRenderProfileFollowScenarios({ assert, serverId: "owned-server", threadId: "owned-thread" });
  const state = () => ({ source: "after", nextSequence: 10, workspacePath: "/owned-workspace", activeThreadReadRequestId: 9,
    activeSocketRoute: { routeOrdinal: 2, server: "owned-server", channel: "runtime", workspaceMatchesFixture: true, threadReadRequestId: 9 },
    seedDispatchCaptureActive: true, notificationBatches: [] });
  let calls = 0, reverse = false;
  const page = { async evaluate(_callback, payload) {
    calls++;
    assert.equal(payload.server, "owned-server"); assert.equal(payload.channel, "runtime");
    assert.equal(payload.workspace, "/owned-workspace"); assert.equal(payload.threadId, "owned-thread"); assert.equal(payload.threadReadId, 9);
    const frameResults = payload.frames.map(frame => ({ method: frame.method, sequence: frame.params.sequence,
      serverId: frame.params.serverId, threadId: frame.params.threadId, turnId: frame.params.turnId,
      browserMockId: "one-owned-socket", dispatchHandlerSyncMs: 0.1 }));
    return { delivered: 4, socketCopies: 1, browserMockId: "one-owned-socket", dispatchTaskDurationsMs: [0.1, 0.1, 0.1, 0.1],
      frameResults: reverse ? frameResults.reverse() : frameResults };
  } };
  const owned = state(), delivered = await emitSyntheticTaskSnapshot(page, owned, "owned_marker", []);
  assert.equal(delivered.dispatchOrderValid, true);
  assert.equal(delivered.seedDispatchEvidence.dispatchOrderValid, true);
  assert.equal(owned.nextSequence, 14); assert.equal(owned.notificationBatches.length, 1);
  assert.deepEqual(owned.notificationBatches[0].sequences, [10, 11, 12, 13]);
  const missingRoute = state(); missingRoute.activeSocketRoute = null;
  await assert.rejects(emitSyntheticTaskSnapshot(page, missingRoute, "owned_marker", []), /active fixture/);
  assert.equal(calls, 1);
  reverse = true;
  const unordered = state();
  await assert.rejects(emitSyntheticTaskSnapshot(page, unordered, "owned_marker", []), /ordered thread/);
  assert.equal(unordered.notificationBatches.length, 0);
});
