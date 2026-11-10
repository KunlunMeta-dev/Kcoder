import { expect, it, vi } from "vitest";
import type { MetadataAuthority } from "./metadata-authority";
const storage = vi.hoisted(() => ({ writes: vi.fn(), values: new Map<string, string>() }));
vi.mock("@react-native-async-storage/async-storage", () => ({ default: {
  getItem: async (key: string) => storage.values.get(key) ?? null,
  setItem: async (key: string, value: string) => { storage.writes(key, value); storage.values.set(key, value); },
} }));
import { metadataStorage } from "./metadata-authority";

// Deterministic dispatch-boundary fixture; real UA task ownership is covered by the registered HTTP suite.
function queuedAuthority() {
  let active = true, flush: (() => void) | undefined;
  const authority: MetadataAuthority = { key: "owned-profile-index", assert() { if (!active) throw new Error("revoked"); }, onRevoke() { return () => {}; },
    effect<T>(operation: () => T): Promise<T> { return new Promise((resolve, reject) => { flush = () => { try { authority.assert(); resolve(operation()); } catch (error) { reject(error); } }; }); },
  };
  return { authority, flush: () => flush!(), revoke: () => { active = false; } };
}
it("checks the caller scope inside the queued effect before dispatching persistent bytes", async () => {
  storage.values.clear(); storage.writes.mockClear(); const q = queuedAuthority(); let current = true;
  const write = metadataStorage(q.authority, () => { if (!current) throw new Error("scope changed"); }).setItem("owned-key", "owned-value");
  const outcome = write.then(() => null, error => error);
  current = false; q.flush(); expect(await outcome).toBeInstanceOf(Error); expect(storage.writes).not.toHaveBeenCalled();
});
it("a revoked metadata owner cannot write after another scope has become current", async () => {
  storage.values.clear(); storage.writes.mockClear(); const q = queuedAuthority();
  const write = metadataStorage(q.authority).setItem("owned-key", "old-value"); const outcome = write.then(() => null, error => error);
  q.revoke(); storage.values.set("owned-key", "new-owner-value"); q.flush();
  expect(await outcome).toBeInstanceOf(Error); expect(storage.values.get("owned-key")).toBe("new-owner-value"); expect(storage.writes).not.toHaveBeenCalled();
});
