import { beforeEach, expect, it, vi } from "vitest";
import type { MobileMigrationClient } from "@/runtime/migration-client";
const host = vi.hoisted(() => ({ states: [] as any[], refs: [] as any[], memos: [] as any[], si: 0, ri: 0, mi: 0, calls: [] as any[], page: null as any }));
vi.mock("react", async original => {
  const actual = await original<typeof import("react")>();
  return { ...actual,
    useState: (initial: any) => { const index = host.si++; if (!(index in host.states)) host.states[index] = typeof initial === "function" ? initial() : initial; return [host.states[index], (value: any) => { host.states[index] = typeof value === "function" ? value(host.states[index]) : value; }]; },
    useRef: (current: any) => host.refs[host.ri++] ??= { current },
    useMemo: (factory: () => any, deps: any[]) => { const index = host.mi++, old = host.memos[index]; if (old && old.deps.length === deps.length && old.deps.every((value: any, i: number) => value === deps[i])) return old.value; const value = factory(); host.memos[index] = { deps, value }; return value; },
  };
});
vi.mock("@/i18n", () => ({ t: (key: string) => key }));
vi.mock("@/theme", () => ({ useThemedStyles: () => ({}) }));
vi.mock("@/components/settings/settings-layout", () => ({ SettingsGroup: "section", SettingsRow: "article" }));
vi.mock("./useHistoricalRead", () => ({ useHistoricalRead: (_client: unknown, name: string, params: unknown, enabled: boolean) => { host.calls.push({ name, params, enabled }); return { result: enabled ? host.page : null, loading: false, error: null }; } }));
import { MigrationHistorySearch } from "./MigrationHistorySearch";
const client = { available: () => true, supports: () => true } as unknown as MobileMigrationClient;
const hit = { position: 4, record: 15, role: "user", block: { index: 2, kind: "text", bodyAvailable: true, sourceBytes: 100 }, before: "before ", matched: "Needle", after: " after", bodyCursor: "signed-body" };
function render(jobId = "history-a", viewId?: string, owner = client) { host.si = host.ri = host.mi = 0; return MigrationHistorySearch({ client: owner, jobId, viewId }); }
function find(node: any, id: string): any {
  if (!node || typeof node !== "object") return null;
  if (node.props?.testID === id || node.type?.name === id) return node;
  const children = node.props?.children;
  for (const child of Array.isArray(children) ? children.flat(Infinity) : [children]) { const value = find(child, id); if (value) return value; } return null;
}
function submit(text: string) { find(render(), "migration-search-query").props.onChangeText(text); find(render(), "migration-search-submit").props.onPress(); return render(); }
beforeEach(() => { host.states = []; host.refs = []; host.memos = []; host.calls = []; host.page = { items: [hit], scannedRecords: 8, totalRecords: 12, processedBytes: 1024, excludedBlocks: 0, unsupportedBlocks: 0, nextCursor: "signed-next" }; });
it("opening and typing dispatch no search; submission fixes the literal query and resets the ephemeral cursor", () => {
  let tree = render(); expect(host.calls.at(-1).enabled).toBe(false);
  find(tree, "migration-search-query").props.onChangeText(" Needle "); tree = render(); expect(host.calls.at(-1).enabled).toBe(false);
  find(tree, "migration-search-submit").props.onPress(); render(); expect(host.calls.at(-1)).toMatchObject({ enabled: true, params: { query: " Needle ", caseSensitive: false, cursor: null, limit: 10 } });
});
it("old hit and page callbacks cannot attach a prior query's bodyCursor or nextCursor to a newly submitted query", () => {
  const previous = submit("old query"), oldHit = find(previous, "migration-search-hit-0"), oldPage = find(previous, "PageControls");
  submit("new query"); oldHit.props.onPress(); oldPage.props.onNext(); const tree = render();
  expect(find(tree, "SearchBody")).toBeNull(); expect(host.calls.at(-1).params).toMatchObject({ query: "new query", cursor: null });
  find(tree, "migration-search-hit-0").props.onPress(); expect(find(render(), "SearchBody")?.props.hit.bodyCursor).toBe("signed-body");
});
it("changing branch/account owner masks all old results and prevents a queued old hit callback before effects run", () => {
  const previous = submit("Needle"), oldHit = find(previous, "migration-search-hit-0");
  let current = render("history-b", "branch-b"); expect(find(current, "migration-search-results")).toBeNull(); expect(host.calls.at(-1).enabled).toBe(false);
  oldHit.props.onPress(); current = render("history-b", "branch-b"); expect(find(current, "SearchBody")).toBeNull();
  current = render("history-a", undefined, { ...client, available: () => true } as MobileMigrationClient); expect(find(current, "migration-search-results")).toBeNull();
});
it("case changes take effect only on explicit submit and clear the old page's signed cursor", () => {
  let tree = submit("Needle"); find(tree, "PageControls").props.onNext(); tree = render(); expect(host.calls.at(-1).params.cursor).toBe("signed-next");
  find(tree, "migration-search-case").props.onPress(); tree = render(); expect(host.calls.at(-1).params.caseSensitive).toBe(false);
  find(tree, "migration-search-submit").props.onPress(); render(); expect(host.calls.at(-1).params).toMatchObject({ caseSensitive: true, cursor: null });
});
