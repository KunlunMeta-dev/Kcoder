import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { shouldAnchorLatest } from "@/components/message-follow-state";
import { AgentPanel } from "./TaskAgent";
import { TaskTranscript } from "./TaskTranscript";
type TaskTranscriptModel = Parameters<typeof TaskTranscript>[0]["model"];

// Direct production-hook/component calls with a deterministic hook and RAF
// host. This is not a mounted React or browser test.
// The pre-change source-derived failure points were useTaskHistory.ts
// d533eeb204d389c445429ed96ad6985f5f4accab0f3cf64e3e17c4bf6423d012
// (layout RAF captured only a boolean) and TaskAgent.tsx
// 6512651abb300455df037283fba30ad85305736aa24384faae2d4b2b795fbce2
// (latest jump did not invalidate an older-page anchor). Those snapshots were
// not dynamically run here.
const harness = vi.hoisted(() => ({
  context: null as any,
  model: null as any,
  refs: [] as { current: unknown }[],
  refCursor: 0,
  platformOS: "web",
  layoutEffects: [] as (() => void | (() => void))[],
}));

vi.mock("react", async importOriginal => ({
  ...await importOriginal<typeof import("react")>(),
  useCallback: (callback: (...args: any[]) => any) => callback,
  useMemo: <T>(factory: () => T) => factory(),
  useLayoutEffect: (effect: () => void | (() => void)) => {
    harness.layoutEffects.push(effect);
  },
  useRef: (initial: unknown) => {
    const index = harness.refCursor++;
    harness.refs[index] ??= { current: initial };
    return harness.refs[index];
  },
}));

vi.mock("react-native", () => ({
  ActivityIndicator: "ActivityIndicator",
  FlatList: "FlatList",
  Platform: { get OS() { return harness.platformOS; } },
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  Text: "Text",
  View: "View",
}));

vi.mock("@/i18n", () => ({ t: (key: string) => key }));
vi.mock("@/i18n/use-locale", () => ({ useLocale: () => "en" }));
vi.mock("@/theme", () => ({
  colors: new Proxy({}, { get: (_target, key) => key }),
  spacing: new Proxy({}, { get: (_target, key) => key }),
}));
vi.mock("lucide-react-native", () => ({
  ArchiveRestore: () => null,
  ArrowDown: () => null,
  Bot: () => null,
  ChevronDown: () => null,
  X: () => null,
}));
vi.mock("@/components/interaction-cards", () => ({
  ApprovalCard: () => null,
  QuestionCard: () => null,
}));
vi.mock("@/components/ui", () => ({ EmptyState: () => null }));
vi.mock("@/storage/new-workspace-preferences", () => ({
  reasoningEffortLabel: (value: string) => value,
}));
vi.mock("./TaskAttachments", () => ({ StagedAttachmentChip: () => null }));
vi.mock("./TaskComposer", () => ({ TaskComposer: () => null }));
vi.mock("./TaskInteractions", () => ({ TaskInteractions: () => null }));
vi.mock("./TaskSubagents", () => ({
  TaskSubagents: () => null,
  taskSubagentViewKey: () => "task-view",
}));
vi.mock("./MessageBubble", () => ({ MessageBubble: () => null }));
vi.mock("./RuntimeErrorBanner", () => ({ RuntimeErrorBanner: () => null }));
vi.mock("./taskStyles", () => ({
  styles: new Proxy({}, { get: (_target, key) => key }),
  useTaskAppearance: () => ({
    styles: new Proxy({}, { get: (_target, key) => key }),
    colors: new Proxy({}, { get: (_target, key) => key }),
  }),
}));
vi.mock("./useTaskAgentState", () => ({
  useTaskAgentState: () => harness.context,
}));
vi.mock("./useTaskCommands", () => ({
  useTaskCommands: (context: unknown) => context,
}));
vi.mock("./useTaskSending", () => ({
  useTaskSending: (context: unknown) => context,
}));
vi.mock("./useTaskAttachments", () => ({
  useTaskAttachments: (context: unknown) => context,
}));
vi.mock("./useTaskModelPreferences", () => ({
  useTaskModelPreferences: (model: unknown) => {
    harness.model = model;
    return model;
  },
}));

