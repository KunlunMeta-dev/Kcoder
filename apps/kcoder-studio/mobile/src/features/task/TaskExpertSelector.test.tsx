import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, expect, test, vi } from "vitest";
import { initLocale } from "@/i18n";
import { LiveTaskExpertSelector, TaskExpertSelector, type TaskExpertSelectorProps } from "./TaskExpertSelector";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

vi.mock("react-native", async importOriginal => {
  const actual = await importOriginal<typeof import("react-native")>();
  return {
    ...actual,
    AppState: { addEventListener: () => ({ remove() {} }) },
    Modal: ({ visible, children }: { visible: boolean; children: React.ReactNode }) => visible ? <>{children}</> : null,
    TextInput: "TextInput",
  };
});
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock("@/components/use-modal-focus-trap", () => ({ useModalFocusTrap: () => null }));
vi.mock("./taskStyles", () => ({ useTaskAppearance: () => ({ styles: new Proxy({}, { get: () => ({}) }), colors: { text: "#fff", textMuted: "#aaa", textDim: "#888" } }) }));
vi.mock("lucide-react-native", () => Object.fromEntries(["Bot", "Check", "ChevronLeft", "Search", "X"].map(name => [name, () => null])));

const choice = {
  reference: { id: "expert-private-id", version: "2.4", definitionSha256: "a".repeat(64) },
  title: "Research guide · 2.4",
};
const directoryPage = { items: [{ id: "expert-private-id", title: "Research guide" }], nextCursor: null };
const versionPage = { items: [choice], nextCursor: null };
const button = (renderer: ReactTestRenderer, testID: string) => renderer.root.findAll(
  node => node.props.testID === testID && typeof node.props.onPress === "function",
)[0];

function props(overrides: Partial<TaskExpertSelectorProps> = {}): TaskExpertSelectorProps {
  return {
    owner: {},
    selection: null,
    disabled: false,
    loadExperts: vi.fn(async (_cursor: string | null, _signal: AbortSignal) => directoryPage),
    loadVersions: vi.fn(async (_expertId: string, _cursor: string | null, _signal: AbortSignal) => versionPage),
    onSelect: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => initLocale("en"));

test("loads versions only after opening a saved expert and selects its displayed version", async () => {
  const loadExperts = vi.fn(async (_cursor: string | null, _signal: AbortSignal) => directoryPage);
  const loadVersions = vi.fn(async (_expertId: string, _cursor: string | null, _signal: AbortSignal) => versionPage);
  const onSelect = vi.fn();
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<TaskExpertSelector {...props({ loadExperts, loadVersions, onSelect })} />); });
  await act(async () => button(renderer, "composer-expert-selector").props.onPress());
  expect(loadExperts).toHaveBeenCalledTimes(1);
  expect(loadVersions).not.toHaveBeenCalled();
  await act(async () => button(renderer, "composer-expert-item-0").props.onPress());
  expect(loadVersions).toHaveBeenCalledTimes(1);
  expect(loadVersions.mock.calls[0][0]).toBe("expert-private-id");
  expect(button(renderer, "composer-expert-option-0").props.accessibilityLabel).toBe("Research guide · 2.4");
  expect(JSON.stringify(renderer.toJSON())).not.toContain("expert-private-id");
  await act(async () => button(renderer, "composer-expert-option-0").props.onPress());
  expect(onSelect).toHaveBeenCalledWith(choice);
  await act(async () => renderer.unmount());
});

test("keeps No expert available and explains the Desktop setting when catalog access is disabled", async () => {
  const loadExperts = vi.fn(async (_cursor: string | null, _signal: AbortSignal) => { throw new Error("AGENT_EXPERTS_OFFICE_DISABLED"); });
  const onSelect = vi.fn();
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<TaskExpertSelector {...props({
    selection: choice, loadExperts, onSelect,
  })} />); });
  await act(async () => button(renderer, "composer-expert-selector").props.onPress());
  expect(JSON.stringify(renderer.toJSON())).toContain("Enable Expert Management in Desktop settings");
  expect(button(renderer, "composer-expert-none").props.disabled).toBe(false);
  await act(async () => button(renderer, "composer-expert-none").props.onPress());
  expect(onSelect).toHaveBeenCalledWith(null);
  await act(async () => renderer.unmount());
});

test("allows a draft to clear its selected expert in unsupported orchestration mode without catalog reads", async () => {
  const loadExperts = vi.fn(async (_cursor: string | null, _signal: AbortSignal) => directoryPage);
  const onSelect = vi.fn();
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<TaskExpertSelector {...props({
    selection: choice,
    nextTurn: false,
    availability: "unsupported",
    availabilityMessage: "Expert selection isn't available in orchestration sessions.",
    loadExperts,
    onSelect,
  })} />); });
  await act(async () => button(renderer, "composer-expert-selector").props.onPress());
  expect(loadExperts).not.toHaveBeenCalled();
  expect(button(renderer, "composer-expert-none").props.disabled).toBe(false);
  await act(async () => button(renderer, "composer-expert-none").props.onPress());
  expect(onSelect).toHaveBeenCalledWith(null);
  await act(async () => renderer.unmount());
});

