import assert from "node:assert/strict";
import test from "node:test";
import { allocateRecoveryStepBudget } from "./public-recovery-budget.mjs";

test("recovery step is capped while leaving the reserved final verification time", () => {
  assert.deepEqual(allocateRecoveryStepBudget({
    deadlineAtMs: 35_000,
    nowMs: 0,
    reserveMs: 24_000,
    maxStepMs: 3_000,
  }), {
    status: "scheduled",
    remainingMs: 35_000,
    reserveMs: 24_000,
    usableMs: 11_000,
    timeoutMs: 3_000,
  });
});

test("recovery step shrinks when elapsed work approaches the reserved verification window", () => {
  const budget = allocateRecoveryStepBudget({
    deadlineAtMs: 35_000,
    nowMs: 33_500,
    reserveMs: 800,
    maxStepMs: 3_000,
  });
  assert.equal(budget.status, "scheduled");
  assert.equal(budget.timeoutMs, 700);
});

test("recovery marks a step unverified when it cannot preserve the required reserve", () => {
  assert.deepEqual(allocateRecoveryStepBudget({
    deadlineAtMs: 35_000,
    nowMs: 34_500,
    reserveMs: 800,
    maxStepMs: 3_000,
  }), {
    status: "unverified-budget-exhausted",
    remainingMs: 500,
    reserveMs: 800,
    usableMs: 0,
    timeoutMs: 0,
  });
});

test("sequential recovery keeps the final static-root check after the 15 second forward-stop budget", () => {
  const reserveAfterEach = [24_000, 21_000, 18_000, 15_000, 12_000, 9_000, 6_000, 3_000, 0];
  const deadlineAtMs = 35_000;
  let nowMs = 15_000;
  let finalStep;
  const statuses = [];
  for (const reserveMs of reserveAfterEach) {
    finalStep = allocateRecoveryStepBudget({
      deadlineAtMs,
      nowMs,
      reserveMs,
      maxStepMs: 3_000,
    });
    statuses.push(finalStep.status);
    if (finalStep.status === "scheduled") nowMs += finalStep.timeoutMs;
  }
  assert.deepEqual(statuses.slice(0, 2), ["unverified-budget-exhausted", "unverified-budget-exhausted"]);
  assert.equal(finalStep.status, "scheduled");
  assert.equal(finalStep.timeoutMs, 3_000);
  assert.equal(nowMs, deadlineAtMs);
});

test("recovery scheduler rejects invalid time budgets", () => {
  assert.throws(() => allocateRecoveryStepBudget({
    deadlineAtMs: 35_000,
    nowMs: 0,
    reserveMs: -1,
    maxStepMs: 3_000,
  }), /reserveMs/);
});
