import type { GatewayProfile } from "@/gateway/types";
import { deleteSecureValue, getSecureValue, setSecureValue } from "./secure";

export const PROFILE_INDEX_KEY = "kcoder-studio-mobile.gateway-profiles.v2";
export const LEGACY_WEB_PROFILE_KEY =
  "kcoder-studio-mobile:gateway-profiles:v1";
const PROFILE_SECRET_PREFIX = "kcoder-studio-mobile.gateway-secret.";

type PublicProfile = Omit<GatewayProfile, "accessToken" | "rpcToken">;

interface StoredProfileIndex {
  profiles: PublicProfile[];
  activeId: string | null;
}

interface StoredProfileSecret {
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

export async function loadProfiles(): Promise<{
  profiles: GatewayProfile[];
  activeId: string | null;
}> {
  const raw = await getSecureValue(PROFILE_INDEX_KEY);
  if (!raw) return { profiles: [], activeId: null };
  const parsed = JSON.parse(raw) as Partial<StoredProfileIndex>;
  const metadata = Array.isArray(parsed.profiles) ? parsed.profiles : [];
  const profiles = (
    await Promise.all(
      metadata.map(async (profile): Promise<GatewayProfile | null> => {
        const secretRaw = await getSecureValue(profileSecretKey(profile.id));
        if (!secretRaw) return null;
        const secret = JSON.parse(secretRaw) as Partial<StoredProfileSecret>;
        if (
          typeof secret.accessToken !== "string" ||
          typeof secret.rpcToken !== "string"
        )
          return null;
        return {
          ...profile,
          accessToken: secret.accessToken,
          rpcToken: secret.rpcToken,
        };
      }),
    )
  ).filter((profile): profile is GatewayProfile => profile !== null);
  return {
    profiles,
    activeId: profiles.some((profile) => profile.id === parsed.activeId)
      ? (parsed.activeId ?? null)
      : (profiles[0]?.id ?? null),
  };
}

export async function persistProfiles(
  profiles: GatewayProfile[],
  activeId: string | null,
): Promise<void> {
  const previousRaw = await getSecureValue(PROFILE_INDEX_KEY);
  if (previousRaw) {
    try {
      const previous = JSON.parse(previousRaw) as Partial<StoredProfileIndex>;
      const currentIds = new Set(profiles.map((profile) => profile.id));
      await Promise.all(
        (Array.isArray(previous.profiles) ? previous.profiles : [])
          .filter((profile) => !currentIds.has(profile.id))
          .map((profile) => deleteSecureValue(profileSecretKey(profile.id))),
      );
    } catch {
      // A damaged old index is replaced completely below.
    }
  }
  if (profiles.length === 0) {
    await deleteSecureValue(PROFILE_INDEX_KEY);
    return;
  }
  await Promise.all(
    profiles.map((profile) =>
      setSecureValue(
        profileSecretKey(profile.id),
        JSON.stringify({
          accessToken: profile.accessToken,
          rpcToken: profile.rpcToken,
        }),
      ),
    ),
  );
  await setSecureValue(
    PROFILE_INDEX_KEY,
    JSON.stringify({
      profiles: profiles.map(publicProfile),
      activeId,
    } satisfies StoredProfileIndex),
  );
}

export async function migrateLegacyWebProfiles(): Promise<{
  profiles: GatewayProfile[];
  activeId: string | null;
} | null> {
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
  await deleteSecureValue(LEGACY_WEB_PROFILE_KEY);
  return { profiles, activeId };
}

export const profileStoreTestHelpers = { profileSecretKey };