test("an external menu request opens the selector from a recoverable current-read error without rendering its Composer trigger", async () => {
  const onRetryCurrent = vi.fn();
  const openRequest = {};
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<TaskExpertSelector {...props({
    selection: undefined,
    availability: "error",
    availabilityMessage: "The current expert could not be read.",
    onRetryCurrent,
    openRequest,
    hideTrigger: true,
  })} />); });
  expect(renderer.root.findAllByProps({ testID: "composer-expert-selector" })).toHaveLength(0);
  expect(button(renderer, "composer-expert-retry-current")).toBeDefined();
  await act(async () => button(renderer, "composer-expert-retry-current").props.onPress());
  expect(onRetryCurrent).toHaveBeenCalledTimes(1);
  await act(async () => button(renderer, "composer-expert-close").props.onPress());
  await act(async () => renderer.update(<TaskExpertSelector {...props({
    selection: undefined,
    availability: "error",
    availabilityMessage: "The current expert could not be read.",
    onRetryCurrent,
    openRequest,
    hideTrigger: true,
  })} />));
  expect(renderer.root.findAllByProps({ testID: "composer-expert-close" })).toHaveLength(0);
  await act(async () => renderer.unmount());
});

test("an external request shows the initial binding read and loads the directory when it becomes ready", async () => {
  const binding = { threadId: "thread-live", revision: 1, turns: [], expert: null };
  let resolveRead!: (value: typeof binding) => void;
  const snapshot = { threadId: "thread-live", cwd: "/workspace", connected: true, configurationReady: true };
  const task = {
    client: {}, clientGeneration: 1, runtimeInstanceNonce: 1, reconnectContext: {}, snapshot,
    supportsExperts: () => true, isDisposed: () => false,
    readExpert: vi.fn(() => new Promise<typeof binding>(resolve => { resolveRead = resolve; })),
    selectExpert: vi.fn(),
    listExperts: vi.fn(async (_language: string, _cursor?: string, _signal?: AbortSignal) => directoryPage),
    listExpertVersions: vi.fn(async (_expertId: string, _cursor?: string, _signal?: AbortSignal) => versionPage),
  };
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<LiveTaskExpertSelector owner={{}} busyOwner={{}}
    task={task as never} snapshot={snapshot as never} scopeActive hideTrigger openRequest={{}} />); });
  expect(renderer.root.findAllByProps({ testID: "composer-expert-selector" })).toHaveLength(0);
  expect(renderer.root.findAllByProps({ testID: "task-expert-selector-sheet" })).toHaveLength(1);
  expect(JSON.stringify(renderer.toJSON())).toContain("Checking the current expert selection");
  expect(task.listExperts).not.toHaveBeenCalled();
  await act(async () => { resolveRead(binding); await Promise.resolve(); });
  expect(task.listExperts).toHaveBeenCalledTimes(1);
  expect(button(renderer, "composer-expert-item-0")).toBeDefined();
  await act(async () => renderer.unmount());
});

test("keeps send locked after an unknown CAS until one authoritative read succeeds", async () => {
  const binding = {
    threadId: "thread-live",
    revision: 8,
    turns: [],
    expert: { definition: { ...choice.reference, version: "2.3", definitionSha256: "b".repeat(64) }, title: "Research guide", source: "expert" },
  };
  let readCount = 0;
  const snapshot = { threadId: "thread-live", cwd: "/workspace", connected: true, configurationReady: true };
  const task = {
    client: {},
    clientGeneration: 1,
    runtimeInstanceNonce: 1,
    reconnectContext: {},
    snapshot,
    supportsExperts: () => true,
    isDisposed: () => false,
    readExpert: vi.fn(async (_signal?: AbortSignal) => {
      readCount += 1;
      if (readCount === 2) throw new Error("lost read receipt");
      return binding;
    }),
    selectExpert: vi.fn(async () => { throw new Error("CAS receipt lost"); }),
    listExperts: vi.fn(async (_language: string, _cursor?: string, _signal?: AbortSignal) => directoryPage),
    listExpertVersions: vi.fn(async (_expertId: string, _cursor?: string, _signal?: AbortSignal) => versionPage),
  };
  const onBusyChange = vi.fn();
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<LiveTaskExpertSelector owner={{}} busyOwner={{}} task={task as never}
    snapshot={snapshot as never} scopeActive onBusyChange={onBusyChange} />); });
  expect(renderer.root.findByProps({ testID: "composer-expert-selector" }).props.accessibilityLabel).toContain("Research guide · 2.3");
  await act(async () => button(renderer, "composer-expert-selector").props.onPress());
  await act(async () => button(renderer, "composer-expert-item-0").props.onPress());
  await act(async () => button(renderer, "composer-expert-option-0").props.onPress());
  expect(task.selectExpert).toHaveBeenCalledTimes(1);
  expect(onBusyChange.mock.calls[onBusyChange.mock.calls.length - 1]?.[0]).toBe(true);
  await act(async () => button(renderer, "composer-expert-retry-current").props.onPress());
  expect(task.readExpert).toHaveBeenCalledTimes(3);
  expect(task.selectExpert).toHaveBeenCalledTimes(1);
  expect(onBusyChange.mock.calls[onBusyChange.mock.calls.length - 1]?.[0]).toBe(false);
  expect(renderer.root.findByProps({ testID: "composer-expert-selector" }).props.accessibilityLabel).toContain("Research guide · 2.3");
  task.clientGeneration = 2;
  await act(async () => button(renderer, "composer-expert-option-0").props.onPress());
  expect(task.selectExpert).toHaveBeenCalledTimes(1);
  await act(async () => renderer.unmount());
});

