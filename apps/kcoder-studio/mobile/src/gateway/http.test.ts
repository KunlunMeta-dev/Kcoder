import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewaySessionExpiredError, gatewayRequest } from "./http";
import type { GatewayProfile } from "./types";

const profile: GatewayProfile = {
  id: "gateway",
  label: "Gateway",
  baseUrl: "http://gateway.test",
  accessToken: "session-token",
  expiresAt: Date.now() + 60_000,
  rpcToken: "rpc",
};

afterEach(() => vi.unstubAllGlobals());

describe("Gateway HTTP session", () => {
  it("把服务端提前撤销的 401 标记为需要重新授权", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 401 })));

    await expect(gatewayRequest(profile, "/api/servers")).rejects.toBeInstanceOf(
      GatewaySessionExpiredError,
    );
  });
});
