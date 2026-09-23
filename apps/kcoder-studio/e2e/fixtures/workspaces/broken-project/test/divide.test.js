import assert from "node:assert/strict";
import test from "node:test";
import { divide } from "../src/divide.js";

test("divides finite values", () => {
  assert.equal(divide(12, 3), 4);
});

test("rejects division by zero", () => {
  assert.throws(() => divide(12, 0), RangeError);
});