type Frame = (time: number) => void;
let nextFrameId = 1;
let frames: Map<number, Frame>;

function scheduleFrame(callback: Frame): number {
  const id = nextFrameId++;
  frames.set(id, callback);
  return id;
}

function runNextFrame(): boolean {
  const next = frames.entries().next().value as [number, Frame] | undefined;
  if (!next) return false;
  frames.delete(next[0]);
  next[1](0);
  return true;
}

function drainFrames(): void {
  let count = 0;
  while (runNextFrame()) {
    count++;
    if (count > 40) throw new Error("RAF queue did not settle within 40 frames");
  }
}

function findByTestId(node: any, testID: string): any {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findByTestId(child, testID);
      if (found) return found;
    }
    return undefined;
  }
  if (!node || typeof node !== "object") return undefined;
  if (node.props?.testID === testID) return node;
  return findByTestId(node.props?.children, testID);
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

type FakeWheelListener = EventListenerOrEventListenerObject;

class FakeWheelDomHost extends EventTarget {
  readonly nodeType = 1;

  contains(node: unknown): boolean {
    return node === this;
  }

  clientHeight = 400;
  isConnected = true;
  scrollHeight = 1000;
  scrollTop = 400;
  readonly addCalls: { type: string; capture: boolean; passive: boolean }[] = [];
  readonly removeCalls: { type: string; capture: boolean }[] = [];
  private readonly registrations: { type: string; listener: FakeWheelListener; capture: boolean }[] = [];

  override addEventListener(
    type: string,
    listener: FakeWheelListener | null,
    options?: boolean | AddEventListenerOptions,
  ): void {
    const capture = typeof options === "boolean" ? options : Boolean(options?.capture);
    const passive = typeof options === "object" ? Boolean(options.passive) : false;
    this.addCalls.push({ type, capture, passive });
    if (listener) this.registrations.push({ type, listener, capture });
    super.addEventListener(type, listener, options);
  }

  override removeEventListener(
    type: string,
    listener: FakeWheelListener | null,
    options?: boolean | EventListenerOptions,
  ): void {
    const capture = typeof options === "boolean" ? options : Boolean(options?.capture);
    this.removeCalls.push({ type, capture });
    const index = this.registrations.findIndex(registered =>
      registered.type === type && registered.listener === listener && registered.capture === capture);
    if (index >= 0) this.registrations.splice(index, 1);
    // Node's EventTarget does not normalize a boolean capture argument the
    // same way browser EventTarget does. Pass the DOM capture option explicitly
    // so this test host removes the exact production registration.
    super.removeEventListener(type, listener, { capture });
  }

  listenerCount(type: string): number {
    return this.registrations.filter(registered => registered.type === type).length;
  }

  dispatchWheel(deltaX: number, deltaY: number): void {
    const event = new Event("wheel");
    Object.defineProperties(event, {
      deltaX: { enumerable: true, value: deltaX },
      deltaY: { enumerable: true, value: deltaY },
    });
    this.dispatchEvent(event);
  }

  getBoundingClientRect(): DOMRect {
    return {
      x: 0, y: 0, top: 0, right: 320, bottom: this.clientHeight, left: 0,
      width: 320, height: this.clientHeight, toJSON: () => ({}),
    };
  }
}

let activeEffectCleanups: (() => void)[] = [];

function trackEffectCleanup(cleanup: () => void): () => void {
  let active = true;
  const ownedCleanup = () => {
    if (!active) return;
    active = false;
    cleanup();
  };
  activeEffectCleanups.push(ownedCleanup);
  return ownedCleanup;
}

