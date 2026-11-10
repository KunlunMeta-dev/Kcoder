export const TOOL_PROFILES = ["full", "core", "nano", "none"] as const;
export type ToolProfile = (typeof TOOL_PROFILES)[number];

export interface ToolProfileSettings {
  profile: ToolProfile;
  effectiveProfile: ToolProfile;
  cliOverride: ToolProfile | null;
}

export interface UsageCounters {
  requests: number;
  unreportedRequests: number;
  estimatedTotalRequests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
}

export interface UsageHistory {
  version: 1;
  trackedSinceMs: number;
  lastRecordedAtMs: number;
  days: Record<string, Record<string, UsageCounters>>;
}

export interface UsageStats {
  windowDays: 30;
  timeZone: "UTC";
  generatedAtMs: number;
  history: UsageHistory | null;
}

export interface UsageSummary {
  total: UsageCounters;
  models: Array<UsageCounters & { label: string }>;
}

const counterKeys: readonly (keyof UsageCounters)[] = [
  "requests",
  "unreportedRequests",
  "estimatedTotalRequests",
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheCreationTokens",
  "totalTokens",
];

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

export function isToolProfile(value: unknown): value is ToolProfile {
  return typeof value === "string" && TOOL_PROFILES.some((profile) => profile === value);
}

export function parseToolProfileSettings(value: unknown): ToolProfileSettings {
  const result = asRecord(value);
  if (
    !result ||
    !isToolProfile(result.profile) ||
    !isToolProfile(result.effectiveProfile) ||
    !(result.cliOverride === null || isToolProfile(result.cliOverride))
  ) {
    throw new Error("Invalid tool profile response");
  }
  return {
    profile: result.profile,
    effectiveProfile: result.effectiveProfile,
    cliOverride: result.cliOverride,
  };
}

function parseCounters(value: unknown): UsageCounters {
  const source = asRecord(value);
  if (!source) throw new Error("Invalid usage counters");
  const result = {} as UsageCounters;
  for (const key of counterKeys) {
    const count = source[key];
    if (!Number.isSafeInteger(count) || (count as number) < 0) {
      throw new Error("Invalid usage counters");
    }
    result[key] = count as number;
  }
  return result;
}

function validDay(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(`${value}T00:00:00.000Z`)) &&
    new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
}

export function parseUsageStats(value: unknown): UsageStats {
  const result = asRecord(value);
  if (
    !result ||
    result.windowDays !== 30 ||
    result.timeZone !== "UTC" ||
    !isTimestamp(result.generatedAtMs)
  ) {
    throw new Error("Invalid usage statistics response");
  }

  if (result.history === null) {
    return {
      windowDays: 30,
      timeZone: "UTC",
      generatedAtMs: result.generatedAtMs,
      history: null,
    };
  }

  const history = asRecord(result.history);
  const days = asRecord(history?.days);
  if (
    !history ||
    history.version !== 1 ||
    !isTimestamp(history.trackedSinceMs) ||
    !isTimestamp(history.lastRecordedAtMs) ||
    !days
  ) {
    throw new Error("Invalid usage statistics response");
  }

  const parsedDays: UsageHistory["days"] = {};
  for (const [day, modelsValue] of Object.entries(days)) {
    const models = asRecord(modelsValue);
    if (!validDay(day) || !models) throw new Error("Invalid usage statistics response");
    const parsedModels: Record<string, UsageCounters> = {};
    for (const [model, counters] of Object.entries(models)) {
      if (!model || model.length > 1024) throw new Error("Invalid usage statistics response");
      parsedModels[model] = parseCounters(counters);
    }
    parsedDays[day] = parsedModels;
  }

  return {
    windowDays: 30,
    timeZone: "UTC",
    generatedAtMs: result.generatedAtMs,
    history: {
      version: 1,
      trackedSinceMs: history.trackedSinceMs,
      lastRecordedAtMs: history.lastRecordedAtMs,
      days: parsedDays,
    },
  };
}

function emptyCounters(): UsageCounters {
  return {
    requests: 0,
    unreportedRequests: 0,
    estimatedTotalRequests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: 0,
  };
}

function addCounters(target: UsageCounters, value: UsageCounters): void {
  for (const key of counterKeys) {
    const sum = target[key] + value[key];
    if (!Number.isSafeInteger(sum)) throw new Error("Usage counters exceed the supported range");
    target[key] = sum;
  }
}

export function summarizeUsage(stats: UsageStats, rangeDays: 7 | 30): UsageSummary | null {
  if (!stats.history) return null;
  const total = emptyCounters();
  const models = new Map<string, UsageCounters>();
  const generated = new Date(stats.generatedAtMs);
  generated.setUTCHours(0, 0, 0, 0);
  const firstDay = new Date(generated.getTime() - (rangeDays - 1) * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const lastDay = generated.toISOString().slice(0, 10);

  for (const [day, rows] of Object.entries(stats.history.days)) {
    if (day < firstDay || day > lastDay) continue;
    for (const [model, counters] of Object.entries(rows)) {
      addCounters(total, counters);
      const summary = models.get(model) ?? emptyCounters();
      addCounters(summary, counters);
      models.set(model, summary);
    }
  }

  return {
    total,
    models: [...models.entries()]
      .map(([label, counters]) => ({ label, ...counters }))
      .sort((left, right) => right.totalTokens - left.totalTokens || left.label.localeCompare(right.label)),
  };
}

export function formatUsageMessage(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{([^{}]+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : match,
  );
}

export function errorText(value: unknown): string {
  if (value instanceof Error && value.message.trim()) return value.message.trim();
  if (typeof value === "string" && value.trim()) return value.trim();
  return "";
}

export function rpcDelivery(value: unknown): "not-sent" | "unknown" | null {
  if (!(value instanceof Error)) return null;
  const delivery = (value as Error & { delivery?: unknown }).delivery;
  return delivery === "not-sent" || delivery === "unknown" ? delivery : null;
}

export function requiresExplicitProfile(value: unknown): boolean {
  return /explicit user profile/i.test(errorText(value));
}
