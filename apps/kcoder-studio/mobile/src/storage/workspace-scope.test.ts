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
import { MAX_WORKSPACE_AUTHORIZATION_SCOPES, loadWorkspaceState, saveWorkspaceState, removeWorkspaceState, removeWorkspaceStatesForProfile, workspaceStateAuthorizationScope, workspaceStateStorageKey, workspacePreferencesTestHelpers, type WorkspaceViewState } from "./workspace-preferences";
beforeEach(() => { data.clear(); workspacePreferencesTestHelpers.reset(); profileStateRemovalTestHelpers.reset(); });
it("renewal retains drafts while a different principal sees only a retention notice", async () => {
  installBrowserProfileFixture([{ ...profile, authorizationGeneration: "family-a" }]);
  const a = workspaceStateAuthorizationScope({ ...profile, authorizationGeneration: "family-a" }, { ...server, accountIdentity: { principalId: "a", role: "member" } } as typeof server);
  const renewed = workspaceStateAuthorizationScope({ ...profile, authorizationGeneration: "family-a", expiresAt: profile.expiresAt + 1000, accessToken: "new" }, { ...server, accountIdentity: { principalId: "a", role: "member" } } as typeof server);
  const b = workspaceStateAuthorizationScope({ ...profile, authorizationGeneration: "family-a" }, { ...server, accountIdentity: { principalId: "b", role: "member" } } as typeof server);
  expect(renewed).toBe(a); expect(b).not.toBe(a);
  await saveWorkspaceState(profile.id, server.id, "t", {
    activeTab: "files",
    composerDraft: "private-a",
    recentFiles: ["/workspace/src/main.rs"],
    queuedMessages: [{ id: "q", content: "never auto dispatch", attachments: [], createdAt: 1 }],
    panels: [
      { id: "agent", kind: "agent", title: "Agent" },
      { id: "files-1", kind: "files", title: "Files" },
    ],
  }, a);
  expect(await loadWorkspaceState(profile.id, server.id, "t", b)).toEqual({ activeTab: "agent", retainedOtherScopeState: true });
  const restored = await loadWorkspaceState(profile.id, server.id, "t", renewed);
  expect(restored.composerDraft).toBe("private-a");
  expect(restored.recentFiles).toEqual([
    "/workspace/src/main.rs",
  ]);
  expect(await loadWorkspaceState("gateway-b", server.id, "t", renewed)).toEqual({ activeTab: "agent" });
  const otherWorkspace = workspaceStateAuthorizationScope(
    { ...profile, authorizationGeneration: "family-a" },
    { ...server, workspacePath: `${server.workspacePath}/other`, accountIdentity: { principalId: "a", role: "member" } } as typeof server,
  );
  expect(await loadWorkspaceState(profile.id, server.id, "t", otherWorkspace)).toEqual({ activeTab: "agent", retainedOtherScopeState: true });
  const otherTarget = workspaceStateAuthorizationScope(
    { ...profile, authorizationGeneration: "family-a" },
    { ...server, id: "target-b", accountIdentity: { principalId: "a", role: "member" } } as typeof server,
  );
  expect(await loadWorkspaceState(profile.id, "target-b", "t", otherTarget)).toEqual({ activeTab: "agent" });
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

const scopeA = () => workspaceStateAuthorizationScope(profile, { ...server, accountIdentity: { principalId: "a", username: "alice", role: "user" } });
const scopeB = () => workspaceStateAuthorizationScope(profile, { ...server, accountIdentity: { principalId: "b", username: "bob", role: "user" } });

it.each<Array<[string, Partial<WorkspaceViewState>]>[number]>([
  ["model and tabs", { model: "saved-model", activeTab: "files", recentFiles: ["/workspace/a.ts"], panels: [{ id: "agent", kind: "agent", title: "Agent" }] }],
  ["empty drafts", { composerDraft: " \n ", queuedMessages: [], failedSubmissions: [] }],
  ["empty queued messages", { queuedMessages: [{ id: "queued-empty", content: " ", attachments: [], createdAt: 1 }] }],
  ["file placeholders", { fileDraft: { path: "", revision: "", content: "", updatedAt: 1 } }],
  ["non-file panel metadata", { panels: [{ id: "browser-1", kind: "browser", title: "Browser", fileDraft: { path: "/workspace/a.ts", revision: "rev-a", content: "", updatedAt: 1 } }] }],
])("does not call retained %s a draft", async (_name, state) => {
  await saveWorkspaceState(profile.id, server.id, "t", state, scopeA());
  const before = [...data];
  expect(await loadWorkspaceState(profile.id, server.id, "t", scopeB())).toEqual({ activeTab: "agent" });
  expect([...data]).toEqual(before);
});

it.each<Array<[string, Partial<WorkspaceViewState>]>[number]>([
  ["composer draft", { composerDraft: "private draft" }],
  ["queued message", { queuedMessages: [{ id: "queued-one", content: "pending", attachments: [], createdAt: 1 }] }],
  ["attachment-only queued message", { queuedMessages: [{ id: "queued-file", content: "", attachments: [{ filename: "a.txt", mimeType: "text/plain", fileSize: 1, path: "/workspace/a.txt" }], createdAt: 1 }] }],
  ["unknown submission", { failedSubmissions: [{ id: "failed-one", content: "unknown receipt", attachments: [], createdAt: 1, outcome: "unknown" }] }],
  ["file cleared by an edit", { fileDraft: { path: "/workspace/a.ts", revision: "rev-a", content: "", updatedAt: 1 } }],
  ["file panel draft", { panels: [{ id: "files-1", kind: "files", title: "a.ts", fileDraft: { path: "/workspace/a.ts", revision: "rev-a", content: "changed", updatedAt: 1 } }] }],
])("notifies about retained %s without restoring or changing it", async (_name, state) => {
  await saveWorkspaceState(profile.id, server.id, "t", state, scopeA());
  const before = [...data];
  expect(await loadWorkspaceState(profile.id, server.id, "t", scopeB())).toEqual({ activeTab: "agent", retainedOtherScopeState: true });
  expect([...data]).toEqual(before);
});

it.each(["missing", "malformed", "removed"])("ignores a %s retained record without deleting old bytes", async (kind) => {
  await saveWorkspaceState(profile.id, server.id, "t", { composerDraft: "retained" }, scopeA());
  const key = workspaceStateStorageKey(profile.id, server.id, "t", scopeA());
  if (kind === "missing") data.delete(key);
  if (kind === "malformed") data.set(key, "{unreadable");
  if (kind === "removed") data.set(`${key}:removed:v1`, "1");
  const before = [...data];
  expect(await loadWorkspaceState(profile.id, server.id, "t", scopeB())).toEqual({ activeTab: "agent" });
  expect([...data]).toEqual(before);
});

it("only reports real drafts in legacy unscoped state", async () => {
  const key = workspaceStateStorageKey(profile.id, server.id, "t");
  data.set(key, JSON.stringify({ activeTab: "files", model: "old-model" }));
  expect(await loadWorkspaceState(profile.id, server.id, "t", scopeB())).toEqual({ activeTab: "agent" });
  data.set(key, JSON.stringify({ composerDraft: "old private draft" }));
  const before = [...data];
  expect(await loadWorkspaceState(profile.id, server.id, "t", scopeB())).toEqual({ activeTab: "agent", retainedOtherScopeState: true });
  expect([...data]).toEqual(before);
});
