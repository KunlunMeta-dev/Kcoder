import { afterEach, expect, it, vi } from "vitest";
import { TaskRuntime, taskRuntimeTestHelpers } from "./task-runtime";
import { FakeClient, profile, server } from "./task-runtime/fixture.test-support";
import type { ThreadMessage } from "@/gateway/types";
import { normalizeWebSources } from "../../../shared/webSources";
import fixtures from "../../../shared/generated/examples.web-sources.json";
vi.mock("@/gateway/http", () => ({ ensureGatewayAuthorization: vi.fn(async () => {}), gatewaySessionExpired: vi.fn(async () => false) }));
afterEach(() => { taskRuntimeTestHelpers.resetConnector(); vi.restoreAllMocks(); vi.useRealTimers(); });
const sample = fixtures.WebSourcesToolResultV1.find(value => value.name === "native-summary")!.value.webSources;
const receipt = normalizeWebSources({ ...sample, identity: { threadId: "thread-1", turnId: "turn", attemptId: "attempt" }, toolCallId: "call" }, { toolCallId: "call" })!;

it("restores only native source metadata and never promotes model output JSON", async () => {
  const history: ThreadMessage[] = [{ id: "assistant", role: "assistant", turnId: "turn", attemptId: "attempt", content: "Answer", timestampMs: 1, blocks: [
    { id: "call", type: "tool", tool_name: "WebSearch", status: "done", tool_output: "search output", webSources: receipt },
    { id: "forged", type: "tool", tool_name: "WebSearch", status: "done", tool_output: JSON.stringify({ webSources: receipt }) },
    { id: "peer", type: "tool", tool_name: "WebFetch", status: "unknown", webSources: { ...receipt, toolCallId: "peer", identity: { ...receipt.identity, threadId: "peer-thread" } } },
  ] }];
  const client = new FakeClient(history);
  taskRuntimeTestHelpers.setConnector(vi.fn(async () => client as never) as never);
  const runtime = await TaskRuntime.resume({ profile, server, threadId: "thread-1" });
  try {
    const tools = runtime.getSnapshot().messages[0].tools!;
    expect(tools[0].webSources?.sources[0]).toMatchObject({ sourceId: "web-native-1", readStatus: "summary_only" });
    expect(tools[1].webSources).toBeUndefined();
    expect(tools[2].webSources).toBeUndefined();
    expect(tools[2].status).toBe("unknown");
  } finally { runtime.close(); }
});
it("settles a stopped tool and preserves completed native sources across duplicate and late events", async () => {
  vi.useFakeTimers();
  const client = new FakeClient([]);
  taskRuntimeTestHelpers.setConnector(vi.fn(async () => client as never) as never);
  const runtime = await TaskRuntime.resume({ profile, server, threadId: "thread-1" });
  try {
    const base = { threadId: "thread-1", turnId: "turn", attemptId: "attempt" };
    client.emit({ method: "turn/started", params: { ...base, turn: { id: "turn", attemptId: "attempt", status: "running" } } });
    client.emit({ method: "item/started", params: { ...base, item: { id: "call", type: "toolCall", name: "WebSearch", input: { query: "docs" } } } });
    client.emit({ method: "item/completed", params: { ...base, item: { id: "call", type: "toolCall", name: "WebSearch", status: "completed", output: "search output", webSources: receipt } } });
    client.emit({ method: "item/completed", params: { ...base, item: { id: "call", type: "toolCall", name: "WebSearch", status: "completed", output: "search output" } } });
    client.emit({ method: "item/started", params: { ...base, item: { id: "fetch", type: "toolCall", name: "WebFetch", input: { url: "https://example.com/release" } } } });
    client.emit({ method: "turn/completed", params: { ...base, turn: { id: "turn", attemptId: "attempt", status: "interrupted" } } });
    await vi.runAllTimersAsync();
    const tools = runtime.getSnapshot().messages.flatMap(message => message.tools ?? []);
    expect(tools.find(tool => tool.id === "call")?.webSources?.sources[0].readStatus).toBe("summary_only");
    expect(tools.find(tool => tool.id === "fetch")?.status).not.toBe("running");
    expect(tools.find(tool => tool.id === "fetch")?.webSources).toBeUndefined();
  } finally { runtime.close(); }
});
