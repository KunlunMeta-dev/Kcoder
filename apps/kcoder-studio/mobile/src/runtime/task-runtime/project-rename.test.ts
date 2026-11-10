import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { GatewayProfile, KCoderServer } from "@/gateway/types";
import { installBrowserProfileFixture } from "@/test/browser-profile-fixture";
import { projectNameValidation } from "@/protocol/project-display-name";
import { taskRuntimeTestHelpers } from "./connectionFactory";
import { renameRuntimeProject } from "./project-rename";

vi.mock("@react-native-async-storage/async-storage", () => ({ default: { getItem: async () => null } }));
const profile: GatewayProfile = { id: "rename-owner", baseUrl: "https://synthetic.test", label: "Owner", accessToken: "token", rpcToken: "rpc", expiresAt: Number.MAX_SAFE_INTEGER, authorizationGeneration: "family", deviceId: "device" };
const server: KCoderServer = { id: "target", label: "Target", runtime: "kcoder", transport: "local", description: "", workspacePath: "/repo" };
const project = { projectKey: "runtime-target:target", workspacePath: "/repo", rootProject: false };
type Row = Record<string, unknown>;
let displayName: string;
let loseReceipt: boolean;
let denyWrite: boolean;
let partialRead: boolean;
let calls: Array<{ method: string; params: Row; server: KCoderServer; profile: GatewayProfile }>;
let closed: number;
let beforeConnect: (() => void) | undefined;
let heldReceipt: Promise<unknown> | undefined;
beforeEach(() => {
  installBrowserProfileFixture([profile]);
  displayName = "Original"; loseReceipt = false; denyWrite = false; partialRead = false; calls = []; closed = 0; beforeConnect = undefined; heldReceipt = undefined;
  taskRuntimeTestHelpers.setConnector((async (owner: GatewayProfile, target: KCoderServer) => {
    beforeConnect?.();
    return {
      close: () => { closed++; },
      async request<T>(method: string, params: Row): Promise<T> {
        calls.push({ method, params, server: target, profile: owner });
        if (method === "runtime.workspaces.rename") {
          if (denyWrite) throw new Error("synthetic write denied");
          displayName = String(params.name);
          if (heldReceipt) return await heldReceipt as T;
          if (loseReceipt) throw new Error("receipt lost after commit");
          return { success: true, accepted: true } as T;
        }
        if (method === "runtime.workspaces.list") return { rootProjectPinned: true, items: ["/repo", "/tools"].map((workspacePath, index) => ({ workspacePath, projectKey: project.projectKey, projectName: partialRead && index ? "Unchanged" : displayName, projectPinned: false, projectPinnedOrder: null })) } as T;
        throw new Error("unexpected RPC");
      },
    };
  }) as never);
});
afterEach(() => { taskRuntimeTestHelpers.resetConnector(); });

it("renames all registry roots with a colliding root-like key without changing directories or pin state", async () => {
  await expect(renameRuntimeProject(profile, server, project, "  新项目  ", () => true)).resolves.toEqual({ name: "新项目" });
  expect(calls.map(call => call.method)).toEqual(["runtime.workspaces.rename", "runtime.workspaces.list"]);
  expect(calls[0]).toMatchObject({ server, profile, params: { deviceId: "target", projectKey: "runtime-target:target", workspacePath: "/repo", runtime: "kcoder", name: "新项目" } });
  expect(calls[0]?.params.rootProject).toBeUndefined();
  expect(calls[0]?.params.pinned).toBeUndefined();
  expect(closed).toBe(1);
});

it("reads back a lost receipt once without replaying the rename", async () => {
  loseReceipt = true;
  await expect(renameRuntimeProject(profile, server, project, "Renamed", () => true)).resolves.toEqual({ name: "Renamed" });
  expect(calls.filter(call => call.method === "runtime.workspaces.rename")).toHaveLength(1);
  expect(calls.filter(call => call.method === "runtime.workspaces.list")).toHaveLength(1);
  expect(closed).toBe(2);
});

it("requires every registered root to confirm the new name and preserves diagnostic causes for failed writes", async () => {
  partialRead = true;
  await expect(renameRuntimeProject(profile, server, project, "Renamed", () => true)).rejects.toMatchObject({ name: "ProjectRenameReconciliationError", stage: "readback" });
  expect(calls.filter(call => call.method === "runtime.workspaces.rename")).toHaveLength(1);
  partialRead = false; denyWrite = true;
  await expect(renameRuntimeProject(profile, server, project, "Retry name", () => true)).rejects.toMatchObject({ stage: "write", cause: { message: "synthetic write denied" } });
  denyWrite = false;
  await expect(renameRuntimeProject(profile, server, project, "Retry name", () => true)).resolves.toEqual({ name: "Retry name" });
});

it("does not send under a replaced authorization or an offline start gate", async () => {
  installBrowserProfileFixture([{ ...profile, authorizationGeneration: "replacement" }]);
  await expect(renameRuntimeProject(profile, server, project, "Name", () => true)).rejects.toThrow();
  expect(calls).toEqual([]);
  installBrowserProfileFixture([profile]);
  let online = true;
  beforeConnect = () => { online = false; };
  await expect(renameRuntimeProject(profile, server, project, "Name", () => true, () => online)).rejects.toThrow();
  expect(calls).toEqual([]);
});

it("does not read or publish a late receipt once its interaction owner changes", async () => {
  let current = true;
  let resolve!: (value: unknown) => void;
  heldReceipt = new Promise(done => { resolve = done; });
  const pending = renameRuntimeProject(profile, server, project, "Name", () => current);
  const rejected = expect(pending).rejects.toThrow();
  await vi.waitFor(() => expect(calls).toHaveLength(1));
  current = false; resolve({ success: true, accepted: true });
  await rejected;
  expect(calls.filter(call => call.method === "runtime.workspaces.list")).toEqual([]);
  expect(closed).toBe(1);
});

it("validates trimmed names by UTF-8 bytes and rejects synthetic roots without dispatch", async () => {
  expect(projectNameValidation("   ")).toBe("empty");
  expect(projectNameValidation("中".repeat(85))).toBeNull();
  expect(projectNameValidation("中".repeat(86))).toBe("too_long");
  expect(projectNameValidation("😀".repeat(64))).toBeNull();
  expect(projectNameValidation("😀".repeat(65))).toBe("too_long");
  await expect(renameRuntimeProject(profile, server, { ...project, rootProject: true }, "Name", () => true)).rejects.toThrow("registered");
  await expect(renameRuntimeProject(profile, server, project, "中".repeat(86), () => true)).rejects.toThrow("long");
  expect(calls).toEqual([]);
});
