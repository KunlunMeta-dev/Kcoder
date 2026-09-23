import assert from "node:assert/strict";
import test from "node:test";

import {
  REQUEST_LOAD_CHANNELS,
  RequestLoadTracker,
  mergeRequestLoad,
  requestLoadDiagnostic,
} from "../request-load.js";

test("tracks in-flight requests per channel and keeps a high-water mark", () => {
  const tracker = new RequestLoadTracker();
  assert.deepEqual(tracker.snapshot().total, { inFlight: 0, highWater: 0 });

  tracker.begin("runtime", 1);
  tracker.begin("runtime", 2);
  tracker.begin("browser", 3);
  assert.deepEqual(tracker.snapshot().perChannel.runtime, { inFlight: 2, highWater: 2 });
  assert.deepEqual(tracker.snapshot().perChannel.browser, { inFlight: 1, highWater: 1 });
  assert.deepEqual(tracker.snapshot().total, { inFlight: 3, highWater: 3 });

  tracker.settle("runtime", 1);
  tracker.settle("runtime", 2);
  // The high-water mark survives the requests that produced it.
  assert.deepEqual(tracker.snapshot().perChannel.runtime, { inFlight: 0, highWater: 2 });
  assert.deepEqual(tracker.snapshot().total, { inFlight: 1, highWater: 3 });
});

test("settling an unknown or repeated request never goes negative", () => {
  const tracker = new RequestLoadTracker();
  tracker.settle("runtime", 7);
  tracker.settle("runtime", undefined);
  tracker.settle("unknown-channel", 1);

  tracker.begin("runtime", 7);
  tracker.begin("runtime", 7);
  tracker.settle("runtime", 7);
  tracker.settle("runtime", 7);
  assert.deepEqual(tracker.snapshot().perChannel.runtime, { inFlight: 0, highWater: 1 });
});

test("stays bounded when requests are never answered", () => {
  const tracker = new RequestLoadTracker({ capacityPerChannel: 8 });
  for (let id = 1; id <= 40; id += 1) tracker.begin("runtime", id);

  const runtime = tracker.snapshot().perChannel.runtime;
  assert.equal(runtime.inFlight, 8, "unanswered requests must not grow the tracker");
  assert.equal(runtime.highWater, 8);

  // The oldest entry was dropped, so its late answer is simply ignored.
  tracker.settle("runtime", 1);
  assert.equal(tracker.snapshot().perChannel.runtime.inFlight, 8);
  tracker.settle("runtime", 40);
  assert.equal(tracker.snapshot().perChannel.runtime.inFlight, 7);
});

test("classifies every channel and never carries request data", () => {
  assert.deepEqual([...REQUEST_LOAD_CHANNELS], ["runtime", "browser", "ssh-terminal", "other"]);
  const tracker = new RequestLoadTracker();
  tracker.begin("ssh-terminal", 1);
  tracker.begin("something-else", 2);

  const snapshot = tracker.snapshot();
  assert.deepEqual(snapshot.perChannel["ssh-terminal"], { inFlight: 1, highWater: 1 });
  assert.deepEqual(snapshot.perChannel.other, { inFlight: 1, highWater: 1 });
  assert.deepEqual(
    Object.keys(snapshot.perChannel).sort(),
    ["browser", "other", "runtime", "ssh-terminal"],
  );
});

test("the diagnostic is counts only and names outstanding requests", () => {
  const tracker = new RequestLoadTracker();
  tracker.begin("runtime", 1);
  tracker.begin("browser", 2);

  const diagnostic = requestLoadDiagnostic(tracker.snapshot());
  assert.equal(diagnostic.event, "request-load");
  assert.deepEqual(diagnostic.perChannel.runtime, { inFlight: 1, highWater: 1 });
  assert.deepEqual(diagnostic.total, { inFlight: 2, highWater: 2 });
  // No ids, methods, payloads or channel-internal names travel with the counts.
  const serialized = JSON.stringify(diagnostic);
  assert.ok(!serialized.includes('"1"') && !serialized.includes('"2"'));
  assert.ok(!serialized.includes("method"));
});

test("a tracker with a broken capacity argument still counts", () => {
  for (const capacityPerChannel of [0, -1, 1.5, Number.NaN]) {
    const tracker = new RequestLoadTracker({ capacityPerChannel });
    tracker.begin("runtime", 1);
    assert.equal(tracker.snapshot().perChannel.runtime.inFlight, 1);
  }
});

test("merging brokers sums what is outstanding and keeps the worst high-water", () => {
  const first = new RequestLoadTracker();
  first.begin("runtime", 1);
  first.begin("runtime", 2);
  first.begin("browser", 3);
  first.settle("runtime", 2);

  const second = new RequestLoadTracker();
  second.begin("runtime", 4);
  second.begin("runtime", 5);
  second.begin("runtime", 6);

  const merged = mergeRequestLoad([first.snapshot(), second.snapshot()]);
  assert.deepEqual(merged.perChannel.runtime, { inFlight: 4, highWater: 3 });
  assert.deepEqual(merged.perChannel.browser, { inFlight: 1, highWater: 1 });
  assert.deepEqual(merged.total, { inFlight: 5, highWater: 6 });
  assert.deepEqual(mergeRequestLoad([]).total, { inFlight: 0, highWater: 0 });
});
