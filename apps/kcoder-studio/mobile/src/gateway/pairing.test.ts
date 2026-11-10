import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { pairingRouteFromSystemPath, parsePairingLink, MAX_PAIRING_LINK_LENGTH } from "./pairing";

const publicKey = "ab".repeat(32);
const descriptorId = createHash("sha256").update(Buffer.from(publicKey, "hex")).digest("hex");
const connectionRoutes = {
  version: 1 as const,
  gatewayId: descriptorId,
  publicKey,
  endpoints: [
    { kind: "public" as const, url: "https://alternate-relay.example/g/tenant-a" },
    { kind: "public" as const, url: "https://relay.example/g/a" },
  ],
};

function pairingLink(gateway: string, gatewayId?: string, routes?: unknown): string {
  const link = new URL("kcoder-studio://connect");
  link.searchParams.set("gateway", gateway);
  link.searchParams.set("token", "pair-token");
  if (gatewayId) link.searchParams.set("gatewayId", gatewayId);
  if (routes) link.searchParams.set("routes", JSON.stringify(routes));
  return link.toString();
}

describe("Gateway pairing links", () => {
  it("keeps legacy links and accepts a matching public Gateway route id", () => {
    expect(parsePairingLink(pairingLink("https://relay.example/g/a"))).toEqual({
      gateway: "https://relay.example/g/a",
      token: "pair-token",
    });

    expect(parsePairingLink(pairingLink("https://relay.example/g/a", "a"))).toEqual({
      gateway: "https://relay.example/g/a",
      token: "pair-token",
    });
  });

  it("accepts a dual-address descriptor when the QR Gateway is one of its canonical candidates", () => {
    const parsed = parsePairingLink(pairingLink("https://relay.example/g/a", "a", connectionRoutes));
    expect(parsed.connectionRoutes).toEqual(connectionRoutes);
    // The Relay route ID in the query remains distinct from the descriptor's public-key identity.
    expect(new URL(pairingLink("https://relay.example/g/a", "a", connectionRoutes)).searchParams.get("gatewayId"))
      .toBe("a");
    expect(parsed.connectionRoutes?.gatewayId).toBe(descriptorId);
  });

  it("rejects metadata that does not match the Gateway route", () => {
    expect(() =>
      parsePairingLink(pairingLink("https://relay.example/g/a", "b")),
    ).toThrow("Gateway ID 与地址路径不一致");
  });

  it.each([
    ["malformed public key", { ...connectionRoutes, publicKey: "ab".repeat(31) }],
    ["malformed descriptor id", { ...connectionRoutes, gatewayId: "not-a-sha256-id" }],
  ])("rejects a descriptor with %s", (_label, routes) => {
    expect(() => parsePairingLink(pairingLink("https://relay.example/g/a", "a", routes))).toThrow();
  });

  it("rejects a valid descriptor that does not advertise the QR Gateway candidate", () => {
    const routes = {
      ...connectionRoutes,
      endpoints: [{ kind: "public" as const, url: "https://other.example/g/a" }],
    };
    expect(() => parsePairingLink(pairingLink("https://relay.example/g/a", "a", routes)))
      .toThrow("连接路由与 Gateway 地址不一致");
  });

  it("rejects repeated routes and links beyond the bounded QR URL size", () => {
    const once = new URL(pairingLink("https://relay.example/g/a", "a", connectionRoutes));
    once.searchParams.append("routes", JSON.stringify(connectionRoutes));
    expect(() => parsePairingLink(once.toString())).toThrow("连接路由无效");
    expect(() => parsePairingLink(`kcoder-studio://connect?${"x".repeat(MAX_PAIRING_LINK_LENGTH)}`))
      .toThrow("配对链接过长");
  });

  it.each([
    "https://relay.example/g/a/../b",
    "https://relay.example/g/a/%2e%2e/b",
    "https://relay.example/g/a/extra",
    "https://relay.example/g/a?target=b",
  ])("rejects unsafe or extra route components in %s", (gateway) => {
    expect(() => parsePairingLink(pairingLink(gateway, "a"))).toThrow();
  });

  it("preserves Relay metadata and the connection descriptor while converting a system link", () => {
    const route = pairingRouteFromSystemPath(
      pairingLink("https://relay.example/g/a", "a", connectionRoutes),
    );
    const parsed = new URL(route, "https://mobile.invalid");
    expect(parsed.pathname).toBe("/connect");
    expect(parsed.searchParams.get("gateway")).toBe("https://relay.example/g/a");
    expect(parsed.searchParams.get("token")).toBe("pair-token");
    expect(parsed.searchParams.get("gatewayId")).toBe("a");
    expect(JSON.parse(parsed.searchParams.get("routes")!)).toEqual(connectionRoutes);
  });

  it("preserves unrelated system routes and rejects invalid pairing routes", () => {
    expect(pairingRouteFromSystemPath("/settings?tab=network")).toBe(
      "/settings?tab=network",
    );
    expect(
      pairingRouteFromSystemPath(
        pairingLink("https://relay.example/g/a", "b"),
      ),
    ).toBe("/welcome?pairingError=invalid");
  });
});
