import type { GatewayProfile } from "@/gateway/types";
import { Platform } from "react-native";
import {
  canonicalGatewayConnectionUrl,
  parseGatewayConnectionRoutes,
  type GatewayConnectionRoutes,
} from "../../../shared/gatewayConnectionRoutes.js";
import { withLocalMetadata } from "./context-lock";
import { metadataSecure, type MetadataAuthority } from "./metadata-authority";


export const PROFILE_INDEX_KEY = "kcoder-studio-mobile.gateway-profiles.v2";
export const LEGACY_WEB_PROFILE_KEY =
  "kcoder-studio-mobile:gateway-profiles:v1";
const PROFILE_SECRET_PREFIX = "kcoder-studio-mobile.gateway-secret.";

type PublicProfile = Omit<GatewayProfile, "accessToken" | "rpcToken" | "refreshToken" | "pendingRotationId">;
type StoredProfile = PublicProfile & { secretKey?: string };

interface StoredProfileIndex {
  profiles: StoredProfile[];
  activeId: string | null;
}

interface StoredProfileSecret {
  profileId?: string;
  baseUrl?: string;
  deviceId?: string;
  authorizationGeneration?: string;
  /** Non-secret Gateway key identity bound to public route metadata. */
  connectionRoutesKeyId?: string;
  accessToken: string;
  rpcToken: string;
  refreshToken?: string;
  pendingRotationId?: string;
}

