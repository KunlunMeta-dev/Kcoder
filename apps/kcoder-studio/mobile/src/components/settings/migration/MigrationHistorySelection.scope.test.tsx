import { beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
const host = vi.hoisted(() => ({ states: [] as any[], refs: [] as any[], effects: [] as any[], si: 0, ri: 0, ei: 0, target: null as any }));
vi.mock("react", async original => {
  const actual = await original<typeof import("react")>();
  return { ...actual,
    useState: (initial: any) => { const index = host.si++; if (!(index in host.states)) host.states[index] = typeof initial === "function" ? initial() : initial; return [host.states[index], (value: any) => { host.states[index] = typeof value === "function" ? value(host.states[index]) : value; }]; },
    useRef: (current: any) => host.refs[host.ri++] ??= { current },
    useEffect: (callback: () => void | (() => void), deps: any[] = []) => { const index = host.ei++, old = host.effects[index]; if (!old || old.deps.length !== deps.length || old.deps.some((value: any, i: number) => value !== deps[i])) { old?.cleanup?.(); host.effects[index] = { callback, deps, pending: true }; } },
  };
});
vi.mock("expo-router", () => ({ useRouter: () => ({ push() {} }), useIsFocused: () => true }));
vi.mock("@/theme", () => ({ useThemedStyles: () => ({}) }));
vi.mock("@/i18n", () => ({ t: (key: string) => key }));
vi.mock("@/i18n/use-locale", () => ({ useLocale() {} }));
vi.mock("@/components/settings/SettingsTargetContext", () => ({ useSettingsTarget: () => host.target }));
vi.mock("@/components/settings/settings-layout", () => ({ SettingsGroup: "section", SettingsRow: "article" }));
vi.mock("@/storage/migration-intents", () => ({ migrationIntentStore: () => ({ read: async () => [], put: async () => {} }) }));
import { MigrationResultsSettings } from "../MigrationResultsSettings";
function target(id: string) { return { ready: true, error: null, targetIdentity: `account:${id}`, profile: { id, baseUrl: `https://${id}.invalid`, authorizationGeneration: id }, serverId: id, workspacePath: "/owned", capabilities: { appServer: { experimental: { migrationBatchV1: true, migrationProvidersV1: true, migrationHistoryJobsV1: true } } }, request: vi.fn(async () => ({})) }; }
function render() { host.si = host.ri = host.ei = 0; return MigrationResultsSettings(); }
function commit() { for (const effect of host.effects) if (effect.pending) { effect.pending = false; effect.cleanup = effect.callback(); } }
function find(node: any, name: string): ReactElement<any> | null {
  if (!node || typeof node !== "object") return null;
  if (node.type?.name === name) return node;
  const children = node.props?.children;
  for (const child of Array.isArray(children) ? children.flat(Infinity) : [children]) { const value = find(child, name); if (value) return value; }
  return null;
}
beforeEach(() => { host.states = []; host.refs = []; host.effects = []; host.target = target("owner-a"); });
it("a selected private history locator cannot be handed to a peer client's history reader", () => {
  render(); commit(); const first = render(), workbench = find(first, "MigrationWorkbench")!;
  workbench.props.onHistory("private-history-a"); expect(find(render(), "MigrationHistoryWorkspace")?.props.jobId).toBe("private-history-a");
  host.target = target("peer-b"); const beforeCommit = render(); expect(find(beforeCommit, "MigrationHistoryWorkspace")).toBeNull(); commit();
  const peer = render(); expect(find(peer, "MigrationHistoryWorkspace")).toBeNull(); expect(find(peer, "MigrationResultsBody")).not.toBeNull();
  expect(host.target.request).not.toHaveBeenCalled();
});
it("an old source selection callback arriving after a target/account change cannot republish its locator", () => {
  render(); commit(); const previous = find(render(), "MigrationWorkbench")!;
  host.target = target("peer-b"); render(); commit(); render();
  previous.props.onHistory("late-private-history-a");
  expect(find(render(), "MigrationHistoryWorkspace")).toBeNull();
});
