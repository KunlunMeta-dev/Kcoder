import type { GatewayProfile } from "@/gateway/types";
import type { ProfileRemovalResult } from "./profile-coordinator";

export interface ProfileRemovalEffects {
  setProfiles(profiles: GatewayProfile[]): void;
  setActiveId(id: string | null): void;
  removeProfileRuntimes(id: string): void;
  clearRuntime(): void;
  markProfileStateRemoval(id: string): number | null;
}

/** Apply effects only after the persisted removal owns this profile snapshot. */
export function applyProfileRemovalEffects(
  result: ProfileRemovalResult,
  profileId: string,
  effects: ProfileRemovalEffects,
): number | null {
  if (!result.removed) return null;
  const generation = effects.markProfileStateRemoval(profileId);
  effects.setProfiles(result.snapshot.profiles);
  effects.setActiveId(result.snapshot.activeId);
  effects.removeProfileRuntimes(profileId);
  if (result.wasActive) effects.clearRuntime();
  return generation;
}
