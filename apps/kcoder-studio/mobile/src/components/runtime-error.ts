export function runtimeErrorSummary(error: string): string {
  if (/\b401\b|unauthori[sz]ed|authentication(?:_error)?|incorrect\s+api[_ -]?key|api[_ -]?key|invalid[_ -]?(?:token|credential)/i.test(error)) {
    return "Provider 拒绝了请求，请检查 API key、模型权限和账户状态。";
  }
  if (/billing|not[_ ]billable|no enabled billing rate|额度|余额不足/i.test(error)) {
    return "当前模型没有可用额度或计费配置，请切换模型或检查 Provider 账户。";
  }
  if (/\b403\b|forbidden/i.test(error)) {
    return "Provider 拒绝了请求，请检查 API key、模型权限和账户状态。";
  }
  if (error.length > 240) return "请求失败，服务端返回了较长的技术信息。";
  return error;
}
