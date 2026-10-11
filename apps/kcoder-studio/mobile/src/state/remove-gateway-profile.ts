import { withLocalIdentityLock } from "@/storage/context-lock";
import { ensureGatewayAuthorization } from "@/gateway/http";
import type { GatewayProfile } from "@/gateway/types";
import type { ProfileCoordinator, ProfileRemovalResult } from "./profile-coordinator";
import { assertWorkspaceOperationsResolvedV2 } from "@/storage/pending-workspace-operation-v2";
import {
  applyProfileRemovalEffects,
  type ProfileRemovalEffects,
} from "./profile-removal-effects";

export interface RemoveGatewayProfileDependencies {
  coordinator: ProfileCoordinator;
  persist(profiles: GatewayProfile[], activeId: string | null): Promise<void>;
  cleanupProfileState(profileId: string, generation?: number): Promise<void>;
  revokeSession?(profile: GatewayProfile): Promise<void>;
  effects: ProfileRemovalEffects;
}

/** Persist first; only a committed removal may discard the old profile's state. */
export async function removeGatewayProfile(
  profileId: string,
  dependencies: RemoveGatewayProfileDependencies,
): Promise<ProfileRemovalResult & { remoteRevocation?: "confirmed" | "unconfirmed" }> {
  const {
    coordinator,
    persist,
    cleanupProfileState,
    revokeSession,
    effects,
  } = dependencies;
  const profile = coordinator.getSnapshot().profiles.find(
    (item) => item.id === profileId,
  );
  if (profile?.authMode === "device") await ensureGatewayAuthorization(profile).catch(() => {});
  const remove = async (): Promise<ProfileRemovalResult & { remoteRevocation?: "confirmed" | "unconfirmed" }> => {
  await coordinator.synchronize();
  const current = coordinator.getSnapshot().profiles.find(item => item.id === profileId);
  if (profile && (!current || current.baseUrl !== profile.baseUrl || current.authorizationGeneration !== profile.authorizationGeneration)) return { snapshot: coordinator.getSnapshot(), removed: false, wasActive: false };
  const revocationProfile = current ? { ...current } : profile;
  const intent = coordinator.beginRemoval(profileId);
  let stateRemovalGeneration: number | null = null;
  const result = await coordinator.remove(intent, persist, (committedRemoval) => {
    stateRemovalGeneration = applyProfileRemovalEffects(
      committedRemoval,
      profileId,
      effects,
    );
  }, assertWorkspaceOperationsResolvedV2);
  if (!result.removed) return result;

  const cleanup = cleanupProfileState(
    profileId,
    stateRemovalGeneration ?? undefined,
  );
  let remoteRevocation: "confirmed" | "unconfirmed" | undefined;
  const revoke = revocationProfile && revokeSession
    ? Promise.resolve()
        .then(() => revokeSession(revocationProfile))
        .then(() => { remoteRevocation = "confirmed"; })
        .catch(() => {
          remoteRevocation = "unconfirmed";
          // Offline removal remains immediate locally; remote revocation is explicit.
        })
    : Promise.resolve();
  await Promise.all([cleanup, revoke]);
  return { ...result, remoteRevocation };
  };
  return profile?.authMode === "device" ? withLocalIdentityLock(`device-authorization:${JSON.stringify([profile.baseUrl, profile.deviceId, profile.authorizationGeneration])}`, remove) : remove();
}
