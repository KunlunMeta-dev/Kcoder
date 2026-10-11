import type { GatewayProfile } from "@/gateway/types";

export async function ensureGatewayAuthorization(_profile: GatewayProfile): Promise<void> {
  // The controlled peer uses a synthetic profile. No HTTP refresh or Gateway
  // authorization request is made by this private contract test.
}
