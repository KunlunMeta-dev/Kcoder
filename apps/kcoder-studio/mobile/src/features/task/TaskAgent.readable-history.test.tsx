// Controlled component/effect host, not mounted React or Browser. Production
// AgentPanel, agent state, history, sending, queue and failed-store paths are used.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { AgentPanel } from "./TaskAgent";
import { failedTaskSubmissionsFor } from "./failedTaskSubmissions";
import { taskMessageQueue } from "@/runtime/task-message-queue";
import { stopFollowingLatest } from "@/components/message-follow-state";
import { TaskRuntime, taskRuntimeTestHelpers } from "@/runtime/task-runtime";
import { FakeClient, profile, server } from "@/runtime/task-runtime/fixture.test-support";
import type { AgentPanelProps } from "./types";
vi.hoisted(() => { Object.defineProperty(globalThis, "__DEV__", { value: false, configurable: true }); });

type Slot = { value?: unknown; deps?: unknown[]; cleanup?: void | (() => void) };
const host = vi.hoisted(() => ({ slots: [] as Slot[], cursor: 0, effects: [] as Array<() => void> }));
vi.mock("react", async original => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const slot = host.slots[host.cursor++] ??= { value: typeof initial === "function" ? (initial as () => unknown)() : initial };
    return [slot.value, (next: unknown) => { slot.value = typeof next === "function" ? (next as (value: unknown) => unknown)(slot.value) : next; }];
  },
  useRef: (initial: unknown) => (host.slots[host.cursor++] ??= { value: { current: initial } }).value,
  useMemo: (factory: () => unknown) => factory(),
  useCallback: (callback: unknown) => callback,
  useSyncExternalStore: (_subscribe: unknown, read: () => unknown) => read(),
  useEffect: (effect: () => void | (() => void), deps: unknown[] = []) => {
    const slot = host.slots[host.cursor++] ??= {};
    if (slot.deps && deps.length === slot.deps.length && deps.every((value, index) => Object.is(value, slot.deps![index]))) return;
    slot.deps = deps;
    host.effects.push(() => { if (typeof slot.cleanup === "function") slot.cleanup(); slot.cleanup = effect(); });
  },
}));
vi.mock("@/i18n/use-locale", () => ({ useLocale: () => "zh-CN" }));
vi.mock("expo-router", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }), useIsFocused: () => true }));
vi.mock("expo-clipboard", () => ({ setStringAsync: vi.fn(async () => true) }));
vi.mock("@/components/keyboard-safe-view", () => ({ KeyboardSafeView: "KeyboardSafeView" }));
vi.mock("react-native", () => ({
  Appearance: { getColorScheme: () => "dark", addChangeListener: () => ({ remove() {} }) },
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Platform: { OS: "web" }, AppState: { addEventListener: () => ({ remove() {} }) },
  Keyboard: { dismiss() {} }, View: "View", Text: "Text", Pressable: "Pressable", ScrollView: "ScrollView", ActivityIndicator: "ActivityIndicator",
}));
vi.mock("lucide-react-native", () => ({ ArchiveRestore: "ArchiveRestore", ArrowDown: "ArrowDown", ChevronDown: "ChevronDown", X: "X" }));
vi.mock("react-native-svg", () => ({ default: "Svg", Path: "Path" }));
vi.mock("./taskStyles", () => ({ useTaskAppearance: () => ({ styles: {}, colors: {} }) }));
vi.mock("@/components/interaction-cards", () => ({ ApprovalCard: "ApprovalCard", QuestionCard: "QuestionCard", AsyncQuestionCard: "AsyncQuestionCard", AsyncQuestionListError: "AsyncQuestionListError" }));
vi.mock("./TaskAttachments", () => ({ StagedAttachmentChip: "StagedAttachmentChip" }));
vi.mock("./TaskComposer", () => ({ TaskComposer: "TaskComposer", ComposerMetaRow: "ComposerMetaRow" }));
vi.mock("./TaskPermissionSelector", () => ({ TaskPermissionSelector: "TaskPermissionSelector" }));
vi.mock("./TaskExpertSelector", () => ({ LiveTaskExpertSelector: "LiveTaskExpertSelector" }));
vi.mock("./TaskInteractions", () => ({ TaskInteractions: "TaskInteractions" }));
vi.mock("./TaskSubagents", () => ({ TaskSubagents: "TaskSubagents", taskSubagentViewKey: () => "subagents" }));
vi.mock("./TaskTranscript", () => ({ TaskTranscript: "TaskTranscript", JumpToLatestButton: "JumpToLatestButton" }));
// Picker/platform and model sheet hooks are observation boundaries here. They
// must never run in the read-only parent; their own behavior has separate suites.
vi.mock("./useTaskAttachments", () => ({ useTaskAttachments: vi.fn(context => context) }));
vi.mock("./useTaskModelPreferences", () => ({ useTaskModelPreferences: vi.fn(context => context) }));
import { useTaskAttachments } from "./useTaskAttachments";
import { useTaskModelPreferences } from "./useTaskModelPreferences";

