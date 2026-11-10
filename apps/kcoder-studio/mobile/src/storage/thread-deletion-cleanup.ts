import { captureSessionTranscriptScope, decodeSessionTranscriptScope, sessionTranscriptScopeKey, type SessionTranscriptScope } from "./session-transcript-scope";
import { DISCARD_RETAINED_TASK_ATTACHMENTS, type DiscardRetainedTaskAttachmentsResult } from "../../../shared/attachmentRetention";
import { metadataStorage, type MetadataAuthority } from "./metadata-authority";
import type { GatewayProfile, KCoderServer } from "@/gateway/types";
import { taskClientConnector } from "@/runtime/task-runtime/connectionFactory";
import { loadWorkspaceState, removeWorkspaceState, workspaceStateAuthorizationScope } from "./workspace-preferences";
import { workspaceAttachmentPathsForThreadDeletion } from "./workspace-attachment-paths";
import { withLocalMetadata } from "./context-lock";
type CleanupAuthorityResolver = (profileId: string, serverId: string) => string | null;
let currentAuthority: CleanupAuthorityResolver | undefined;
export function installThreadDeletionCleanupAuthorityResolver(resolver: CleanupAuthorityResolver): () => void {
  currentAuthority = resolver;
  return () => { if (currentAuthority === resolver) currentAuthority = undefined; };
}
const PREFIX = "kcoder-studio:mobile-thread-deletion-cleanup:v1:";
const tails = new Map<string, Promise<unknown>>();
const pendingAcknowledgements = new Map<string, Set<string>>();
type Ticket = { cacheScope?: SessionTranscriptScope; id: string; scope: string; serverId: string; threadId: string; cwd?: string; registryWorkspace?: string; attachments: string[]; confirmed: boolean; claim?: { id: string; until: number }; lastAttemptAt?: number; retryAt?: number; failures?: number };
const keyFor = (profileId: string) => PREFIX + encodeURIComponent(profileId);
const rememberAcknowledgement = (profileId: string, id: string) => {
  const pending = pendingAcknowledgements.get(profileId) ?? new Set<string>();
  pending.add(id);
  pendingAcknowledgements.set(profileId, pending);
};
const forgetAcknowledgement = (profileId: string, id: string) => {
  const pending = pendingAcknowledgements.get(profileId);
  pending?.delete(id);
  if (pending?.size === 0) pendingAcknowledgements.delete(profileId);
};

export class ThreadDeletionCleanupConfirmationPendingError extends Error {
  constructor(message = "Remote deletion was confirmed, but saving its local cleanup record failed.") {
    super(message);
    this.name = "ThreadDeletionCleanupConfirmationPendingError";
  }
}

