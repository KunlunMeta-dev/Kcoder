import { beforeEach, expect, it, vi } from "vitest";
const host = vi.hoisted(() => ({ states: [] as any[], si: 0, task: null as any }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(), useState: (initial: any) => { const index = host.si++; if (!(index in host.states)) host.states[index] = initial; return [host.states[index], (value: any) => { host.states[index] = typeof value === "function" ? value(host.states[index]) : value; }]; } }));
vi.mock("@/theme", () => ({ useThemedStyles: () => ({}) }));
vi.mock("@/i18n", () => ({ t: (key: string) => key }));
vi.mock("@/components/settings/settings-layout", () => ({ SettingsGroup: "section" }));
vi.mock("./useHistoricalWorker", () => ({ useHistoricalWorker: () => host.task }));
vi.mock("./useMigrationHistoryView", () => ({
  useMigrationHistoryView: () => ({ state: "idle", lease: null, error: "", open() {}, release: async () => {} }),
}));
import { MigrationHistoryWorkspace } from "./MigrationHistoryWorkspace";
function walk(node: any, predicate: (node: any) => boolean): any {
  if (!node || typeof node !== "object") return null;
  if (predicate(node)) return node;
  for (const child of [node.props?.children].flat(Infinity)) { const found = walk(child, predicate); if (found) return found; }
  return null;
}
const result = (stage: string, workerState: string | null = "stopped") => ({ job: { jobId: "owned", sequence: 7, stage }, workerRunning: false, workerState });
function render(client: any) { host.si = 0; return MigrationHistoryWorkspace({ client, reader: {} as never, jobId: "owned", onHistory() {} }); }
function button(tree: any, id: string) { return walk(tree, node => node.props?.testID === id); }
beforeEach(() => { host.states = []; host.task = { result: result("planned"), busy: false, error: null, refresh() {}, valid: () => true, perform: async (operation: () => Promise<any>) => { try { await operation(); } catch { /* The hook reports the operation error separately. */ } } }; });
it("unknown ownership disables both new execution and resume without presenting idle as a fact", () => {
  const client = { supports: () => false, supportsCapability: () => true, call: vi.fn() };
  for (const stage of ["planned", "failed"]) {
    host.task.result = result(stage, "unknown"); const tree = render(client);
    expect(button(tree, "migration-history-run").props.disabled).toBe(true);
    expect(button(tree, "migration-history-resume").props.disabled).toBe(true);
    expect(walk(tree, node => node.props?.children === "migration_history.worker_unknown")).not.toBeNull();
    expect(walk(tree, node => node.props?.children === "migration_workbench.worker_idle")).toBeNull();
  }
  expect(client.call).not.toHaveBeenCalled();
});
it("a confirmation opened while stopped cannot execute after a fresh read reports unknown ownership", async () => {
  const call = vi.fn().mockResolvedValue(result("planned", "unknown"));
  const client = { supports: () => false, supportsCapability: () => true, call };
  button(render(client), "migration-history-run").props.onPress();
  await button(render(client), "migration-history-confirm").props.onConfirm();
  await Promise.resolve(); await Promise.resolve();
  expect(call.mock.calls.map(row => row[0])).toEqual(["historyRead"]);
});
it("legacy untracked cancellation admits only a fresh checked Resume, never an automatic Run", async () => {
  const legacy = { ...result("normalizing", "unknown"), workerError: "history_job_execution_untracked", job: { ...result("normalizing").job, cancelRequested: true } };
  host.task.result = legacy;
  const call = vi.fn().mockResolvedValueOnce(legacy).mockResolvedValue(result("normalizing", "stopped"));
  const client = { supports: () => false, supportsCapability: () => true, call };
  const tree = render(client); expect(button(tree, "migration-history-run").props.disabled).toBe(true);
  expect(button(tree, "migration-history-resume").props.disabled).toBe(false);
  expect(button(tree, "migration-history-resume").props.children).toBe("migration_history.recover_legacy");
  button(tree, "migration-history-resume").props.onPress(); await button(render(client), "migration-history-confirm").props.onConfirm();
  for (let i = 0; i < 8; i++) await Promise.resolve();
  expect(call.mock.calls.map(row => row[0])).toEqual(["historyRead", "historyResume"]);
});
it("a previously permitted legacy recovery cannot resume after Native reports another ownership failure", async () => {
  host.task.result = { ...result("normalizing", "unknown"), workerError: "history_job_execution_untracked", job: { ...result("normalizing").job, cancelRequested: true } };
  const call = vi.fn().mockResolvedValue({ ...host.task.result, workerError: "history_job_execution_unknown" });
  const client = { supports: () => false, supportsCapability: () => true, call };
  button(render(client), "migration-history-resume").props.onPress(); await button(render(client), "migration-history-confirm").props.onConfirm();
  for (let i = 0; i < 8; i++) await Promise.resolve();
  expect(call.mock.calls.map(row => row[0])).toEqual(["historyRead"]);
});
it("a completed untracked legacy archive exposes an ownership-only check without cancelling or rerunning its parser", async () => {
  host.task.result = { ...result("normalized", "unknown"), workerError: "history_job_execution_untracked", job: { ...result("normalized").job, cancelRequested: false } };
  const call = vi.fn().mockResolvedValueOnce(host.task.result).mockResolvedValue(result("normalized", "stopped"));
  const client = { supports: () => false, supportsCapability: () => true, call };
  let tree = render(client);
  expect(button(tree, "migration-history-cancel").props.disabled).toBe(true);
  expect(button(tree, "migration-history-run").props.disabled).toBe(true); expect(button(tree, "migration-history-resume").props.disabled).toBe(false);
  expect(button(tree, "migration-history-resume").props.children).toBe("migration_history.check_legacy_completed");
  button(tree, "migration-history-resume").props.onPress(); await button(render(client), "migration-history-confirm").props.onConfirm();
  for (let i = 0; i < 8; i++) await Promise.resolve();
  expect(call.mock.calls.map(row => row[0])).toEqual(["historyRead", "historyResume"]);
  host.task.result = { ...host.task.result, workerState: "stopped", workerError: undefined, job: { ...host.task.result.job, cancelRequested: false } }; tree = render(client);
  expect(button(tree, "migration-history-run").props.disabled).toBe(true); expect(button(tree, "migration-history-resume").props.disabled).toBe(true);
});
it("a Run confirmation cannot rerun a job that became normalized before fresh read", async () => {
  const call = vi.fn().mockResolvedValue(result("normalized", "stopped"));
  const client = { supports: () => false, supportsCapability: () => true, call };
  button(render(client), "migration-history-run").props.onPress(); await button(render(client), "migration-history-confirm").props.onConfirm();
  for (let i = 0; i < 8; i++) await Promise.resolve();
  expect(call.mock.calls.map(row => row[0])).toEqual(["historyRead"]);
});
it.each(["failed", "cancelled"])("untracked %s history exposes explicit recovery without requiring a no-op terminal cancellation", async stage => {
  host.task.result = { ...result(stage, "unknown"), workerError: "history_job_execution_untracked", job: { ...result(stage).job, cancelRequested: false } };
  const call = vi.fn().mockResolvedValueOnce(host.task.result).mockResolvedValue(result(stage, "stopped"));
  const client = { supports: () => false, supportsCapability: () => true, call };
  const tree = render(client);
  expect(button(tree, "migration-history-cancel").props.disabled).toBe(true); expect(button(tree, "migration-history-run").props.disabled).toBe(true);
  expect(button(tree, "migration-history-resume").props.disabled).toBe(false); expect(button(tree, "migration-history-resume").props.children).toBe("migration_history.check_legacy_stopped");
  button(tree, "migration-history-resume").props.onPress(); await button(render(client), "migration-history-confirm").props.onConfirm();
  for (let i = 0; i < 8; i++) await Promise.resolve();
  expect(call.mock.calls.map(row => row[0])).toEqual(["historyRead", "historyResume"]);
});
