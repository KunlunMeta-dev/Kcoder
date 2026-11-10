import { t } from "@/i18n";

export type GatewayHttpErrorCategory =
  | "authentication"
  | "not_found"
  | "rate_limited"
  | "gateway_unavailable"
  | "other";

export type GatewayHttpErrorMessageKey =
  | "connect.http_authentication_failed"
  | "connect.http_address_not_found"
  | "connect.http_rate_limited"
  | "connect.http_gateway_unavailable"
  | "connect.http_request_rejected";

const categoryMessageKeys: Record<GatewayHttpErrorCategory, GatewayHttpErrorMessageKey> = {
  authentication: "connect.http_authentication_failed",
  not_found: "connect.http_address_not_found",
  rate_limited: "connect.http_rate_limited",
  gateway_unavailable: "connect.http_gateway_unavailable",
  other: "connect.http_request_rejected",
};

/** HTTP failures stay distinct from network, timeout, cancellation, and auth-state errors. */
export class GatewayHttpError extends Error {
  readonly category: GatewayHttpErrorCategory;
  readonly detail?: string;

  constructor(readonly status: number, detail?: string) {
    const category = categoryForGatewayHttpStatus(status);
    const safeDetail = safeGatewayHttpErrorDetail(detail);
    const localizedCategory = t(categoryMessageKeys[category]);
    super(safeDetail ? `${safeDetail} — ${localizedCategory}` : localizedCategory);
    this.name = "GatewayHttpError";
    this.category = category;
    this.detail = safeDetail;
  }
}

export interface GatewayHttpErrorPresentation {
  categoryKey: GatewayHttpErrorMessageKey;
  status: number;
  /** A bounded, sanitized JSON error suitable for display as the primary error. */
  detail?: string;
}

const routeFailureKeys = {
  descriptor: "connect.route_identity_failed",
  key_digest: "connect.route_crypto_failed",
  nonce: "connect.route_crypto_failed",
  network: "connect.route_network_failed",
  http: "connect.route_http_failed",
  body: "connect.route_response_failed",
  identity: "connect.route_identity_failed",
  signature: "connect.route_identity_failed",
  timeout: "connect.route_timeout",
} as const;

/** Only bounded local stage codes and HTTP status are displayed, never raw causes or QR data. */
export function gatewayRouteErrorPresentation(error: unknown): {
  messageKey: typeof routeFailureKeys[keyof typeof routeFailureKeys]; detail: string;
} | undefined {
  const seen = new Set<unknown>();
  for (let depth = 0; depth < 5 && error instanceof Error && !seen.has(error); depth++) {
    seen.add(error);
    const value = error as Error & { code?: unknown; failure?: unknown; status?: unknown };
    if (value.name === "GatewayRouteResolutionError" &&
        (value.code === "GATEWAY_ROUTE_UNAVAILABLE" || value.code === "GATEWAY_ROUTE_DESCRIPTOR_INVALID") &&
        typeof value.failure === "string" && Object.hasOwn(routeFailureKeys, value.failure)) {
      const failure = value.failure as keyof typeof routeFailureKeys;
      const status = typeof value.status === "number" && Number.isInteger(value.status) &&
        value.status >= 100 && value.status <= 599 ? ` · HTTP ${value.status}` : "";
      return { messageKey: routeFailureKeys[failure], detail: `${value.code}/${failure}${status}` };
    }
    error = value.cause;
  }
  return undefined;
}

/** Resolve presentation data at render time so screens can translate with their current locale. */
export function gatewayHttpErrorPresentation(error: unknown): GatewayHttpErrorPresentation | undefined {
  if (!(error instanceof GatewayHttpError)) return undefined;
  return {
    categoryKey: categoryMessageKeys[error.category],
    status: error.status,
    ...(error.detail ? { detail: error.detail } : {}),
  };
}

export function categoryForGatewayHttpStatus(status: number): GatewayHttpErrorCategory {
  if (status === 401 || status === 403) return "authentication";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limited";
  if (status >= 500 && status <= 599) return "gateway_unavailable";
  return "other";
}

/** Keep useful server text while dropping markup, endpoint URLs, and credential-bearing details. */
export function safeGatewayHttpErrorDetail(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  let detail = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!detail || /<\/?[a-z][^>]*>/i.test(detail) || /<!doctype/i.test(detail)) return undefined;

  detail = detail
    .replace(/\b(?:https?|wss?):\/\/[^\s<>"']+/gi, "[address hidden]")
    .replace(/(^|\s)(?:(?:\d{1,3}\.){3}\d{1,3}|(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,})(?::\d{1,5})?(?:\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]+(?:\?[^\s<>"']*)?)?/g, "$1[address hidden]")
    .replace(/(^|\s)\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]+(?:\?[^\s<>"']*)?/g, "$1[path hidden]");

  const credentialField = "(?:(?:access|refresh|rpc|pairing|api|auth|session|device|client)[_-]?(?:token|secret|key)|token|secret|authorization|password|cookie|credential|jwt)";
  const credentialAssignment = new RegExp(`["']?${credentialField}["']?\\s*[:=]`, "i");
  const authSchemeToken = /\b(?:basic|bearer)\s+([A-Za-z0-9._~+/-]{8,}={0,2})/gi;
  let authSchemeMatch: RegExpExecArray | null;
  let hasAuthSchemeCredential = false;
  while ((authSchemeMatch = authSchemeToken.exec(detail))) {
    const token = authSchemeMatch[1]!.replace(/=+$/, "");
    const upperCount = token.match(/[A-Z]/g)?.length ?? 0;
    const lowerCount = token.match(/[a-z]/g)?.length ?? 0;
    if (
      token.length >= 24 || /[0-9._~+/-]/.test(token) ||
      (upperCount >= 2 && lowerCount >= 2)
    ) {
      hasAuthSchemeCredential = true;
      break;
    }
  }
  if (credentialAssignment.test(detail) || hasAuthSchemeCredential) {
    return undefined;
  }

  detail = detail
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[redacted]")
    .replace(/\b[A-Fa-f0-9]{48,}\b/g, "[redacted]")
    .replace(/\b[A-Za-z0-9_-]{64,}\b/g, "[redacted]")
    .trim();

  if (!detail) return undefined;
  return detail.length > 240 ? `${detail.slice(0, 237).trimEnd()}…` : detail;
}