function transaction<T>(profileId: string, operation: (tickets: Ticket[], authority?: MetadataAuthority) => Promise<T>): Promise<T> {
  const key = keyFor(profileId);
  const pending = (tails.get(key) ?? Promise.resolve()).catch(() => {}).then(() => withLocalMetadata(`thread-deletion-cleanup:${key}`, async authority => {
    const raw = await metadataStorage(authority).getItem(key);
    const tickets: Ticket[] = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(tickets) || tickets.length > 64) throw new Error("删除清理记录无效");
    return operation(tickets, authority);
  }));
  tails.set(key, pending); void pending.finally(() => { if (tails.get(key) === pending) tails.delete(key); }).catch(() => {});
  return pending;
}
export async function prepareThreadDeletionCleanup(profile: GatewayProfile, server: KCoderServer, threadId: string, cwd: string | undefined, attachments: readonly string[], registryWorkspace?: string): Promise<string> {
  const scope = workspaceStateAuthorizationScope(profile, server);
  const id = JSON.stringify([scope, threadId]);
  let cacheScope: SessionTranscriptScope | undefined;
  if (cwd) try { cacheScope = captureSessionTranscriptScope(profile, server, cwd, threadId); } catch { /* Incomplete targets do not cache. */ }
  const local = await loadWorkspaceState(profile.id, server.id, threadId, scope);
  attachments = [...attachments, ...workspaceAttachmentPathsForThreadDeletion(local)];
  await transaction(profile.id, async (tickets, authority) => {
    const prior = tickets.find(ticket => ticket.id === id);
    if (!prior && tickets.length >= 64) throw new Error("待清理删除记录已满，请先连接目标完成清理");
    const paths = [...new Set([...(prior?.attachments ?? []), ...attachments])];
    if (paths.length > 256 || paths.some(path => typeof path !== "string" || path.length > 4096)) throw new Error("删除附件清理记录超过限制");
    await metadataStorage(authority).setItem(keyFor(profile.id), JSON.stringify([...tickets.filter(ticket => ticket.id !== id), { ...prior, ...(cacheScope ? { cacheScope } : {}), id, scope, serverId: server.id, threadId, cwd, registryWorkspace, attachments: paths, confirmed: prior?.confirmed ?? false }]));
  });
  return id;
}
export async function confirmThreadDeletionCleanup(profileId: string, id: string): Promise<void> {
  try {
    await transaction(profileId, async (tickets, authority) => {
      if (!tickets.some(ticket => ticket.id === id)) throw new Error("删除清理记录缺失");
      await metadataStorage(authority).setItem(keyFor(profileId), JSON.stringify(tickets.map(ticket => ticket.id === id ? { ...ticket, confirmed: true } : ticket)));
    });
    forgetAcknowledgement(profileId, id);
  } catch {
    // The caller invokes confirmation only after an exact remote delete ACK.
    // Keep that fact in memory so storage recovery retries this write locally.
    rememberAcknowledgement(profileId, id);
    throw new ThreadDeletionCleanupConfirmationPendingError();
  }
}

async function retryPendingAcknowledgements(profileId: string): Promise<void> {
  const pending = [...(pendingAcknowledgements.get(profileId) ?? [])];
  for (const id of pending) {
    try {
      const persisted = await transaction(profileId, async (tickets, authority) => {
        if (!tickets.some(ticket => ticket.id === id)) return false;
        await metadataStorage(authority).setItem(keyFor(profileId), JSON.stringify(tickets.map(ticket => ticket.id === id ? { ...ticket, confirmed: true } : ticket)));
        return true;
      });
      if (persisted) forgetAcknowledgement(profileId, id);
    } catch {
      // Keep the ACK in memory and retry from the normal app recovery trigger.
    }
  }
}

