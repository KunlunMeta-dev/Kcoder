import { isTurnFileChangesCapture } from "./generated/contractGuards.mjs";
import type { TurnFileChangesCapture } from "./generated/contracts.js";

export function normalizeTurnFileCapture(
  value: unknown,
  binding?: { threadId?: string; turnId?: string; attemptId?: string },
): TurnFileChangesCapture | undefined {
  if (!isTurnFileChangesCapture(value) || value.version !== 1) return undefined;
  if (!/^[a-f0-9]{64}$/.test(value.captureId) || value.limitations.length > 6)
    return undefined;
  for (const id of [value.threadId, value.turnId, value.attemptId]) {
    if (!id || id.length > 512 || /[\u0000-\u001f\u007f]/.test(id))
      return undefined;
  }
  if (
    (binding?.threadId !== undefined && value.threadId !== binding.threadId) ||
    (binding?.turnId !== undefined && value.turnId !== binding.turnId) ||
    (binding?.attemptId !== undefined && value.attemptId !== binding.attemptId)
  )
    return undefined;
  for (const window of [value.base, value.head]) {
    if (
      window &&
      (!Number.isSafeInteger(window.startedAtMs) ||
        !Number.isSafeInteger(window.completedAtMs) ||
        window.startedAtMs < 0 ||
        window.completedAtMs < window.startedAtMs ||
        window.completedAtMs > 8_640_000_000_000_000)
    )
      return undefined;
  }
  if (
    value.artifactId !== null &&
    value.artifactId !== undefined &&
    !/^[a-f0-9]{64}$/.test(value.artifactId)
  )
    return undefined;
  if (value.state === "changed" || value.state === "unchanged") {
    if (
      !value.base ||
      !value.head ||
      value.limitations.length !== 0 ||
      (value.state === "changed") !== Boolean(value.artifactId)
    )
      return undefined;
  }
  if (value.state === "capturing")
    return {
      ...value,
      state: "unknown",
      limitations: [
        ...new Set([...value.limitations, "captureIncomplete" as const]),
      ],
    };
  return value;
}
