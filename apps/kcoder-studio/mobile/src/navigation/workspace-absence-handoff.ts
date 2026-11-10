import type { GatewayProfile, KCoderServer } from "@/gateway/types";
import { workspaceObservationPath } from "@/gateway/workspace-cwd-observation";
import type { WorkspacePresenceObservation } from "@/runtime/task-runtime/workspace-presence";
import { captureSessionTranscriptScope, decodeSessionTranscriptScope, sessionTranscriptScopeKey, type SessionTranscriptScope } from "@/storage/session-transcript-scope";

export const WORKSPACE_ABSENCE_HANDOFF_TTL_MS = 5 * 60_000;
export interface WorkspaceAbsenceHandoffOwner { isCurrent(): boolean }
export interface WorkspaceAbsenceHandoff {
  readonly token: string;
  readonly serverId: string;
  readonly absentCwd: string;
  readonly scope: SessionTranscriptScope;
  readonly targetIdentity: string;
  readonly loginGeneration: number;
  readonly observedAt: number;
}
type Stage = "home" | "form";
interface PendingHandoff {
  value: WorkspaceAbsenceHandoff;
  createdAt: number;
  stage: Stage;
  owner: WorkspaceAbsenceHandoffOwner | null;
}
// One bounded navigation hint, never network authority or persistent revocation state.
let pending: PendingHandoff | null = null;
let sequence = 0;
function entry(token: string | undefined): PendingHandoff | null {
  return typeof token === "string" && pending?.value.token === token && Date.now() >= pending.createdAt &&
    Date.now() - pending.createdAt < WORKSPACE_ABSENCE_HANDOFF_TTL_MS ? pending : null;
}
function matches(value: WorkspaceAbsenceHandoff, profile: GatewayProfile, server: KCoderServer): boolean {
  try {
    return server.transport === "local" && server.id === value.serverId && server.observationTargetIdentity === value.targetIdentity &&
      sessionTranscriptScopeKey(captureSessionTranscriptScope(profile, server, value.scope.cwd, value.scope.threadId)) === sessionTranscriptScopeKey(value.scope);
  } catch { return false; }
}

/** Mint before leaving the confirmed recovery owner; no route/query field can mint a hint. */
export function createWorkspaceAbsenceHandoff(input: {
  profile: GatewayProfile; server: KCoderServer; cwd: string; threadId: string;
  observation: WorkspacePresenceObservation | null; isCurrent: () => boolean;
}): string | null {
  try {
    const observation = input.observation, result = observation?.result;
    const scope = observation && decodeSessionTranscriptScope(observation.scope);
    const targetIdentity = input.server.observationTargetIdentity;
    const cwd = workspaceObservationPath(input.cwd);
    if (!input.isCurrent() || !observation?.isCurrent() || !scope || !result || !cwd ||
        input.server.transport !== "local" || !targetIdentity || !/^[a-f0-9]{64}$/.test(targetIdentity) ||
        result.version !== 1 || result.status !== "absent" || result.targetId !== input.server.id || result.targetSignature !== targetIdentity ||
        workspaceObservationPath(result.workspacePath) !== cwd || workspaceObservationPath(scope.cwd) !== cwd ||
        !Number.isSafeInteger(result.loginGeneration) || result.loginGeneration < 0 || !Number.isFinite(result.observedAt) || result.observedAt < 0 ||
        sessionTranscriptScopeKey(captureSessionTranscriptScope(input.profile, input.server, input.cwd, input.threadId)) !== sessionTranscriptScopeKey(scope)) return null;
    const token = `workspace-absence-${Date.now().toString(36)}-${++sequence}-${Math.random().toString(36).slice(2)}`;
    Object.freeze(scope.profile); Object.freeze(scope.target); Object.freeze(scope);
    pending = { value: Object.freeze({ token, serverId: input.server.id, absentCwd: cwd, scope,
      targetIdentity, loginGeneration: result.loginGeneration, observedAt: result.observedAt }), createdAt: Date.now(), stage: "home", owner: null };
    return token;
  } catch { return null; }
}

/** Descriptor lookup only; the selected descriptor must still pass claim validation. */
export function workspaceAbsenceHandoffServerId(token: string | undefined): string | undefined { return entry(token)?.value.serverId; }

/** Render-time inspection is pure: an abandoned render cannot consume or revoke a hint. */
export function peekWorkspaceAbsenceHandoff(token: string | undefined, stage: Stage, owner: WorkspaceAbsenceHandoffOwner,
  profile: GatewayProfile, server: KCoderServer): WorkspaceAbsenceHandoff | null {
  const found = entry(token);
  if (!found || found.stage !== stage || (found.owner && found.owner !== owner)) return null;
  try { return owner.isCurrent() && matches(found.value, profile, server) ? found.value : null; }
  catch { return null; }
}

/** Re-renders may reuse only the same receiver owner. Auth/target mismatches burn the hint. */
export function claimWorkspaceAbsenceHandoff(token: string | undefined, stage: Stage, owner: WorkspaceAbsenceHandoffOwner,
  profile: GatewayProfile, server: KCoderServer): WorkspaceAbsenceHandoff | null {
  const found = entry(token);
  if (!found) { if (pending?.value.token === token) pending = null; return null; }
  if (found.stage !== stage || (found.owner && found.owner !== owner)) return null;
  try {
    if (!owner.isCurrent() || !matches(found.value, profile, server)) { pending = null; return null; }
    found.owner = owner;
    return found.value;
  } catch { pending = null; return null; }
}

/** Transfer once at the current Home action; Home cleanup cannot revoke the new form owner. */
export function forwardWorkspaceAbsenceHandoff(token: string | undefined, owner: WorkspaceAbsenceHandoffOwner,
  profile: GatewayProfile, server: KCoderServer): string | undefined {
  const value = claimWorkspaceAbsenceHandoff(token, "home", owner, profile, server);
  if (!value || !pending) return undefined;
  pending.stage = "form";
  pending.owner = null;
  return value.token;
}
export function revokeWorkspaceAbsenceHandoff(token: string | undefined, owner?: WorkspaceAbsenceHandoffOwner): void {
  const found = typeof token === "string" && pending?.value.token === token ? pending : null;
  if (found && (!owner || found.owner === owner)) pending = null;
}

/** Only a current catalog row may provide a strict, segment-aligned ancestor. */
export function workspaceAbsenceHandoffParent(value: WorkspaceAbsenceHandoff, options: readonly { path: string }[]): string | undefined {
  return options.filter(option => {
    const path = workspaceObservationPath(option.path);
    return path !== null && path !== value.absentCwd && value.absentCwd.startsWith(path.endsWith("/") ? path : `${path}/`);
  }).sort((left, right) => right.path.length - left.path.length)[0]?.path;
}
