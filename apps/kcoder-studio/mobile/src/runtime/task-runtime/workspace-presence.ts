import type { GatewayProfile, KCoderServer } from "@/gateway/types";
import { observeWorkspaceCwd, type BoundWorkspaceCwdObservation } from "@/gateway/workspace-cwd-observation";
import { sessionTranscriptCache } from "@/storage/session-transcript-cache";
import { captureSessionTranscriptScope, sessionTranscriptScopeKey, type SessionTranscriptScope } from "@/storage/session-transcript-scope";
import type { SessionTranscriptWorkspaceWitness } from "@/storage/session-transcript-store";

export const WORKSPACE_PRESENCE_PHASE_DEADLINE_MS = 5_000;
export interface WorkspacePresenceObservation {
  result: BoundWorkspaceCwdObservation & { status: "absent" };
  scope: SessionTranscriptScope;
  witness: SessionTranscriptWorkspaceWitness | null;
  /** Ephemeral attempt ownership remains mandatory even when cache I/O produced no witness. */
  isCurrent: () => boolean;
}

/** Recovery-failure path only. Capture the exact cache prefix before observing the target. */
export async function probeWorkspacePresence(input: {
  profile: GatewayProfile; server: KCoderServer; cwd: string; threadId: string;
  isCurrentOwner: () => boolean; signal?: AbortSignal;
}, cache = sessionTranscriptCache): Promise<WorkspacePresenceObservation | null> {
  if (!input.server.observationTargetIdentity || input.server.transport !== "local") return null;
  let scope: SessionTranscriptScope;
  try { scope = captureSessionTranscriptScope(input.profile, input.server, input.cwd, input.threadId); }
  catch { return null; }
  const scopeKey = sessionTranscriptScopeKey(scope), identity = input.server.observationTargetIdentity;
  let active = true, successful = false;
  const controller = new AbortController();
  let resolveCancellation!: (value: null) => void;
  const cancellation = new Promise<null>(resolve => { resolveCancellation = resolve; });
  const abort = () => { active = false; controller.abort(); resolveCancellation(null); };
  const current = () => {
    try { return active && !input.signal?.aborted && input.isCurrentOwner() && input.server.observationTargetIdentity === identity &&
      scopeKey === sessionTranscriptScopeKey(captureSessionTranscriptScope(input.profile, input.server, input.cwd, input.threadId)); }
    catch { return false; }
  };
  if (!current()) return null;
  input.signal?.addEventListener("abort", abort, { once: true });
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>(resolve => {
    deadlineTimer = setTimeout(() => { abort(); resolve(null); }, WORKSPACE_PRESENCE_PHASE_DEADLINE_MS);
  });
  const operation = (async (): Promise<WorkspacePresenceObservation | null> => {
    let witness: SessionTranscriptWorkspaceWitness | null = null;
    try { witness = await cache.captureWorkspaceWitness(scope, current); }
    catch { /* The current view may leave a bound absent workspace without claiming cache deletion. */ }
    if (!current()) return null;
    const result = await observeWorkspaceCwd({ profile: input.profile, server: input.server, cwd: input.cwd,
      isCurrent: current, signal: controller.signal });
    if (!current() || result.status !== "absent") return null;
    return { result: { ...result, status: "absent" }, scope, witness, isCurrent: current };
  })();
  try {
    const result = await Promise.race([operation, deadline, cancellation]);
    successful = result !== null && current();
    return successful ? result : null;
  } catch { return null; }
  finally {
    if (!successful) abort();
    if (deadlineTimer) clearTimeout(deadlineTimer);
    input.signal?.removeEventListener("abort", abort);
  }
}
