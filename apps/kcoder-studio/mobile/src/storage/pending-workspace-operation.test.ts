import { installBrowserProfileFixture } from "@/test/browser-profile-fixture";
// Model-independent durable operation identity and ambiguous creation recovery.
import { beforeEach, afterEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => new Map<string, string>());
vi.mock("@react-native-async-storage/async-storage", () => ({ default: {
 getItem: vi.fn(async (key: string) => state.get(key) ?? null), setItem: vi.fn(async (key: string, value: string) => { state.set(key, value); }), removeItem: vi.fn(async (key: string) => { state.delete(key); }),
} }));
import { MobileRpcError } from "@/gateway/rpc";
import { recoverableWorkspaceOperation } from "./pending-workspace-operation";
import { profile, server } from "@/runtime/task-runtime/fixture.test-support";
afterEach(() => state.clear());
it("retains stable worktree ID after unknown reply and reload checks instead of creating again", async () => {
 const ids: string[] = []; const mutate = vi.fn(async (id: string) => { ids.push(id); throw new MobileRpcError("lost ACK"); });
 const readback = vi.fn(async (id: string) => { ids.push(id); return undefined as string | undefined; });
 const input = { profile, server, path: "/workspace", kind: "worktree" as const, intent: "same", mutate, readback };
 await expect(recoverableWorkspaceOperation(input)).rejects.toThrow("结果仍未知");
 await expect(recoverableWorkspaceOperation({ ...input, profile: { ...profile, expiresAt: profile.expiresAt + 1 } })).rejects.toThrow("结果仍未知");
 expect(mutate).toHaveBeenCalledOnce(); expect(new Set(ids).size).toBe(1);
 readback.mockResolvedValue("/workspace/created");
 expect(await recoverableWorkspaceOperation(input)).toBe("/workspace/created"); expect(state.size).toBe(1); expect(JSON.parse([...state.values()][0]!)).toMatchObject({ result: "/workspace/created" });
});
it("remote mutation failure after reservation retains the same uncertain ID", async () => {
 const ids: string[] = [];
 const mutate = vi.fn(async (id: string) => { ids.push(id); throw new MobileRpcError("mkdir completed but registry failed", -32602, "remote"); });
 const readback = vi.fn(async (id: string) => { ids.push(id); return undefined; });
 const input = { profile, server, path: "/partial", kind: "create" as const, intent: "partial", mutate, readback };
 await expect(recoverableWorkspaceOperation(input)).rejects.toThrow("结果仍未知");
 await expect(recoverableWorkspaceOperation({ ...input, newIntent: true })).rejects.toThrow("结果仍未知");
 expect(mutate).toHaveBeenCalledOnce(); expect(new Set(ids).size).toBe(1);
});
it("an authoritative missing receipt after definite invalid-input rejection releases the local gate", async () => {
 const mutate = vi.fn(async () => { throw new MobileRpcError("invalid path", -32602, "remote"); });
 await expect(recoverableWorkspaceOperation({ profile, server, path: "/invalid", kind: "create", intent: "invalid", mutate, readback: async () => null })).rejects.toThrow("invalid path");
 expect(state.size).toBe(0);
});

beforeEach(() => installBrowserProfileFixture([profile]));
