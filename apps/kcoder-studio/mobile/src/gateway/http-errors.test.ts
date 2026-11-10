import { describe, expect, it } from "vitest";
import { initLocale, t } from "@/i18n";
import {
  categoryForGatewayHttpStatus,
  GatewayHttpError,
  gatewayHttpErrorPresentation,
  gatewayRouteErrorPresentation,
  safeGatewayHttpErrorDetail,
} from "./http-errors";

describe("Gateway HTTP errors", () => {
  it("renders only safe route stage metadata through nested causes", () => {
    const route = Object.assign(new Error("token=private https://private.invalid"), {
      name: "GatewayRouteResolutionError", code: "GATEWAY_ROUTE_UNAVAILABLE", failure: "http", status: 502,
    });
    expect(gatewayRouteErrorPresentation(new Error("pairing failed", { cause: route }))).toEqual({
      messageKey: "connect.route_http_failed", detail: "GATEWAY_ROUTE_UNAVAILABLE/http · HTTP 502",
    });
    expect(gatewayRouteErrorPresentation(new Error("token=private"))).toBeUndefined();
    route.failure = "__proto__";
    expect(gatewayRouteErrorPresentation(route)).toBeUndefined();
  });

  it.each([
    [401, "authentication"],
    [403, "authentication"],
    [404, "not_found"],
    [429, "rate_limited"],
    [500, "gateway_unavailable"],
    [503, "gateway_unavailable"],
    [400, "other"],
    [409, "other"],
  ] as const)("classifies HTTP %i as %s", (status, category) => {
    expect(categoryForGatewayHttpStatus(status)).toBe(category);
  });

  it("retains useful business details and redacts HTML and endpoint URLs", () => {
    expect(safeGatewayHttpErrorDetail("Device limit reached")).toBe("Device limit reached");
    expect(safeGatewayHttpErrorDetail("Gateway is locked")).toBe("Gateway is locked");
    expect(safeGatewayHttpErrorDetail("<html><body>Not found</body></html>")).toBeUndefined();

    const detail = safeGatewayHttpErrorDetail("Device grant rejected at https://relay.invalid/g/tenant?token=private");
    expect(detail).toContain("Device grant rejected");
    expect(detail).toContain("[address hidden]");
    expect(detail).not.toContain("relay.invalid");
    expect(detail).not.toContain("private");
    expect(safeGatewayHttpErrorDetail("Gateway rejected /g/private/api/mobile/session?token=secret"))
      .toBe("Gateway rejected [path hidden]");
    expect(safeGatewayHttpErrorDetail("Authorization: Basic dXNlcjpwYXNz")).toBeUndefined();
    expect(safeGatewayHttpErrorDetail("Basic dXNlcjpwYXNz")).toBeUndefined();
    expect(safeGatewayHttpErrorDetail("Bearer abcdef0123456789")).toBeUndefined();
    expect(safeGatewayHttpErrorDetail("Basic plan limit reached")).toBe("Basic plan limit reached");
    expect(safeGatewayHttpErrorDetail("Bearer authentication is required"))
      .toBe("Bearer authentication is required");
  });

  it.each([
    ["api_token=short-secret", "short-secret"],
    ["sessionToken=short-secret", "short-secret"],
    ["auth_token=short-secret", "short-secret"],
    ["device_secret=short-secret", "short-secret"],
    ["apiKey=short-secret", "short-secret"],
    ["password=two word secret", "two word secret"],
    ["token=private value", "private value"],
    [JSON.stringify({ apiKey: "short secret" }), "short secret"],
    [JSON.stringify({ access_token: "abc123" }), "abc123"],
    [JSON.stringify({ password: 'two word "secret"' }), 'two word "secret"'],
    [JSON.stringify({ authorization: "Basic dXNlcjpwYXNz" }), "dXNlcjpwYXNz"],
  ])("drops error details containing credential assignment (#)", (input, secret) => {
    initLocale("en");
    const error = new GatewayHttpError(403, `Request rejected: ${input}`);
    expect(safeGatewayHttpErrorDetail(`Request rejected: ${input}`)).toBeUndefined();
    expect(error.detail).toBeUndefined();
    expect(error.message).toBe(t("connect.http_authentication_failed"));
    expect(error.message).not.toContain(secret);
  });

  it("produces render-time localized guidance and keeps HTTP status diagnostic", () => {
    initLocale("en");
    const error = new GatewayHttpError(404);
    expect(error.message).toBe(t("connect.http_address_not_found"));
    expect(error.message).not.toContain("404");
    expect(gatewayHttpErrorPresentation(error)).toEqual({
      categoryKey: "connect.http_address_not_found",
      status: 404,
    });
    const detailedError = new GatewayHttpError(403, "Gateway is locked");
    expect(detailedError.message).toContain("Gateway is locked");
    expect(detailedError.message).toContain(t("connect.http_authentication_failed"));
    expect(detailedError.message).not.toContain("403");

    initLocale("zh-CN");
    const chineseError = new GatewayHttpError(404);
    expect(chineseError.message).toBe(t("connect.http_address_not_found"));
    expect(chineseError.message).not.toContain("404");
    const chineseDetail = new GatewayHttpError(403, "Device limit reached");
    expect(chineseDetail.message).toContain("Device limit reached");
    expect(chineseDetail.message).toContain(t("connect.http_authentication_failed"));
    expect(chineseDetail.message).not.toContain("403");

    initLocale("en");
    expect(gatewayHttpErrorPresentation(new Error("offline"))).toBeUndefined();
  });
});
