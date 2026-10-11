import { installBrowserProfileFixture } from "@/test/browser-profile-fixture";
import { beforeEach, expect, it, vi } from "vitest";
const data = vi.hoisted(() => new Map<string, string>());
vi.mock("@react-native-async-storage/async-storage", () => ({ default: {
  getItem: async (key: string) => data.get(key) ?? null,
  setItem: async (key: string, value: string) => { data.set(key, value); },
  removeItem: async (key: string) => { data.delete(key); },
  getAllKeys: async () => [...data.keys()],
  multiRemove: async (keys: string[]) => { keys.forEach(key => data.delete(key)); },
} }));
import { profile, server } from "@/runtime/task-runtime/fixture.test-support";
import { profileStateRemovalTestHelpers } from "./profile-state-removal";
import { MAX_WORKSPACE_AUTHORIZATION_SCOPES, loadWorkspaceState, saveWorkspaceState, removeWorkspaceState, removeWorkspaceStatesForProfile, workspaceStateAuthorizationScope, workspacePreferencesTestHelpers } from "./workspace-preferences";
beforeEach(() => { data.clear(); workspacePreferencesTestHelpers.reset(); profileStateRemovalTestHelpers.reset(); });
it("renewal retains drafts while a different principal sees only a retention notice", async () => {
  installBrowserProfileFixture([{ ...profile, authorizationGeneration: "family-a" }]);
  const a = workspaceStateAuthorizationScope({ ...profile, authorizationGeneration: "family-a" }, { ...server, accountIdentity: { principalId: "a", role: "member" } } as typeof server);
  const renewed = workspaceStateAuthorizationScope({ ...profile, authorizationGeneration: "family-a", expiresAt: profile.expiresAt + 1000, accessToken: "new" }, { ...server, accountIdentity: { principalId: "a", role: "member" } } as typeof server);
  const b = workspaceStateAuthorizationScope({ ...profile, authorizationGeneration: "family-a" }, { ...server, accountIdentity: { principalId: "b", role: "member" } } as typeof server);
  expect(renewed).toBe(a); expect(b).not.toBe(a);
  await saveWorkspaceState(profile.id, server.id, "t", { composerDraft: "private-a", queuedMessages: [{ id: "q", content: "never auto dispatch", attachments: [], createdAt: 1 }] }, a);
  expect(await loadWorkspaceState(profile.id, server.id, "t", b)).toEqual({ activeTab: "agent", retainedOtherScopeState: true });
  expect((await loadWorkspaceState(profile.id, server.id, "t", renewed)).composerDraft).toBe("private-a");
});
it("old-scope cleanup cannot remove a new identity draft; profile cleanup includes all indexes", async () => {
  const a = workspaceStateAuthorizationScope(profile, { ...server, accountIdentity: { principalId: "a", username: "alice", role: "user" } });
  const b = workspaceStateAuthorizationScope(profile, { ...server, accountIdentity: { principalId: "b", username: "bob", role: "user" } });
  await saveWorkspaceState(profile.id, server.id, "t", { composerDraft: "old" }, a);
  await saveWorkspaceState(profile.id, server.id, "t", { composerDraft: "new" }, b);
  await removeWorkspaceState(profile.id, server.id, "t", a);
  expect((await loadWorkspaceState(profile.id, server.id, "t", b)).composerDraft).toBe("new");
  await removeWorkspaceStatesForProfile(profile.id);
  expect(data.size).toBe(0);
});
it("bounds the scope index and preserves every retained scope at capacity", async () => {
  const scope = (n: number) => workspaceStateAuthorizationScope(profile, { ...server, accountIdentity: { principalId: `principal-${n}`, username: `user${n}`, role: "user" } });
  for (let n = 0; n < MAX_WORKSPACE_AUTHORIZATION_SCOPES; n++) await saveWorkspaceState(profile.id, server.id, "t", { composerDraft: `draft${n}` }, scope(n));
  await expect(saveWorkspaceState(profile.id, server.id, "t", { composerDraft: "overflow" }, scope(MAX_WORKSPACE_AUTHORIZATION_SCOPES))).rejects.toThrow("16");
  expect((await loadWorkspaceState(profile.id, server.id, "t", scope(0))).composerDraft).toBe("draft0");
});

beforeEach(() => installBrowserProfileFixture([profile]));
