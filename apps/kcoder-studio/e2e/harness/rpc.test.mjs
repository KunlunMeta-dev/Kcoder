import test from "node:test";
import assert from "node:assert/strict";
import { isTurnCompletion } from "./rpc.mjs";

test("completion matching never reuses another thread with the same local turn ID", () => {
  const first = {
    method: "turn/completed",
    params: { threadId: "first", turnId: "turn-1" },
  };
  assert.equal(isTurnCompletion(first, "first", "turn-1"), true);
  assert.equal(isTurnCompletion(first, "second", "turn-1"), false);
  assert.equal(isTurnCompletion(first, "first", "turn-2"), false);
  assert.equal(
    isTurnCompletion({ method: "turn/completed" }, undefined, undefined),
    false,
  );
});
