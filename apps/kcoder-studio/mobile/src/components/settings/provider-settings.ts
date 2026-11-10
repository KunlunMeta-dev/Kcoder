export const PROVIDER_API_FORMATS = [
  "anthropic_messages",
  "openai_chat_completions",
  "openai_responses",
  "gemini_generate_content",
] as const;

export type ProviderApiFormat = (typeof PROVIDER_API_FORMATS)[number];
export type ProviderAuthenticationMode = "api_key" | "none";

export interface ProviderAuthentication {
  mode: ProviderAuthenticationMode;
}

export interface ProviderModelCapabilities {
  text: boolean;
  tools: boolean;
  vision: boolean;
  reasoning: boolean;
  structured_output: boolean;
}

export interface ProviderTemplate {
  id: string;
  displayName: string;
  apiFormat: ProviderApiFormat;
  endpoint: string;
  documentationUrl: string;
  authentication?: ProviderAuthentication;
}

export interface ProviderProfile {
  id: string;
  apiFormat: ProviderApiFormat;
  endpoint: string;
  model: string;
  contextWindowTokens: number;
  maxOutputTokens: number;
  apiKeyConfigured: boolean;
  authentication?: ProviderAuthentication;
  capabilities?: ProviderModelCapabilities;
  nextTurnConfiguration?: { revision?: string };
  isDefault: boolean;
  isProviderDefault?: boolean;
  canDelete?: boolean;
}

export interface ProviderSettings {
  supportsIndependentProbe?: boolean;
  supportsRuntimeScope?: boolean;
  supportsOptimisticConcurrency?: boolean;
  revision?: string;
  savedRevision?: string;
  supportsChatProtocol?: boolean;
  supportsModelReasoning?: boolean;
  supportsModelReasoningPolicy?: boolean;
  supportsExtraBody?: boolean;
  supportsModelExtraBody?: boolean;
  supportsTurnModelReload?: boolean;
  supportsNewSessionReload?: boolean;
  supportsMultipleModels?: boolean;
  supportsModelCapabilities?: boolean;
  profiles: ProviderProfile[];
  restartRequired: boolean;
  warning?: string | null;
}

export interface ProviderSettingsDraft {
  id: string;
  apiFormat: ProviderApiFormat;
  endpoint: string;
  model: string;
  contextWindowTokens: string;
  maxOutputTokens: string;
  apiKey: string;
  authentication: ProviderAuthenticationMode;
  capabilities?: ProviderModelCapabilities;
  makeDefault: boolean;
  originalModel?: string;
  savedCredentialConfigured: boolean;
}

export interface ProviderUpsertOptions {
  expectedRevision?: string;
  independentProbe: boolean;
  supportsAuthenticationPolicy: boolean;
  supportsModelCapabilities: boolean;
  supportsMultipleModels: boolean;
}

export function makeProviderUpsertParams(
  draft: ProviderSettingsDraft,
  contextWindowTokens: number,
  maxOutputTokens: number,
  options: ProviderUpsertOptions,
): Record<string, unknown> {
  const params: Record<string, unknown> = {
    id: draft.id.trim(),
    apiFormat: draft.apiFormat,
    endpoint: draft.endpoint.trim(),
    model: draft.model.trim(),
    contextWindowTokens,
    maxOutputTokens,
    makeDefault: draft.makeDefault,
    validateConnection: !options.independentProbe,
  };
  if (options.expectedRevision) params.expectedRevision = options.expectedRevision;
  if (draft.apiKey.trim()) params.apiKey = draft.apiKey;
  if (options.supportsAuthenticationPolicy)
    params.authentication = { mode: draft.authentication } satisfies ProviderAuthentication;
  if (options.supportsMultipleModels && draft.originalModel)
    params.originalModel = draft.originalModel;
  if (options.supportsModelCapabilities)
    params.capabilities = draft.capabilities ?? conservativeProviderCapabilities;
  return params;
}

export const conservativeProviderCapabilities: ProviderModelCapabilities = {
  text: true,
  tools: false,
  vision: false,
  reasoning: false,
  structured_output: false,
};

export function positiveInteger(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function safeProviderEndpointLabel(value: string): string {
  try {
    const url = new URL(value);
    let changed = false;
    if (url.username || url.password) {
      url.username = url.username ? "redacted" : "";
      url.password = url.password ? "redacted" : "";
      changed = true;
    }
    if (url.search) {
      url.search = "?redacted";
      changed = true;
    }
    if (url.hash) {
      url.hash = "#redacted";
      changed = true;
    }
    return changed ? url.toString() : value;
  } catch {
    return value;
  }
}

export function providerProbeErrorCategory(error: unknown): string | null {
  const message = error instanceof Error ? error.message : "";
  const match = /\[provider_probe_([a-z_]+)\]/.exec(message);
  if (!match) return null;
  const allowed = new Set([
    "authentication",
    "permission",
    "quota",
    "rate_limit",
    "overloaded",
    "model",
    "timeout",
    "network",
    "response",
    "configuration",
    "changed",
    "busy",
    "unsupported",
  ]);
  return allowed.has(match[1]) ? match[1] : null;
}

/** Lost mutation receipts are uncertain; do not retry or clear the user's draft. */
export function providerSaveOutcomeUnknown(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (/\[provider_probe_[a-z_]+\]/.test(error.message)) return false;
  const delivery = (error as Error & { delivery?: string }).delivery;
  if (delivery === "not-sent") return false;
  if (delivery === "unknown") return true;
  const reason = (error as Error & { reason?: string }).reason;
  return (
    reason === "connection" ||
    reason === "timeout" ||
    error.message.includes("[provider_transaction_pending]") ||
    /timed?\s*out|timeout|connection closed|连接已断开/i.test(error.message)
  );
}

export function providerTemplateDraft(template: ProviderTemplate): ProviderSettingsDraft {
  return {
    id: template.id,
    apiFormat: template.apiFormat,
    endpoint: template.endpoint,
    model: "",
    contextWindowTokens: "",
    maxOutputTokens: "",
    apiKey: "",
    authentication: template.authentication?.mode ?? "api_key",
    capabilities: conservativeProviderCapabilities,
    makeDefault: false,
    savedCredentialConfigured: false,
  };
}