test("a same-thread reconnect keeps the lost-CAS lock until the new generation can read the binding", async () => {
  const binding = {
    threadId: "thread-live",
    revision: 8,
    turns: [],
    expert: { definition: { ...choice.reference, version: "2.3", definitionSha256: "b".repeat(64) }, title: "Research guide", source: "expert" },
  };
  let readCount = 0;
  let rejectMutation!: (reason: Error) => void;
  const snapshot = { threadId: "thread-live", cwd: "/workspace", connected: true, configurationReady: true };
  const task = {
    client: {},
    clientGeneration: 1,
    runtimeInstanceNonce: 1,
    reconnectContext: {},
    snapshot,
    supportsExperts: () => true,
    isDisposed: () => false,
    readExpert: vi.fn(async (_signal?: AbortSignal) => {
      readCount += 1;
      if (readCount === 2) throw new Error("new generation read failed");
      return binding;
    }),
    selectExpert: vi.fn(() => new Promise((_resolve, reject) => { rejectMutation = reject; })),
    listExperts: vi.fn(async (_language: string, _cursor?: string, _signal?: AbortSignal) => directoryPage),
    listExpertVersions: vi.fn(async (_expertId: string, _cursor?: string, _signal?: AbortSignal) => versionPage),
  };
  const firstOwner = {};
  const nextOwner = {};
  const busyOwner = {};
  const onBusyChange = vi.fn();
  let renderer!: ReactTestRenderer;
  const panel = (owner: object, openRequest?: object, hideTrigger = false) => <LiveTaskExpertSelector owner={owner} busyOwner={busyOwner}
    task={task as never} snapshot={snapshot as never} scopeActive openRequest={openRequest} hideTrigger={hideTrigger} onBusyChange={onBusyChange} />;
  await act(async () => { renderer = create(panel(firstOwner)); });
  await act(async () => button(renderer, "composer-expert-selector").props.onPress());
  await act(async () => button(renderer, "composer-expert-item-0").props.onPress());
  await act(async () => button(renderer, "composer-expert-option-0").props.onPress());
  expect(task.selectExpert).toHaveBeenCalledTimes(1);
  expect(onBusyChange.mock.calls[onBusyChange.mock.calls.length - 1]?.[0]).toBe(true);

  task.clientGeneration = 2;
  await act(async () => { renderer.update(panel(nextOwner, undefined, true)); await Promise.resolve(); });
  expect(task.readExpert).toHaveBeenCalledTimes(2);
  await act(async () => { rejectMutation(new Error("lost CAS receipt")); await Promise.resolve(); });
  expect(task.selectExpert).toHaveBeenCalledTimes(1);
  expect(task.readExpert).toHaveBeenCalledTimes(2);
  expect(onBusyChange.mock.calls[onBusyChange.mock.calls.length - 1]?.[0]).toBe(true);

  const recoveryRequest = {};
  await act(async () => renderer.update(panel(nextOwner, recoveryRequest, true)));
  expect(button(renderer, "composer-expert-retry-current")).toBeDefined();
  await act(async () => button(renderer, "composer-expert-retry-current").props.onPress());
  expect(task.readExpert).toHaveBeenCalledTimes(3);
  expect(task.selectExpert).toHaveBeenCalledTimes(1);
  expect(onBusyChange.mock.calls[onBusyChange.mock.calls.length - 1]?.[0]).toBe(false);
  expect(renderer.root.findAllByProps({ testID: "composer-expert-selector" })).toHaveLength(0);
  expect(button(renderer, "composer-expert-item-0").props.accessibilityState.selected).toBe(true);
  await act(async () => renderer.unmount());
});
