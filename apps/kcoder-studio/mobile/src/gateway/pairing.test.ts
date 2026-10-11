import { describe, expect, it } from "vitest";
import { pairingRouteFromSystemPath, parsePairingLink } from "./pairing";

function pairingLink(gateway: string, gatewayId?: string): string {
  const metadata = gatewayId ? `&gatewayId=${encodeURIComponent(gatewayId)}` : "";
  return `kcoder-studio://connect?gateway=${encodeURIComponent(gateway)}&token=pair-token${metadata}`;
}

describe("Gateway pairing links", () => {
  it("keeps legacy links and accepts a matching public Gateway route id", () => {
    expect(
      parsePairingLink(pairingLink("https://relay.example/g/a")),
    ).toEqual({ gateway: "https://relay.example/g/a", token: "pair-token" });

    expect(
      parsePairingLink(pairingLink("https://relay.example/g/a", "a")),
    ).toEqual({ gateway: "https://relay.example/g/a", token: "pair-token" });
  });

  it("rejects metadata that does not match the Gateway route", () => {
    expect(() =>
      parsePairingLink(pairingLink("https://relay.example/g/a", "b")),
    ).toThrow("Gateway ID 与地址路径不一致");
  });

  it.each([
    "https://relay.example/g/a/../b",
    "https://relay.example/g/a/%2e%2e/b",
    "https://relay.example/g/a/extra",
    "https://relay.example/g/a?target=b",
  ])("rejects unsafe or extra route components in %s", (gateway) => {
    expect(() => parsePairingLink(pairingLink(gateway, "a"))).toThrow();
  });

  it("preserves the public route metadata while converting a system link", () => {
    const route = pairingRouteFromSystemPath(
      pairingLink("https://relay.example/g/a", "a"),
    );
    const parsed = new URL(route, "https://mobile.invalid");
    expect(parsed.pathname).toBe("/connect");
    expect(parsed.searchParams.get("gateway")).toBe("https://relay.example/g/a");
    expect(parsed.searchParams.get("token")).toBe("pair-token");
    expect(parsed.searchParams.get("gatewayId")).toBe("a");
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
