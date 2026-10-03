import { describe, expect, it } from "vitest";
import { runtimeErrorSummary } from "./runtime-error";

describe("runtimeErrorSummary", () => {
  it("将额度错误转换为适合手机阅读的提示", () => {
    expect(runtimeErrorSummary("API error 403: no enabled billing rate for MiniMax-M3"))
      .toBe("当前模型没有可用额度或计费配置，请切换模型或检查 Provider 账户。");
  });

  it("将鉴权错误转换为不暴露原始响应的提示", () => {
    expect(runtimeErrorSummary("authentication_error: Incorrect API key provided secret-value"))
      .toBe("Provider 拒绝了请求，请检查 API key、模型权限和账户状态。");
    expect(runtimeErrorSummary("401 billing configuration rejected"))
      .toBe("Provider 拒绝了请求，请检查 API key、模型权限和账户状态。");
  });

  it("保留简短错误并折叠未知的超长错误", () => {
    expect(runtimeErrorSummary("连接已断开")).toBe("连接已断开");
    expect(runtimeErrorSummary("x".repeat(300))).toBe("请求失败，服务端返回了较长的技术信息。");
  });
});
