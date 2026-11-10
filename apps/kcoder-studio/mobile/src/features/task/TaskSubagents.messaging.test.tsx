import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentSteerResult, AgentSummary } from "@/runtime/task-runtime/types";
import type { TaskRuntime } from "@/runtime/task-runtime";

const host = vi.hoisted(() => ({
  task: null as any,
  conversationLoading: false,
  agent: { agentId: "child", status: "completed", acceptingMessages: false, queueDepth: 0 } as AgentSummary,
  intents: new Map<string, { clientMessageId: string; createdAt: number }>(),
  capabilities: { discover: true, commands: true, pages: false, stop: false, conversation: true },
}));
vi.mock("@/i18n", () => ({ t: (key: string, params?: Record<string, unknown>) => `${key}${params ? JSON.stringify(params) : ""}` }));
vi.mock("@/i18n/use-locale", () => ({ useLocale: () => "en" }));
vi.mock("@/storage/interface-version", () => ({ useInterfaceVersion: () => "v3" }));
vi.mock("./TaskSubagentView", () => ({
  TaskSubagentPanel: "TaskSubagentPanel", TaskSubagentList: "TaskSubagentList",
  TaskSubagentTranscript: "TaskSubagentTranscript", TaskSubagentInstructionInput: "TaskSubagentInstructionInput",
  subagentStatusLabel: (status: string) => status,
}));
vi.mock("./TaskSubagentConversation", () => ({ TaskSubagentConversation: (props: any) => React.createElement("TaskSubagentConversation", props, props.controls) }));
vi.mock("./useSubagentConversation", () => ({ useSubagentConversation: () => ({ loading: host.conversationLoading, snapshot: { running: false, connected: true } }) }));
vi.mock("@/components/ui", () => ({ Button: "Button" }));
vi.mock("@/components/interaction-cards", () => ({ QuestionCard: "QuestionCard", interactionCardIdentity: () => "question" }));
vi.mock("@/theme", () => ({ spacing: { md: 12 }, useThemedStyles: () => ({ colors: {}, styles: {} }) }));
vi.mock("@/state/profile-coordinator", () => ({ profileAuthorizationScopeKey: () => "auth-scope" }));
vi.mock("@/runtime/task-runtime/threadDirectory", () => ({ interactionServerIdentity: () => "target" }));
vi.mock("@/state/AppContext", () => ({ useApp: () => ({
  activeProfile: host.task.reconnectContext.profile,
  runtime: { servers: [host.task.reconnectContext.server], serversReady: true },
  demo: false, runtimeActivationEpoch: 1, isCurrentInteractionOwner: () => true,
}) }));
vi.mock("@/runtime/task-runtime", () => ({ taskRuntimeRegistry: {
  entries: () => [{ profileId: "profile", serverId: "server", threadId: "parent", runtime: host.task }],
  interactionInboxRows: () => [],
} }));
vi.mock("./mobileAgentIntent", () => ({
  readAgentIntent: vi.fn(async (scope: string) => host.intents.get(scope) ?? null),
  saveAgentIntent: vi.fn(async (scope: string, intent: { clientMessageId: string; createdAt: number }) => { host.intents.set(scope, intent); }),
  clearAgentIntent: vi.fn(async (scope: string) => { host.intents.delete(scope); }),
}));
vi.mock("react-native-safe-area-context", () => ({ SafeAreaView: "SafeAreaView" }));
vi.mock("react-native", () => ({
  ActivityIndicator: "ActivityIndicator", KeyboardAvoidingView: "KeyboardAvoidingView", Modal: "Modal",
  Platform: { OS: "web" }, ScrollView: "ScrollView", Text: "Text", TextInput: "TextInput", View: "View",
  StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1 },
}));
import { TaskSubagents } from "./TaskSubagents";

