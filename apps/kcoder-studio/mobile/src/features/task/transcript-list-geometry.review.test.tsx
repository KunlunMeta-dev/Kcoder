import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  beginProgrammaticFollow,
  initialMessageFollowState,
  observeMessageListDistance,
  suspendMessageFollowInput,
  type MessageFollowState,
} from "@/components/message-follow-state";
import { TaskTranscript } from "./TaskTranscript";
import {
  InvertedTranscriptGeometry,
  TRANSCRIPT_ANCHOR_SETTLE_MAX_FRAMES,
  TranscriptAnchorBoundary,
} from "./transcript-list-geometry";

// These tests call the real helper and component with a deterministic hook/DOM
// host. They are not mounted React, RN Web, browser, or native-device tests.
const host = vi.hoisted(() => ({
  refs: [] as { current: unknown }[],
  refCursor: 0,
  layoutEffects: [] as (() => void | (() => void))[],
  platformOS: "web",
}));

vi.mock("react", async importOriginal => ({
  ...await importOriginal<typeof import("react")>(),
  useRef: (initial: unknown) => {
    const index = host.refCursor++;
    host.refs[index] ??= { current: initial };
    return host.refs[index];
  },
  useCallback: (callback: unknown) => callback,
  useMemo: (factory: () => unknown) => factory(),
  useLayoutEffect: (effect: () => void | (() => void)) => {
    host.layoutEffects.push(effect);
  },
}));

