import type { GatewayProfile, KCoderServer } from "./types";
import { gatewayRequest } from "./http";
import { captureSessionTranscriptScope, sessionTranscriptScopeKey } from "@/storage/session-transcript-scope";

export const WORKSPACE_CWD_REQUEST_TIMEOUT_MS = 4_000;
export interface BoundWorkspaceCwdObservation {
  version: 1; targetId: string; targetSignature: string; workspacePath: string;
  loginGeneration: number; observedAt: number; status: "present" | "absent";
}
export type WorkspaceCwdObservation = BoundWorkspaceCwdObservation | { status: "unknown"; reason: string };
const unknown = (reason: string): WorkspaceCwdObservation => ({ status: "unknown", reason });

/** Conservative path spelling shared by request and response validation. No remote path guessing. */
export function workspaceObservationPath(value: string): string | null {
  if (typeof value !== "string" || !value || value.length > 2048 || /\p{Cc}/u.test(value)) return null;
  // A backslash in a POSIX name is literal. Only drive paths use it as a separator.
  const slashes = /^[a-z]:[\\/]/i.test(value) ? value.replace(/\\/g, "/") : value;
  const path = /^[a-z]:\/+$/i.test(slashes) ? `${slashes.slice(0, 2)}/` : slashes.replace(/\/+$/, "") || "/";
  if (!path.startsWith("/") && !/^[a-z]:\//i.test(path)) return null;
  const components = path.split("/").filter(Boolean);
  if (components.length > 128 || components.some(component => component === "." || component === "..")) return null;
  return path;
}

/** Advisory and abortable. Only a fully bound local result may become cache invalidation evidence. */
export async function observeWorkspaceCwd(input: {
  profile: GatewayProfile; server: KCoderServer; cwd: string; isCurrent: () => boolean; signal?: AbortSignal;
}): Promise<WorkspaceCwdObservation> {
  const path = workspaceObservationPath(input.cwd);
  const targetIdentity = input.server.observationTargetIdentity;
  if (!path) return unknown("invalid_path");
  if (!targetIdentity || !/^[a-f0-9]{64}$/.test(targetIdentity)) return unknown("unbound_target");
  if (input.server.transport !== "local") return unknown("unsupported_transport");
  let scopeKey: string;
  try { scopeKey = sessionTranscriptScopeKey(captureSessionTranscriptScope(input.profile, input.server, input.cwd, "__workspace_observation__")); }
  catch { return unknown("unbound_scope"); }
  const current = () => {
    try { return input.isCurrent() && input.server.observationTargetIdentity === targetIdentity &&
      workspaceObservationPath(input.cwd) === path && scopeKey === sessionTranscriptScopeKey(
        captureSessionTranscriptScope(input.profile, input.server, input.cwd, "__workspace_observation__")); }
    catch { return false; }
  };
  if (!current() || input.signal?.aborted) return unknown("cancelled");
  const controller = new AbortController();
  const abort = () => controller.abort();
  input.signal?.addEventListener("abort", abort, { once: true });
  let finishAbort!: () => void;
  const cancelled = new Promise<WorkspaceCwdObservation>(resolve => {
    finishAbort = () => resolve(unknown("cancelled_or_timeout"));
    controller.signal.addEventListener("abort", finishAbort, { once: true });
  });
  const timer = setTimeout(abort, WORKSPACE_CWD_REQUEST_TIMEOUT_MS);
  try {
    const request = gatewayRequest<unknown>(input.profile,
      `/api/servers/${encodeURIComponent(input.server.id)}/cwd-observation?workspace=${encodeURIComponent(path)}&expectedTargetIdentity=${targetIdentity}`,
      { signal: controller.signal }).then(payload => {
      if (!current() || controller.signal.aborted || !payload || typeof payload !== "object" || Array.isArray(payload))
        return unknown("stale_or_invalid_response");
      const value = payload as Record<string, unknown>;
      if (value.authorized !== true || value.version !== 1 || value.targetId !== input.server.id ||
          value.targetSignature !== targetIdentity || typeof value.workspacePath !== "string" || workspaceObservationPath(value.workspacePath) !== path ||
          !Number.isSafeInteger(value.loginGeneration) || Number(value.loginGeneration) < 0 ||
          typeof value.observedAt !== "number" || !Number.isFinite(value.observedAt) || value.observedAt < 0)
        return unknown("unbound_response");
      if (value.status !== "present" && value.status !== "absent")
        return unknown(typeof value.reason === "string" && value.reason.length <= 128 ? value.reason : "unobservable");
      if (value.reason !== undefined) return unknown("invalid_response");
      return { version: 1, targetId: value.targetId as string, targetSignature: targetIdentity,
        workspacePath: path, loginGeneration: value.loginGeneration as number, observedAt: value.observedAt,
        status: value.status } satisfies BoundWorkspaceCwdObservation;
    }, () => unknown("request_failed"));
    return await Promise.race([request, cancelled]);
  } finally {
    clearTimeout(timer); input.signal?.removeEventListener("abort", abort);
    controller.signal.removeEventListener("abort", finishAbort);
  }
}
