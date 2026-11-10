import { Platform } from "react-native";
import type { GatewayProfile } from "@/gateway/types";
import { PROFILE_INDEX_KEY } from "./profile-store";
import { isProfileStateRemovalPending } from "./profile-state-removal";
import { withLocalIdentityLock, withLocalMetadata } from "./context-lock";
import { metadataSecure, type MetadataAuthority } from "./metadata-authority";

/** Non-secret, immutable ownership captured before any await. Token rotation is immaterial. */
export interface WorkspaceProfileIdentity {
  readonly id: string;
  readonly baseUrl: string;
  readonly authorizationGeneration: string;
  readonly deviceId?: string;
}
export class WorkspaceProfileFenceError extends Error {
  constructor() { super("Gateway 授权归属已变化或无法确认，本次本机写入或远程操作未继续"); this.name = "WorkspaceProfileFenceError"; }
}
export function captureWorkspaceProfileIdentity(profile: GatewayProfile): WorkspaceProfileIdentity {
  return { id: profile.id, baseUrl: profile.baseUrl, authorizationGeneration: profile.authorizationGeneration ?? `legacy:${profile.id}`, deviceId: profile.deviceId };
}
/** Older draft scopes carry route/generation, but cannot prove a device identity. */
export function workspaceProfileIdentityFromScope(profileId: string, scope?: string): WorkspaceProfileIdentity {
  if (!scope) return { id: profileId, baseUrl: "", authorizationGeneration: `legacy:${profileId}` };
  let fields: unknown;
  try { fields = JSON.parse(scope); } catch {
    if (Platform.OS !== "web") return { id: profileId, baseUrl: "", authorizationGeneration: `legacy:${profileId}` };
    throw new WorkspaceProfileFenceError();
  }
  if (!Array.isArray(fields) || typeof fields[0] !== "string" || typeof fields[1] !== "string") throw new WorkspaceProfileFenceError();
  return { id: profileId, baseUrl: fields[0], authorizationGeneration: fields[1] };
}
export function workspacePreferenceProfileIdentity(profileId: string, scope: string): WorkspaceProfileIdentity {
  let fields: unknown;
  try { fields = JSON.parse(scope); } catch {
    if (Platform.OS !== "web") return { id: profileId, baseUrl: "", authorizationGeneration: `legacy:${profileId}` };
    throw new WorkspaceProfileFenceError();
  }
  if (!Array.isArray(fields) || fields.length !== 2 || typeof fields[0] !== "string" || (fields[1] !== null && typeof fields[1] !== "string")) throw new WorkspaceProfileFenceError();
  return { ...workspaceProfileIdentityFromScope(profileId, fields[0]), deviceId: fields[1] ?? undefined };
}
function assertPresent(identity: WorkspaceProfileIdentity): void {
  if (isProfileStateRemovalPending(identity.id)) throw new WorkspaceProfileFenceError();
}
function assertWebLockAvailable(): void {
  if (typeof navigator === "undefined" || typeof navigator.locks?.request !== "function") throw new WorkspaceProfileFenceError();
}
async function currentSharedProfile(profileId: string, authority?: MetadataAuthority): Promise<GatewayProfile> {
  let raw: string | null;
  try { raw = await metadataSecure(authority).getSecureValue(PROFILE_INDEX_KEY); } catch { throw new WorkspaceProfileFenceError(); }
  let index: unknown;
  try { index = raw ? JSON.parse(raw) : null; } catch { throw new WorkspaceProfileFenceError(); }
  if (!index || typeof index !== "object" || !Array.isArray((index as { profiles?: unknown }).profiles)) throw new WorkspaceProfileFenceError();
  const profiles = (index as { profiles: unknown[] }).profiles;
  if (profiles.some((value) => !value || typeof value !== "object" || typeof (value as GatewayProfile).id !== "string" || typeof (value as GatewayProfile).baseUrl !== "string" || ((value as GatewayProfile).deviceId !== undefined && typeof (value as GatewayProfile).deviceId !== "string") || ((value as GatewayProfile).authorizationGeneration !== undefined && typeof (value as GatewayProfile).authorizationGeneration !== "string"))) throw new WorkspaceProfileFenceError();
  const matches = profiles.filter((value) => (value as GatewayProfile).id === profileId) as GatewayProfile[];
  const current = matches[0];
  if (matches.length !== 1 || !current) throw new WorkspaceProfileFenceError();
  return current;
}
/** Capture legacy ownership; the metadata write fence still rechecks the identity. */
export async function workspaceProfileIdentityForId(profileId: string, authority?: MetadataAuthority): Promise<WorkspaceProfileIdentity> {
  return captureWorkspaceProfileIdentity(await currentSharedProfile(profileId, authority));
}
/** Resolve a scope's profile fields to the current full identity, then let the write fence recheck it under lock. */
export async function workspaceProfileIdentityForScope(profileId: string, scope: string, authority?: MetadataAuthority): Promise<WorkspaceProfileIdentity> {
  const requested = workspaceProfileIdentityFromScope(profileId, scope);
  const current = captureWorkspaceProfileIdentity(await currentSharedProfile(profileId, authority));
  if (requested.baseUrl !== current.baseUrl || requested.authorizationGeneration !== current.authorizationGeneration)
    throw new WorkspaceProfileFenceError();
  return current;
}
async function assertSharedIdentity(identity: WorkspaceProfileIdentity, authority?: MetadataAuthority): Promise<void> {
  assertPresent(identity);
  const current = await currentSharedProfile(identity.id, authority);
  assertPresent(identity);
  if (current.baseUrl !== identity.baseUrl || (current.authorizationGeneration ?? `legacy:${current.id}`) !== identity.authorizationGeneration || current.deviceId !== identity.deviceId) throw new WorkspaceProfileFenceError();
  // An old scope that omits device cannot borrow the device in the current metadata.
  if (current.deviceId !== undefined && !Object.prototype.hasOwnProperty.call(identity, "deviceId")) throw new WorkspaceProfileFenceError();
}
export async function withWorkspaceProfileWrite<T>(identity: WorkspaceProfileIdentity, operation: () => Promise<T>): Promise<T> {
  assertPresent(identity);
  const checked = async () => {
    await assertSharedIdentity(identity);
    return operation(); // Storage only; never await a network response under this lock.
  };
  if (Platform.OS !== "web") return withLocalIdentityLock("gateway-profile-index", checked);
  assertWebLockAvailable();
  return navigator.locks.request("kcoder-mobile:gateway-profile-index", { mode: "exclusive" }, checked);
}
/** New metadata consumers must route every persistent effect through this authority. */
export async function withWorkspaceProfileMetadata<T>(identity: WorkspaceProfileIdentity, operation: (authority?: MetadataAuthority) => Promise<T>, parent?: MetadataAuthority): Promise<T> {
  assertPresent(identity);
  return withLocalMetadata("gateway-profile-index", async authority => {
    await assertSharedIdentity(identity, authority);
    return operation(authority);
  }, parent);
}
/** Returning an object deliberately prevents Promise assimilation while the index lock is held. */
export async function startWorkspaceProfileRpc<T>(identity: WorkspaceProfileIdentity, send: () => Promise<T>): Promise<{ response: Promise<T> }> {
  return withWorkspaceProfileMetadata(identity, async authority => authority
    ? authority.effect(() => ({ response: send() }))
    : { response: send() });
}
