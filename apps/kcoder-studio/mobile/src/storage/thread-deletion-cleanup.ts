import { DISCARD_RETAINED_TASK_ATTACHMENTS, type DiscardRetainedTaskAttachmentsResult } from "../../../shared/attachmentRetention";
import { MobileRpcError } from "@/gateway/rpc";
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { GatewayProfile, KCoderServer } from "@/gateway/types";
import { taskClientConnector } from "@/runtime/task-runtime/connectionFactory";
import { loadWorkspaceState, removeWorkspaceState, workspaceStateAuthorizationScope } from "./workspace-preferences";
import { workspaceAttachmentPathsForThreadDeletion } from "./workspace-attachment-paths";
import { withLocalIdentityLock } from "./context-lock";
type CleanupAuthorityResolver = (profileId: string, serverId: string) => string | null;
let currentAuthority: CleanupAuthorityResolver | undefined;
export function installThreadDeletionCleanupAuthorityResolver(resolver: CleanupAuthorityResolver): () => void {
  currentAuthority = resolver;
  return () => { if (currentAuthority === resolver) currentAuthority = undefined; };
}
const PREFIX = "kcoder-studio:mobile-thread-deletion-cleanup:v1:";
const tails = new Map<string, Promise<unknown>>();
type Ticket = { id: string; scope: string; serverId: string; threadId: string; cwd?: string; registryWorkspace?: string; attachments: string[]; confirmed: boolean; claim?: { id: string; until: number }; lastAttemptAt?: number; retryAt?: number; failures?: number };
const keyFor = (profileId: string) => PREFIX + encodeURIComponent(profileId);
function transaction<T>(profileId: string, operation: (tickets: Ticket[]) => Promise<T>): Promise<T> {
  const key = keyFor(profileId);
  const pending = (tails.get(key) ?? Promise.resolve()).catch(() => {}).then(() => withLocalIdentityLock(`thread-deletion-cleanup:${key}`, async () => {
    const raw = await AsyncStorage.getItem(key);
    const tickets: Ticket[] = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(tickets) || tickets.length > 64) throw new Error("删除清理记录无效");
    return operation(tickets);
  }));
  tails.set(key, pending); void pending.finally(() => { if (tails.get(key) === pending) tails.delete(key); }).catch(() => {});
  return pending;
}
export async function prepareThreadDeletionCleanup(profile: GatewayProfile, server: KCoderServer, threadId: string, cwd: string | undefined, attachments: readonly string[], registryWorkspace?: string): Promise<string> {
  const scope = workspaceStateAuthorizationScope(profile, server);
  const id = JSON.stringify([scope, threadId]);
  const local = await loadWorkspaceState(profile.id, server.id, threadId, scope);
  attachments = [...attachments, ...workspaceAttachmentPathsForThreadDeletion(local)];
  await transaction(profile.id, async tickets => {
    const prior = tickets.find(ticket => ticket.id === id);
    if (!prior && tickets.length >= 64) throw new Error("待清理删除记录已满，请先连接目标完成清理");
    const paths = [...new Set([...(prior?.attachments ?? []), ...attachments])];
    if (paths.length > 256 || paths.some(path => typeof path !== "string" || path.length > 4096)) throw new Error("删除附件清理记录超过限制");
    await AsyncStorage.setItem(keyFor(profile.id), JSON.stringify([...tickets.filter(ticket => ticket.id !== id), { ...prior, id, scope, serverId: server.id, threadId, cwd, registryWorkspace, attachments: paths, confirmed: prior?.confirmed ?? false }]));
  });
  return id;
}
export async function confirmThreadDeletionCleanup(profileId: string, id: string): Promise<void> {
  await transaction(profileId, async tickets => { await AsyncStorage.setItem(keyFor(profileId), JSON.stringify(tickets.map(ticket => ticket.id === id ? { ...ticket, confirmed: true } : ticket))); });
}
export async function retryThreadDeletionCleanup(profile: GatewayProfile, servers: readonly KCoderServer[]): Promise<void> {
  const authorityAtStart = currentAuthority;
  if (!authorityAtStart) return;
  const claimId = `cleanup-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  // Storage locks contain only local read/claim/merge, never socket/RPC awaits.
  // One ticket and eight paths per trigger bound background resource work.
  const ticket = await transaction(profile.id, async tickets => {
    if (currentAuthority !== authorityAtStart) return undefined;
    const now = Date.now();
    const candidate = tickets.filter(ticket => (!ticket.claim || ticket.claim.until <= now) && (ticket.retryAt ?? 0) <= now && authorityAtStart(profile.id, ticket.serverId) === ticket.scope && servers.some(server => server.id === ticket.serverId && workspaceStateAuthorizationScope(profile, server) === ticket.scope)).sort((left, right) => (left.lastAttemptAt ?? 0) - (right.lastAttemptAt ?? 0))[0];
    if (!candidate) return undefined;
    candidate.claim = { id: claimId, until: now + 120_000 };
    candidate.lastAttemptAt = now;
    await AsyncStorage.setItem(keyFor(profile.id), JSON.stringify(tickets));
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
  let confirmed = ticket.confirmed;
  try {
    assertScope();
    client = await taskClientConnector(profile, server, ticket.cwd ?? server.workspacePath, "runtime", { priority: "background" });
    assertScope();
    if (!confirmed) {
      try { await client.request("thread/read", { threadId: ticket.threadId, limit: 1 }); }
      catch (error) {
        // Only exact target authority confirms a delete whose local ACK save failed.
        if (error instanceof MobileRpcError && error.reason === "remote" && error.code === -32021 && error.message === `persisted thread not found: ${ticket.threadId}`) confirmed = true;
      }
      if (!confirmed) return;
    }
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
    await removeWorkspaceState(profile.id, server.id, ticket.threadId, ticket.scope);
    finished = true;
  } catch {
    // Remote deletion stays accepted. Each unconfirmed local cleanup remains durable.
  } finally {
    registry?.close(); client?.close();
    await transaction(profile.id, async tickets => {
      const current = tickets.find(candidate => candidate.id === ticket.id && candidate.claim?.id === claimId);
      if (!current) return;
      const authorized = authorityMatches();
      current.confirmed ||= confirmed;
      if (authorized) current.attachments = current.attachments.filter(path => !cleared.has(path));
      else finished = false;
      delete current.claim;
      if (!finished) {
        current.failures = Math.min((current.failures ?? 0) + 1, 6);
        current.retryAt = Date.now() + Math.min(30_000, 1_000 * 2 ** (current.failures - 1));
      }
      // Merge current storage, including tickets/paths added during the RPC.
      const updated = finished && current.attachments.length === 0 ? tickets.filter(candidate => candidate !== current) : tickets;
      await AsyncStorage.setItem(keyFor(profile.id), JSON.stringify(updated));
    });
  }
}

export const threadDeletionCleanupKey = keyFor;
