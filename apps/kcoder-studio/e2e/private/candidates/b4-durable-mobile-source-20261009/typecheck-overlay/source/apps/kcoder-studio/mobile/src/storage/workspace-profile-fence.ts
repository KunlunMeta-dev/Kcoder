import type { GatewayProfile } from "@/gateway/types";

export interface WorkspaceProfileIdentity {
  readonly id: string;
  readonly baseUrl: string;
  readonly authorizationGeneration: string;
  readonly deviceId?: string;
}

export function captureWorkspaceProfileIdentity(profile: GatewayProfile): WorkspaceProfileIdentity {
  return {
    id: profile.id,
    baseUrl: profile.baseUrl,
    authorizationGeneration: profile.authorizationGeneration ?? `legacy:${profile.id}`,
    deviceId: profile.deviceId,
  };
}

// Vitest's fake connector has no SecureStore/profile index. This seam only
// permits deterministic storage tests; it is not Web Locks or profile-removal
// evidence. The separate Browser test uses real IndexedDB but keeps the same
// explicitly narrow profile-fence boundary.
export async function withWorkspaceProfileWrite<T>(_identity: WorkspaceProfileIdentity, operation: () => Promise<T>): Promise<T> {
  return operation();
}
