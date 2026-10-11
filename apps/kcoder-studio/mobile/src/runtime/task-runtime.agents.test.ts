import { afterEach, expect, it, vi } from "vitest";
import type { JsonRecord } from "@/gateway/rpc";
import { TaskRuntime, taskRuntimeTestHelpers } from "./task-runtime";
import {
  FakeClient,
  profile,
  server,
} from "./task-runtime/fixture.test-support";
vi.mock("@/gateway/http", () => ({
  ensureGatewayAuthorization: vi.fn(async () => {}),
  gatewaySessionExpired: vi.fn(async () => false),
}));
afterEach(() => taskRuntimeTestHelpers.resetConnector());
class AgentClient extends FakeClient {
  calls: { method: string; params: JsonRecord }[] = [];
  responses: { id: number; result: unknown }[] = [];
  flags = new Set(["agentArtifactsV1"]);
  deferred: ((value: unknown) => void) | null = null;
  override supportsExperimental(name: string) {
    return this.flags.has(name);
  }
  override async request<T>(
    method: string,
    params: JsonRecord = {},
  ): Promise<T> {
    this.calls.push({ method, params });
    if (method === "agent/list")
      return { threadId: "thread-1", agents: [] } as T;
    if (method === "agent/artifact/read")
      return {
        threadId: "thread-1",
        agentId: "worker",
        content: "public output",
      } as T;
    return super.request(method, params);
  }
  override respond(id?: number, result?: unknown) {
    this.responses.push({ id: id!, result });
  }
}
async function connect(client: AgentClient) {
  taskRuntimeTestHelpers.setConnector(async () => client as never);
  const task = await TaskRuntime.resume({
    profile,
    server,
    threadId: "thread-1",
  });
  client.calls = [];
  return task;
}
it("legacy artifact targets remain read-only without guessing unsupported transcript or command RPC", async () => {
  const client = new AgentClient([]),
    task = await connect(client);
  expect(task.agentCapabilities().discover).toBe(true);
  expect(task.agentCapabilities().commands).toBe(false);
  await task.readSubagent({
    agentId: "worker",
    status: "completed",
    acceptingMessages: false,
    queueDepth: 0,
  });
  expect(client.calls[0]).toEqual({
    method: "agent/artifact/read",
    params: { threadId: "thread-1", agentId: "worker", kind: "output" },
  });
  await expect(task.readSubagentCommand("worker", "cmd:0:one")).rejects.toThrow(
    "指令状态",
  );
  expect(client.calls).toHaveLength(1);
  task.close();
});
it("a replaced connection cannot publish an old agent page", async () => {
  const client = new AgentClient([]),
    task = await connect(client),
    original = client.request.bind(client);
  client.request = <T>(method: string, params: JsonRecord = {}) =>
    method === "agent/artifact/read"
      ? new Promise<T>((resolve) => {
          client.deferred = resolve as (value: unknown) => void;
        })
      : original<T>(method, params);
  const result = task.readSubagent({
    agentId: "worker",
    status: "completed",
    acceptingMessages: false,
    queueDepth: 0,
  });
  task.clientGeneration++;
  client.deferred!({
    threadId: "thread-1",
    agentId: "worker",
    content: "old account content",
  });
  await expect(result).rejects.toThrow("失效");
  task.close();
});
it("ignoring one source question responds only to its ledger entry and never stops either task", async () => {
  const client = new AgentClient([]),
    task = await connect(client);
  task.handleRpc({
    jsonrpc: "2.0",
    id: 11,
    method: "question/request",
    params: {
      questionId: "child",
      sourceAgent: { parentSessionId: "thread-1", agentId: "worker" },
      questions: [],
    },
  });
  task.handleRpc({
    jsonrpc: "2.0",
    id: 12,
    method: "question/request",
    params: { questionId: "parent", questions: [] },
  });
  task.patch({ running: true });
  task.respondAgentQuestions("worker", 11, {}, true);
  expect(client.responses).toEqual([
    { id: 11, result: { answers: {}, annotations: { ignored: true } } },
  ]);
  expect(task.snapshot.running).toBe(true);
  expect(task.pendingInteractions).toHaveLength(2);
  expect(task.pendingInteractions[1].responding).not.toBe(true);
  expect(client.calls).toHaveLength(0);
  expect(() => task.respondAgentQuestions("another-worker", 12, {})).toThrow(
    "失效",
  );
  task.close();
});
it("source attribution requires the actual parent session rather than an agent-looking title", async () => {
  const task = await connect(new AgentClient([]));
  task.handleRpc({
    jsonrpc: "2.0",
    id: 13,
    method: "question/request",
    params: {
      questionId: "foreign",
      sourceAgent: { parentSessionId: "foreign-parent", agentId: "worker" },
      questions: [],
    },
  });
  expect(
    task.snapshot.interaction?.kind === "question" &&
      task.snapshot.interaction.sourceAgent,
  ).toBeUndefined();
  task.close();
});

it("steer response cannot acknowledge a different identity or obsolete connection", async () => {
  const client = new AgentClient([]), task = await connect(client);
  client.flags.add("agentSteering");
  const original = client.request.bind(client);
  client.request = <T>(method: string, params: JsonRecord = {}) =>
    method === "agent/steer" ? new Promise<T>(resolve => { client.deferred = resolve as (value: unknown) => void; }) : original<T>(method, params);
  const wrong = task.steerSubagent("worker", "中文追加", "cmd:0:original");
  client.deferred!({agentId: "worker", clientMessageId: "cmd:0:foreign", status: "queued_live", queued: true});
  await expect(wrong).rejects.toThrow("身份不匹配");
  const obsolete = task.steerSubagent("worker", "中文追加", "cmd:0:original");
  task.clientGeneration++;
  client.deferred!({agentId: "worker", clientMessageId: "cmd:0:original", status: "queued_live", queued: true});
  await expect(obsolete).rejects.toThrow("失效");
  task.close();
});
