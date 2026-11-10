import { afterEach, expect, it, vi } from "vitest";
import { observeWorkspaceCwd, workspaceObservationPath, WORKSPACE_CWD_REQUEST_TIMEOUT_MS } from "./workspace-cwd-observation";
import { parseInitialMobileServers } from "./http";
import { profile as originalProfile, server as originalServer } from "@/runtime/task-runtime/fixture.test-support";
import { probeWorkspacePresence } from "@/runtime/task-runtime/workspace-presence";
import { createSessionTranscriptStore } from "@/storage/session-transcript-store";

const identity = "a".repeat(64);
const profile = { ...originalProfile, baseUrl: "https://gateway.test/g/route", authorizationGeneration: "grant" };
const server = { ...originalServer, observationTargetIdentity: identity };
const body = { authorized: true, version: 1, targetId: server.id, targetSignature: identity,
  workspacePath: "/workspace", loginGeneration: 3, observedAt: 123, status: "absent" };
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const request = (overrides: Partial<Parameters<typeof observeWorkspaceCwd>[0]> = {}) => observeWorkspaceCwd({ profile,
  server, cwd: "/workspace", isCurrent: () => true, ...overrides });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

it("uses the same-origin Gateway route and the exact opaque target precondition", async () => {
  const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response(body)); vi.stubGlobal("fetch", fetcher);
  expect(await request()).toMatchObject({ status: "absent", targetSignature: identity, workspacePath: "/workspace" });
  const url = new URL(String(fetcher.mock.calls[0][0]));
  expect(url.pathname).toBe("/g/route/api/servers/local/cwd-observation");
  expect(url.searchParams.getAll("expectedTargetIdentity")).toEqual([identity]);
  expect(url.searchParams.get("workspace")).toBe("/workspace");
  expect(url.toString()).not.toContain(profile.accessToken);
});

it.each(["version", "targetId", "targetSignature", "workspacePath", "loginGeneration", "authorized", "observedAt", "reason"])(
  "rejects a response with a mismatched %s", async field => {
    vi.stubGlobal("fetch", vi.fn(async () => response({ ...body, [field]: field === "version" ? 2 : "mismatch" })));
    expect(await request()).toMatchObject({ status: "unknown" });
  });

it.each([404, 500])("HTTP %s never means workspace absence", async status => {
  vi.stubGlobal("fetch", vi.fn(async () => response({ error: "unavailable" }, status)));
  expect(await request()).toMatchObject({ status: "unknown" });
});

it("network errors, unknown states, and missing target identity preserve uncertainty", async () => {
  const fetcher = vi.fn().mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce(response({ ...body, status: "unknown", reason: "parent_missing" }));
  vi.stubGlobal("fetch", fetcher);
  expect(await request()).toMatchObject({ status: "unknown" });
  expect(await request()).toMatchObject({ status: "unknown", reason: "parent_missing" });
  expect(await request({ server: { ...server, observationTargetIdentity: undefined } })).toMatchObject({ status: "unknown", reason: "unbound_target" });
  expect(await request({ server: { ...server, transport: "ssh" } })).toMatchObject({ status: "unknown", reason: "unsupported_transport" });
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it.each(["owner", "grant", "target"])("a late response cannot bind after %s changes", async kind => {
  let release!: (value: Response) => void, current = true;
  const mutableProfile = { ...profile }, mutableServer = { ...server };
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(resolve => { release = resolve; })));
  const pending = request({ profile: mutableProfile, server: mutableServer, isCurrent: () => current });
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  if (kind === "owner") current = false;
  if (kind === "grant") mutableProfile.authorizationGeneration = "other";
  if (kind === "target") mutableServer.observationTargetIdentity = "b".repeat(64);
  release(response(body)); expect(await pending).toMatchObject({ status: "unknown" });
});

it.each(["timeout", "caller"])("a hung request is bounded by %s using portable abort signals", async kind => {
  vi.useFakeTimers();
  const caller = new AbortController(); let signal!: AbortSignal;
  vi.stubGlobal("fetch", vi.fn((_url, init) => { signal = init.signal; return new Promise<Response>(() => {}); }));
  const pending = request({ signal: caller.signal });
  await Promise.resolve(); await Promise.resolve();
  if (kind === "caller") caller.abort();
  else await vi.advanceTimersByTimeAsync(WORKSPACE_CWD_REQUEST_TIMEOUT_MS);
  expect(await pending).toMatchObject({ status: "unknown" }); expect(signal.aborted).toBe(true);
});

it("normalizes response separator spelling and preserves absolute drive roots", async () => {
  expect(workspaceObservationPath("C:/")).toBe("C:/"); expect(workspaceObservationPath("C:\\")).toBe("C:/");
  expect(workspaceObservationPath("/parent/../child")).toBeNull();
  const fetcher = vi.fn(async () => response({ ...body, workspacePath: "C:\\Users\\me\\workspace" }));
  vi.stubGlobal("fetch", fetcher);
  expect(await request({ cwd: "C:/Users/me/workspace" })).toMatchObject({ status: "absent", workspacePath: "C:/Users/me/workspace" });
});

it.each(["C:\\Users\\me\\workspace", "C:\\"])("binds an actual Windows route through scope capture, HTTP and the prefix probe (%s)", async cwd => {
  const target = { ...server, workspacePath: cwd };
  const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response({ ...body, workspacePath: cwd }));
  vi.stubGlobal("fetch", fetcher);
  let manifest: string | null = null;
  const cache = createSessionTranscriptStore({ readManifest: async () => manifest, readEntry: async () => null,
    reset: async raw => { manifest = raw; }, commit: async change => { manifest = change.manifest; } },
  async (_owner, operation) => operation());
  const observation = await probeWorkspacePresence({ profile, server: target, cwd, threadId: "windows-thread",
    isCurrentOwner: () => true }, cache);
  expect(observation?.result.status).toBe("absent");
  expect(observation?.scope.cwd).toBe(cwd); expect(observation?.witness?.lease.scope.cwd).toBe(cwd);
  expect(new URL(String(fetcher.mock.calls[0]?.[0])).searchParams.get("workspace")).toBe(cwd.replace(/\\/g, "/"));
});

it("does not turn a literal POSIX backslash into a different observed directory", async () => {
  const cwd = "/workspace/part\\name";
  expect(workspaceObservationPath(cwd)).toBe(cwd);
  const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response({ ...body, workspacePath: cwd }));
  vi.stubGlobal("fetch", fetcher);
  expect(await request({ cwd })).toMatchObject({ status: "absent", workspacePath: cwd });
  expect(new URL(String(fetcher.mock.calls[0]?.[0])).searchParams.get("workspace")).toBe(cwd);
});

it("bootstrap accepts the opaque identity but rejects malformed or secret-shaped additions", () => {
  expect(parseInitialMobileServers({ version: 1, servers: [server] })).toEqual([server]);
  expect(parseInitialMobileServers({ version: 1, servers: [{ ...server, observationTargetIdentity: "bad" }] })).toBeUndefined();
  expect(parseInitialMobileServers({ version: 1, servers: [{ ...server, loginOwner: "private" }] })).toBeUndefined();
});