function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as ReactNode)];
}
function render(props: AgentPanelProps & { workspaceReady: boolean }) {
  host.cursor = 0; host.effects = [];
  return elements(AgentPanel(props));
}
function commit() { host.effects.splice(0).forEach(effect => effect()); }
const runtimes = new Set<TaskRuntime>();
beforeEach(() => { host.slots = []; host.cursor = 0; host.effects = []; vi.useFakeTimers(); vi.clearAllMocks(); });
afterEach(() => { host.slots.forEach(slot => { if (typeof slot.cleanup === "function") slot.cleanup(); }); vi.useRealTimers(); for (const task of runtimes) task.close(); runtimes.clear(); taskRuntimeTestHelpers.resetConnector(); });

it("does not consume empty hydration or run mutation hooks, then preserves follow refs and restores the real queue/failed row", async () => {
  const client = new FakeClient([{ id: "visible", role: "user", content: "visible history", timestampMs: 1 }]);
  taskRuntimeTestHelpers.setConnector(async () => client as never);
  const task = await TaskRuntime.resume({ profile, server, threadId: "thread-1" }); runtimes.add(task);
  const failed = failedTaskSubmissionsFor(task), hydrate = vi.spyOn(failed, "hydrateOnce");
  const onDraftChange = vi.fn(), onQueuedMessagesChange = vi.fn();
  const base: AgentPanelProps = { task, profile, server, demo: false, bottomInset: 0,
    onDraftChange, onQueuedMessagesChange, onOpenFile: () => false, onOpenChanges() {} };
  let tree = render({ ...base, workspaceReady: false }); commit();
  await vi.advanceTimersByTimeAsync(400);
  const transcript = tree.find(element => element.type === "TaskTranscript")!;
  const model = transcript.props.model as ReturnType<typeof import("./useTaskHistory").useTaskHistory<ReturnType<typeof import("./useTaskAgentState").useTaskAgentState>>>;
  expect(transcript.props.readOnly).toBe(true); expect(model.snapshot.messages[0].content).toBe("visible history");
  expect(hydrate).not.toHaveBeenCalled(); expect(taskMessageQueue(task).getSnapshot()).toEqual([]);
  expect(onDraftChange).not.toHaveBeenCalled(); expect(onQueuedMessagesChange).not.toHaveBeenCalled();
  expect(useTaskAttachments).not.toHaveBeenCalled(); expect(useTaskModelPreferences).not.toHaveBeenCalled();
  expect(tree.some(element => typeof element.type === "function" && element.type.name === "TaskWritablePanel")).toBe(false);
  const follow = stopFollowingLatest(); model.messageFollowState.current = follow;
  model.messageListLayoutHeight.current = 321;
  const restored = { ...base, workspaceReady: true, initialDraft: "restored draft",
    initialQueuedMessages: [{ id: "queue-original", content: "queued", createdAt: 1, attachments: [] }],
    initialFailedSubmissions: [{ id: "failed-original", content: "recover", createdAt: 1, attachments: [], outcome: "unknown" as const }] };
  tree = render(restored); commit(); tree = render(restored);
  const next = tree.find(element => element.type === "TaskTranscript")!;
  const nextModel = next.props.model as typeof model;
  expect(nextModel.messageListRef).toBe(model.messageListRef);
  expect(nextModel.webPrependAnchor).toBe(model.webPrependAnchor);
  expect(nextModel.messageFollowState.current).toBe(follow);
  expect(nextModel.messageListLayoutHeight.current).toBe(321);
  expect(taskMessageQueue(task).getSnapshot()[0]?.id).toBe("queue-original");
  expect(next.props.readOnly).toBe(false);
  // Execute the actual newly mounted writable child with independent hook slots.
  const child = tree.find(element => typeof element.type === "function" && element.type.name === "TaskWritablePanel")!;
  const parentSlots = host.slots; host.slots = []; host.cursor = 0; host.effects = [];
  (child.type as (props: Record<string, unknown>) => ReactNode)(child.props);
  expect(hydrate).toHaveBeenCalledWith(restored.initialFailedSubmissions);
  expect(failed.getSnapshot()[0]?.id).toBe("failed-original");
  expect(useTaskAttachments).toHaveBeenCalledTimes(1); expect(useTaskModelPreferences).toHaveBeenCalledTimes(1);
  host.slots = parentSlots;
});


