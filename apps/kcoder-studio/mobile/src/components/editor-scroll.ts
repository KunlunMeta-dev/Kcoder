function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : undefined;
}

function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
}

export function editorScrollOffsetY(event: unknown): number {
  const nativeEvent = field(event, "nativeEvent");
  const nativeOffset = finiteNumber(field(field(nativeEvent, "contentOffset"), "y"));
  if (nativeOffset !== undefined) return nativeOffset;
  const currentTargetOffset = finiteNumber(field(field(event, "currentTarget"), "scrollTop"));
  if (currentTargetOffset !== undefined) return currentTargetOffset;
  return finiteNumber(field(field(nativeEvent, "target"), "scrollTop")) ?? 0;
}
