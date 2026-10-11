import type { GatewayProfile } from "@/gateway/types";
import type { ConnectionCommitResult } from "./profile-coordinator";

export interface ProfileConnectionEffects {
  setProfiles(profiles: GatewayProfile[]): void;
  setActiveId(id: string): void;
  removeProfileRuntimes(id: string): void;
  clearRuntime(): void;
}

/** Apply only the React/runtime effects justified by this connection's commit. */
export function applyProfileConnectionEffects(
  result: ConnectionCommitResult,
  exchangedProfile: GatewayProfile,
  isLatestIntent: () => boolean,
  effects: ProfileConnectionEffects,
): GatewayProfile | null {
  if (!result.committed) return null;

  const { snapshot } = result;
  const committedProfile =
    snapshot.profiles.find((item) => item.baseUrl === exchangedProfile.baseUrl) ??
    exchangedProfile;
  const latestIntent = isLatestIntent();
  effects.setProfiles(snapshot.profiles);

  const activated =
    result.activated &&
    snapshot.activeId === committedProfile.id &&
    latestIntent;
  if (!activated) return null;

  if (committedProfile.id !== exchangedProfile.id)
    effects.removeProfileRuntimes(committedProfile.id);
  effects.setActiveId(snapshot.activeId!);
  effects.clearRuntime();

  return committedProfile;
}
