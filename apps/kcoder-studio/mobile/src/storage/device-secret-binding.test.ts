import { beforeEach, expect, it, vi } from "vitest";
const values = vi.hoisted(() => new Map<string, string>());
vi.mock("./secure", () => ({ getSecureValue: vi.fn(async (key: string) => values.get(key) ?? null), setSecureValue: vi.fn(async (key: string, value: string) => { values.set(key, value); }), deleteSecureValue: vi.fn(async (key: string) => { values.delete(key); }) }));
import { loadProfiles, persistProfiles, PROFILE_INDEX_KEY } from "./profile-store";
import type { GatewayProfile } from "@/gateway/types";
const profile: GatewayProfile = { id: "synthetic", label: "device", baseUrl: "https://relay.example/g/gateway-one", accessToken: "synthetic-access", rpcToken: "synthetic-rpc", expiresAt: 9999999999999, authorizationGeneration: "synthetic-family", deviceId: "synthetic-device", authMode: "device", refreshToken: "a".repeat(64), refreshExpiresAt: 9999999999999, pendingRotationId: "synthetic-rotation-01" };
beforeEach(() => values.clear());
it("keeps refresh credential and pending rotation outside metadata and restores their bound route", async () => {
 await persistProfiles([profile], profile.id); const raw = values.get(PROFILE_INDEX_KEY)!;
 expect(raw).not.toContain(profile.refreshToken); expect(raw).not.toContain(profile.pendingRotationId);
 expect((await loadProfiles()).profiles[0]).toMatchObject(profile);
});
it.each(["baseUrl", "deviceId", "authorizationGeneration"] as const)("does not attach secrets to changed %s metadata", async field => {
 await persistProfiles([profile], profile.id); const index = JSON.parse(values.get(PROFILE_INDEX_KEY)!); index.profiles[0][field] = "changed-identity"; values.set(PROFILE_INDEX_KEY, JSON.stringify(index));
 const loaded = (await loadProfiles()).profiles[0]; expect(loaded.accessToken).toBe(""); expect(loaded.refreshToken).toBeUndefined(); expect(loaded.expiresAt).toBe(0);
});
