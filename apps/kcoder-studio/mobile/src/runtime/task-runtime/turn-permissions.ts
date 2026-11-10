import { t } from "@/i18n";
import type { GatewayRpcClient } from "@/gateway/rpc";
import { isPermissionMode, type PermissionMode } from "@/protocol/task-permission-mode";

export function permissionParams(
  mode: PermissionMode | undefined,
  client: GatewayRpcClient | null,
): { permissionMode?: Exclude<PermissionMode, "default"> } {
  if (mode === undefined || mode === "default") return {};
  if (!isPermissionMode(mode)) throw new Error(t("task.permission_mode_invalid"));
  if (client?.supportsExperimental?.("turnPermissions") !== true)
    throw new Error(t("task.permission_mode_unavailable"));
  return { permissionMode: mode };
}