function makeContext(loadOlderMessages: () => Promise<void> = async () => {}) {
  const scroller = new FakeWheelDomHost();
  const latestRequestHeights: number[] = [];
  // This direct scrollToEnd spy serves the native-list path. On Web the
  // production geometry adapter intercepts scrollToEnd and calls raw
  // scrollToOffset({offset: 0}); Web assertions observe that raw request.
  const scrollToEnd = vi.fn(() => latestRequestHeights.push(scroller.scrollHeight));
  const scrollToOffset = vi.fn((options: { offset: number; animated?: boolean }) => {
    const maximum = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    scroller.scrollTop = Math.max(0, Math.min(maximum, options.offset));
    if (options.offset === 0) latestRequestHeights.push(scroller.scrollHeight);
  });
  const list = {
    getNativeScrollRef: () => scroller,
    scrollToEnd,
    scrollToOffset,
  };
  const context: any = {
    task: { loadOlderMessages: vi.fn(loadOlderMessages) },
    snapshot: {
      activeTurnId: undefined,
      archivedAt: undefined,
      connected: true,
      continuationPending: false,
      error: undefined,
      hasMoreBefore: true,
      interaction: null,
      interactionCount: 0,
      loadingOlder: false,
      messages: [],
      model: undefined,
      pendingTurnPreferences: undefined,
      reasoningEffort: undefined,
      running: false,
      sendAcceptanceUnknown: false,
    },
    bottomInset: 0,
    queuedMessages: [],
    attachments: [],
    attachmentError: null,
    unarchiveError: null,
    setUnarchiveError: vi.fn(),
    unarchiving: false,
    setUnarchiving: vi.fn(),
    queueError: null,
    composerNotice: null,
    messageListRef: { current: list },
    messageListLayoutHeight: { current: 0 },
    messageFollowState: {
      current: { followsLatest: true, programmaticFollow: false, awaitingDistanceAway: false },
    },
    webPrependAnchor: { current: null as any },
    mountedRef: { current: true },
    mountGeneration: { current: 1 },
    showJumpToLatest: true,
    setShowJumpToLatest: vi.fn(),
    slashCommands: [],
    selectSlashCommand: vi.fn(),
    removeQueuedMessage: vi.fn(),
    removeAttachment: vi.fn(),
    openModelPicker: vi.fn(),
    selectedModelOption: undefined,
    scroller,
    scrollToEnd,
    scrollToOffset,
    latestRequestHeights,
  };
  context.setShowJumpToLatest = vi.fn((next: boolean | ((current: boolean) => boolean)) => {
    context.showJumpToLatest = typeof next === "function"
      ? next(context.showJumpToLatest)
      : next;
  });
  return context;
}

function renderActualConsumers(context: any) {
  harness.context = context;
  harness.model = null;
  harness.refCursor = 0;
  harness.refs = [];
  harness.layoutEffects = [];
  const panel = AgentPanel({} as never);
  const jumpButton = findByTestId(panel, "jump-to-latest");
  const transcriptRefStart = harness.refCursor;
  const transcript = TaskTranscript({ model: harness.model });
  const list = findByTestId(transcript, "message-list");
  if (!jumpButton || !list) throw new Error("actual route consumers did not expose expected controls");

  if (harness.platformOS === "web") {
    const ref = list.props.ref;
    if (typeof ref !== "function") throw new Error("production Web list ref was not exposed");
    // Bind the exact context list object so the production adapter reaches its
    // observable raw scrollToOffset implementation.
    ref(context.messageListRef.current);
  }
  const cleanups = harness.layoutEffects
    .map(effect => effect())
    .filter((cleanup): cleanup is () => void => typeof cleanup === "function")
    .map(trackEffectCleanup);

  return {
    model: harness.model, panel, jumpButton, list: list.props, wheelHost: context.scroller,
    dispose() { cleanups.forEach(cleanup => cleanup()); },
    rerenderTranscript(nextModel: TaskTranscriptModel) {
      harness.refCursor = transcriptRefStart;
      harness.layoutEffects = [];
      const nextTree = TaskTranscript({ model: nextModel });
      const nextList = findByTestId(nextTree, "message-list");
      if (!nextList) throw new Error("rerendered TaskTranscript did not expose its production list");
      return nextList.props;
    },
  };
}

