const removalGenerationByProfile = new Map<string, number>();
let nextRemovalGeneration = 0;

export function markProfileStateRemoval(
  profileId: string,
  generation?: number,
): number | null {
  if (!profileId.trim()) return null;
  const next = generation ?? ++nextRemovalGeneration;
  removalGenerationByProfile.set(profileId, next);
  return next;
}

export function isProfileStateRemovalPending(profileId: string): boolean {
  return !profileId.trim() || removalGenerationByProfile.has(profileId);
}

export function clearProfileStateRemoval(
  profileId: string,
  generation: number,
): boolean {
  if (removalGenerationByProfile.get(profileId) !== generation) return false;
  removalGenerationByProfile.delete(profileId);
  return true;
}

export function profileStateRemovalTestHelpersReset(): void {
  removalGenerationByProfile.clear();
  nextRemovalGeneration = 0;
}

export const profileStateRemovalTestHelpers = {
  reset(): void {
    profileStateRemovalTestHelpersReset();
  },
};
