export function usageChartFixture(now = Date.now()) {
  const midnight = new Date(now); midnight.setUTCHours(0, 0, 0, 0);
  const date = ago => new Date(midnight.getTime() - ago * 86400000).toISOString().slice(0, 10);
  const counters = total => ({ requests: 1, unreportedRequests: 0, estimatedTotalRequests: 0,
    inputTokens: total - 10, outputTokens: 10, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: total });
  return { today: date(0), yesterday: date(1), zero: date(2), missing: date(26),
    history: { version: 1, trackedSinceMs: midnight.getTime() - 25 * 86400000, lastRecordedAtMs: now,
      days: { [date(0)]: { alpha: counters(100) }, [date(1)]: { beta: counters(50) } } } };
}
