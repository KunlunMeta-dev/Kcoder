import type { GatewayProfile } from "@/gateway/types";
import { deleteSecureValue, getSecureValue, setSecureValue } from "./secure";

export const PROFILE_INDEX_KEY = "kcoder-studio-mobile.gateway-profiles.v2";
export const LEGACY_WEB_PROFILE_KEY =
  "kcoder-studio-mobile:gateway-profiles:v1";
const PROFILE_SECRET_PREFIX = "kcoder-studio-mobile.gateway-secret.";

type PublicProfile = Omit<GatewayProfile, "accessToken" | "rpcToken">;
type StoredProfile = PublicProfile & { secretKey?: string };

interface StoredProfileIndex {
  profiles: StoredProfile[];
  activeId: string | null;
}

interface StoredProfileSecret {
  profileId?: string;
  accessToken: string;
  rpcToken: string;
}

function profileSecretKey(id: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${PROFILE_SECRET_PREFIX}${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function publicProfile(profile: GatewayProfile): PublicProfile {
  const {
    accessToken: _accessToken,
    rpcToken: _rpcToken,
    ...metadata
  } = profile;
  return metadata;
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
export async function loadProfiles(): Promise<{ profiles: GatewayProfile[]; activeId: string | null }> {
  const raw = await getSecureValue(PROFILE_INDEX_KEY);
  if (!raw) return { profiles: [], activeId: null };
  const parsed = JSON.parse(raw) as Partial<StoredProfileIndex>;
  const metadata = indexProfiles(parsed);
  const keys = metadata.map(secretKeyFor);
  const profiles = await Promise.all(metadata.map(async (entry, index): Promise<GatewayProfile> => {
    const {secretKey: _key, ...profile} = entry;
    // Keep the endpoint available for reauthorization; do not discard unrelated connections.
    const unavailable = {...profile, accessToken: "", rpcToken: "cookie-auth", expiresAt: 0};
    const key = keys[index];
    if (!key || keys.filter(candidate => candidate === key).length > 1) return unavailable;
    const secretRaw = await getSecureValue(key);
    if (!secretRaw) return unavailable;
    try {
      const secret = JSON.parse(secretRaw) as StoredProfileSecret;
      if (!secret || typeof secret.accessToken !== "string" || typeof secret.rpcToken !== "string" ||
        (entry.secretKey !== undefined && secret.profileId !== entry.id)) return unavailable;
      return {...profile, accessToken: secret.accessToken, rpcToken: secret.rpcToken};
    } catch { return unavailable; }
  }));
  return { profiles, activeId: profiles.some(profile => profile.id === parsed.activeId) ? parsed.activeId! : profiles[0]?.id ?? null };
}

let persistenceTail: Promise<void> = Promise.resolve();
let secretSequence = 0;
// The nonce identifies an immutable storage record, not an authentication secret.
async function freshSecretKey(id: string): Promise<string> {
  for (let attempt=0; attempt<8; attempt++) {
    const key = `${profileSecretKey(id)}.v3.${Date.now().toString(36)}.${++secretSequence}.${Math.random().toString(36).slice(2)}`;
    if (await getSecureValue(key) === null) return key;
  }
  throw new Error("无法分配新的凭据存储记录");
}
export function persistProfiles(profiles: GatewayProfile[], activeId: string | null): Promise<void> {
  const snapshot = profiles.map(profile => ({...profile}));
  const operation = persistenceTail.then(() => persistProfileSnapshot(snapshot, activeId));
  persistenceTail = operation.catch(() => {});
  return operation;
}
async function persistProfileSnapshot(profiles: GatewayProfile[], activeId: string | null): Promise<void> {
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
      const secretRaw = JSON.stringify({profileId:profile.id,accessToken:profile.accessToken,rpcToken:profile.rpcToken});
      let key = oldKey;
      if (!key || await getSecureValue(key) !== secretRaw) {
        key = await freshSecretKey(profile.id);
        created.push(key);
        await setSecureValue(key, secretRaw);
      }
      next.push({...publicProfile(profile), secretKey:key});
    }
    indexRaw = JSON.stringify({profiles:next,activeId:profiles.some(profile=>profile.id===activeId)?activeId:profiles[0]?.id??null} satisfies StoredProfileIndex);
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
  if (await getSecureValue(PROFILE_INDEX_KEY)) return null;
  const raw = await getSecureValue(LEGACY_WEB_PROFILE_KEY);
  if (!raw) return null;
  const parsed = JSON.parse(raw) as {
    profiles?: GatewayProfile[];
    activeId?: string;
  };
  const profiles = Array.isArray(parsed.profiles) ? parsed.profiles : [];
  const activeId = profiles.some((profile) => profile.id === parsed.activeId)
    ? (parsed.activeId ?? null)
    : (profiles[0]?.id ?? null);
  await persistProfiles(profiles, activeId);
  await Promise.allSettled([deleteSecureValue(LEGACY_WEB_PROFILE_KEY)]);
  return { profiles, activeId };
}

export const profileStoreTestHelpers = { profileSecretKey };
