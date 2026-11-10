import { t } from "@/i18n";

/** Route diagnostics stay in runtime state; list feedback uses localized copy. */
export function gatewayErrorMessage(message: string): string {
  if (message === "No advertised Gateway route passed the connection proof") return t("home.gateway_recovering");
  if (message === "Gateway connection descriptor is invalid") return t("home.gateway_route_invalid");
  return message;
}
