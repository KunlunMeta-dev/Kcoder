import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useNewTaskDraftConnection } from "./useNewTaskDraftConnection";
import { profile, server } from "@/runtime/task-runtime/fixture.test-support";
const fixture = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock("@/runtime/task-runtime/connectionFactory", () => ({ taskClientConnector: (...args: unknown[]) => fixture.connect(...args) }));
vi.mock("@/runtime/task-runtime/new-catalog-read-source", () => ({ catalogReadScopeKey: (profile: any, server: any) => JSON.stringify([profile.id, profile.authorizationGeneration, server.id]) }));
let result!: ReturnType<typeof useNewTaskDraftConnection>;
let renderer: ReactTestRenderer | undefined;
function Probe({ cwd = "/workspace", selected = profile, enabled = true }: { cwd?: string; selected?: typeof profile; enabled?: boolean }) { result = useNewTaskDraftConnection(selected, server, cwd, enabled); return null; }
const client = () => ({ close: vi.fn(), subscribeClose: vi.fn(() => vi.fn()), supportsExperimental: vi.fn(() => true) });
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); fixture.connect.mockReset(); });
afterEach(async () => { await act(async () => renderer?.unmount()); renderer = undefined; vi.unstubAllGlobals(); });
it("initializes without creating a thread, publishes real capabilities and retries an initialization failure", async () => {
  const connection = client(); fixture.connect.mockRejectedValueOnce(new Error("init refused")).mockResolvedValueOnce(connection);
  await act(async () => { renderer = create(<Probe />); });
  expect(result).toMatchObject({ ready: false, error: "init refused" });
  await act(async () => { result.retry(); });
  expect(result).toMatchObject({ ready: true, error: null, supportsPermissions: true });
  expect(fixture.connect.mock.calls[0][2]).toBe("/workspace");
  expect(fixture.connect.mock.calls[0][4].signal).toBeInstanceOf(AbortSignal);
});
it.each(["cwd", "authorization"])("closes a late %s owner without publishing it into the new draft", async change => {
  let resolve!: (value: any) => void; const old = client(); const current = client();
  fixture.connect.mockReturnValueOnce(new Promise(done => { resolve = done; })).mockResolvedValueOnce(current);
  await act(async () => { renderer = create(<Probe />); });
  const signal = fixture.connect.mock.calls[0][4].signal;
  await act(async () => { renderer!.update(<Probe cwd={change === "cwd" ? "/other" : "/workspace"} selected={change === "authorization" ? { ...profile, authorizationGeneration: "new-auth" } : profile} />); });
  expect(signal.aborted).toBe(true);
  await act(async () => { resolve(old); });
  expect(old.close).toHaveBeenCalledOnce(); expect(result.client).toBe(current);
});
it("does not initialize a disabled preview and clears ready on a transport close", async () => {
  const connection = client(); fixture.connect.mockResolvedValue(connection);
  await act(async () => { renderer = create(<Probe enabled={false} />); });
  expect(fixture.connect).not.toHaveBeenCalled(); expect(result.ready).toBe(false);
  await act(async () => { renderer!.update(<Probe />); });
  expect(result.ready).toBe(true);
  await act(async () => { (connection.subscribeClose.mock.calls[0] as any[])[0](); });
  expect(result.ready).toBe(false); expect(result.error).toBeTruthy();
});