function profileSecretKey(id: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${PROFILE_SECRET_PREFIX}${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function routeKeyId(routes: GatewayConnectionRoutes): string {
  return `${routes.gatewayId}:${routes.publicKey}`;
}

function profileRouteMetadata(profile: GatewayProfile): {
  routes?: GatewayConnectionRoutes;
  keyId?: string;
} {
  if (profile.connectionRoutes === undefined) return {};
  const routes = parseGatewayConnectionRoutes(profile.connectionRoutes);
  const canonicalBaseUrl = canonicalGatewayConnectionUrl(profile.baseUrl);
  if (!routes || !canonicalBaseUrl || !routes.endpoints.some(endpoint => endpoint.url === canonicalBaseUrl)) {
    throw new Error("Gateway 连接描述与 canonical 地址不匹配");
  }
  return { routes, keyId: routeKeyId(routes) };
}

function storedRouteMetadata(entry: StoredProfile): {
  routes?: GatewayConnectionRoutes;
  keyId?: string;
  valid: boolean;
} {
  if (entry.connectionRoutes === undefined) return { valid: true };
  const routes = parseGatewayConnectionRoutes(entry.connectionRoutes);
  const canonicalBaseUrl = canonicalGatewayConnectionUrl(entry.baseUrl);
  if (!routes || !canonicalBaseUrl || !routes.endpoints.some(endpoint => endpoint.url === canonicalBaseUrl)) {
    return { valid: false };
  }
  return { routes, keyId: routeKeyId(routes), valid: true };
}

function publicProfile(profile: GatewayProfile): PublicProfile {
  const {
    accessToken: _accessToken,
    rpcToken: _rpcToken,
    refreshToken: _refreshToken,
    pendingRotationId: _pendingRotationId,
    ...metadata
  } = profile;
  const routeMetadata = profileRouteMetadata(profile);
  return {
    ...metadata,
    ...(routeMetadata.routes ? { connectionRoutes: routeMetadata.routes } : {}),
  };
}

function secretKeyFor(profile: StoredProfile): string | null {
  if (profile.secretKey === undefined) return profileSecretKey(profile.id);
  return profile.secretKey.startsWith(`${profileSecretKey(profile.id)}.v3.`) && /^[A-Za-z0-9._-]+$/.test(profile.secretKey) ? profile.secretKey : null;
}
function indexProfiles(index: Partial<StoredProfileIndex>): StoredProfile[] {
  return (Array.isArray(index.profiles) ? index.profiles : []).filter(profile => profile &&
    typeof profile.id === "string" && typeof profile.label === "string" && typeof profile.baseUrl === "string" &&
    typeof profile.expiresAt === "number" && (profile.secretKey === undefined || typeof profile.secretKey === "string"));
}
export async function loadProfiles(authority?: MetadataAuthority): Promise<{ profiles: GatewayProfile[]; activeId: string | null }> {
  const { getSecureValue } = metadataSecure(authority);
  const raw = await getSecureValue(PROFILE_INDEX_KEY);
  if (!raw) return { profiles: [], activeId: null };
  const parsed = JSON.parse(raw) as Partial<StoredProfileIndex>;
  const metadata = indexProfiles(parsed);
  const keys = metadata.map(secretKeyFor);
  const profiles = await Promise.all(metadata.map(async (entry, index): Promise<GatewayProfile> => {
    const {secretKey: _key, ...profile} = entry;
    const routeMetadata = storedRouteMetadata(entry);
    const { connectionRoutes: _untrustedRoutes, ...profileWithoutRoutes } = profile;
    const safeProfile = {
      ...profileWithoutRoutes,
      ...(routeMetadata.routes ? { connectionRoutes: routeMetadata.routes } : {}),
    };
    // Keep the endpoint available for reauthorization; do not discard unrelated connections.
    const unavailable = {...safeProfile, accessToken: "", rpcToken: "cookie-auth", expiresAt: 0};
    if (!routeMetadata.valid) return unavailable;
    const key = keys[index];
    if (!key || keys.filter(candidate => candidate === key).length > 1) return unavailable;
    const secretRaw = await getSecureValue(key);
    if (!secretRaw) return unavailable;
    try {
      const secret = JSON.parse(secretRaw) as StoredProfileSecret;
      if (!secret || typeof secret.accessToken !== "string" || typeof secret.rpcToken !== "string" ||
        (entry.secretKey !== undefined && secret.profileId !== entry.id) || (secret.baseUrl !== undefined && secret.baseUrl !== profile.baseUrl) || (secret.refreshToken !== undefined && (secret.baseUrl !== profile.baseUrl || secret.deviceId !== profile.deviceId || secret.authorizationGeneration !== profile.authorizationGeneration))) return unavailable;
      if (secret.connectionRoutesKeyId !== routeMetadata.keyId) return unavailable;
      return {...safeProfile, accessToken: secret.accessToken, rpcToken: secret.rpcToken, refreshToken: typeof secret.refreshToken === "string" ? secret.refreshToken : undefined, pendingRotationId: typeof secret.pendingRotationId === "string" ? secret.pendingRotationId : undefined};
    } catch { return unavailable; }
  }));
  const activeId = parsed.activeId === null
    ? null
    : profiles.some((profile) => profile.id === parsed.activeId)
      ? parsed.activeId!
      : profiles[0]?.id ?? null;
  authority?.assert();
  return { profiles, activeId };
}

let persistenceTail: Promise<void> = Promise.resolve();
let secretSequence = 0;
// The nonce identifies an immutable storage record, not an authentication secret.
async function freshSecretKey(id: string, authority?: MetadataAuthority): Promise<string> {
  const { getSecureValue } = metadataSecure(authority);
  for (let attempt=0; attempt<8; attempt++) {
    const key = `${profileSecretKey(id)}.v3.${Date.now().toString(36)}.${++secretSequence}.${Math.random().toString(36).slice(2)}`;
    if (await getSecureValue(key) === null) return key;
  }
  throw new Error("无法分配新的凭据存储记录");
}
export function persistProfiles(profiles: GatewayProfile[], activeId: string | null, authority?: MetadataAuthority): Promise<void> {
  const snapshot = profiles.map(profile => ({...profile}));
  const operation = persistenceTail.then(() => persistProfileSnapshot(snapshot, activeId, authority));
  persistenceTail = operation.catch(() => {});
  return operation;
}
async function persistProfileSnapshot(profiles: GatewayProfile[], activeId: string | null, authority?: MetadataAuthority): Promise<void> {
  const { getSecureValue, setSecureValue, deleteSecureValue } = metadataSecure(authority);
  const previousRaw = await getSecureValue(PROFILE_INDEX_KEY);
  let previous: StoredProfile[] = [];
  try { if (previousRaw) previous = indexProfiles(JSON.parse(previousRaw)); } catch { /* Replace damaged metadata only on a successful commit. */ }
  const created: string[] = [];
  const next: StoredProfile[] = [];
  let indexAttempted = false;
  let committed = false;
  let indexRaw = "";
  try {
    for (const profile of profiles) {
      const entry = previous.find(item => item.id === profile.id);
      const oldKey = entry?.secretKey ? secretKeyFor(entry) : null;
      const routeMetadata = profileRouteMetadata(profile);
      if (entry) {
        const previousRoutes = storedRouteMetadata(entry);
        const previousSecretRaw = oldKey ? await getSecureValue(oldKey) : null;
        let previousSecret: StoredProfileSecret | undefined;
        if (previousSecretRaw) {
          try {
            const parsedSecret = JSON.parse(previousSecretRaw) as unknown;
            if (parsedSecret && typeof parsedSecret === "object" && !Array.isArray(parsedSecret))
              previousSecret = parsedSecret as StoredProfileSecret;
          } catch { /* Existing legacy profiles may be recovered from the current in-memory grant. */ }
        }
        const hasRouteBinding = entry.connectionRoutes !== undefined || routeMetadata.keyId !== undefined ||
          previousSecret?.connectionRoutesKeyId !== undefined;
        if (hasRouteBinding && (!previousRoutes.valid || !previousSecret ||
            previousSecret.connectionRoutesKeyId !== previousRoutes.keyId ||
            routeMetadata.keyId !== previousRoutes.keyId)) {
          throw new Error("Gateway 连接身份已绑定凭据，不能替换或移除其 route key");
        }
      }
      const secretRaw = JSON.stringify({
        profileId: profile.id,
        baseUrl: profile.baseUrl,
        deviceId: profile.deviceId,
        authorizationGeneration: profile.authorizationGeneration,
        ...(routeMetadata.keyId ? { connectionRoutesKeyId: routeMetadata.keyId } : {}),
        accessToken: profile.accessToken,
        rpcToken: profile.rpcToken,
        refreshToken: profile.refreshToken,
        pendingRotationId: profile.pendingRotationId,
      });
      let key = oldKey;
      if (!key || await getSecureValue(key) !== secretRaw) {
        key = await freshSecretKey(profile.id, authority);
        created.push(key);
        await setSecureValue(key, secretRaw);
      }
      next.push({...publicProfile(profile), secretKey:key});
    }
    const persistedActiveId = activeId === null
      ? null
      : profiles.some((profile) => profile.id === activeId)
        ? activeId
        : profiles[0]?.id ?? null;
    indexRaw = JSON.stringify({profiles:next,activeId:persistedActiveId} satisfies StoredProfileIndex);
    indexAttempted = true;
    await setSecureValue(PROFILE_INDEX_KEY, indexRaw);
    committed = true;
  } catch (error) {
    // A native write may commit before reporting an error. Read back before cleanup.
    let knownUncommitted = !indexAttempted;
    if (indexAttempted) {
      try { committed = await getSecureValue(PROFILE_INDEX_KEY) === indexRaw; knownUncommitted = !committed; }
      catch { /* Keep staged secrets if commit outcome is unknown. */ }
    }
    if (!committed) {
      if (knownUncommitted) await Promise.allSettled(created.map(deleteSecureValue));
      throw error;
    }
  }
  const retained = new Set(next.map(secretKeyFor));
  const obsolete = [...new Set(previous.map(secretKeyFor))].filter((key): key is string => key !== null && !retained.has(key));
  // Cleanup failure must not turn an already committed index into a failed save.
  await Promise.allSettled(obsolete.map(deleteSecureValue));
}

export async function migrateLegacyWebProfiles(): Promise<{
  profiles: GatewayProfile[];
  activeId: string | null;
} | null> {
  // Migration is another index writer. Recheck under the same lock as pairing
  // and removal; an existing winner must also reach the hydration consumer.
  const migrate = async (authority?: MetadataAuthority) => {
    const { getSecureValue, deleteSecureValue } = metadataSecure(authority);
    if (await getSecureValue(PROFILE_INDEX_KEY)) return loadProfiles(authority);
    const raw = await getSecureValue(LEGACY_WEB_PROFILE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as {
      profiles?: GatewayProfile[];
      activeId?: string | null;
    };
    const profiles = Array.isArray(parsed.profiles) ? parsed.profiles : [];
    const activeId = parsed.activeId === null
      ? null
      : typeof parsed.activeId === "string" && profiles.some((profile) => profile.id === parsed.activeId)
        ? parsed.activeId
        : profiles[0]?.id ?? null;
    await persistProfiles(profiles, activeId, authority);
    await Promise.allSettled([deleteSecureValue(LEGACY_WEB_PROFILE_KEY)]);
    return { profiles, activeId };
  };
  return withLocalMetadata("gateway-profile-index", migrate);
}

export const profileStoreTestHelpers = { profileSecretKey };
