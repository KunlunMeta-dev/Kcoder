import type { GatewayProfile, KCoderServer } from "@/gateway/types";
import { sessionTranscriptCache } from "@/storage/session-transcript-cache";
import { captureSessionTranscriptScope, sessionTranscriptScopeKey, sessionTranscriptWorkspaceScopeKey,
  type SessionTranscriptScope } from "@/storage/session-transcript-scope";
import type { SessionTranscriptLease, SessionTranscriptWorkspacePublisherFence } from "@/storage/session-transcript-store";
import { WorkspaceProfileFenceError } from "@/storage/workspace-profile-fence";
import type { TaskRuntime } from "./core";
import { workspaceThreadScopeIdentity } from "./workspaces";

type PublicationCache = Pick<typeof sessionTranscriptCache, "captureWorkspacePublisherFence" | "capturePublisherLease">;
interface Binding { scopeKey: string; fence: SessionTranscriptWorkspacePublisherFence; cache: PublicationCache;
  server: KCoderServer; targetIdentity: string | null }
const bindings = new WeakMap<TaskRuntime, Binding | null>();

/** One preflight per real factory operation. It never waits before a network request. */
export function startRuntimeTranscriptPublication(input: {
  profile: GatewayProfile; server: KCoderServer; cwd?: string; threadId?: string; isCurrentOwner?: () => boolean;
}, cache: PublicationCache = sessionTranscriptCache) {
  let candidate: SessionTranscriptScope | null = null;
  let settled: SessionTranscriptWorkspacePublisherFence | null = null;
  let frozen: SessionTranscriptWorkspacePublisherFence | null | undefined;
  const targetIdentity = input.server.observationTargetIdentity ?? null;
  try {
    // This internal descriptor only captures a workspace fence. It is never a confirmed record.
    if (input.cwd) candidate = captureSessionTranscriptScope(input.profile, input.server, input.cwd,
      input.threadId ?? "__publisher_workspace_preflight__");
  } catch { /* An incomplete candidate disables this optional cache publisher. */ }
  const captured = candidate;
  const candidateCurrent = () => {
    try {
      if (!captured || input.isCurrentOwner?.() === false ||
          (input.server.observationTargetIdentity ?? null) !== targetIdentity) return false;
      return sessionTranscriptScopeKey(captured) === sessionTranscriptScopeKey(
        captureSessionTranscriptScope(input.profile, input.server, input.cwd!, captured.threadId));
    }
    catch { return false; }
  };
  if (captured) {
    // Attach both handlers now, including for storage/identity failure during a failed connection.
    try {
      void cache.captureWorkspacePublisherFence(captured, candidateCurrent).then(value => {
        if (frozen === undefined && candidateCurrent()) settled = value;
      }, () => {}).catch(() => {});
    } catch { /* Cache failure must not prevent the network operation. */ }
  }
  return Object.freeze({
    freeze() {
      if (frozen === undefined) frozen = candidateCurrent() ? settled : null;
    },
    bind(runtime: TaskRuntime, actualScope: SessionTranscriptScope | null) {
      if (bindings.has(runtime)) return;
      // Even an unsuccessful bind is final. Remounts and registry reuse cannot renew authority.
      bindings.set(runtime, null);
      if (!frozen || !captured || !actualScope || !candidateCurrent()) return;
      const snapshot = runtime.getSnapshot();
      if (runtime.disposed || snapshot.threadId !== actualScope.threadId ||
          (input.threadId !== undefined && input.threadId !== actualScope.threadId) ||
          sessionTranscriptWorkspaceScopeKey(captured) !== sessionTranscriptWorkspaceScopeKey(actualScope)) return;
      try {
        const observed = captureSessionTranscriptScope(input.profile, input.server, snapshot.cwd, snapshot.threadId);
        if (sessionTranscriptScopeKey(observed) !== sessionTranscriptScopeKey(actualScope)) return;
      } catch { return; }
      bindings.set(runtime, { scopeKey: sessionTranscriptScopeKey(actualScope), fence: frozen, cache,
        server: input.server, targetIdentity });
    },
  });
}

/** Mint from the original fixed fence only; a stale Runtime stays alive but cannot publish cache. */
export async function captureRuntimeTranscriptLease(runtime: TaskRuntime, scope: SessionTranscriptScope,
  isCurrent: () => boolean, cache: PublicationCache = sessionTranscriptCache,
  currentServer?: KCoderServer): Promise<SessionTranscriptLease | null> {
  const binding = bindings.get(runtime);
  if (!binding || binding.cache !== cache || sessionTranscriptScopeKey(scope) !== binding.scopeKey) return null;
  const publisherCurrent = () => {
    const snapshot = runtime.getSnapshot();
    const target = currentServer ?? binding.server;
    return !runtime.disposed && isCurrent() && snapshot.threadId === scope.threadId &&
      target.id === scope.target.id && (target.observationTargetIdentity ?? null) === binding.targetIdentity &&
      (binding.server.observationTargetIdentity ?? null) === binding.targetIdentity &&
      workspaceThreadScopeIdentity(snapshot.cwd) === scope.cwd;
  };
  if (!publisherCurrent()) return null;
  try {
    const lease = await cache.capturePublisherLease(scope, binding.fence, publisherCurrent);
    return publisherCurrent() ? lease : null;
  } catch (error) {
    if (error instanceof WorkspaceProfileFenceError) return null;
    throw error;
  }
}
