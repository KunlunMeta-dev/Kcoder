import { gatewaySessionExpired } from "@/gateway/http";
import type { JsonRecord } from "@/gateway/rpc";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskRuntime, taskRuntimeTestHelpers } from "./task-runtime";
import {
  FakeClient,
  profile,
  server,
} from "./task-runtime/fixture.test-support";
vi.mock("@/gateway/http", () => ({
  gatewaySessionExpired: vi.fn(async () => false),
}));
beforeEach(() => {
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  vi.mocked(gatewaySessionExpired).mockResolvedValue(false);
});
afterEach(() => {
  vi.restoreAllMocks();
  taskRuntimeTestHelpers.resetConnector();
  vi.useRealTimers();
});
describe("TaskRuntime 终端租约", () => {
  it("首次 fit 早于 terminal/start 时使用最新 PTY 尺寸", async () => {
    const client = new FakeClient([]);
    const requests: Array<{ method: string; params: JsonRecord }> = [];
    client.request = vi.fn(async (method: string, params: JsonRecord = {}) => {
      requests.push({ method, params });
      if (method === "thread/resume")
        return {
          thread: {
            id: "thread-size-before",
            title: "终端尺寸",
            cwd: "/workspace",
            status: "idle",
          },
        } as never;
      if (method === "thread/read") return { messages: [] } as never;
      if (method === "terminal/start")
        return { session_id: "pty-size-before", cwd: "/workspace" } as never;
      if (method === "terminal/attach")
        return {
          session_id: params.session_id,
          cwd: "/workspace",
          transcript: "",
          through_sequence: 0,
        } as never;
      return {} as never;
    });
    taskRuntimeTestHelpers.setConnector(
      vi.fn(async () => client as never) as never,
    );
    const runtime = await TaskRuntime.resume({
      profile,
      server,
      threadId: "thread-size-before",
    });
    const terminal = runtime.terminalSession("terminal-size-before");

    terminal.resize(41, 132);
    await terminal.start();

    expect(
      requests.find((request) => request.method === "terminal/start")?.params,
    ).toMatchObject({ rows: 41, cols: 132 });
    runtime.close();
  });

  it("terminal/start 在途时发生 fit 会在会话创建后补发 resize", async () => {
    const client = new FakeClient([]);
    const requests: Array<{ method: string; params: JsonRecord }> = [];
    let resolveStart!: (value: { session_id: string; cwd: string }) => void;
    const delayedStart = new Promise<{ session_id: string; cwd: string }>(
      (resolve) => {
        resolveStart = resolve;
      },
    );
    client.request = vi.fn(async (method: string, params: JsonRecord = {}) => {
      requests.push({ method, params });
      if (method === "thread/resume")
        return {
          thread: {
            id: "thread-size-race",
            title: "终端尺寸",
            cwd: "/workspace",
            status: "idle",
          },
        } as never;
      if (method === "thread/read") return { messages: [] } as never;
      if (method === "terminal/start") return (await delayedStart) as never;
      if (method === "terminal/attach")
        return {
          session_id: params.session_id,
          cwd: "/workspace",
          transcript: "",
          through_sequence: 0,
        } as never;
      return {} as never;
    });
    taskRuntimeTestHelpers.setConnector(
      vi.fn(async () => client as never) as never,
    );
    const runtime = await TaskRuntime.resume({
      profile,
      server,
      threadId: "thread-size-race",
    });
    const terminal = runtime.terminalSession("terminal-size-race");

    const starting = terminal.start();
    terminal.resize(36, 118);
    resolveStart({ session_id: "pty-size-race", cwd: "/workspace" });
    await starting;

    expect(
      requests.filter((request) => request.method === "terminal/resize"),
    ).toEqual([
      {
        method: "terminal/resize",
        params: { session_id: "pty-size-race", rows: 36, cols: 118 },
      },
    ]);
    runtime.close();
  });

  it("页面卸载后复用同一 PTY，只有显式关闭面板才关闭远端会话", async () => {
    const client = new FakeClient([]);
    const requests: Array<{ method: string; params: JsonRecord }> = [];
    client.request = vi.fn(async (method: string, params: JsonRecord = {}) => {
      requests.push({ method, params });
      if (method === "thread/resume")
        return {
          thread: {
            id: "thread-1",
            title: "终端",
            cwd: "/workspace",
            status: "idle",
          },
        } as never;
      if (method === "thread/read") return { messages: [] } as never;
      if (method === "terminal/start")
        return { session_id: "pty-1", cwd: "/workspace" } as never;
      if (method === "terminal/attach")
        return {
          session_id: params.session_id,
          cwd: "/workspace",
          transcript: "",
          through_sequence: 0,
        } as never;
      return {} as never;
    });
    taskRuntimeTestHelpers.setConnector(
      vi.fn(async () => client as never) as never,
    );
    const runtime = await TaskRuntime.resume({
      profile,
      server,
      threadId: "thread-1",
    });

    const firstMount = runtime.terminalSession("terminal-main");
    expect(runtime.isLiveTerminalSession("terminal-main")).toBe(false);
    await firstMount.start();
    expect(runtime.isLiveTerminalSession("terminal-main")).toBe(true);
    client.emit({
      method: "terminal/output",
      params: { session_id: "pty-1", sequence: 1, data: "hello\r\n$ " },
    });

    const secondMount = runtime.terminalSession("terminal-main");
    expect(secondMount).toBe(firstMount);
    expect(secondMount.getSnapshot()).toMatchObject({
      sessionId: "pty-1",
      status: "running",
    });
    expect(secondMount.getTranscript()).toContain("hello");
    expect(
      requests.filter((request) => request.method === "terminal/start"),
    ).toHaveLength(1);

    runtime.closeTerminalSession("terminal-main");
    expect(runtime.isLiveTerminalSession("terminal-main")).toBe(false);
    expect(
      requests.filter((request) => request.method === "terminal/close"),
    ).toEqual([{ method: "terminal/close", params: { session_id: "pty-1" } }]);
    runtime.close();
  });

  it("页面刷新后的新 runtime 用持久化 sessionId 附着原 PTY 而不新建 shell", async () => {
    const client = new FakeClient([]);
    const requests: Array<{ method: string; params: JsonRecord }> = [];
    client.request = vi.fn(async (method: string, params: JsonRecord = {}) => {
      requests.push({ method, params });
      if (method === "thread/resume")
        return {
          thread: {
            id: "thread-persisted-terminal",
            cwd: "/workspace",
            status: "idle",
          },
        } as never;
      if (method === "thread/read") return { messages: [] } as never;
      if (method === "terminal/attach")
        return {
          session_id: params.session_id,
          cwd: "/workspace",
          transcript: "before refresh\r\n$ ",
          through_sequence: 7,
        } as never;
      if (method === "terminal/start") throw new Error("不应创建新终端");
      return {} as never;
    });
    taskRuntimeTestHelpers.setConnector(
      vi.fn(async () => client as never) as never,
    );
    const runtime = await TaskRuntime.resume({
      profile,
      server,
      threadId: "thread-persisted-terminal",
    });

    const terminal = runtime.terminalSession("terminal-main", "pty-persisted");
    await terminal.start();

    expect(
      requests.filter((request) => request.method === "terminal/start"),
    ).toHaveLength(0);
    expect(
      requests.filter((request) => request.method === "terminal/attach"),
    ).toEqual([
      {
        method: "terminal/attach",
        params: { session_id: "pty-persisted", rows: 28, cols: 100 },
      },
    ]);
    expect(terminal.getSnapshot()).toMatchObject({
      sessionId: "pty-persisted",
      status: "running",
      sequence: 1,
    });
    expect(terminal.getTranscript()).toContain("before refresh");
    runtime.close();
  });

  it("断线后保留 sessionId 并用 attach snapshot 去重恢复期间输出", async () => {
    vi.useFakeTimers();
    const initial = new FakeClient([]);
    const recovered = new FakeClient([]);
    const initialRequests: Array<{ method: string; params: JsonRecord }> = [];
    const recoveredRequests: Array<{ method: string; params: JsonRecord }> = [];
    let resolveAttach!: (value: {
      session_id: string;
      cwd: string;
      transcript: string;
      through_sequence: number;
    }) => void;
    const delayedAttach = new Promise<{
      session_id: string;
      cwd: string;
      transcript: string;
      through_sequence: number;
    }>((resolve) => {
      resolveAttach = resolve;
    });
    initial.request = vi.fn(async (method: string, params: JsonRecord = {}) => {
      initialRequests.push({ method, params });
      if (method === "thread/resume")
        return {
          thread: {
            id: "thread-terminal-reconnect",
            cwd: "/workspace",
            status: "idle",
          },
        } as never;
      if (method === "thread/read") return { messages: [] } as never;
      if (method === "terminal/start")
        return { session_id: "pty-stable", cwd: "/workspace" } as never;
      if (method === "terminal/attach")
        return {
          session_id: "pty-stable",
          cwd: "/workspace",
          transcript: "",
          through_sequence: 0,
        } as never;
      return {} as never;
    });
    recovered.request = vi.fn(
      async (method: string, params: JsonRecord = {}) => {
        recoveredRequests.push({ method, params });
        if (method === "thread/resume")
          return {
            thread: {
              id: "thread-terminal-reconnect",
              cwd: "/workspace",
              status: "idle",
            },
          } as never;
        if (method === "thread/read") return { messages: [] } as never;
        if (method === "terminal/attach") return (await delayedAttach) as never;
        return {} as never;
      },
    );
    const clients = [initial, recovered];
    taskRuntimeTestHelpers.setConnector(
      vi.fn(async () => clients.shift() as never) as never,
    );
    const runtime = await TaskRuntime.resume({
      profile,
      server,
      threadId: "thread-terminal-reconnect",
    });
    const terminal = runtime.terminalSession("terminal-reconnect");
    await terminal.start();
    initial.emit({
      method: "terminal/output",
      params: { session_id: "pty-stable", sequence: 1, data: "before\r\n" },
    });

    initial.emit({
      method: "connection/closed",
      params: { reason: "network lost" },
    });
    expect(terminal.getSnapshot()).toMatchObject({
      sessionId: "pty-stable",
      status: "reconnecting",
    });
    await vi.advanceTimersByTimeAsync(500);
    await Promise.resolve();
    recovered.emit({
      method: "terminal/output",
      params: { session_id: "pty-stable", sequence: 3, data: "after\r\n" },
    });
    resolveAttach({
      session_id: "pty-stable",
      cwd: "/workspace",
      transcript: "before\r\nduring\r\n",
      through_sequence: 2,
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(
      recoveredRequests.filter(
        (request) => request.method === "terminal/start",
      ),
    ).toHaveLength(0);
    expect(
      recoveredRequests.filter(
        (request) => request.method === "terminal/attach",
      ),
    ).toHaveLength(1);
    expect(terminal.getSnapshot()).toMatchObject({
      sessionId: "pty-stable",
      status: "running",
    });
    expect(terminal.getTranscript().match(/before/g)).toHaveLength(1);
    expect(terminal.getTranscript().match(/during/g)).toHaveLength(1);
    expect(terminal.getTranscript().match(/after/g)).toHaveLength(1);
    expect(
      initialRequests.filter((request) => request.method === "terminal/start"),
    ).toHaveLength(1);
    runtime.close();
  });

  it("终端输出 sequence 出现缺口时重新 attach 同一会话", async () => {
    vi.useFakeTimers();
    const client = new FakeClient([]);
    const requests: Array<{ method: string; params: JsonRecord }> = [];
    let attachCount = 0;
    client.request = vi.fn(async (method: string, params: JsonRecord = {}) => {
      requests.push({ method, params });
      if (method === "thread/resume")
        return {
          thread: {
            id: "thread-terminal-gap",
            cwd: "/workspace",
            status: "idle",
          },
        } as never;
      if (method === "thread/read") return { messages: [] } as never;
      if (method === "terminal/start")
        return { session_id: "pty-gap", cwd: "/workspace" } as never;
      if (method === "terminal/attach") {
        attachCount += 1;
        return {
          session_id: "pty-gap",
          cwd: "/workspace",
          transcript: attachCount === 1 ? "" : "one\r\ntwo\r\n",
          through_sequence: attachCount === 1 ? 0 : 2,
        } as never;
      }
      return {} as never;
    });
    taskRuntimeTestHelpers.setConnector(
      vi.fn(async () => client as never) as never,
    );
    const runtime = await TaskRuntime.resume({
      profile,
      server,
      threadId: "thread-terminal-gap",
    });
    const terminal = runtime.terminalSession("terminal-gap");
    await terminal.start();

    client.emit({
      method: "terminal/output",
      params: { session_id: "pty-gap", sequence: 2, data: "two\r\n" },
    });
    expect(terminal.getSnapshot()).toMatchObject({
      sessionId: "pty-gap",
      status: "reconnecting",
    });
    await vi.runAllTimersAsync();
    await Promise.resolve();

    expect(
      requests.filter((request) => request.method === "terminal/start"),
    ).toHaveLength(1);
    expect(
      requests.filter((request) => request.method === "terminal/attach"),
    ).toHaveLength(2);
    expect(terminal.getSnapshot()).toMatchObject({
      sessionId: "pty-gap",
      status: "running",
    });
    expect(terminal.getTranscript().match(/one/g)).toHaveLength(1);
    expect(terminal.getTranscript().match(/two/g)).toHaveLength(1);
    runtime.close();
  });

  it("重连 attach 找不到原终端时清除失效 sessionId 并等待用户显式重启", async () => {
    vi.useFakeTimers();
    const initial = new FakeClient([]);
    const recovered = new FakeClient([]);
    const recoveredRequests: Array<{ method: string; params: JsonRecord }> = [];
    initial.request = vi.fn(async (method: string, params: JsonRecord = {}) => {
      if (method === "thread/resume")
        return {
          thread: {
            id: "thread-terminal-missing",
            cwd: "/workspace",
            status: "idle",
          },
        } as never;
      if (method === "thread/read") return { messages: [] } as never;
      if (method === "terminal/start")
        return { session_id: "pty-missing", cwd: "/workspace" } as never;
      if (method === "terminal/attach")
        return {
          session_id: params.session_id,
          cwd: "/workspace",
          transcript: "",
          through_sequence: 0,
        } as never;
      return {} as never;
    });
    recovered.request = vi.fn(
      async (method: string, params: JsonRecord = {}) => {
        recoveredRequests.push({ method, params });
        if (method === "thread/resume")
          return {
            thread: {
              id: "thread-terminal-missing",
              cwd: "/workspace",
              status: "idle",
            },
          } as never;
        if (method === "thread/read") return { messages: [] } as never;
        if (method === "terminal/attach") throw new Error("terminal not found");
        return {} as never;
      },
    );
    const clients = [initial, recovered];
    taskRuntimeTestHelpers.setConnector(
      vi.fn(async () => clients.shift() as never) as never,
    );
    const runtime = await TaskRuntime.resume({
      profile,
      server,
      threadId: "thread-terminal-missing",
    });
    const terminal = runtime.terminalSession("terminal-missing");
    await terminal.start();

    initial.emit({
      method: "connection/closed",
      params: { reason: "network lost" },
    });
    await vi.advanceTimersByTimeAsync(500);
    await Promise.resolve();
    await Promise.resolve();

    expect(
      recoveredRequests.filter(
        (request) => request.method === "terminal/start",
      ),
    ).toHaveLength(0);
    expect(
      recoveredRequests.filter(
        (request) => request.method === "terminal/attach",
      ),
    ).toHaveLength(1);
    expect(terminal.getSnapshot()).toMatchObject({
      sessionId: null,
      status: "error",
      error: "原终端已不可用：terminal not found",
    });
    runtime.close();
  });

  it("新建终端后 attach 失败会清除 sessionId 并关闭孤立的远端会话", async () => {
    const client = new FakeClient([]);
    const requests: Array<{ method: string; params: JsonRecord }> = [];
    client.request = vi.fn(async (method: string, params: JsonRecord = {}) => {
      requests.push({ method, params });
      if (method === "thread/resume")
        return {
          thread: {
            id: "thread-terminal-attach-failure",
            cwd: "/workspace",
            status: "idle",
          },
        } as never;
      if (method === "thread/read") return { messages: [] } as never;
      if (method === "terminal/start")
        return { session_id: "pty-orphan", cwd: "/workspace" } as never;
      if (method === "terminal/attach") throw new Error("attach failed");
      return {} as never;
    });
    taskRuntimeTestHelpers.setConnector(
      vi.fn(async () => client as never) as never,
    );
    const runtime = await TaskRuntime.resume({
      profile,
      server,
      threadId: "thread-terminal-attach-failure",
    });
    const terminal = runtime.terminalSession("terminal-attach-failure");

    await terminal.start();
    await Promise.resolve();

    expect(terminal.getSnapshot()).toMatchObject({
      sessionId: null,
      status: "error",
      error: "attach failed",
    });
    expect(
      requests.filter((request) => request.method === "terminal/close"),
    ).toEqual([
      { method: "terminal/close", params: { session_id: "pty-orphan" } },
    ]);
    runtime.close();
  });
});
