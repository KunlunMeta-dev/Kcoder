import assert from "node:assert/strict";
import test from "node:test";
import {
  createRuntimeTargetAdapter,
  PassthroughRuntimeTargetAdapter,
  RuntimeTargetAdapter,
} from "../src/runtime-target-adapter.js";

const request = (id, method, params = {}) => ({ jsonrpc: "2.0", id, method, params });

test("KCoder adapter keeps the established wire protocol intact", () => {
  const adapter = createRuntimeTargetAdapter("kcoder");
  const message = request(1, "thread/list", { limit: 10 });

  assert.equal(adapter.runtime, "kcoder");
  assert.equal(adapter.rawPassthrough, true);
  assert.deepEqual(adapter.toUpstream(message), { upstream: [message], client: [] });
  assert.deepEqual(adapter.fromUpstream({ jsonrpc: "2.0", id: 1, result: { threads: [] } }), {
    upstream: [], client: [{ jsonrpc: "2.0", id: 1, result: { threads: [] } }],
  });
});

test("adapter abstraction remains reusable without exposing unsupported runtimes", () => {
  const adapter = new PassthroughRuntimeTargetAdapter("fixture");
  assert.ok(adapter instanceof RuntimeTargetAdapter);
  assert.deepEqual(adapter.toUpstream({ id: 7 }), {
    upstream: [{ id: 7 }],
    client: [],
  });
  assert.throws(() => createRuntimeTargetAdapter("codex"), /unsupported runtime target adapter/);
});

test("base adapter fails explicitly when a future implementation is incomplete", () => {
  const adapter = new RuntimeTargetAdapter("future");
  assert.throws(() => adapter.toUpstream({}), /does not implement toUpstream/);
  assert.throws(() => adapter.fromUpstream({}), /does not implement fromUpstream/);
});