class AsyncQuestionClient extends FakeClient {
  read?: () => Promise<unknown>;
  constructor(readonly question: import("@/runtime/task-runtime").AsyncQuestionRecord) { super([]); }
  override matchesRuntimeOwner(): boolean { return true; }
  override supportsExperimental(capability: string): boolean { return capability === "asyncUserQuestionsV1"; }
  override async request<T>(method: string, params: import("@/gateway/rpc").JsonRecord = {}): Promise<T> {
    if (method === "asyncQuestion/list") return (this.read ? await this.read()
      : { threadId: this.question.threadId, questions: [this.question] }) as T;
    return super.request<T>(method, params);
  }
}

function questionCard(task: TaskRuntime) {
  const tree = render({ task, profile, server, demo: false, bottomInset: 0, workspaceReady: true,
    onOpenFile: () => false, onOpenChanges() {} });
  const child = tree.find(element => typeof element.type === "function" && element.type.name === "TaskWritablePanel")!;
  const parentSlots = host.slots; host.slots = []; host.cursor = 0; host.effects = [];
  try {
    const controls = elements((child.type as (props: Record<string, unknown>) => ReactNode)(child.props));
    return controls.find(element => element.type === "AsyncQuestionCard")!;
  } finally {
    host.slots.forEach(slot => { if (typeof slot.cleanup === "function") slot.cleanup(); });
    host.slots = parentSlots;
  }
}

it.each(["pending", "queued"] as const)(
  "%s card waits for the replacement connection's first confirmed list, preserving ordinary refresh input", async status => {
    const question: import("@/runtime/task-runtime").AsyncQuestionRecord = {
      questionId: "question", requestId: "request", threadId: "thread-1", sourceTurnId: "turn",
      toolCallId: "tool", revision: 1, createdAtMs: 1, status,
      questions: [{ id: "mode", header: "Mode", question: "Which mode?", multiSelect: false, options: [] }],
      ...(status === "queued" ? { answer: { submissionId: "saved", acceptedAtMs: 2,
        answers: { mode: { text: "Original answer" } } } } : {}),
    };
    const client = new AsyncQuestionClient(question);
    taskRuntimeTestHelpers.setConnector(async () => client as never);
    const task = await TaskRuntime.resume({ profile, server, threadId: question.threadId,
      profileActivationEpoch: 1, isCurrentInteractionOwner: () => true }); runtimes.add(task);
    await task.refreshAsyncQuestions();
    expect(questionCard(task).props.disabled).toBe(false);
    const replacement = new AsyncQuestionClient(question);
    let finish!: (value: unknown) => void;
    replacement.read = () => new Promise(resolve => { finish = resolve; });
    taskRuntimeTestHelpers.setConnector(async () => replacement as never);
    await task.reconnectNow();
    try {
      expect(task.getSnapshot().connected).toBe(true);
      expect(task.getAsyncQuestionSnapshot()).toMatchObject({ loading: true, questions: [question] });
      expect(questionCard(task).props.disabled).toBe(true);
    } finally {
      replacement.read = undefined;
      finish({ threadId: question.threadId, questions: [question] });
      await vi.waitFor(() => expect(task.getAsyncQuestionSnapshot().loading).toBe(false));
    }
    expect(questionCard(task).props.disabled).toBe(false);
    replacement.read = () => new Promise(resolve => { finish = resolve; });
    const refresh = task.refreshAsyncQuestions();
    try { expect(questionCard(task).props.disabled).toBe(false); }
    finally { finish({ threadId: question.threadId, questions: [question] }); await refresh; }
    task.asyncQuestionSnapshot = { ...task.asyncQuestionSnapshot, error: "Original list unavailable" };
    expect(questionCard(task).props.disabled).toBe(true);
    task.asyncQuestionSnapshot = { ...task.asyncQuestionSnapshot, error: undefined };
    task.patch({ connected: false });
    expect(questionCard(task).props.disabled).toBe(true);
  },
);
