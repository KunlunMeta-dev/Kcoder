import { pairingRouteFromSystemPath } from "@/gateway/pairing";

export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  return pairingRouteFromSystemPath(path);
}
