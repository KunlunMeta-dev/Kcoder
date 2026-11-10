import { beforeEach, expect, it, vi } from "vitest";
vi.mock("@/components/settings/SettingsTargetContext", () => ({ useSettingsTarget() { throw new Error("Project target selection is outside this non-project fixture"); } }));
const host = vi.hoisted(() => ({ scope: "root", slots: [] as any[], index: 0, parentBusy: false }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(), useState: (initial: any) => [host.scope === "child" ? host.slots[host.index++] ?? initial : initial, () => {}], useRef: (current: any) => ({ current }), useEffect() {} }));
vi.mock("@/theme", () => ({ useThemedStyles: () => ({}) }));
vi.mock("@/i18n", () => ({ t: (key: string) => key }));
vi.mock("@/components/settings/settings-layout", () => ({ SettingsGroup: "section" }));
vi.mock("./useMigrationAction", () => ({ useMigrationAction: (client: any) => ({ busy: host.scope === "root" && host.parentBusy, error: null, run: async (operation: () => Promise<any>, accepted: (result: any) => void = () => {}) => { try { const result = await operation(); if (client.available()) accepted(result); } catch { /* The real hook exposes errors without accepting the result. */ } } }) }));
import { MigrationBatchOperation } from "./MigrationBatchOperation";
function walk(node: any, predicate: (node: any) => boolean): any { if (!node || typeof node !== "object") return null; if (predicate(node)) return node; for (const child of [node.props?.children].flat(Infinity)) { const found = walk(child, predicate); if (found) return found; } return null; }
function button(client: any, onHistory: (id: string) => void) {
  host.scope = "root";
  const root = MigrationBatchOperation({ client, job: { job: { jobId: "parent", sequence: 0, status: "ready" }, issues: [] } as never, onEdit() {}, onHistory });
  const child = walk(root, node => node.type?.name === "BatchItems")!;
  host.scope = "child"; host.index = 0;
  const tree = child.type(child.props);
  return walk(tree, node => node.props?.testID === "migration-open-history-item");
}
const settle = async () => { for (let index = 0; index < 8; index++) await Promise.resolve(); };
beforeEach(() => { host.parentBusy = false; host.slots = [0, { items: [{ id: "item", sourceName: "Owned", status: "pending", issues: [] }], planned: [{ itemId: "item", historyJobId: "reserved-child" }] }, null]; });
it("a reserved child identifier cannot navigate before an authoritative history read acknowledges the actual job", async () => {
  let resolve!: (value: any) => void; const pending = new Promise(yes => { resolve = yes; });
  const call = vi.fn(() => pending), onHistory = vi.fn(), client = { call, available: () => true };
  button(client, onHistory).props.onPress(); expect(onHistory).not.toHaveBeenCalled();
  expect(call).toHaveBeenCalledWith("historyRead", { jobId: "reserved-child" });
  resolve({ job: { jobId: "reserved-child" }, workerRunning: true }); await settle(); expect(onHistory).toHaveBeenCalledExactlyOnceWith("reserved-child");
});
it("a not-yet-created child or late account completion stays on the parent page", async () => {
  const onHistory = vi.fn(), call = vi.fn().mockRejectedValue(new Error("history_job_not_found")), client = { call, available: () => true };
  button(client, onHistory).props.onPress(); await settle(); expect(onHistory).not.toHaveBeenCalled();
  let current = true, resolve!: (value: any) => void; call.mockReturnValue(new Promise(yes => { resolve = yes; }));
  button({ call, available: () => current }, onHistory).props.onPress(); current = false; resolve({ job: { jobId: "reserved-child" } }); await settle(); expect(onHistory).not.toHaveBeenCalled();
});
it("parent mutations disable the child reader even when the child has no pending request", () => {
  host.parentBusy = true; const call = vi.fn(), onHistory = vi.fn();
  expect(button({ call, available: () => true }, onHistory).props.disabled).toBe(true); expect(call).not.toHaveBeenCalled();
});

it("completed records retain a capability-gated instruction preview bound to the original job and item", () => {
  const call = vi.fn(), client = { call, available: () => true, supports: (name: string) => name === "instructionBody" };
  host.slots = [0, { items: [{ id: "original-instruction", category: "instructions", sourceName: "Captured instructions", status: "committed", issues: [] }] }, null];
  host.scope = "root";
  const root = MigrationBatchOperation({ client: client as never, job: { job: { jobId: "saved-original", sequence: 9, status: "completed" }, issues: [] } as never, onEdit() {}, onHistory() {} });
  const child = walk(root, node => node.type?.name === "BatchItems")!;
  host.scope = "child"; host.index = 0;
  const preview = walk(child.type(child.props), node => node.type?.name === "MigrationJobInstructionPreview");
  expect(preview.props.jobId).toBe("saved-original"); expect(preview.props.itemId).toBe("original-instruction");
  expect(preview.props.client).toBe(client); expect(call).not.toHaveBeenCalled();
  host.index = 0;
  expect(walk(child.type({ ...child.props, client: { ...client, supports: () => false } }), node => node.type?.name === "MigrationJobInstructionPreview")).toBeNull();
});