function renderNativeConsumers(context: any) {
  harness.platformOS = "ios";
  return renderActualConsumers(context);
}

function nativeScrollEvent(context: any, y: number) {
  return {
    nativeEvent: {
      contentOffset: { y },
      contentSize: { height: context.scroller.scrollHeight },
      layoutMeasurement: { height: context.scroller.clientHeight },
    },
  };
}

function nativeScroll(listProps: any, context: any, y: number): void {
  context.scroller.scrollTop = y;
  listProps.onScroll(nativeScrollEvent(context, y));
}

function userWheelTowardOlder(listProps: any, context: any, nextRawTop: number): void {
  // This fake dispatch runs TaskTranscript's capture callback; it does not run
  // RNW's default wheel handler. Supply the resulting inverted-list raw offset.
  context.scroller.dispatchWheel(0, -25);
  context.scroller.scrollTop = nextRawTop;
  listProps.onScroll({
    nativeEvent: {
      contentOffset: { y: nextRawTop },
      contentSize: { height: context.scroller.scrollHeight },
      layoutMeasurement: { height: context.scroller.clientHeight },
    },
  });
}

beforeEach(() => {
  harness.context = null;
  harness.model = null;
  harness.refs = [];
  harness.refCursor = 0;
  harness.platformOS = "web";
  frames = new Map();
  nextFrameId = 1;
  vi.stubGlobal("requestAnimationFrame", scheduleFrame);
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
});

afterEach(() => {
  activeEffectCleanups.splice(0).reverse().forEach(cleanup => cleanup());
  harness.layoutEffects = [];
  harness.platformOS = "web";
  vi.unstubAllGlobals();
});

