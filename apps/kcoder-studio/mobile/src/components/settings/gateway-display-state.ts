import type { GatewayProfile } from "@/gateway/types";

export type GatewayDisplayState = "connected" | "checking" | "offline";

type GatewayRuntimeState = {
  error: string | null;
  loading: boolean;
  reauthorizationRequired: boolean;
  serversReady: boolean;
};

/** Describes reachability of the selected Gateway, never the health of an individual server. */
export function getGatewayDisplayState(
  profile: GatewayProfile | null,
  runtime: GatewayRuntimeState,
  now = Date.now(),
): GatewayDisplayState {
  if (!profile || (profile.expiresAt <= now && !profile.refreshToken) || runtime.error || runtime.reauthorizationRequired)
    return "offline";
  if (runtime.loading || !runtime.serversReady) return "checking";
  return "connected";
}
