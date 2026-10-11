import { t } from "@/i18n";
export function runtimeErrorSummary(error: string): string {
  if (
    /\b401\b|unauthori[sz]ed|authentication(?:_error)?|incorrect\s+api[_ -]?key|api[_ -]?key|invalid[_ -]?(?:token|credential)/i.test(
      error,
    )
  ) {
    return t("task.the_provider_rejected_the_request_check_the_api");
  }
  if (
    /billing|not[_ ]billable|no enabled billing rate|额度|余额不足/i.test(error)
  ) {
    return t("task.this_model_has_no_available_quota_or_billing");
  }
  if (/\b403\b|forbidden/i.test(error)) {
    return t("task.the_provider_rejected_the_request_check_the_api");
  }
  if (error.length > 240)
    return t("task.the_request_failed_the_server_returned_detailed_technical");
  return error;
}