describe("Task history follow intent consumers", () => {
  it("does not let a layout RAF restore follow after a real web wheel gesture", () => {
    const context = makeContext();
    const { model, list } = renderActualConsumers(context);

    model.handleMessageListLayout({ nativeEvent: { layout: { height: 480 } } });
    userWheelTowardOlder(list, context, 425);
    expect(context.messageFollowState.current.followsLatest).toBe(false);

    drainFrames();

    expect(context.scrollToOffset).not.toHaveBeenCalled();
    expect(context.messageFollowState.current.followsLatest).toBe(false);
    expect(context.setShowJumpToLatest).toHaveBeenCalledTimes(1);
  });

  it("ignores an old layout RAF after the actual jump-to-latest press creates a new intent", () => {
    const context = makeContext();
    const { model, jumpButton, list } = renderActualConsumers(context);

    model.handleMessageListLayout({ nativeEvent: { layout: { height: 480 } } });
    userWheelTowardOlder(list, context, 425);
    jumpButton.props.onPress();
    expect(context.scrollToOffset).toHaveBeenCalledTimes(1);
    expect(context.scrollToOffset).toHaveBeenLastCalledWith({ offset: 0, animated: true });

    drainFrames();

    expect(context.scrollToOffset).toHaveBeenCalledTimes(1);
    expect(shouldAnchorLatest(context.messageFollowState.current)).toBe(true);
    expect(context.messageFollowState.current.programmaticFollow).toBe(true);
    expect(context.setShowJumpToLatest).toHaveBeenCalledTimes(2);
  });

  it("does not let a queued layout RAF scroll after lifecycle refs invalidate its owner", () => {
    const context = makeContext();
    const oldScrollToEnd = context.scrollToEnd;
    const { model } = renderActualConsumers(context);

    model.handleMessageListLayout({ nativeEvent: { layout: { height: 480 } } });
    context.mountedRef.current = false;
    context.mountGeneration.current++;
    const replacementScrollToEnd = vi.fn();
    context.messageListRef.current = {
      getNativeScrollRef: () => context.scroller,
      scrollToEnd: replacementScrollToEnd,
    };

    drainFrames();

    expect(oldScrollToEnd).not.toHaveBeenCalled();
    expect(replacementScrollToEnd).not.toHaveBeenCalled();
    expect(context.scrollToOffset).not.toHaveBeenCalled();
  });

  it("keeps the four-stable-frame prepend anchor active across a real stop gesture", async () => {
    const pendingLoad = deferred<void>();
    const context = makeContext(() => pendingLoad.promise);
    const { model, list } = renderActualConsumers(context);
    const logicalScroller = context.messageListRef.current.getNativeScrollRef();
    const initialLogicalTop = logicalScroller.scrollTop;
    const initialRawTop = context.scroller.scrollTop;

    const load = model.loadOlder();
    const originalAnchor = context.webPrependAnchor.current;
    expect(originalAnchor).not.toBeNull();
    pendingLoad.resolve();
    await load;

    context.scroller.scrollHeight = 1100;
    list.onContentSizeChange();
    expect(logicalScroller.scrollTop).toBe(initialLogicalTop + 100);
    expect(context.scroller.scrollTop).toBe(initialRawTop);
    userWheelTowardOlder(list, context, initialRawTop + 25);
    expect(context.messageFollowState.current.followsLatest).toBe(false);
    expect(context.webPrependAnchor.current).toBe(originalAnchor);

    drainFrames();

    expect(logicalScroller.scrollTop).toBe(initialLogicalTop + 75);
    expect(context.scroller.scrollTop).toBe(initialRawTop + 25);
    expect(context.webPrependAnchor.current).toBeNull();
    expect(shouldAnchorLatest(context.messageFollowState.current)).toBe(false);
  });

  it("drops an in-flight older-page anchor when the real latest button is pressed", async () => {
    const pendingLoad = deferred<void>();
    const context = makeContext(() => pendingLoad.promise);
    const { model, jumpButton } = renderActualConsumers(context);

    const load = model.loadOlder();
    expect(context.webPrependAnchor.current).not.toBeNull();
    jumpButton.props.onPress();
    const jumpedRawTop = context.scroller.scrollTop;
    expect(context.webPrependAnchor.current).toBeNull();
    expect(shouldAnchorLatest(context.messageFollowState.current)).toBe(true);
    context.scroller.scrollHeight = 1100;

    pendingLoad.resolve();
    await load;
    drainFrames();

    expect(context.scroller.scrollTop).toBe(jumpedRawTop);
    expect(jumpedRawTop).toBe(0);
    expect(context.webPrependAnchor.current).toBeNull();
    expect(context.scrollToOffset).toHaveBeenCalledTimes(1);
    expect(context.scrollToOffset).toHaveBeenCalledWith({ offset: 0, animated: true });
  });

  it("resumes a paused native transcript when a toward-tail drag reaches distance 24 from 80", () => {
    const context = makeContext();
    context.scroller.scrollTop = 520;
    context.messageFollowState.current = {
      followsLatest: false,
      programmaticFollow: false,
      awaitingDistanceAway: false,
    };
    const { list } = renderNativeConsumers(context);

    list.onScrollBeginDrag(nativeScrollEvent(context, 520));
    nativeScroll(list, context, 576);

    expect(context.messageFollowState.current.followsLatest).toBe(true);
    expect(context.messageFollowState.current.awaitingDistanceAway).toBe(false);
  });

  it("keeps latest follow through a native drag with no actual offset movement", () => {
    const context = makeContext();
    const { list } = renderNativeConsumers(context);
    const initialIntent = context.messageFollowState.current;

    list.onScrollBeginDrag(nativeScrollEvent(context, context.scroller.scrollTop));
    list.onScrollEndDrag(nativeScrollEvent(context, context.scroller.scrollTop));

    expect(context.messageFollowState.current).toBe(initialIntent);
    expect(shouldAnchorLatest(context.messageFollowState.current)).toBe(true);
    expect(context.scrollToEnd).not.toHaveBeenCalled();
  });

  it("resumes after a native toward-tail fling ends inside the latest threshold", () => {
    const context = makeContext();
    context.scroller.scrollTop = 420;
    context.messageFollowState.current = {
      followsLatest: false,
      programmaticFollow: false,
      awaitingDistanceAway: false,
    };
    const { list } = renderNativeConsumers(context);

    list.onScrollBeginDrag(nativeScrollEvent(context, 420));
    nativeScroll(list, context, 450);
    list.onScrollEndDrag(nativeScrollEvent(context, 450));
    list.onMomentumScrollBegin(nativeScrollEvent(context, 500));
    list.onMomentumScrollEnd(nativeScrollEvent(context, 510));

    expect(context.messageFollowState.current.followsLatest).toBe(true);
  });

  it("does not let an old native gesture or momentum cancel a newer explicit jump", () => {
    const context = makeContext();
    const { list, jumpButton } = renderNativeConsumers(context);

    list.onScrollBeginDrag(nativeScrollEvent(context, 400));
    nativeScroll(list, context, 430);
    list.onScrollEndDrag(nativeScrollEvent(context, 430));
    jumpButton.props.onPress();
    const jumpIntent = context.messageFollowState.current;
    expect(jumpIntent.programmaticFollow).toBe(true);

    list.onMomentumScrollBegin(nativeScrollEvent(context, 430));
    nativeScroll(list, context, 450);
    list.onMomentumScrollEnd(nativeScrollEvent(context, 450));

    expect(context.messageFollowState.current).toBe(jumpIntent);
    expect(context.messageFollowState.current.programmaticFollow).toBe(true);
    expect(context.scrollToEnd).toHaveBeenCalledTimes(1);
  });

  it("lets a pending upward wheel intent beat an older layout RAF before offset movement arrives", () => {
    const context = makeContext();
    const { model, list } = renderActualConsumers(context);

    model.handleMessageListLayout({ nativeEvent: { layout: { height: 480 } } });
    context.scroller.dispatchWheel(0, -25);

    // The layout callback was queued first. The user input candidate exists,
    // while the browser's actual offset change has not arrived yet.
    expect(runNextFrame()).toBe(true);
    expect(context.scrollToOffset).not.toHaveBeenCalled();

    context.scroller.scrollTop = 425;
    list.onScroll({
      nativeEvent: {
        contentOffset: { y: 425 },
        contentSize: { height: context.scroller.scrollHeight },
        layoutMeasurement: { height: context.scroller.clientHeight },
      },
    });
    drainFrames();

    expect(context.messageFollowState.current.followsLatest).toBe(false);
    expect(context.scrollToOffset).not.toHaveBeenCalled();
  });

  it("settles a no-offset wheel candidate and anchors content that changed while it was pending", () => {
    const context = makeContext();
    const { model, list } = renderActualConsumers(context);

    model.handleMessageListLayout({ nativeEvent: { layout: { height: 480 } } });
    context.scroller.dispatchWheel(0, -25);
    expect(runNextFrame()).toBe(true);
    expect(context.scrollToOffset).not.toHaveBeenCalled();

    context.scroller.scrollHeight = 1200;
    list.onContentSizeChange();
    drainFrames();

    expect(context.messageFollowState.current.followsLatest).toBe(true);
    expect(context.messageFollowState.current.programmaticFollow).toBe(false);
    expect(context.scroller.scrollTop).toBe(0);
    expect(context.scrollToOffset).toHaveBeenCalledTimes(1);
    expect(context.scrollToOffset).toHaveBeenLastCalledWith({ offset: 0, animated: false });
    expect(context.latestRequestHeights).toContain(1200);
  });

  it("does not let a pending old wheel candidate replace a newer explicit jump intent", () => {
    const context = makeContext();
    const { list, jumpButton } = renderActualConsumers(context);

    context.scroller.dispatchWheel(0, -25);
    jumpButton.props.onPress();
    const jumpIntent = context.messageFollowState.current;
    expect(jumpIntent.programmaticFollow).toBe(true);

    context.scroller.scrollTop = 425;
    list.onScroll({
      nativeEvent: {
        contentOffset: { y: 425 },
        contentSize: { height: context.scroller.scrollHeight },
        layoutMeasurement: { height: context.scroller.clientHeight },
      },
    });
    drainFrames();

    expect(context.messageFollowState.current).toBe(jumpIntent);
    expect(context.messageFollowState.current.programmaticFollow).toBe(true);
    expect(context.scrollToOffset).toHaveBeenCalledTimes(1);
    expect(context.scrollToOffset).toHaveBeenCalledWith({ offset: 0, animated: true });
  });

  it("unregisters the Web capture listener at cleanup and ignores later events", () => {
    const context = makeContext();
    const rendered = renderActualConsumers(context);
    const { wheelHost } = rendered;

    expect(wheelHost.addCalls).toContainEqual({ type: "wheel", capture: true, passive: true });
    expect(wheelHost.listenerCount("wheel")).toBe(1);
    rendered.dispose();
    expect(wheelHost.removeCalls).toContainEqual({ type: "wheel", capture: true });
    expect(wheelHost.listenerCount("wheel")).toBe(0);

    const before = context.messageFollowState.current;
    wheelHost.dispatchWheel(0, -25);
    expect(context.messageFollowState.current).toBe(before);
    expect(frames.size).toBe(0);
  });

  it("rejects a pending wheel candidate after the mounted transcript changes owner", () => {
    const context = makeContext();
    const rendered = renderActualConsumers(context);
    const { model, wheelHost } = rendered;

    wheelHost.dispatchWheel(0, -25);
    const pendingIntent = model.messageFollowState.current;
    expect(pendingIntent.pendingInput).toBeDefined();

    // Hold the follow-intent ref stable so owner identity is the fence under
    // test; the old listener/effect remains mounted across this same-hook rerender.
    const replacementModel = { ...model, task: { ...model.task } };
    const replacementList = rendered.rerenderTranscript(replacementModel);
    wheelHost.scrollTop = 425;
    replacementList.onScroll(nativeScrollEvent(context, 425));
    expect(replacementModel.messageFollowState.current).toBe(pendingIntent);

    drainFrames();
    expect(replacementModel.messageFollowState.current).toBe(pendingIntent);
    expect(replacementModel.messageFollowState.current.followsLatest).toBe(true);
    rendered.dispose();
  });

  it("lets a real native drag candidate beat a queued layout RAF before upward offset arrives", () => {
    const context = makeContext();
    const { model, list } = renderNativeConsumers(context);

    model.handleMessageListLayout({ nativeEvent: { layout: { height: 480 } } });
    list.onScrollBeginDrag(nativeScrollEvent(context, 400));
    expect(runNextFrame()).toBe(true);
    expect(context.scrollToEnd).not.toHaveBeenCalled();

    nativeScroll(list, context, 350);
    drainFrames();

    expect(context.messageFollowState.current.followsLatest).toBe(false);
    expect(context.scrollToEnd).not.toHaveBeenCalled();
  });

  it("releases a zero-offset native drag and anchors content changed while it was pending", () => {
    const context = makeContext();
    const { model, list } = renderNativeConsumers(context);
    context.scrollToEnd.mockImplementation(() => {
      context.latestRequestHeights.push(context.scroller.scrollHeight);
      context.scroller.scrollTop = context.scroller.scrollHeight - context.scroller.clientHeight;
    });

    model.handleMessageListLayout({ nativeEvent: { layout: { height: 480 } } });
    list.onScrollBeginDrag(nativeScrollEvent(context, 400));
    expect(runNextFrame()).toBe(true);
    expect(context.scrollToEnd).not.toHaveBeenCalled();

    context.scroller.scrollHeight = 1200;
    list.onContentSizeChange();
    expect(context.scrollToEnd).not.toHaveBeenCalled();
    list.onScrollEndDrag(nativeScrollEvent(context, 400));
    drainFrames();

    expect(context.messageFollowState.current.followsLatest).toBe(true);
    expect(context.messageFollowState.current.programmaticFollow).toBe(false);
    expect(context.scrollToEnd).toHaveBeenCalledTimes(1);
    expect(context.scrollToEnd).toHaveBeenCalledWith({ animated: false });
    expect(context.latestRequestHeights).toEqual([1200]);
    expect(context.scroller.scrollTop).toBe(800);
  });
});
