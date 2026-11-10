import type { GatewayProfile, KCoderServer } from "@/gateway/types";
import { Sha256Stream } from "@/protocol/sha256-stream";
import { captureWorkspaceProfileIdentity, type WorkspaceProfileIdentity } from "./workspace-profile-fence";
import { workspaceThreadScopeIdentity } from "@/gateway/target-identity";

/** Display ownership only. This descriptor never authorizes a connection or RPC. */
export interface SessionTranscriptScope {
  version: 1;
  profile: WorkspaceProfileIdentity & { authMode: "device" | "legacy" };
  target: {
    id: string;
    transport: "local" | "ssh";
    /** Full connection identity, without persisting command strings or connection secrets. */
    connectionFingerprint: string;
    principalId: string | null;
    role: string | null;
    workspacePath: string | null;
  };
  cwd: string;
  threadId: string;
}
const atom = (value: string): string => {
  if (typeof value !== "string" || !value || value.length > 4096 || /\p{Cc}/u.test(value)) throw new Error("Invalid transcript display scope");
  return value;
};
const optional = (value: string | undefined): string | null => value === undefined ? null : atom(value);
function canonicalPath(value: string): string {
  const path = workspaceThreadScopeIdentity(atom(value));
  if (!path || (!path.startsWith("/") && !/^[a-z]:[\\/]/i.test(path))) throw new Error("Transcript cwd must be absolute");
  return path;
}
function validateProfile(profile: SessionTranscriptScope["profile"]): void {
  atom(profile.id); atom(profile.baseUrl); atom(profile.authorizationGeneration);
  if (profile.authMode !== "device" && profile.authMode !== "legacy") throw new Error("Invalid transcript auth mode");
  if (profile.deviceId !== undefined) atom(profile.deviceId);
  if (profile.authMode === "device" && !profile.deviceId) throw new Error("Incomplete device display scope");
  const endpoint = new URL(profile.baseUrl);
  if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
      endpoint.toString().replace(/\/$/, "") !== profile.baseUrl) throw new Error("Transcript Gateway URL must be canonical and credential-free");
}
/** Small ownership tuples only. JSON escapes lone surrogates; no Hermes TextEncoder required. */
export function sessionTranscriptIdentityDigest(value: string): string {
  if (value.length > 64 * 1024) throw new Error("Transcript ownership tuple exceeds budget");
  const encoded = encodeURIComponent(value); const bytes: number[] = [];
  for (let index = 0; index < encoded.length; index++) {
    if (encoded[index] === "%") { bytes.push(parseInt(encoded.slice(index + 1, index + 3), 16)); index += 2; }
    else bytes.push(encoded.charCodeAt(index));
  }
  return new Sha256Stream().update(Uint8Array.from(bytes)).digestHex();
}

/** Call only after the server descriptor and actual thread cwd were confirmed online. */
export function captureSessionTranscriptScope(profile: GatewayProfile, server: KCoderServer, cwd: string, threadId: string): SessionTranscriptScope {
  if (server.runtime !== "kcoder" || !["local", "ssh"].includes(server.transport)) throw new Error("Invalid transcript runtime or transport");
  if (profile.authMode === "device" && !profile.authorizationGeneration) throw new Error("Incomplete device generation");
  const identity = { ...captureWorkspaceProfileIdentity(profile), authMode: profile.authMode === undefined ? "legacy" as const : profile.authMode };
  validateProfile(identity);
  if (server.port !== undefined && (!Number.isInteger(server.port) || server.port < 1 || server.port > 65535)) throw new Error("Invalid transcript target port");
  if ((server.transport === "ssh" || server.accountIdentity !== undefined) && (!server.accountIdentity?.principalId || !server.accountIdentity.role)) throw new Error("Incomplete account display scope");
  if (server.transport === "ssh" && !server.host) throw new Error("Incomplete remote display scope");
  const connection = [server.runtime, server.transport, optional(server.host), optional(server.user), server.port ?? null,
    optional(server.command), optional(server.profile), optional(server.settingsFile),
    optional(server.accountIdentity?.principalId), optional(server.accountIdentity?.role),
    server.workspacePath === undefined ? null : atom(server.workspacePath), server.acceptNewHostKey ?? null];
  return { version: 1, profile: identity,
    target: { id: atom(server.id), transport: server.transport, connectionFingerprint: sessionTranscriptIdentityDigest(JSON.stringify(connection)),
      principalId: optional(server.accountIdentity?.principalId), role: optional(server.accountIdentity?.role),
      workspacePath: server.workspacePath === undefined ? null : canonicalPath(server.workspacePath) },
    cwd: canonicalPath(cwd), threadId: atom(threadId) };
}
export function sessionTranscriptScopeKey(scope: SessionTranscriptScope): string { return JSON.stringify(scope); }

/** Identifies the bounded set of threads owned by one exact display workspace. */
export function sessionTranscriptWorkspaceScopeKey(scope: SessionTranscriptScope): string {
  const captured = decodeSessionTranscriptScope(scope);
  if (!captured) throw new Error("Invalid transcript display scope");
  return JSON.stringify([captured.version, captured.profile, captured.target, captured.cwd]);
}

export function decodeSessionTranscriptScope(value: unknown): SessionTranscriptScope | null {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const scope = value as SessionTranscriptScope;
    const keys = (item: object, allowed: string[]) => Object.keys(item).every(key => allowed.includes(key));
    if (scope.version !== 1 || !keys(scope, ["version", "profile", "target", "cwd", "threadId"]) || !scope.profile || !scope.target ||
        !keys(scope.profile, ["id", "baseUrl", "authorizationGeneration", "deviceId", "authMode"]) ||
        !keys(scope.target, ["id", "transport", "connectionFingerprint", "principalId", "role", "workspacePath"])) return null;
    validateProfile(scope.profile); atom(scope.target.id); atom(scope.threadId);
    if (!["local", "ssh"].includes(scope.target.transport) || !/^[a-f0-9]{64}$/.test(scope.target.connectionFingerprint) ||
        scope.cwd !== canonicalPath(scope.cwd) || (scope.target.workspacePath !== null && scope.target.workspacePath !== canonicalPath(scope.target.workspacePath))) return null;
    if (scope.target.principalId === null) { if (scope.target.role !== null || scope.target.transport === "ssh") return null; }
    else { atom(scope.target.principalId); atom(scope.target.role!); }
    // Stable ordering makes exact ownership comparison independent of parser property order.
    return { version: 1, profile: { id: scope.profile.id, baseUrl: scope.profile.baseUrl, authorizationGeneration: scope.profile.authorizationGeneration,
      deviceId: scope.profile.deviceId, authMode: scope.profile.authMode },
      target: { id: scope.target.id, transport: scope.target.transport, connectionFingerprint: scope.target.connectionFingerprint,
        principalId: scope.target.principalId, role: scope.target.role, workspacePath: scope.target.workspacePath }, cwd: scope.cwd, threadId: scope.threadId };
  } catch { return null; }
}
