import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import type { InteractionInboxRow } from "@/runtime/task-runtime/types";

type HookSlot = { value?: any; deps?: unknown[]; cleanup?: void | (() => void) };
const host = vi.hoisted(() => ({ slots: [] as HookSlot[], cursor: 0, effects: [] as Array<() => void> }));

vi.mock("react", async (importOriginal) => {
  const original = await importOriginal<typeof import("react")>();
  const sameDeps = (left?: unknown[], right?: unknown[]) => Boolean(left && right &&
    left.length === right.length && left.every((value, index) => Object.is(value, right[index])));
  return {
    ...original,
    useState: (initial: unknown) => {
      const slot = host.slots[host.cursor++] ??= { value: typeof initial === "function" ? (initial as () => unknown)() : initial };
      return [slot.value, (next: unknown) => {
        slot.value = typeof next === "function" ? (next as (value: unknown) => unknown)(slot.value) : next;
      }];
    },
    useRef: (initial: unknown) => (host.slots[host.cursor++] ??= { value: { current: initial } }).value,
    useCallback: (callback: unknown, deps: unknown[]) => {
      const slot = host.slots[host.cursor++] ??= {};
      if (!sameDeps(slot.deps, deps)) { slot.deps = deps; slot.value = callback; }
      return slot.value;
    },
    useMemo: (factory: () => unknown, deps: unknown[]) => {
      const slot = host.slots[host.cursor++] ??= {};
      if (!sameDeps(slot.deps, deps)) { slot.deps = deps; slot.value = factory(); }
      return slot.value;
    },
    useEffect: (effect: () => void | (() => void), deps: unknown[] = []) => {
      const slot = host.slots[host.cursor++] ??= {};
      if (sameDeps(slot.deps, deps)) return;
      slot.deps = deps;
      host.effects.push(() => { slot.cleanup?.(); slot.cleanup = effect(); });
    },
  };
});

vi.mock("@/i18n", () => ({ t: (key: string) => key }));
vi.mock("@/i18n/use-locale", () => ({ useLocale: () => "en" }));
vi.mock("@/storage/interface-version", () => ({ useInterfaceVersion: () => "v3" }));
vi.mock("./TaskSubagentView", () => ({ TaskSubagentPanel: "Modal", TaskSubagentList: "TaskSubagentList", TaskSubagentTranscript: "TaskSubagentTranscript", TaskSubagentInstructionInput: "TaskSubagentInstructionInput", subagentStatusLabel: (value: string) => value }));
vi.mock("./TaskSubagentConversation", () => ({ TaskSubagentConversation: "TaskSubagentConversation" }));
vi.mock("@/components/ui", () => ({ Button: "Button" }));
vi.mock("@/components/interaction-cards", () => ({
  QuestionCard: "QuestionCard",
  interactionCardIdentity: (question: { requestId: number; questionId: string; owner: { appServerEpoch: string } }) =>
    `${question.requestId}:${question.questionId}:${question.owner.appServerEpoch}`,
}));
vi.mock("@/theme", () => ({
  spacing: { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 },
  useThemedStyles: () => ({ colors: {}, styles: {} }),
}));
vi.mock("@/state/profile-coordinator", () => ({ profileAuthorizationScopeKey: () => "scope-a" }));
vi.mock("@/runtime/task-runtime/threadDirectory", () => ({
  interactionServerIdentity: () => "target-a",
}));
vi.mock("@/state/AppContext", () => ({
  useApp: () => ({
    activeProfile: profile,
    runtime: { servers: [server], serversReady: true, reauthorizationRequired: false },
    demo: false,
    runtimeActivationEpoch: 3,
    isCurrentInteractionOwner: () => true,
  }),
}));
vi.mock("@/runtime/task-runtime", () => ({
  taskRuntimeRegistry: {
    interactionInboxRows: () => [routeRow],
    entries: () => [{ profileId: "profile-a", serverId: "server-a", threadId: "parent-thread", runtime: task }],
  },
}));
vi.mock("react-native-safe-area-context", () => ({ SafeAreaView: "SafeAreaView" }));
vi.mock("react-native", () => ({
  ActivityIndicator: "ActivityIndicator",
  KeyboardAvoidingView: "KeyboardAvoidingView",
  Modal: "Modal",
  Platform: { OS: "web" },
  ScrollView: "ScrollView",
  StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1 },
  Text: "Text",
  TextInput: "TextInput",
  View: "View",
}));

import { TaskSubagents } from "./TaskSubagents";

const profile = {
  id: "profile-a", label: "Current", baseUrl: "https://gateway.invalid",
  accessToken: "secret", refreshToken: "refresh", authorizationGeneration: "auth-a",
};
const server = {
  id: "server-a", label: "Target A", observationTargetIdentity: "target-a", transport: "local",
};
const routeRow: InteractionInboxRow = {
  profileId: "profile-a", profileAuthorizationScopeKey: "scope-a", serverId: "server-a",
  appServerId: "server-engine-S",
  serverConfigIdentity: "target-a", threadId: "parent-thread", title: "parent", cwd: "/workspace",
  kind: "question", requestId: 9, interactionId: "question-9",
  sourceAgent: { parentSessionId: "parent-thread", agentId: "agent-9" },
  turnId: "turn-9", appServerEpoch: "epoch-9", runtimeInstanceNonce: 4,
  profileActivationEpoch: 3, originClientGeneration: 2, status: "pending", liveActionable: false,
};
const task = {
  snapshot: { threadId: "parent-thread", cwd: "/workspace", connected: false },
  reconnectContext: { profile, server, profileActivationEpoch: 3 },
  runtimeInstanceNonce: 4,
  clientGeneration: 3,
  client: { isTransportOpen: () => false },
  reconnecting: true,
  pendingInteractions: [],
  isDisposed: () => false,
  getSnapshot: () => ({ connected: false }),
  agentCapabilities: () => ({ discover: false, pages: false, commands: false }),
  isInteractionActionable: () => false,
} as any;
const routeFocus = {
  kind: "question" as const,
  requestId: 9,
  interactionId: "question-9",
  turnId: "turn-9",
  appServerEpoch: "epoch-9",
  agentId: "agent-9",
  parentSessionId: "parent-thread",
  status: "pending" as const,
  liveActionable: false,
};

function children(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(children);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...children(node.props.children as ReactNode)];
}

beforeEach(() => {
  host.slots = [];
  host.cursor = 0;
  host.effects = [];
  vi.useFakeTimers();
});

afterEach(() => {
  host.slots.forEach((slot) => slot.cleanup?.());
  vi.useRealTimers();
});

describe("TaskSubagents route focus", () => {
  it("opens and selects the exact source agent for a disconnected row as readonly", () => {
    host.cursor = 0;
    let tree = TaskSubagents({ task, bottomInset: 0, sourceAgentRouteFocus: routeFocus });
    host.effects.splice(0).forEach((effect) => effect());

    host.cursor = 0;
    tree = TaskSubagents({ task, bottomInset: 0, sourceAgentRouteFocus: routeFocus });
    const rendered = children(tree);
    const modal = rendered.find((element) => element.type === "Modal");
    const selectedAgent = rendered.find((element) => element.props.testID === "subagent-route-focus-readonly");

    expect(modal?.props.visible).toBe(true);
    expect(selectedAgent).toBeDefined();
    expect(JSON.stringify(selectedAgent?.props.children)).toContain("agent-9");
    expect(rendered.some((element) => element.type === "QuestionCard")).toBe(false);
  });
});
