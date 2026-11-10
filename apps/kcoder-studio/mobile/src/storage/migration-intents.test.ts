import { beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ data: new Map<string, string>(), current: true, inGate: false }));
vi.mock("@react-native-async-storage/async-storage", () => ({ default: { getItem: async (key: string) => state.data.get(key) ?? null, setItem: async (key: string, value: string) => { state.data.set(key, value); } } }));
vi.mock("./workspace-profile-fence", () => ({ captureWorkspaceProfileIdentity: (profile: unknown) => profile, withWorkspaceProfileMetadata: async (_identity: unknown, body: () => Promise<unknown>) => { if (!state.current) throw new Error("profile revoked"); expect(state.inGate).toBe(false); state.inGate = true; try { return await body(); } finally { state.inGate = false; } } }));
import { migrationIntentStore, type MigrationIntent } from "./migration-intents";
import type { GatewayProfile } from "@/gateway/types";
const profile = { id: "selected", baseUrl: "https://selected.invalid", authorizationGeneration: "auth-a" } as GatewayProfile;
const row = (id = "request", phase: MigrationIntent["phase"] = "intent"): MigrationIntent => ({ id, method: "migration/batch/run", createdAt: 1, phase, jobId: "job", planId: "plan", requestId: id, sequence: 2 });
beforeEach(() => { state.data.clear(); state.current = true; state.inGate = false; });
it("retains only receipt coordinates and never accepts a raw RPC body or credential into local persistence", async () => {
  const store = migrationIntentStore(profile, "selected-target", () => true);
  await expect(store.put({ ...row(), params: { apiKey: "SECRET_CANARY" } } as never)).rejects.toThrow("migration_recovery_record_invalid");
  expect(state.data.size).toBe(0);
  await store.put(row());
  expect(await store.read()).toEqual([row()]);
  expect(state.inGate).toBe(false);
});
it("separates account/target scopes and rejects stale authorization before a local read or write", async () => {
  const selected = migrationIntentStore(profile, "target-a:auth-a", () => state.current);
  const other = migrationIntentStore(profile, "target-b:auth-a", () => state.current);
  await selected.put(row());
  expect(await other.read()).toEqual([]);
  state.current = false;
  await expect(selected.read()).rejects.toThrow("profile revoked");
  await expect(selected.put(row("new"))).rejects.toThrow("profile revoked");
});
it("does not replace the original parameters or downgrade a recorded acknowledgement after a delayed error", async () => {
  const store = migrationIntentStore(profile, "scope", () => true);
  await store.put(row());
  await expect(store.put({ ...row(), planId: "different" })).rejects.toThrow("migration_recovery_identity_changed");
  await store.put(row("request", "acknowledged"));
  await store.put(row("request", "unknown"));
  expect((await store.read())[0].phase).toBe("acknowledged");
});
it("bounds the journal without evicting unresolved outcomes, and can retire only settled local locators", async () => {
  const store = migrationIntentStore(profile, "scope", () => true);
  for (let index = 0; index < 64; index++) await store.put(row(`request-${index}`, "unknown"));
  await expect(store.put(row("overflow"))).rejects.toThrow("migration_recovery_records_full");
  expect(await store.read()).toHaveLength(64);
  await store.put(row("request-0", "acknowledged"));
  await store.put(row("explicit-new"));
  const rows = await store.read();
  expect(rows).toHaveLength(64);
  expect(rows.find(value => value.id === "request-0")).toBeUndefined();
  expect(rows.find(value => value.id === "request-1")?.phase).toBe("unknown");
});
it("retains an unknown locator until the user explicitly marks that local locator reviewed, without inventing an acknowledgement", async () => {
  const store = migrationIntentStore(profile, "scope", () => true);
  await store.put(row("original", "unknown"));
  await store.put(row("original", "reviewed"));
  expect((await store.read())[0]).toMatchObject({ phase: "reviewed", requestId: "original", sequence: 2 });
});
it('retains a public memory CAS selector immutably without allowing arbitrary note text', async () => {
  const store = migrationIntentStore(profile, 'memory-scope', () => true);
  const control = { requestId: 'request', id: 'notes', ownerOperationId: 'owned', expectedRevision: 'a'.repeat(64), enabled: true, confirmUnverifiedNotes: true };
  const value: MigrationIntent = { id: 'request', method: 'migration/memory/control', createdAt: 1, phase: 'unknown', requestId: 'request', memoryControl: control };
  await store.put(value);
  expect((await store.read())[0].memoryControl).toEqual(control);
  await expect(store.put({ ...value, memoryControl: { ...control, expectedRevision: 'b'.repeat(64) } })).rejects.toThrow('migration_recovery_identity_changed');
  await expect(store.put({ ...value, memoryControl: { ...control, text: 'PRIVATE_NOTE_BODY' } as never })).rejects.toThrow('migration_recovery_record_invalid');
  await expect(store.put({ ...value, id: 'other' })).rejects.toThrow('migration_recovery_record_invalid');
});
