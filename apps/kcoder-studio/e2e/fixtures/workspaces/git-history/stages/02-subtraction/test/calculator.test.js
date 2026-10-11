import assert from "node:assert/strict";
import test from "node:test";
import { add, subtract } from "../src/calculator.js";

test("supports addition and subtraction", () => {
  assert.equal(add(2, 3), 5);
  assert.equal(subtract(7, 4), 3);
});

