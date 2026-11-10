import type { ServerStatus } from "@/gateway/types";
import { t } from "@/i18n";

export type ConnectionStatus = ServerStatus["status"] | "unknown";

export function connectionStatusLabel(status: ConnectionStatus): string {
  if (status === "online") return t("settings.status_online");
  if (status === "offline") return t("settings.status_offline");
  if (status === "checking") return t("settings.status_checking");
  return t("task.unknown");
}

export interface ConnectionStatusSource {
  servers: readonly { id: string }[];
  statuses: readonly Pick<ServerStatus, "id" | "status">[];
  loading: boolean;
  serversReady: boolean;
  serversUpdatedAt: number | null;
  error: string | null;
  reauthorizationRequired: boolean;
  statusRefreshing: boolean;
  statusError: string | null;
}

export interface MobileConnectionStatusProps {
  gatewayStatus: ConnectionStatus;
  serverStatuses: Record<string, ConnectionStatus>;
}

/** Keep Gateway reachability and per-target RPC status independent of thread activity. */
export function selectMobileConnectionStatusProps(
  source: ConnectionStatusSource,
): MobileConnectionStatusProps {
  const serverListConfirmed = source.serversReady && source.serversUpdatedAt !== null;
  const gatewayStatus: ConnectionStatus = source.reauthorizationRequired
    ? "unknown"
    : source.error
      ? "offline"
      : source.loading || !serverListConfirmed
        ? "checking"
        : "online";

  const serverStatuses = Object.fromEntries(
    source.servers.map(({ id }) => {
      const status: ConnectionStatus = source.reauthorizationRequired ||
        source.error || source.statusError || !serverListConfirmed
        ? "unknown"
        : source.statusRefreshing
          ? "checking"
          : source.statuses.find((item) => item.id === id)?.status ?? "unknown";
      return [id, status];
    }),
  );
  return { gatewayStatus, serverStatuses };
}
