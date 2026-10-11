import { afterEach, expect, it, vi } from "vitest";
import { exchangeMobileSession, exchangeMobileSessionWithBootstrap, parseInitialMobileServers } from "./http";
import { normalizeServer, publicServer } from "../../../src/server-config.js";

vi.mock("@/storage/context-lock", () => ({ canCoordinateDeviceAuthorization: () => false }));
afterEach(() => vi.unstubAllGlobals());

it("accepts the actual publicServer serializer's local and account SSH optional fields", () => {
  const defaults = { repoRoot: "/fixture", appServerBin: "/fixture/kcoder", workspace: "/fixture/work", platform: "linux" };
  const local = publicServer(normalizeServer({ id: "local", label: "Local", labelKey: "currentComputer", transport: "local" }, defaults));
  const ssh = { ...publicServer(normalizeServer({ id: "account", label: "Account", transport: "ssh", host: "fixture.invalid",
    security: { identity: { mode: "kcoder-account", username: "alice" } } }, defaults)),
    authorityId: "1111111111111111", accountIdentity: { principalId: "principal", username: "alice", role: "user" } };
  expect(parseInitialMobileServers({ version: 1, servers: [local, ssh] })).toEqual([local, ssh]);
  expect(parseInitialMobileServers({ version: 1, servers: [] })).toEqual([]);
  for (const seed of [undefined, { version: 2, servers: [local] }, { version: 1, servers: [local, local] },
    { version: 1, servers: [{ ...local, accessToken: "synthetic" }] },
    { version: 1, servers: [{ ...ssh, accountIdentity: { ...ssh.accountIdentity, loginOwner: "synthetic" } }] }]) {
    expect(parseInitialMobileServers(seed)).toBeUndefined();
  }
});

it("old exchange does not opt in or persist seed; bootstrap exchange opts in and returns it separately", async () => {
  const server = { id: "local", label: "Local", description: "Local", runtime: "kcoder", transport: "local" };
  const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ accessToken: "synthetic-session", expiresAt: Date.now() + 60_000,
    capabilities: { mobileInitialServersV1: true }, initialServers: { version: 1, servers: [server] } }),
    { status: 200, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", fetcher); vi.stubGlobal("document", {});
  const old = await exchangeMobileSession("http://gateway.test", "synthetic-token");
  expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body)).requestInitialServers).toBeUndefined();
  expect(old).not.toHaveProperty("initialServers");
  const next = await exchangeMobileSessionWithBootstrap("http://gateway.test", "synthetic-token");
  expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body)).requestInitialServers).toBe(true);
  expect(next.initialServers).toEqual([server]);
  expect(next.profile).not.toHaveProperty("initialServers");
});

it.each([{ initialServers: [] }, { initialServers: undefined }, { initialServers: { version: 2, servers: [] } },
  { initialServers: { version: 1, servers: "bad" } }])("bad or future advertised seed falls back without discarding a valid profile", async ({ initialServers }) => {
  vi.stubGlobal("document", {});
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ accessToken: "synthetic-session", expiresAt: Date.now() + 60_000,
    capabilities: { mobileInitialServersV1: true }, initialServers }), { status: 200 })));
  const result = await exchangeMobileSessionWithBootstrap("http://gateway.test", "synthetic-token");
  expect(result.profile.accessToken).toBe("synthetic-session"); expect(result.initialServers).toBeUndefined();
});