vi.mock("react-native", () => ({
  ActivityIndicator: "ActivityIndicator",
  FlatList: "FlatList",
  Platform: { get OS() { return host.platformOS; } },
  Pressable: "Pressable",
  Text: "Text",
  View: "View",
}));
vi.mock("@/i18n", () => ({ t: (key: string) => key }));
vi.mock("@/i18n/use-locale", () => ({ useLocale: () => "en" }));
vi.mock("@/theme", () => ({
  colors: new Proxy({}, { get: (_target, key) => key }),
  spacing: new Proxy({}, { get: (_target, key) => key }),
}));
vi.mock("lucide-react-native", () => ({ Bot: () => null }));
vi.mock("@/components/ui", () => ({ EmptyState: () => null }));
vi.mock("./MessageBubble", () => ({ MessageBubble: () => null }));
vi.mock("./RuntimeErrorBanner", () => ({ RuntimeErrorBanner: () => null }));
vi.mock("./taskStyles", () => ({
  styles: new Proxy({}, { get: (_target, key) => key }),
  useTaskAppearance: () => ({
    colors: new Proxy({}, { get: (_target, key) => key }),
    styles: new Proxy({}, { get: (_target, key) => key }),
  }),
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

function drainFrames(limit = 40): number {
  let count = 0;
  while (runNextFrame()) {
    count++;
    if (count > limit) throw new Error("RAF queue did not settle within " + limit + " frames");
  }
  return count;
}

type Rect = { top: number; bottom: number; left: number; right: number; width: number; height: number };

function rect(top: number, bottom = top + 60): Rect {
  return { top, bottom, left: 0, right: 320, width: 320, height: bottom - top };
}

function makeHost(initialTop = 120) {
  const listeners = new Map<string, (event: any) => void>();
  const raw: any = {
    nodeType: 1,
    clientHeight: 240,
    isConnected: true,
    scrollHeight: 1200,
    scrollTop: initialTop,
    addEventListener: vi.fn((type: string, listener: (event: any) => void) => {
      listeners.set(type, listener);
    }),
    removeEventListener: vi.fn((type: string) => listeners.delete(type)),
    getBoundingClientRect: () => rect(0, 240),
  };
  raw.contains = (node: unknown) => node === raw;
  return { raw, listeners };
}

function makeGeometryFixture(initialTop = 120) {
  const owner = {};
  const intent: MessageFollowState = {
    followsLatest: false,
    programmaticFollow: false,
    awaitingDistanceAway: false,
  };
  const lifetime = { current: { intent, mounted: true, generation: 1, owner } };
  const { raw: scroller } = makeHost(initialTop);
  const list = {
    getNativeScrollRef: vi.fn(() => scroller),
    scrollToOffset: vi.fn(),
  };
  const geometry = new InvertedTranscriptGeometry(() => lifetime.current);
  const proxy = geometry.bind(list)!;
  let insertedHeight = 0;
  const initialTopForRow = initialTop;
  const row: any = {
    isConnected: true,
    getBoundingClientRect: () => rect(72 + insertedHeight + (scroller.scrollTop - initialTopForRow)),
  };
  geometry.setRow("message-a", row);
  const logicalHost = proxy.getNativeScrollRef() as HTMLElement;
  geometry.captureAnchor();
  return {
    geometry,
    lifetime,
    list,
    proxy,
    row,
    scroller,
    logicalHost,
    addHeight(value: number) { insertedHeight += value; },
  };
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

function makeTranscriptModel(platform: "web" | "ios" = "web") {
  const { raw: scroller, listeners } = makeHost(120);
  const rawList = {
    getNativeScrollRef: vi.fn(() => scroller),
    scrollToOffset: vi.fn(),
  };
  const model: any = {
    task: {},
    onOpenFile: vi.fn(),
    onOpenChanges: vi.fn(),
    snapshot: {
      activeTurnId: undefined,
      connected: true,
      continuationPending: false,
      error: undefined,
      hasMoreBefore: false,
      loadingOlder: false,
      messages: [{ id: "message-a", role: "user", content: "hello" }],
      running: false,
      sendAcceptanceUnknown: false,
    },
    messageListRef: { current: platform === "web" ? null : rawList },
    messageFollowState: { current: initialMessageFollowState() },
    setShowJumpToLatest: vi.fn(),
    webPrependAnchor: { current: null },
    compensateWebPrepend: vi.fn(),
    loadOlder: vi.fn(),
    mountedRef: { current: true },
    mountGeneration: { current: 1 },
  };
  return { model, rawList, scroller, listeners };
}

function renderActualTranscript(model: any) {
  host.refs = [];
  host.refCursor = 0;
  host.layoutEffects = [];
  const tree: any = TaskTranscript({ model } as never);
  const listElement = findByTestId(tree, "message-list");
  if (!listElement) throw new Error("TaskTranscript did not render its production message list");
  return {
    tree,
    props: listElement.props,
    attachWebList(list: unknown) {
      const ref = listElement.props.ref ?? listElement.ref;
      if (typeof ref !== "function") throw new Error("Web list ref was not attached through the production adapter");
      ref(list);
    },
    runLayoutEffects() {
      return host.layoutEffects.map(effect => effect()).filter(
        (cleanup): cleanup is () => void => typeof cleanup === "function",
      );
    },
  };
}

function nativeEvent(y: number) {
  return {
    nativeEvent: {
      contentOffset: { y },
      contentSize: { height: 1200 },
      layoutMeasurement: { height: 240 },
    },
  };
}

beforeEach(() => {
  nextFrameId = 1;
  frames = new Map();
  host.refs = [];
  host.refCursor = 0;
  host.layoutEffects = [];
  host.platformOS = "web";
  vi.stubGlobal("requestAnimationFrame", scheduleFrame);
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
});

afterEach(() => {
  vi.unstubAllGlobals();
  host.platformOS = "web";
});

describe("inverted transcript geometry direct consumers", () => {
  it("keeps the same paused row viewport offset through committed height changes", () => {
    const fixture = makeGeometryFixture();
    const boundary = new TranscriptAnchorBoundary({ geometry: fixture.geometry, children: null });
    const initialViewportOffset = fixture.row.getBoundingClientRect().top -
      fixture.scroller.getBoundingClientRect().top;
    const initialRawTop = fixture.scroller.scrollTop;

    boundary.getSnapshotBeforeUpdate();
    fixture.addHeight(34);
    boundary.componentDidUpdate();

    expect(fixture.row.getBoundingClientRect().top - fixture.scroller.getBoundingClientRect().top)
      .toBe(initialViewportOffset);
    expect(fixture.scroller.scrollTop).toBe(initialRawTop - 34);

    boundary.getSnapshotBeforeUpdate();
    fixture.addHeight(19);
    boundary.componentDidUpdate();
    drainFrames();

    expect(fixture.row.getBoundingClientRect().top - fixture.scroller.getBoundingClientRect().top)
      .toBe(initialViewportOffset);
    expect(fixture.scroller.scrollTop).toBe(initialRawTop - 53);
    expect(fixture.geometry.restoreAnchor()).toBe(true);
    expect(fixture.row.isConnected).toBe(true);
  });

  it("bounds continuous measurement settlement and starts a fresh bounded cycle on later content", () => {
    expect(TRANSCRIPT_ANCHOR_SETTLE_MAX_FRAMES).toBe(16);
    const fixture = makeGeometryFixture();
    const initialTop = fixture.scroller.scrollTop;

    fixture.addHeight(1);
    fixture.geometry.contentChanged();
    let delivered = 0;
    for (let frame = 0; frame < TRANSCRIPT_ANCHOR_SETTLE_MAX_FRAMES; frame++) {
      fixture.addHeight(1);
      expect(runNextFrame()).toBe(true);
      delivered++;
    }

    expect(delivered).toBe(TRANSCRIPT_ANCHOR_SETTLE_MAX_FRAMES);
    expect(runNextFrame()).toBe(false);
    expect(fixture.scroller.scrollTop)
      .toBe(initialTop - 1 - TRANSCRIPT_ANCHOR_SETTLE_MAX_FRAMES);

    fixture.addHeight(3);
    fixture.geometry.contentChanged();
    expect(runNextFrame()).toBe(true);
    expect(fixture.scroller.scrollTop)
      .toBe(initialTop - 4 - TRANSCRIPT_ANCHOR_SETTLE_MAX_FRAMES);
    expect(drainFrames()).toBeGreaterThan(0);
    expect(runNextFrame()).toBe(false);
  });

  it("does not restore through a virtualized row after its production ref is cleared", () => {
    const { model, scroller } = makeTranscriptModel();
    const rendered = renderActualTranscript(model);
    const rawList = {
      getNativeScrollRef: vi.fn(() => scroller),
      scrollToOffset: vi.fn(),
    };
    rendered.attachWebList(rawList);
    const cleanups = rendered.runLayoutEffects();
    const rowElement = rendered.props.renderItem({ item: model.snapshot.messages[0] });
    const rowRef = rowElement.props.ref;
    expect(typeof rowRef).toBe("function");
    const row: any = { isConnected: true, getBoundingClientRect: () => rect(40) };
    rowRef(row);

    const geometry = rendered.tree.props.geometry as InvertedTranscriptGeometry;
    model.messageFollowState.current = {
      followsLatest: false, programmaticFollow: false, awaitingDistanceAway: false,
    };
    model.messageListRef.current.getNativeScrollRef();
    rowRef(null);
    const logicalTop = model.messageListRef.current.getNativeScrollRef().scrollTop;

    expect(geometry.restoreAnchor()).toBe(false);
    row.isConnected = false;
    expect(geometry.restoreAnchor()).toBe(false);
    expect(model.messageListRef.current.getNativeScrollRef().scrollTop).toBe(logicalTop);
    cleanups.forEach(cleanup => cleanup());
  });

  it("lets the actual Web capture listener defer an offset write until unresolved wheel input ends", () => {
    const { model, scroller, listeners } = makeTranscriptModel();
    const rendered = renderActualTranscript(model);
    const list = { getNativeScrollRef: vi.fn(() => scroller), scrollToOffset: vi.fn() };
    rendered.attachWebList(list);
    const cleanups = rendered.runLayoutEffects();
    const wheel = listeners.get("wheel");
    expect(wheel).toBeDefined();
    expect(scroller.addEventListener).toHaveBeenCalledWith("wheel", expect.any(Function), {
      capture: true, passive: true,
    });

    wheel!({ deltaX: 0, deltaY: -30, target: scroller });
    expect(model.messageFollowState.current.pendingInput).toBeDefined();
    rendered.props.onContentSizeChange(320, 600);
    expect(list.scrollToOffset).not.toHaveBeenCalled();

    // Capture runs before RNW's default scroll. The later normalized event is
    // deliberately stale; the consumer must reread the current raw host offset.
    scroller.scrollTop += 28;
    rendered.props.onScroll(nativeEvent(120));
    expect(model.messageFollowState.current.followsLatest).toBe(false);
    expect(model.messageFollowState.current.pendingInput).toBeUndefined();
    drainFrames();
    expect(list.scrollToOffset).not.toHaveBeenCalled();
    cleanups.forEach(cleanup => cleanup());
    expect(scroller.removeEventListener).toHaveBeenCalledWith("wheel", expect.any(Function), true);
  });

  it("does not treat an anchor compensation event as fresh user input", () => {
    const { model, scroller } = makeTranscriptModel();
    const rendered = renderActualTranscript(model);
    const list = { getNativeScrollRef: vi.fn(() => scroller), scrollToOffset: vi.fn() };
    rendered.attachWebList(list);
    const cleanups = rendered.runLayoutEffects();
    const rowElement = rendered.props.renderItem({ item: model.snapshot.messages[0] });
    let contentShift = 0;
    const initialTop = scroller.scrollTop;
    const row: any = {
      isConnected: true,
      getBoundingClientRect: () => rect(64 + contentShift + (scroller.scrollTop - initialTop)),
    };
    (rowElement.props.ref ?? rowElement.ref)(row);
    model.messageFollowState.current = {
      followsLatest: false, programmaticFollow: false, awaitingDistanceAway: false,
    };
    const pausedIntent = model.messageFollowState.current;
    model.messageListRef.current.getNativeScrollRef();

    contentShift += 27;
    rendered.props.onContentSizeChange(320, 630);
    const correctedRawTop = scroller.scrollTop;
    expect(correctedRawTop).toBe(initialTop - 27);
    rendered.props.onScroll(nativeEvent(initialTop));

    expect(scroller.scrollTop).toBe(correctedRawTop);
    expect(model.messageFollowState.current).toBe(pausedIntent);
    expect(model.messageFollowState.current.pendingInput).toBeUndefined();
    expect(list.scrollToOffset).not.toHaveBeenCalled();
    cleanups.forEach(cleanup => cleanup());
  });

  it("releases an unchanged wheel candidate with one deferred anchor after content growth", () => {
    const { model, scroller, listeners } = makeTranscriptModel();
    const rendered = renderActualTranscript(model);
    const list = { getNativeScrollRef: vi.fn(() => scroller), scrollToOffset: vi.fn() };
    rendered.attachWebList(list);
    const cleanups = rendered.runLayoutEffects();

    listeners.get("wheel")!({ deltaX: 0, deltaY: -25, target: scroller });
    rendered.props.onContentSizeChange(320, 640);
    expect(list.scrollToOffset).not.toHaveBeenCalled();
    expect(model.messageFollowState.current.pendingInput?.needsAnchor).toBe(true);

    // No physical offset change means no user decision. RAF releases the
    // captured follow intent and performs exactly one tail anchor.
    expect(runNextFrame()).toBe(true);
    expect(model.messageFollowState.current.followsLatest).toBe(true);
    expect(model.messageFollowState.current.pendingInput).toBeUndefined();
    expect(list.scrollToOffset).toHaveBeenCalledTimes(1);
    expect(list.scrollToOffset).toHaveBeenCalledWith({ offset: 0, animated: false });
    expect(drainFrames()).toBe(0);
    cleanups.forEach(cleanup => cleanup());
  });

  it("drops queued work when the lifetime owner changes or the transcript boundary unmounts", () => {
    const ownerFixture = makeGeometryFixture();
    ownerFixture.addHeight(12);
    ownerFixture.geometry.contentChanged();
    const correctedTop = ownerFixture.scroller.scrollTop;
    ownerFixture.lifetime.current = { ...ownerFixture.lifetime.current, owner: {} };
    ownerFixture.addHeight(40);
    expect(runNextFrame()).toBe(true);
    expect(ownerFixture.scroller.scrollTop).toBe(correctedTop);
    expect(runNextFrame()).toBe(false);

    const unmountFixture = makeGeometryFixture();
    const boundary = new TranscriptAnchorBoundary({ geometry: unmountFixture.geometry, children: null });
    unmountFixture.addHeight(7);
    unmountFixture.geometry.contentChanged();
    const correctedBeforeUnmount = unmountFixture.scroller.scrollTop;
    boundary.componentWillUnmount();
    unmountFixture.addHeight(40);
    expect(runNextFrame()).toBe(false);
    expect(unmountFixture.scroller.scrollTop).toBe(correctedBeforeUnmount);
  });

  it("keeps the native transcript branch free of Web DOM measurement and wheel listeners", () => {
    host.platformOS = "ios";
    const { model, rawList, scroller } = makeTranscriptModel("ios");
    rawList.getNativeScrollRef.mockImplementation(() => {
      throw new Error("Native transcript must not inspect the Web scroll host");
    });
    const rendered = renderActualTranscript(model);
    expect(rendered.props.inverted).toBe(false);
    const cleanups = rendered.runLayoutEffects();
    rendered.props.onScroll(nativeEvent(120));

    expect(rawList.getNativeScrollRef).not.toHaveBeenCalled();
    expect(scroller.addEventListener).not.toHaveBeenCalled();
    cleanups.forEach(cleanup => cleanup());
  });
});

describe("owned latest-jump interruption geometry contract (non-browser)", () => {
  function makeOwnedJump(initialTop = 120) {
    const fixture = makeGeometryFixture(initialTop);
    const adapter = fixture.proxy as typeof fixture.proxy & {
      scrollToEnd(options?: { animated?: boolean }): unknown;
    };
    const intent = beginProgrammaticFollow();
    fixture.lifetime.current = { ...fixture.lifetime.current, intent };
    adapter.scrollToEnd({ animated: true });
    fixture.list.scrollToOffset.mockClear();
    return { ...fixture, adapter };
  }

  function makeInput(
    fixture: ReturnType<typeof makeGeometryFixture>,
    direction: "toward-old" | "toward-latest" | undefined,
    options: { host?: HTMLElement; outerInput?: boolean } = {},
  ) {
    const current = fixture.lifetime.current;
    const intent = direction === "toward-old"
      ? suspendMessageFollowInput(current.intent) : current.intent;
    fixture.lifetime.current = { ...current, intent };
    return {
      intent,
      generation: current.generation,
      owner: current.owner,
      direction,
      host: options.host ?? fixture.geometry.rawHost()!,
      outerInput: options.outerInput ?? true,
    };
  }

  function startTowardOld(fixture: ReturnType<typeof makeGeometryFixture>) {
    const input = makeInput(fixture, "toward-old");
    fixture.geometry.inputStarted(input);
    return input;
  }

  it("stops only the matching owned jump at the current raw offset", () => {
    const fixture = makeOwnedJump(218);
    fixture.scroller.scrollTop = 207; // the browser may have advanced the owned animation

    startTowardOld(fixture);

    expect(fixture.list.scrollToOffset.mock.calls.map(([options]) => options)).toEqual([
      { offset: 207, animated: false },
    ]);
    expect(fixture.list.scrollToOffset).not.toHaveBeenCalledWith({ offset: 0, animated: false });
  });

  it("restores the captured latest intent exactly once when input has no outer movement", () => {
    // This is the geometry recovery contract only. It does not prove that a
    // nested BoundedOutput wheel reaches the outer RNW host in Chrome.
    const fixture = makeOwnedJump(218);
    const input = startTowardOld(fixture);
    const pending = input.intent.pendingInput;
    expect(pending).toBeDefined();
    if (!pending) throw new Error("Expected the captured follow intent");

    // Match TaskTranscript.releaseInput when no browser offset movement occurred:
    // restore the captured intent; inputFinished owns the single latest anchor.
    fixture.lifetime.current = { ...fixture.lifetime.current, intent: pending.follow };
    input.intent = pending.follow;
    fixture.geometry.inputFinished(input);

    expect(fixture.list.scrollToOffset.mock.calls.map(([options]) => options)).toEqual([
      { offset: 218, animated: false },
      { offset: 0, animated: false },
    ]);
  });

  it("does not restore latest after actual toward-old movement changes the follow intent", () => {
    const fixture = makeOwnedJump(218);
    const input = startTowardOld(fixture);
    fixture.scroller.scrollTop += 36;
    const movedIntent = observeMessageListDistance(
      input.intent, fixture.geometry.movement()!.distance, "toward-old",
    );
    expect(movedIntent.followsLatest).toBe(false);
    expect(movedIntent.programmaticFollow).toBe(false);
    fixture.lifetime.current = { ...fixture.lifetime.current, intent: movedIntent };
    input.intent = movedIntent;

    fixture.geometry.inputFinished(input);

    expect(fixture.list.scrollToOffset.mock.calls.map(([options]) => options)).toEqual([
      { offset: 218, animated: false },
    ]);
  });

  it("rejects an interruption after owner, generation, or list binding becomes stale", () => {
    for (const invalidation of ["owner", "generation", "binding"] as const) {
      const fixture = makeOwnedJump(218);
      const current = fixture.lifetime.current;
      const staleInput = makeInput(fixture, "toward-old");
      if (invalidation === "owner")
        fixture.lifetime.current = { ...fixture.lifetime.current, owner: {} };
      if (invalidation === "generation")
        fixture.lifetime.current = { ...fixture.lifetime.current, generation: current.generation + 1 };
      if (invalidation === "binding")
        fixture.geometry.bind({ getNativeScrollRef: () => fixture.scroller, scrollToOffset: vi.fn() });

      fixture.geometry.inputStarted(staleInput);

      expect(fixture.list.scrollToOffset, invalidation).not.toHaveBeenCalled();
    }
  });

  it("keeps a superseding jump owned when an older input callback arrives", () => {
    const fixture = makeOwnedJump(218);
    const old = fixture.lifetime.current;
    const staleInput = makeInput(fixture, "toward-old");

    const nextIntent = beginProgrammaticFollow();
    fixture.lifetime.current = { ...old, intent: nextIntent, generation: old.generation + 1 };
    fixture.adapter.scrollToEnd({ animated: true });
    fixture.list.scrollToOffset.mockClear();
    fixture.geometry.inputStarted(staleInput);
    expect(fixture.list.scrollToOffset).not.toHaveBeenCalled();

    const currentInput = makeInput(fixture, "toward-old");
    fixture.geometry.inputStarted(currentInput);

    expect(fixture.list.scrollToOffset.mock.calls.map(([options]) => options)).toEqual([
      { offset: 218, animated: false },
    ]);
  });

  it("does not cancel for toward-latest, horizontal/no-direction, or an unowned paused input", () => {
    for (const direction of ["toward-latest", undefined] as const) {
      const fixture = makeOwnedJump(218);
      const input = makeInput(fixture, direction);
      fixture.geometry.inputStarted(input);
      expect(fixture.list.scrollToOffset).not.toHaveBeenCalled();
      fixture.geometry.inputFinished(input);
      expect(fixture.list.scrollToOffset).not.toHaveBeenCalled();
    }

    const paused = makeGeometryFixture(218);
    const input = makeInput(paused, "toward-old");
    paused.geometry.inputStarted(input);
    paused.geometry.inputFinished(input);
    expect(paused.list.scrollToOffset).not.toHaveBeenCalled();
  });

  it("requires the exact raw fixture host and outerInput=true to consume a jump", () => {
    for (const invalid of ["wrong-host", "not-outer"] as const) {
      const fixture = makeOwnedJump(218);
      const invalidInput = makeInput(fixture, "toward-old", invalid === "wrong-host"
        ? { host: makeHost().raw as HTMLElement }
        : { outerInput: false });

      fixture.geometry.inputStarted(invalidInput);
      expect(fixture.list.scrollToOffset).not.toHaveBeenCalled();

      // An ineligible candidate must not consume the marker; the same exact
      // fixture host can still stop it with a current outer-input candidate.
      const eligibleInput = makeInput(fixture, "toward-old");
      fixture.geometry.inputStarted(eligibleInput);
      expect(fixture.list.scrollToOffset.mock.calls.map(([options]) => options)).toEqual([
        { offset: 218, animated: false },
      ]);
    }
  });

  it("uses TaskTranscript target and nested-room eligibility before outer-wheel interruption", () => {
    // Deterministic hook-level fixture only; it does not assert trusted DOM
    // dispatch, RNW scroll chaining, or Chrome's nested event routing.
    const { model, rawList, scroller, listeners } = makeTranscriptModel();
    const nested = {
      nodeType: 1,
      parentElement: scroller,
      scrollTop: 28,
      scrollHeight: 300,
      clientHeight: 100,
    } as any;
    scroller.contains = (node: unknown) => node === nested || node === scroller;
    const rendered = renderActualTranscript(model);
    rendered.attachWebList(rawList);
    const cleanups = rendered.runLayoutEffects();
    model.messageFollowState.current = beginProgrammaticFollow();
    const adapter = model.messageListRef.current as { scrollToEnd(options?: { animated?: boolean }): unknown };
    adapter.scrollToEnd({ animated: true });
    rawList.scrollToOffset.mockClear();
    const wheel = listeners.get("wheel");
    expect(wheel).toBeDefined();

    // The actual target is a distinct inner vertical host with room for this delta.
    wheel!({ deltaX: 0, deltaY: -20, target: nested });
    expect(rawList.scrollToOffset).not.toHaveBeenCalled();
    expect(model.messageFollowState.current.programmaticFollow).toBe(true);

    // At the inner old-edge, the component marks this input eligible for the
    // owned outer host, then the normal no-motion finish restores latest once.
    nested.scrollTop = 0;
    wheel!({ deltaX: 0, deltaY: -20, target: nested });
    expect(rawList.scrollToOffset).toHaveBeenCalledTimes(1);
    expect(rawList.scrollToOffset).toHaveBeenLastCalledWith({ offset: 120, animated: false });
    expect(runNextFrame()).toBe(true);
    expect(rawList.scrollToOffset.mock.calls.map(([options]) => options)).toEqual([
      { offset: 120, animated: false },
      { offset: 0, animated: false },
    ]);
    cleanups.forEach(cleanup => cleanup());
  });

});
