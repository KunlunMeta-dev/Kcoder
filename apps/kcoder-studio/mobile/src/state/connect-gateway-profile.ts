import type { GatewayProfile } from "@/gateway/types";
import type { ConnectionCommitResult } from "./profile-coordinator";

export interface ConnectGatewayProfileDependencies<T> {
  signal?: AbortSignal;
  exchange(): Promise<GatewayProfile>;
  commit(
    profile: GatewayProfile,
    onCommit: (result: ConnectionCommitResult) => void,
  ): Promise<ConnectionCommitResult>;
  applyCommit(
    profile: GatewayProfile,
    result: ConnectionCommitResult,
  ): T | null;
  revoke(profile: GatewayProfile): Promise<void>;
}

/** Exchange a Gateway session, then persist/apply it through the profile coordinator. */
export async function connectGatewayProfile<T>(
  dependencies: ConnectGatewayProfileDependencies<T>,
): Promise<T | null> {
  const { signal, exchange, commit, applyCommit, revoke } = dependencies;
  if (signal?.aborted) return null;

  try {
    const profile = await exchange();
    if (signal?.aborted) {
      await revokeBestEffort(revoke, profile);
      return null;
    }

    let committed = false;
    let appliedProfile: T | null = null;
    const result = await commit(profile, (commitResult) => {
      // The coordinator invokes this only after durable commit. Set this before
      // effects so a thrown effect cannot revoke a profile that is already saved.
      if (commitResult.committed) committed = true;
      appliedProfile = applyCommit(profile, commitResult);
    });
    if (result.committed) {
      committed = true;
      return appliedProfile;
    }
    if (!committed) await revokeBestEffort(revoke, profile);
    return null;
  } catch (error) {
    if (signal?.aborted) return null;
    throw error;
  }
}

async function revokeBestEffort(
  revoke: (profile: GatewayProfile) => Promise<void>,
  profile: GatewayProfile,
): Promise<void> {
  try {
    // The revocation helper owns its timeout; do not propagate the aborted
    // connection signal into cleanup.
    await revoke(profile);
  } catch {
    // A stale session can expire naturally; cleanup must not replace the
    // connection's cancellation or persistence result.
  }
}
