import { t } from "@/i18n";
import type { ProviderFailureDetails } from "../../../shared/providerFailure";

export function providerFailureSummary(
  failure: ProviderFailureDetails | undefined,
): string {
  return t(`task.failure_${failure?.category ?? "unknown"}`);
}
