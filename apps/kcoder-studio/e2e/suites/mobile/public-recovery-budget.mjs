export function allocateRecoveryStepBudget({
  deadlineAtMs,
  nowMs,
  reserveMs,
  maxStepMs,
  minUsefulMs = 500,
}) {
  for (const [name, value] of Object.entries({ deadlineAtMs, nowMs, reserveMs, maxStepMs, minUsefulMs })) {
    if (!Number.isFinite(value) || value < 0) throw new TypeError(`${name} must be a finite non-negative number`);
  }
  if (maxStepMs === 0 || minUsefulMs === 0) throw new RangeError("recovery step limits must be positive");

  const remainingMs = Math.max(0, Math.floor(deadlineAtMs - nowMs));
  const usableMs = Math.max(0, remainingMs - Math.floor(reserveMs));
  const timeoutMs = Math.min(Math.floor(maxStepMs), usableMs);
  const scheduled = timeoutMs >= Math.ceil(minUsefulMs);
  return {
    status: scheduled ? "scheduled" : "unverified-budget-exhausted",
    remainingMs,
    reserveMs: Math.floor(reserveMs),
    usableMs,
    timeoutMs: scheduled ? timeoutMs : 0,
  };
}
