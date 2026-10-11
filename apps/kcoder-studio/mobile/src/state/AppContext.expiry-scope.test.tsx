// Actual AppProvider callback and actual coordinator with a deterministic hook host.
// No effects are executed: this covers callback/state-updater authority, not mounted UI.
import { beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
const host = vi.hoisted(() => ({
  states: [] as unknown[], refs: [] as { current: unknown }[], setters: [] as ((value: unknown) => void)[],
  stateIndex: 0, refIndex: 0, deferred: false, updates: [] as (() => void)[],
}));
vi.mock("react", async importOriginal => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual,
    useState(initial: unknown) {
      const i = host.stateIndex++;
      if (!(i in host.states)) host.states[i] = typeof initial === "function" ? (initial as () => unknown)() : initial;
      host.setters[i] ??= (value: unknown) => {
        const apply = () => { host.states[i] = typeof value === "function" ? (value as (current: unknown) => unknown)(host.states[i]) : value; };
        if (host.deferred) host.updates.push(apply); else apply();
      };
      return [host.states[i], host.setters[i]];
    },
    useRef(initial: unknown) { return host.refs[host.refIndex++] ??= { current: initial }; },
    useEffect() {}, useCallback: (callback: unknown) => callback, useMemo: (factory: () => unknown) => factory(),
  };
});
vi.mock("react-native", () => ({ AppState: { currentState: "active" }, Platform: { OS: "web" } }));
vi.mock("@/storage/profile-store", () => ({ PROFILE_INDEX_KEY: "index", loadProfiles: vi.fn(), persistProfiles: vi.fn(), migrateLegacyWebProfiles: vi.fn() }));
vi.mock("@/gateway/http", () => ({
  ensureGatewayAuthorization: vi.fn(async () => {}), GatewaySessionExpiredError: class extends Error {} }));
vi.mock("@/runtime/task-runtime", () => ({ taskRuntimeRegistry: {} }));
vi.mock("@/runtime/task-runtime/modelCatalog", () => ({ clearModelCache: vi.fn() }));
vi.mock("@/runtime/task-runtime/workspaces", () => ({ clearWorkspaceOptionsCache: vi.fn() }));
vi.mock("@/storage/workspace-preferences", () => ({ workspaceStateAuthorizationScope: vi.fn() }));
vi.mock("@/storage/thread-deletion-cleanup", () => ({}));
vi.mock("./device-authorization", () => ({ DeviceAuthorizationManager: class {} }));
vi.mock("./profile-connection-effects", () => ({}));
vi.mock("./connect-gateway-profile", () => ({}));
vi.mock("./remove-gateway-profile", () => ({}));
import { AppProvider } from "./AppContext";
import { ProfileCoordinator, profileAuthorizationScopeKey } from "./profile-coordinator";
import { profile } from "@/runtime/task-runtime/fixture.test-support";

function render() {
  host.stateIndex = host.refIndex = 0;
  return (AppProvider({ children: null }) as ReactElement<{ value: {
    markGatewayReauthorizationRequired(id: string, scope?: string): void;
    runtime: { reauthorizationRequired: boolean; error: string | null };
  } }>).props.value;
}
function coordinator() { return host.refs.map(ref => ref.current).find(value => value instanceof ProfileCoordinator) as ProfileCoordinator; }
beforeEach(() => {
  host.states = []; host.refs = []; host.setters = []; host.updates = []; host.deferred = false;
});

it("marks valid same-scope runtime expiry without depending on form ownership", () => {
  const value = render(); const current = { ...profile, authorizationGeneration: "A" };
  coordinator().hydrate({ profiles: [current], activeId: current.id });
  const runtimeCallback = () => value.markGatewayReauthorizationRequired(current.id, profileAuthorizationScopeKey(current));
  // Actual form navigation/unmount is covered in the route consumer test.
  runtimeCallback();
  expect(render().runtime.reauthorizationRequired).toBe(true);
});
it("rejects an old callback after same-id authorization replacement", () => {
  const value = render(); const old = { ...profile, authorizationGeneration: "A" };
  coordinator().hydrate({ profiles: [{ ...old, authorizationGeneration: "B" }], activeId: old.id });
  value.markGatewayReauthorizationRequired(old.id, profileAuthorizationScopeKey(old));
  expect(render().runtime.reauthorizationRequired).toBe(false);
});
it("accepts same-scope expiry across access-token rotation", () => {
  const value = render(); const old = { ...profile, authorizationGeneration: "A" };
  coordinator().hydrate({ profiles: [{ ...old, accessToken: "rotated", expiresAt: old.expiresAt + 1 }], activeId: old.id });
  value.markGatewayReauthorizationRequired(old.id, profileAuthorizationScopeKey(old));
  expect(render().runtime.reauthorizationRequired).toBe(true);
});
it("checks authority again when a previously queued runtime updater executes", () => {
  const value = render(); const old = { ...profile, authorizationGeneration: "A" };
  coordinator().hydrate({ profiles: [old], activeId: old.id });
  host.deferred = true;
  value.markGatewayReauthorizationRequired(old.id, profileAuthorizationScopeKey(old));
  expect(host.updates).toHaveLength(1);
  coordinator().hydrate({ profiles: [{ ...old, authorizationGeneration: "B" }], activeId: old.id });
  host.updates.shift()!(); host.deferred = false;
  expect(render().runtime.reauthorizationRequired).toBe(false);
});
it("preserves legacy id-only callback semantics for the active profile", () => {
  const value = render(); coordinator().hydrate({ profiles: [profile], activeId: profile.id });
  value.markGatewayReauthorizationRequired(profile.id);
  expect(render().runtime.reauthorizationRequired).toBe(true);
});