let renderer: ReactTestRenderer | undefined;
let warning: ReturnType<typeof vi.spyOn>;
const nodes = (type: string) => renderer!.root.findAll(node => String(node.type) === type);
const button = (id = "mobile-subagent-send") => {
  if (id !== "mobile-subagent-send") return nodes("Button").find(node => node.props.testID === id);
  const composer = nodes("TaskSubagentConversation")[0]?.props.composer;
  return composer ? { props: { disabled: !composer.canSend, onPress: composer.onSend, children: composer.label } } : undefined;
};
const input = () => { const composer = nodes("TaskSubagentConversation")[0]?.props.composer; return composer ? { props: composer } : undefined; };
const flush = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(10); }); };
async function openAgent() {
  await act(async () => { renderer = create(<TaskSubagents task={host.task as TaskRuntime} bottomInset={0} />); });
  await act(async () => { renderer!.update(<TaskSubagents task={host.task as TaskRuntime} bottomInset={0} openRequest={{}} />); });
  await flush();
  await act(async () => { nodes("TaskSubagentList")[0]!.props.onChoose("child"); });
  await flush();
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
}
async function write(message = "Continue checking the layout") {
  await act(async () => { input()!.props.onChange(message); });
}

beforeEach(() => {
  vi.useFakeTimers();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  warning = vi.spyOn(console, "error").mockImplementation((...args) => {
    if (!String(args[0]).includes("react-test-renderer is deprecated")) throw new Error(args.map(String).join(" "));
  });
  host.intents.clear();
  host.conversationLoading = false;
  host.agent = { agentId: "child", status: "completed", acceptingMessages: false, queueDepth: 0 };
  host.capabilities = { discover: true, commands: true, pages: false, stop: false, conversation: true };
  host.task = {
    snapshot: { threadId: "parent", cwd: "/workspace", connected: true, title: "Parent" },
    reconnectContext: { profile: { id: "profile" }, server: { id: "server", label: "Server" }, profileActivationEpoch: 1 },
    runtimeInstanceNonce: 1, clientGeneration: 1, client: { isTransportOpen: () => true },
    reconnecting: false, pendingInteractions: [], isDisposed: () => false,
    getSnapshot: () => host.task.snapshot,
    agentCapabilities: () => host.capabilities,
    listSubagents: vi.fn(async () => ({ threadId: "parent", agents: [host.agent] })),
    readSubagent: vi.fn(async () => ({ threadId: "parent", agentId: "child", content: "Public result" })),
    readSubagentCommands: vi.fn(async () => ({ threadId: "parent", agentId: "child", receiptEpoch: 7, receipts: [] })),
    readSubagentCommand: vi.fn(async () => ({ receipt: null })),
    steerSubagent: vi.fn(async (_agent: string, _message: string, id: string): Promise<AgentSteerResult> => {
      expect([...host.intents.values()][0]?.clientMessageId).toBe(id);
      return { agentId: "child", clientMessageId: id, status: "resuming", queued: true };
    }),
  };
});
afterEach(async () => {
  await act(async () => { renderer?.unmount(); });
  renderer = undefined;
  warning.mockRestore();
  vi.useRealTimers();
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

it.each(["completed", "failed"])("continues a %s child with its closed live queue, then allows another message to the same agent", async status => {
  host.agent = { ...host.agent, status };
  await openAgent();
  await write();
  expect(button()!.props.disabled).toBe(false);
  expect(button()!.props.children).toBe("task.subagent_continue");
  await act(async () => { await button()!.props.onPress(); });
  expect(host.task.steerSubagent).toHaveBeenCalledWith("child", "Continue checking the layout", expect.stringMatching(/^cmd:7:/));
  expect(input()!.props.value).toBe("");
  expect(host.intents.size).toBe(0);
  host.agent = { ...host.agent, status: "running", acceptingMessages: true };
  await act(async () => { await nodes("TaskSubagentPanel")[0]!.props.onRefresh(); });
  await write("Now check the dark theme");
  expect(button()!.props.children).toBe("task.send_instruction");
  await act(async () => { await button()!.props.onPress(); });
  expect(host.task.steerSubagent).toHaveBeenCalledTimes(2);
  const calls = host.task.steerSubagent.mock.calls;
  expect(calls[1][0]).toBe("child");
  expect(calls[1][2]).not.toBe(calls[0][2]);
});

it.each(["cancelled", "halted", "closed", "unknown", "running"])("does not dispatch to an unavailable %s child even if its handler is invoked", async status => {
  host.agent = { ...host.agent, status, acceptingMessages: status === "unknown" };
  await openAgent(); await write();
  expect(button()!.props.disabled).toBe(true);
  await act(async () => { await button()!.props.onPress(); });
  expect(host.task.steerSubagent).not.toHaveBeenCalled();
  expect(host.intents.size).toBe(0);
  expect(input()!.props.value).toBe("Continue checking the layout");
});

it.each(["pending", "running", "paused"])("still sends a live instruction to an accepting %s child", async status => {
  host.agent = { ...host.agent, status, acceptingMessages: true };
  await openAgent(); await write();
  expect(button()!.props.disabled).toBe(false);
  expect(button()!.props.children).toBe("task.send_instruction");
  await act(async () => { await button()!.props.onPress(); });
  expect(host.task.steerSubagent).toHaveBeenCalledTimes(1);
});

it.each(["finishing", "closed", "cancelled", "rejected"])("retains the draft after a definite %s response", async status => {
  host.task.steerSubagent.mockResolvedValue({ agentId: "child", status, queued: false });
  await openAgent(); await write();
  await act(async () => { await button()!.props.onPress(); });
  expect(input()!.props.value).toBe("Continue checking the layout");
  expect(host.intents.size).toBe(0);
  expect(nodes("Text").some(node => String(node.props.children).includes(status === "finishing" ? "task.subagent_finishing" : "task.subagent_not_accepted"))).toBe(true);
});

it.each(["lost-response", "unfamiliar-status"])("keeps the original intent after %s and queries without replaying", async mode => {
  if (mode === "lost-response") host.task.steerSubagent.mockRejectedValue(new Error("connection lost"));
  else host.task.steerSubagent.mockResolvedValue({ agentId: "child", status: "future-status", queued: false });
  await openAgent(); await write();
  await act(async () => { await button()!.props.onPress(); });
  expect(host.intents.size).toBe(1);
  expect(button()!.props.disabled).toBe(true);
  expect(input()!.props.value).toBe("Continue checking the layout");
  const originalId = [...host.intents.values()][0]!.clientMessageId;
  await act(async () => { await button("mobile-subagent-query")!.props.onPress(); });
  expect(host.task.readSubagentCommand).toHaveBeenCalledWith("child", originalId);
  expect(host.task.steerSubagent).toHaveBeenCalledTimes(1);
  expect(host.intents.size).toBe(1);
});

it("disables sending on disconnect and does not bypass an older target's missing command capability", async () => {
  await openAgent(); await write();
  host.task.reconnecting = true;
  await act(async () => { renderer!.update(<TaskSubagents task={host.task as TaskRuntime} bottomInset={0} />); });
  expect(button()!.props.disabled).toBe(true);
  await act(async () => { await button()!.props.onPress(); });
  expect(host.task.steerSubagent).not.toHaveBeenCalled();
  host.capabilities.commands = false;
  await act(async () => { renderer!.update(<TaskSubagents task={host.task as TaskRuntime} bottomInset={0} />); });
  expect(button()).toBeUndefined();
  expect(input()).toBeUndefined();
});

it("preserves the draft while observation is reconnecting and never dispatches through the disabled Composer", async () => {
  await openAgent(); await write();
  host.conversationLoading = true;
  await act(async () => { renderer!.update(<TaskSubagents task={host.task} bottomInset={0} />); });
  expect(button()!.props.disabled).toBe(true);
  await act(async () => { await button()!.props.onPress(); });
  expect(host.task.steerSubagent).not.toHaveBeenCalled();
  expect(input()!.props.value).toBe("Continue checking the layout");
});
it("rejects an oversized instruction before writing intent, leaving it editable instead of unknown", async () => {
  await openAgent(); await write("长".repeat(23000));
  await act(async () => { await button()!.props.onPress(); });
  expect(host.task.steerSubagent).not.toHaveBeenCalled();
  expect(host.intents.size).toBe(0);
  expect(input()!.props.disabled).toBe(false);
  expect(nodes("Text").some(node => node.props.children === "task.subagent_message_too_large")).toBe(true);
});

it("keeps history paging available through More and restores the same child draft on return to Live", async () => {
  host.capabilities.pages = true;
  await openAgent(); await write("Keep this child draft");
  await act(async () => { await nodes("TaskSubagentPanel")[0]!.props.onHistory(); });
  expect(host.task.readSubagent).toHaveBeenCalledWith(host.agent, expect.objectContaining({ history: true }));
  expect(input()).toBeUndefined();
  expect(nodes("TaskSubagentConversation")[0]!.props.history).toBe(true);
  await act(async () => { nodes("TaskSubagentPanel")[0]!.props.onLive(); });
  expect(input()!.props.value).toBe("Keep this child draft");
});

it("keeps the selected worker and draft across same-owner transport replacement", async () => {
  await openAgent(); await write("Keep me across reconnect");
  host.task.clientGeneration++;
  await act(async () => { renderer!.update(<TaskSubagents task={host.task} bottomInset={0} />); });
  await flush();
  expect(nodes("TaskSubagentPanel")[0]!.props.visible).toBe(true);
  expect(input()!.props.value).toBe("Keep me across reconnect");
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  expect(input()!.props.value).toBe("Keep me across reconnect");
});

it("carries an unknown instruction across transport replacement and queries its original receipt without replay", async () => {
  host.task.steerSubagent.mockRejectedValue(new Error("lost receipt"));
  await openAgent(); await write("Do this exactly once");
  await act(async () => { await button()!.props.onPress(); });
  const original = [...host.intents.values()][0]!.clientMessageId;
  host.task.clientGeneration++;
  await act(async () => { renderer!.update(<TaskSubagents task={host.task} bottomInset={0} />); });
  await flush();
  expect(button()!.props.disabled).toBe(true);
  expect(button("mobile-subagent-query")).toBeDefined();
  host.task.readSubagentCommand.mockResolvedValue({ receipt: { clientMessageId: original, status: "applied" } });
  await act(async () => { await button("mobile-subagent-query")!.props.onPress(); });
  expect(host.task.readSubagentCommand).toHaveBeenCalledWith("child", original);
  expect(host.task.steerSubagent).toHaveBeenCalledTimes(1);
  expect(host.intents.size).toBe(0);
});

it("releases the busy UI when leaving an in-flight instruction and returning to query its original receipt", async () => {
  let finish: (value: AgentSteerResult) => void = () => {};
  host.task.steerSubagent.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  await openAgent(); await write("One in-flight command");
  await act(async () => { button()!.props.onPress(); });
  const original = [...host.intents.values()][0]!.clientMessageId;
  await act(async () => { nodes("TaskSubagentPanel")[0]!.props.onBack(); });
  await act(async () => { nodes("TaskSubagentList")[0]!.props.onChoose("child"); });
  await flush();
  expect(button("mobile-subagent-query")!.props.disabled).toBe(false);
  host.task.readSubagentCommand.mockResolvedValue({ receipt: { clientMessageId: original, status: "applied" } });
  await act(async () => { await button("mobile-subagent-query")!.props.onPress(); });
  await act(async () => { finish({ agentId: "child", clientMessageId: original, status: "applied", queued: false }); });
  expect(host.task.steerSubagent).toHaveBeenCalledTimes(1);
  expect(host.intents.size).toBe(0);
});
