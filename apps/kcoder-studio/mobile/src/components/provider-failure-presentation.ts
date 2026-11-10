import { t } from "@/i18n";
import type { ProviderFailureDetails } from "../../../shared/providerFailure";

export function providerFailureSummary(
  failure: ProviderFailureDetails | undefined,
): string {
  if (failure?.http_status === 503) return t("task.model_service_unavailable");
  return t(`task.failure_${failure?.category ?? "unknown"}`);
}
