const MEMORY_SOURCES = new Set(['linux-vmrss', 'windows-working-set']);

// Keep only process-owned metrics; never infer remote memory from the SSH wrapper.
export function normalizeBrokerResourceSnapshot(value, receivedAt) {
  if (!value || typeof value !== 'object' || !Number.isSafeInteger(value.processId) || value.processId <= 0 ||
      typeof value.instanceId !== 'string' || !value.instanceId || value.instanceId.length > 128 ||
      !Number.isFinite(receivedAt) || receivedAt < 0) return null;
  const measured = value.includesChildren === false && MEMORY_SOURCES.has(value.memorySource) &&
    Number.isSafeInteger(value.residentBytes) && value.residentBytes >= 0;
  return Object.freeze({
    processId: value.processId,
    instanceId: value.instanceId,
    residentBytes: measured ? value.residentBytes : null,
    memorySource: measured ? value.memorySource : 'unavailable',
    receivedAt,
  });
}
