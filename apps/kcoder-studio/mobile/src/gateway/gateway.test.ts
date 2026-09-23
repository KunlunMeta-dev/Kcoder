import { describe, expect, it } from "vitest";
import { normalizedBaseUrl } from "./http";
import { allowHttpGatewayForEnvironment } from "../../app.config";
import { pairingRouteFromSystemPath, parsePairingLink } from "./pairing";
import { buildGatewayRpcUrl } from "./rpc";
import type { GatewayProfile, KCoderServer } from "./types";

const profile: GatewayProfile = {
  id: "vm",
  label: "VM",
  baseUrl: "http://127.0.0.1:4173",
  accessToken: "secret",
  expiresAt: 9_999_999_999_999,
  rpcToken: "cookie-auth",
};
const server: KCoderServer = {
  id: "ssh-lab",
  label: "SSH",
  description: "test",
  runtime: "kcoder",
  transport: "ssh",
};

describe("Gateway 地址和配对", () => {
  it("规范化内网地址并拒绝危险 scheme", () => {
    expect(normalizedBaseUrl("127.0.0.1:4173/")).toBe("http://127.0.0.1:4173");
    expect(() => normalizedBaseUrl("file:///tmp/x")).toThrow("只支持");
  });

  it("生产构建默认禁止明文 Gateway，仅允许显式开启", () => {
    expect(allowHttpGatewayForEnvironment({ NODE_ENV: "production" })).toBe(false);
    expect(allowHttpGatewayForEnvironment({ NODE_ENV: "production", KCODER_STUDIO_ALLOW_HTTP: "1" })).toBe(true);
    expect(allowHttpGatewayForEnvironment({ NODE_ENV: "development" })).toBe(false);
    expect(normalizedBaseUrl("gateway.example.com", false)).toBe("https://gateway.example.com");
    expect(() => normalizedBaseUrl("http://gateway.example.com", false)).toThrow("只允许 HTTPS");
  });

  it("解析 KCoder 配对链接并提供中文错误", () => {
    expect(
      parsePairingLink(
        "kcoder-studio://connect?gateway=http%3A%2F%2F127.0.0.1%3A4173&token=abc",
      ),
    ).toEqual({ gateway: "http://127.0.0.1:4173", token: "abc" });
    expect(() => parsePairingLink("not a link")).toThrow("格式无效");
  });

  it("将原生配对路径改写到连接页", () => {
    const expected = "/connect?gateway=http%3A%2F%2F127.0.0.1%3A4174&token=123";
    expect(pairingRouteFromSystemPath("kcoder-studio://connect?gateway=http%3A%2F%2F127.0.0.1%3A4174&token=123")).toBe(expected);
    expect(pairingRouteFromSystemPath("connect?gateway=http%3A%2F%2F127.0.0.1%3A4174&token=123")).toBe(expected);
    expect(pairingRouteFromSystemPath("/settings")).toBe("/settings");
    expect(pairingRouteFromSystemPath("kcoder-studio://connect?gateway=x")).toBe("/welcome?pairingError=invalid");
  });

  it("runtime 与 browser 使用独立 Gateway channel", () => {
    const runtime = new URL(buildGatewayRpcUrl(profile, server, "/srv/work", "runtime"));
    const browser = new URL(buildGatewayRpcUrl(profile, server, "/srv/work", "browser"));
    expect(runtime.protocol).toBe("ws:");
    expect(runtime.searchParams.get("channel")).toBe("runtime");
    expect(browser.searchParams.get("channel")).toBe("browser");
    expect(browser.searchParams.get("server")).toBe("ssh-lab");
    expect(browser.searchParams.get("workspace")).toBe("/srv/work");
    expect(browser.toString()).not.toContain(profile.accessToken);
  });
});
