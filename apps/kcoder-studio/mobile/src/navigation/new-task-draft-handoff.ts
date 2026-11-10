import type { GatewayProfile, KCoderServer } from "@/gateway/types";
import { threadListScopeKey } from "@/runtime/thread-list-projection";
import { profileAuthorizationScopeKey } from "@/state/profile-coordinator";
import type { WorkspaceIsolation } from "@/storage/new-workspace-preferences";

export const NEW_TASK_DRAFT_HANDOFF_TTL_MS = 5 * 60_000;
const MAX_HANDOFFS = 8;

export interface NewTaskDraftState {
  prompt: string;
  executionMode: "default" | "orchestrate" | "moa" | "moa-plan";
  model: string;
  modelExplicit: boolean;
  reasoningEffort: string;
  isolation: WorkspaceIsolation;
  gitRef: string;
}
export interface NewTaskDraftReturn {
  profileId: string;
  serverId: string;
  cwd: string;
  operationReceiptId?: string;
  operationReceiptVersion?: string;
  operationKind?: string;
  operationSourcePath?: string;
}
export interface NewTaskDraftHandoffHandle { token: string; sourceIntent: string }
interface Handoff {
  profileScope: string;
  scope: string;
  sourceIntent: string;
  createdAt: number;
  draft: NewTaskDraftState;
  onConsumed?: () => void;
  returnedTo?: string;
}

// Unsent text stays in this bounded JS realm. Routes carry only an opaque nonce.
const handoffs = new Map<string, Handoff>();
let sequence = 0;
function scope(profile: GatewayProfile, server: KCoderServer): string {
  return JSON.stringify([profileAuthorizationScopeKey(profile), threadListScopeKey(profile, server),
    server.runtime, server.observationTargetIdentity, server.accountIdentity?.username]);
}
function returnKey(value: NewTaskDraftReturn): string {
  return JSON.stringify([value.profileId, value.serverId, value.cwd, value.operationReceiptId,
    value.operationReceiptVersion, value.operationKind, value.operationSourcePath]);
}
function current(token: string | undefined): Handoff | undefined {
  const now = Date.now();
  for (const [key, value] of handoffs) {
    if (now < value.createdAt || now - value.createdAt >= NEW_TASK_DRAFT_HANDOFF_TTL_MS) handoffs.delete(key);
  }
  return token ? handoffs.get(token) : undefined;
}
function matching(token: string | undefined, profile: GatewayProfile, server: KCoderServer): Handoff | undefined {
  const value = current(token);
  if (!value) return;
  if (value.scope !== scope(profile, server)) { revokeNewTaskDraftHandoff(token); return; }
  return value;
}

export function createNewTaskDraftHandoff(input: {
  profile: GatewayProfile; server: KCoderServer; sourceIntent: string;
  draft: NewTaskDraftState; isCurrent(): boolean; onConsumed?(): void;
}): string | undefined {
  if (!input.isCurrent() || !input.sourceIntent) return;
  current(undefined);
  while (handoffs.size >= MAX_HANDOFFS) handoffs.delete(handoffs.keys().next().value!);
  const token = `new-draft-${Date.now().toString(36)}-${++sequence}-${Math.random().toString(36).slice(2)}`;
  handoffs.set(token, { profileScope: profileAuthorizationScopeKey(input.profile), scope: scope(input.profile, input.server), sourceIntent: input.sourceIntent,
    createdAt: Date.now(), draft: { ...input.draft }, onConsumed: input.onConsumed });
  return token;
}

export function retainNewTaskDraftHandoffProfile(token: string | undefined, profile: GatewayProfile): boolean {
  const value = current(token);
  if (!value) return false;
  if (value.profileScope !== profileAuthorizationScopeKey(profile)) { revokeNewTaskDraftHandoff(token); return false; }
  return true;
}

/** Called by the project page's committed owner; a mismatched target burns the nonce. */
export function claimNewTaskDraftHandoff(token: string | undefined, profile: GatewayProfile, server: KCoderServer): NewTaskDraftHandoffHandle | undefined {
  const value = matching(token, profile, server);
  return value && !value.returnedTo ? { token: token!, sourceIntent: value.sourceIntent } : undefined;
}

/** Only the successful project continuation binds a nonce to its exact return locator. */
export function returnNewTaskDraftHandoff(handle: NewTaskDraftHandoffHandle | undefined, profile: GatewayProfile, server: KCoderServer,
  destination: NewTaskDraftReturn): string | undefined {
  const token = handle?.token;
  const value = matching(token, profile, server);
  if (!value || value.sourceIntent !== handle?.sourceIntent || value.returnedTo || destination.profileId !== profile.id || destination.serverId !== server.id || !destination.cwd.trim()) {
    revokeNewTaskDraftHandoff(token); return;
  }
  value.returnedTo = returnKey(destination);
  return token;
}

/** Consume in a committed effect, never during render or an abandoned StrictMode render. */
export function consumeNewTaskDraftHandoff(token: string | undefined, profile: GatewayProfile, server: KCoderServer,
  destination: NewTaskDraftReturn): NewTaskDraftState | undefined {
  const value = matching(token, profile, server);
  if (!value) return;
  if (!value.returnedTo || value.returnedTo !== returnKey(destination)) { revokeNewTaskDraftHandoff(token); return; }
  handoffs.delete(token!);
  try { value.onConsumed?.(); } catch { /* A departed source cannot interrupt the receiver's restoration. */ }
  return { ...value.draft };
}

export function revokeNewTaskDraftHandoff(token: string | undefined): void {
  if (token) handoffs.delete(token);
}
