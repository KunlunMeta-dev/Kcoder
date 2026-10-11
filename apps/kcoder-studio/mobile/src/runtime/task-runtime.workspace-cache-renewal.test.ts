import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ensureGatewayAuthorization } from "@/gateway/http";
import { clearWorkspaceOptionsCache, listWorkspaceOptions } from "./task-runtime/workspaces";
import { taskRuntimeTestHelpers } from "./task-runtime/connectionFactory";
import { profile, server } from "./task-runtime/fixture.test-support";

vi.mock("@/gateway/http", () => ({ ensureGatewayAuthorization: vi.fn() }));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => { vi.mocked(ensureGatewayAuthorization).mockReset(); });
afterEach(() => { clearWorkspaceOptionsCache(); taskRuntimeTestHelpers.resetConnector(); });

it("an already cancelled expired read starts neither shared renewal nor a workspace connection", async () => {
  const expired = { ...profile, expiresAt: Date.now() - 1, refreshToken: "synthetic-refresh" };
  vi.mocked(ensureGatewayAuthorization).mockImplementation(async () => { expired.expiresAt = Date.now() + 60_000; });
  const connector = vi.fn(async () => ({ request: vi.fn(), close: vi.fn() }) as never);
  taskRuntimeTestHelpers.setConnector(connector);
  const controller = new AbortController(); controller.abort();
  await expect(listWorkspaceOptions(expired, server, { signal: controller.signal })).rejects.toThrow("取消");
  expect(ensureGatewayAuthorization).not.toHaveBeenCalled();
  expect(connector).not.toHaveBeenCalled();
});

it("caller cancellation while renewal is held prevents any new workspace RPC connection", async () => {
  const expired = { ...profile, expiresAt: Date.now() - 1, refreshToken: "synthetic-refresh" };
  const renewal = deferred();
  vi.mocked(ensureGatewayAuthorization).mockImplementation(async () => {
    await renewal.promise;
    expired.expiresAt = Date.now() + 60_000;
  });
  const request = vi.fn(async () => ({ items: [] }));
  const connector = vi.fn(async () => ({ request, close: vi.fn() }) as never);
  taskRuntimeTestHelpers.setConnector(connector);
  const controller = new AbortController();
  const read = listWorkspaceOptions(expired, server, { signal: controller.signal, priority: "background" });
  const outcome = read.then(() => "resolved", () => "cancelled");
  expect(ensureGatewayAuthorization).toHaveBeenCalledOnce();
  controller.abort();
  renewal.resolve();
  expect(await outcome).toBe("cancelled");
  expect(connector).not.toHaveBeenCalled();
  expect(request).not.toHaveBeenCalled();
});

it("a successful renewal preserves background admission priority for the actual workspace loader", async () => {
  const expired = { ...profile, expiresAt: Date.now() - 1, refreshToken: "synthetic-refresh" };
  const renewal = deferred();
  vi.mocked(ensureGatewayAuthorization).mockImplementation(async () => {
    await renewal.promise;
    expired.expiresAt = Date.now() + 60_000;
  });
  const request = vi.fn(async () => ({ items: [] }));
  const close = vi.fn();
  const connector = vi.fn(async () => ({ request, close }) as never);
  taskRuntimeTestHelpers.setConnector(connector);
  const controller = new AbortController();
  const read = listWorkspaceOptions(expired, server, { signal: controller.signal, priority: "background" });
  renewal.resolve();
  expect(await read).toEqual([]);
  expect(connector).toHaveBeenCalledWith(expired, server, server.workspacePath, "runtime", expect.objectContaining({ priority: "background", signal: expect.any(AbortSignal) }));
  expect(request.mock.calls).toEqual([["runtime.workspaces.list", { deviceId: server.id }], ["runtime.worktrees.list", { deviceId: server.id }]]);
  expect(close).toHaveBeenCalledOnce();
});
