import type { GatewayServerCapabilities } from "@/gateway/rpc";

export interface WorkspaceBrowserClient {
  getCapabilities(): GatewayServerCapabilities | undefined;
  request<T>(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<T>;
}

export interface WorkspaceBrowserStartCopy {
  capabilityUnsupported: string;
  preflightMethodUnsupported: string;
  preflightUnavailable: string;
  preflightWarning(reason: string): string;
  sessionIdMissing: string;
}

export interface WorkspaceBrowserStartResult {
  sessionId: string;
  preflightWarning: string | null;
}

class BrowserPreflightUnavailableError extends Error {}

function errorReason(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

/** Checks readiness and starts a session on the caller-owned workspace browser connection. */
export async function startWorkspaceBrowserSession(
  client: WorkspaceBrowserClient,
  url: string,
  viewport: { width: number; height: number },
  copy: WorkspaceBrowserStartCopy,
): Promise<WorkspaceBrowserStartResult> {
  const experimental = client.getCapabilities()?.experimental;
  if (experimental?.browserSessions !== true)
    throw new Error(copy.capabilityUnsupported);
  const warnings: string[] = [];
  if (experimental.browserPreflight === true) {
    try {
      const result = await client.request<{ available?: boolean; reason?: string | null }>(
        "browser/preflight",
        {},
      );
      if (result.available === false) {
        throw new BrowserPreflightUnavailableError(
          result.reason?.trim() || copy.preflightUnavailable,
        );
      }
      if (result.available !== true)
        warnings.push(copy.preflightWarning(copy.preflightUnavailable));
    } catch (value) {
      if (value instanceof BrowserPreflightUnavailableError) throw value;
      warnings.push(copy.preflightWarning(errorReason(value)));
    }
  } else {
    warnings.push(copy.preflightMethodUnsupported);
  }

  const started = await client.request<{ session_id?: string }>(
    "browser/start",
    { url, ...viewport },
    30_000,
  );
  if (!started.session_id) throw new Error(copy.sessionIdMissing);
  return { sessionId: started.session_id, preflightWarning: warnings.length ? warnings.join(" ") : null };
}
