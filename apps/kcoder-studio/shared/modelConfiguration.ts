export interface ModelReasoningPolicy {
  mode: "hidden" | "optional" | "always_on" | "always_off";
  efforts: string[];
}
const reasoningEfforts = new Set([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);
export function readReasoningPolicy(
  value: unknown,
): ModelReasoningPolicy | undefined {
  if (!value || typeof value !== "object") return undefined;
  const policy = value as Record<string, unknown>;
  if (
    !["hidden", "optional", "always_on", "always_off"].includes(
      String(policy.mode),
    ) ||
    !Array.isArray(policy.efforts) ||
    !policy.efforts.every(
      (effort) => typeof effort === "string" && reasoningEfforts.has(effort),
    )
  )
    return undefined;
  return {
    mode: policy.mode as ModelReasoningPolicy["mode"],
    efforts: [...new Set(policy.efforts as string[])],
  };
}
/** Public projection only. Never copy unknown fields from a server response. */
export interface ModelConfigurationSummary {
  providerId: string | null;
  modelId: string;
  apiFormat: string | null;
  chatProtocol: string;
  contextWindowTokens: number | null;
  maxOutputTokens: number | null;
  requestOutputLimits: Record<string, number | null>;
  outputHeadroomTokens: number | null;
  text: boolean;
  tools: boolean;
  vision: boolean;
  reasoning: boolean;
  structuredOutput: boolean;
  reasoningEffort: string | null;
  reasoningPolicy?: ModelReasoningPolicy;
  extraBodyConfigured: boolean;
  requestOverrideFields: string[];
  revision: string;
  boundary: "next_turn" | "session_snapshot";
  sources: Record<string, string[]>;
}
const fields = new Set([
  "endpoint",
  "api_format",
  "authentication",
  "chat_protocol",
  "context_window_tokens",
  "output_headroom_tokens",
  "max_output_tokens",
  "capabilities",
  "capabilities.text",
  "capabilities.tools",
  "capabilities.vision",
  "capabilities.reasoning",
  "capabilities.structured_output",
  "reasoning_effort",
  "reasoning_policy",
  "extra_body",
]);
const layers = new Set([
  "default",
  "user",
  "executable",
  "project",
  "local",
  "overlay",
  "cli_environment",
  "environment",
  "turn",
  "session_snapshot",
]);
const overrides = new Set([
  "max_tokens",
  "max_completion_tokens",
  "max_output_tokens",
  "temperature",
  "thinking",
  "reasoning",
  "reasoning_effort",
]);
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown) => (typeof value === "string" ? value : null);
const tokens = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
export function readModelConfiguration(
  value: unknown,
): ModelConfigurationSummary | undefined {
  const input = record(value);
  if (
    typeof input.modelId !== "string" ||
    typeof input.revision !== "string" ||
    !/^[a-f0-9]{64}$/.test(input.revision) ||
    !["next_turn", "session_snapshot"].includes(String(input.boundary))
  )
    return undefined;
  const sources: Record<string, string[]> = {};
  for (const [field, raw] of Object.entries(record(input.sources)))
    if (fields.has(field) && Array.isArray(raw))
      sources[field] = raw.filter(
        (layer): layer is string =>
          typeof layer === "string" && layers.has(layer),
      );
  return {
    providerId: text(input.providerId),
    modelId: input.modelId,
    apiFormat: text(input.apiFormat),
    chatProtocol: text(input.chatProtocol) ?? "auto",
    contextWindowTokens: tokens(input.contextWindowTokens),
    maxOutputTokens: tokens(input.maxOutputTokens),
    requestOutputLimits: Object.fromEntries(
      Object.entries(record(input.requestOutputLimits))
        .filter(([field]) =>
          ["max_tokens", "max_completion_tokens", "max_output_tokens"].includes(
            field,
          ),
        )
        .map(([field, value]) => [field, tokens(value)]),
    ),
    outputHeadroomTokens: tokens(input.outputHeadroomTokens),
    text: input.text === true,
    tools: input.tools === true,
    vision: input.vision === true,
    reasoning: input.reasoning === true,
    structuredOutput: input.structuredOutput === true,
    reasoningEffort: text(input.reasoningEffort),
    reasoningPolicy: readReasoningPolicy(input.reasoningPolicy),
    extraBodyConfigured: input.extraBodyConfigured === true,
    requestOverrideFields: Array.isArray(input.requestOverrideFields)
      ? input.requestOverrideFields.filter(
          (field): field is string =>
            typeof field === "string" && overrides.has(field),
        )
      : [],
    revision: input.revision,
    boundary: input.boundary as ModelConfigurationSummary["boundary"],
    sources,
  };
}

export interface ModelExecutionScope {
  targetId: string;
  accountMode: "shared" | "account";
  username: string | null;
  principalId: string | null;
}
export function readModelExecutionScope(
  value: unknown,
): ModelExecutionScope | undefined {
  const input = record(value);
  if (
    typeof input.targetId !== "string" ||
    !["shared", "account"].includes(String(input.accountMode))
  )
    return undefined;
  return {
    targetId: input.targetId,
    accountMode: input.accountMode as ModelExecutionScope["accountMode"],
    username: text(input.username),
    principalId: text(input.principalId),
  };
}
