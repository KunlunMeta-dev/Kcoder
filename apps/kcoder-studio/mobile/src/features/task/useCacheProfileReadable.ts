import { useEffect, useState } from "react";
import type { GatewayProfile } from "@/gateway/types";
import { profileAuthorizationScopeKey } from "@/state/profile-coordinator";
import { cacheProfileReadable, cacheProfileReadDeadline } from "./session-cache-coordinator";

/** The last valid access/renewable grant hides cache at expiry without another app render. */
export function useCacheProfileReadable(profile: GatewayProfile | null, reauthorizationRequired: boolean): boolean {
  const [revision, tick] = useState(0);
  const identity = profile ? profileAuthorizationScopeKey(profile) : null;
  const deadline = profile && !reauthorizationRequired ? cacheProfileReadDeadline(profile) : 0;
  useEffect(() => {
    if (deadline <= Date.now()) return;
    const timer = setTimeout(() => tick(value => value + 1), Math.min(2_147_483_647, Math.max(1, deadline - Date.now())));
    return () => clearTimeout(timer);
  }, [identity, deadline, profile?.refreshToken, revision]);
  return Boolean(profile && cacheProfileReadable(profile, reauthorizationRequired));
}