export async function retryThreadDeletionCleanup(profile: GatewayProfile, servers: readonly KCoderServer[]): Promise<void> {
  const authorityAtStart = currentAuthority;
  if (!authorityAtStart) return;
  await retryPendingAcknowledgements(profile.id);
  const claimId = `cleanup-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  // Storage locks contain only local read/claim/merge, never socket/RPC awaits.
  // One ticket and eight paths per trigger bound background resource work.
  const ticket = await transaction(profile.id, async (tickets, authority) => {
    if (currentAuthority !== authorityAtStart) return undefined;
    const now = Date.now();
    const candidate = tickets.filter(ticket => ticket.confirmed === true && (!ticket.claim || ticket.claim.until <= now) && (ticket.retryAt ?? 0) <= now && authorityAtStart(profile.id, ticket.serverId) === ticket.scope && servers.some(server => server.id === ticket.serverId && workspaceStateAuthorizationScope(profile, server) === ticket.scope)).sort((left, right) => (left.lastAttemptAt ?? 0) - (right.lastAttemptAt ?? 0))[0];
    if (!candidate) return undefined;
    candidate.claim = { id: claimId, until: now + 120_000 };
    candidate.lastAttemptAt = now;
    await metadataStorage(authority).setItem(keyFor(profile.id), JSON.stringify(tickets));
    return { ...candidate, attachments: [...candidate.attachments] };
  });
  if (!ticket) return;
  const server = servers.find(server => server.id === ticket.serverId && workspaceStateAuthorizationScope(profile, server) === ticket.scope)!;
  let client: Awaited<ReturnType<typeof taskClientConnector>> | undefined;
  let registry: typeof client;
  const cleared = new Set<string>();
  const authorityMatches = () => currentAuthority === authorityAtStart && authorityAtStart(profile.id, server.id) === ticket.scope;
  const assertScope = () => { if (!authorityMatches() || workspaceStateAuthorizationScope(profile, server) !== ticket.scope) throw new Error("删除清理授权范围已改变"); };
  let finished = false;
  try {
    assertScope();
    client = await taskClientConnector(profile, server, ticket.cwd ?? server.workspacePath, "runtime", { priority: "background" });
    assertScope();
    if (ticket.attachments.length) {
      const attempted = ticket.attachments.slice(0, 8);
      const result = await client.request<DiscardRetainedTaskAttachmentsResult>(DISCARD_RETAINED_TASK_ATTACHMENTS, { threadId: ticket.threadId, paths: attempted });
      // Completion is explicit per path. Missing/malformed ACK cannot retire refs.
      if (Array.isArray(result?.cleared)) for (const path of result.cleared) if (typeof path === "string" && attempted.includes(path)) cleared.add(path);
      if (ticket.attachments.some(path => !cleared.has(path))) return;
    }
    assertScope();
    if (ticket.cwd) {
      registry = await taskClientConnector(profile, server, ticket.registryWorkspace ?? server.workspacePath, "runtime", { priority: "background" });
      assertScope();
      await registry.request("runtime.worktrees.conversations.remove", { deviceId: server.id, path: ticket.cwd, taskId: ticket.threadId });
    }
    assertScope();
    if (ticket.cacheScope) {
      const cacheScope = decodeSessionTranscriptScope(ticket.cacheScope);
      if (!cacheScope || !ticket.cwd || sessionTranscriptScopeKey(cacheScope) !== sessionTranscriptScopeKey(captureSessionTranscriptScope(profile, server, ticket.cwd, ticket.threadId)))
        throw new Error("删除缓存清理身份不匹配");
      const { sessionTranscriptCache } = await import("./session-transcript-cache");
      const lease = await sessionTranscriptCache.capture(cacheScope, authorityMatches);
      await sessionTranscriptCache.invalidateThread(lease);
    }
    assertScope();
    await removeWorkspaceState(profile.id, server.id, ticket.threadId, ticket.scope);
    finished = true;
  } catch {
    // Remote deletion stays accepted. Each unconfirmed local cleanup remains durable.
  } finally {
    registry?.close(); client?.close();
    await transaction(profile.id, async (tickets, authority) => {
      const current = tickets.find(candidate => candidate.id === ticket.id && candidate.claim?.id === claimId);
      if (!current) return;
      const authorized = authorityMatches();
      if (authorized) current.attachments = current.attachments.filter(path => !cleared.has(path));
      else finished = false;
      delete current.claim;
      if (!finished) {
        current.failures = Math.min((current.failures ?? 0) + 1, 6);
        current.retryAt = Date.now() + Math.min(30_000, 1_000 * 2 ** (current.failures - 1));
      }
      // Merge current storage, including tickets/paths added during the RPC.
      const updated = finished && current.attachments.length === 0 ? tickets.filter(candidate => candidate !== current) : tickets;
      await metadataStorage(authority).setItem(keyFor(profile.id), JSON.stringify(updated));
    });
  }
}

export const threadDeletionCleanupKey = keyFor;

/** A pending exact delete intent suppresses stale cached display without claiming a remote deletion.
 * Only a confirmed target delete ACK permits the existing cleanup worker to retire this ticket. */
export async function isSessionTranscriptDeletionPending(scope: SessionTranscriptScope): Promise<boolean> {
  return transaction(scope.profile.id, async (tickets, authority) => tickets.some(ticket => {
    const captured = decodeSessionTranscriptScope(ticket.cacheScope);
    return captured !== null && sessionTranscriptScopeKey(captured) === sessionTranscriptScopeKey(scope);
  }));
}
