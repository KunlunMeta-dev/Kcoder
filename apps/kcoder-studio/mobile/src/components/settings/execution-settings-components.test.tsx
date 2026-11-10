import { beforeEach, describe, expect, it, vi } from "vitest";
import { en } from "@/i18n/locales/en";
import { zhCN } from "@/i18n/locales/zh-CN";

const harness = vi.hoisted(() => ({
  states: [] as unknown[],
  refs: [] as Array<{ current: unknown } | undefined>,
  effects: [] as Array<{ deps: unknown[] | undefined; cleanup?: () => void } | undefined>,
  stateCursor: 0,
  refCursor: 0,
  effectCursor: 0,
  target: null as Record<string, unknown> | null,
  drafts: new Map<string, unknown>(),
  listeners: new Set<() => void>(),
  labels: {} as Record<string, string>,
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: (initial: unknown) => {
      const index = harness.stateCursor++;
      if (!(index in harness.states)) harness.states[index] = typeof initial === "function" ? (initial as () => unknown)() : initial;
      return [harness.states[index], (update: unknown) => {
        harness.states[index] = typeof update === "function"
          ? (update as (previous: unknown) => unknown)(harness.states[index])
          : update;
      }];
    },
    useRef: (initial: unknown) => {
      const index = harness.refCursor++;
      return harness.refs[index] ??= { current: initial };
    },
    useEffect: (effect: () => void | (() => void), deps?: unknown[]) => {
      const index = harness.effectCursor++;
      const previous = harness.effects[index];
      const unchanged = deps !== undefined && previous?.deps !== undefined && deps.length === previous.deps.length && deps.every((value, depIndex) => Object.is(value, previous.deps?.[depIndex]));
      if (unchanged) return;
      previous?.cleanup?.();
      const cleanup = effect();
      harness.effects[index] = { deps: deps ? [...deps] : undefined, cleanup: typeof cleanup === "function" ? cleanup : undefined };
    },
  };
});

vi.mock("react-native", () => ({
  ActivityIndicator: "ActivityIndicator",
  Pressable: "Pressable",
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Text: "Text",
  TextInput: "TextInput",
  View: "View",
}));
vi.mock("@/components/settings/settings-layout", async () => {
  const ReactRuntime = await import("react");
  return {
    SettingsGroup: ({ children, ...props }: Record<string, unknown>) => ReactRuntime.createElement("SettingsGroup", props, children as never),
    SettingsRow: (props: Record<string, unknown>) => ReactRuntime.createElement("SettingsRow", props),
  };
});
vi.mock("@/components/settings/settings-choice-sheet", async () => {
  const ReactRuntime = await import("react");
  return { SettingsChoiceSheet: (props: Record<string, unknown>) => ReactRuntime.createElement("SettingsChoiceSheet", props) };
});
vi.mock("@/components/settings/SettingsTargetContext", () => ({
  useSettingsTarget: () => harness.target,
  SettingsTargetChangedError: class SettingsTargetChangedError extends Error {
    constructor(readonly delivery: "not-sent" | "unknown") { super("target changed"); }
  },
}));
vi.mock("@/i18n", () => ({ t: (key: string) => harness.labels[key] ?? key }));
vi.mock("@/i18n/use-locale", () => ({ useLocale: () => "en" }));
vi.mock("@/gateway/rpc", () => ({
  MobileRpcError: class MobileRpcError extends Error {
    constructor(message: string, readonly code: number, readonly reason: "transport" | "remote" | "protocol", readonly delivery: "not-sent" | "unknown") { super(message); }
  },
}));
vi.mock("@/theme", () => ({
  radius: { lg: 12, md: 8, pill: 999, settingsGroup: 14 },
  spacing: { xs: 4, sm: 8, md: 12, lg: 16 },
  useTheme: () => ({ colors: {
    accentText: "accentText", border: "border", blue: "blue", green: "green", overlay: "overlay",
    red: "red", settingsGroupBackground: "group", settingsPageBackground: "page", text: "text",
    textDim: "dim", textMuted: "muted", yellow: "yellow",
  } }),
  useThemedStyles: (create: (colors: Record<string, string>) => unknown) => create({
    accentText: "accentText", border: "border", blue: "blue", green: "green", overlay: "overlay",
    red: "red", settingsGroupBackground: "group", settingsPageBackground: "page", text: "text",
    textDim: "dim", textMuted: "muted", yellow: "yellow",
  }),
}));

import { MobileRpcError } from "@/gateway/rpc";
import { CustomInstructionsSettings } from "./CustomInstructionsSettings";
import { ExecutionDefaultsSettings } from "./ExecutionDefaultsSettings";

type ElementLike = { type: unknown; props: Record<string, unknown> & { children?: unknown } };
type TestTarget = { request: ReturnType<typeof vi.fn>; ready: boolean };

function makeTarget(request: (method: string, params?: unknown) => Promise<unknown>, identity = "profile-a/server-a"): TestTarget {
  const target = {
    profile: { id: "profile-a" },
    server: { id: "server-a" },
    servers: [{ id: "server-a" }],
    serverId: "server-a",
    targetIdentity: identity,
    workspacePath: undefined,
    selectServer: vi.fn(),
    retry: vi.fn(),
    loading: false,
    error: null,
    ready: true,
    capabilities: { gateway: {}, appServer: { experimental: { executionDefaultsV1: true } } },
    request: vi.fn(request),
    readDraft: <T,>(targetIdentity: string, key: string) => (harness.drafts.get(targetIdentity + ":" + key) as T | undefined) ?? null,
    writeDraft: (targetIdentity: string, key: string, value: unknown) => {
      harness.drafts.set(targetIdentity + ":" + key, value);
      for (const listener of harness.listeners) listener();
    },
    subscribeDraft: (listener: () => void) => {
      harness.listeners.add(listener);
      return () => { harness.listeners.delete(listener); };
    },
  };
  harness.target = target;
  return target;
}

function render(component: () => unknown): ElementLike {
  harness.stateCursor = 0;
  harness.refCursor = 0;
  harness.effectCursor = 0;
  return component() as ElementLike;
}

function findByTestId(root: unknown, testID: string): ElementLike {
  if (Array.isArray(root)) {
    for (const child of root) {
      try { return findByTestId(child, testID); } catch { /* Search the remaining rendered siblings. */ }
    }
    throw new Error(`Missing ${testID}`);
  }
  if (!root || typeof root !== "object") throw new Error(`Missing ${testID}`);
  const element = root as ElementLike;
  if (element.props?.testID === testID) return element;
  if (typeof element.type === "function") {
    return findByTestId((element.type as (props: ElementLike["props"]) => unknown)(element.props), testID);
  }
  const children = element.props?.children;
  for (const child of Array.isArray(children) ? children : [children]) {
    try { return findByTestId(child, testID); } catch { /* Search the remaining rendered siblings. */ }
  }
  throw new Error(`Missing ${testID}`);
}

function maybeByTestId(root: unknown, testID: string): ElementLike | null {
  try { return findByTestId(root, testID); } catch { return null; }
}

function press(element: ElementLike): void {
  const handler = element.props.onPress;
  if (typeof handler === "function") (handler as () => void)();
}

async function flush(): Promise<void> {
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
}

const validDefaults = {
  persistedPermissionMode: null,
  effectivePermissionMode: "ask",
  cliPermissionModeOverride: null,
};

function unmountEditor() {
  for (const effect of harness.effects) effect?.cleanup?.();
  harness.states = [];
  harness.refs = [];
  harness.effects = [];
  harness.stateCursor = 0;
  harness.refCursor = 0;
  harness.effectCursor = 0;
}

beforeEach(() => {
  unmountEditor();
  harness.target = null;
  harness.drafts.clear();
  harness.listeners.clear();
  harness.labels = {};
});

describe("execution default settings receipts", () => {
  it.each([
    ["en", en, "Never ask (deny otherwise)", "Deny actions that need approval."],
    ["zh-CN", zhCN, "拒绝需确认的操作", "需要审批的操作将被拒绝。"],
  ] as const)("reuses the existing %s permission semantics for dont_ask", async (_locale, labels, expectedLabel, expectedDescription) => {
    harness.labels = labels;
    makeTarget(async () => ({ persistedPermissionMode: "dont_ask", effectivePermissionMode: "dont_ask", cliPermissionModeOverride: null }));
    let tree = await settled(ExecutionDefaultsSettings);
    expect(findByTestId(tree, "execution-defaults-permission-mode").props.value).toBe(expectedLabel);
    expect(findByTestId(tree, "execution-defaults-effective").props.children).toContain(expectedLabel);
    press(findByTestId(tree, "execution-defaults-permission-mode"));
    tree = render(ExecutionDefaultsSettings);
    const options = findByTestId(tree, "execution-defaults-choice-sheet").props.options as Array<{ value: string; label: string }>;
    expect(options.find((option) => option.value === "dont_ask")?.label).toBe(expectedLabel);
    expect(options.find((option) => option.value === "follow")?.label).toBe(labels["execution_defaults.follow_target"]);
    expect(labels["task.permission_mode_dont_ask_description"]).toBe(expectedDescription);
    expect(options.map((option) => option.value)).toEqual(["follow", "ask", "auto", "accept_edits", "dont_ask", "bypass", "yolo"]);
  });

  it("rejects a read DTO with a missing required field and keeps saving unavailable", async () => {
    const target = makeTarget(async () => ({ persistedPermissionMode: null, effectivePermissionMode: "ask" }));
    render(ExecutionDefaultsSettings);
    await flush();
    const tree = render(ExecutionDefaultsSettings);

    expect(maybeByTestId(tree, "execution-defaults-permission-mode")).toBeNull();
    expect(maybeByTestId(tree, "execution-defaults-retry")).not.toBeNull();
    expect(target.request).toHaveBeenCalledTimes(1);
    expect(target.request).toHaveBeenCalledWith("settings/execution-defaults/read", {});
  });

  it("reads after an unknown write and only writes again after an explicit save", async () => {
    let reads = 0;
    let writes = 0;
    const target = makeTarget(async (method) => {
      if (method === "settings/execution-defaults/read") {
        reads += 1;
        return reads === 1 ? validDefaults : { ...validDefaults, effectivePermissionMode: "auto" };
      }
      writes += 1;
      if (writes === 1) throw new MobileRpcError("delivery unknown", -1, "transport", "unknown");
      return { ...validDefaults, persistedPermissionMode: "auto", effectivePermissionMode: "auto" };
    });
    let tree = render(ExecutionDefaultsSettings);
    await flush();
    tree = render(ExecutionDefaultsSettings);
    press(findByTestId(tree, "execution-defaults-permission-mode"));
    tree = render(ExecutionDefaultsSettings);
    const sheet = findByTestId(tree, "execution-defaults-choice-sheet");
    (sheet.props.onSelect as (value: string) => void)("auto");
    (sheet.props.onClose as () => void)();
    tree = render(ExecutionDefaultsSettings);
    const saveButton = findByTestId(tree, "execution-defaults-save");
    press(saveButton);
    press(saveButton);
    (sheet.props.onSelect as (value: string) => void)("ask");
    await flush();
    tree = render(ExecutionDefaultsSettings);
    await flush();
    tree = render(ExecutionDefaultsSettings);

    expect(target.request.mock.calls.map(([method]) => method)).toEqual([
      "settings/execution-defaults/read",
      "settings/execution-defaults/save",
      "settings/execution-defaults/read",
    ]);
    expect(maybeByTestId(tree, "execution-defaults-reconciled")).not.toBeNull();
    expect(maybeByTestId(tree, "execution-defaults-saved")).toBeNull();
    expect(writes).toBe(1);

    press(findByTestId(tree, "execution-defaults-save"));
    await flush();
    tree = render(ExecutionDefaultsSettings);
    expect(writes).toBe(2);
    expect(maybeByTestId(tree, "execution-defaults-saved")).not.toBeNull();
  });
});

describe("custom instruction settings receipts", () => {
  it("does not treat a missing read field as an empty saved baseline", async () => {
    const target = makeTarget(async () => ({}));
    let tree = render(CustomInstructionsSettings);
    await flush();
    tree = render(CustomInstructionsSettings);
    const input = findByTestId(tree, "custom-instructions-input");
    (input.props.onChangeText as (value: string) => void)("new draft");
    tree = render(CustomInstructionsSettings);

    expect(findByTestId(tree, "custom-instructions-save").props.disabled).toBe(true);
    expect(maybeByTestId(tree, "custom-instructions-retry")).not.toBeNull();
    expect(target.request).toHaveBeenCalledTimes(1);
  });

  it("reconciles an invalid write receipt by reading current instructions before another save", async () => {
    let reads = 0;
    let writes = 0;
    const target = makeTarget(async (method) => {
      if (method === "runtime.context.get") {
        reads += 1;
        return { instructions: "stored" };
      }
      writes += 1;
      return writes === 1 ? {} : { instructions: "draft" };
    });
    let tree = render(CustomInstructionsSettings);
    await flush();
    tree = render(CustomInstructionsSettings);
    (findByTestId(tree, "custom-instructions-input").props.onChangeText as (value: string) => void)("draft");
    tree = render(CustomInstructionsSettings);
    press(findByTestId(tree, "custom-instructions-save"));
    press(findByTestId(tree, "custom-instructions-save"));
    await flush();
    tree = render(CustomInstructionsSettings);
    await flush();
    tree = render(CustomInstructionsSettings);

    expect(target.request.mock.calls.map(([method]) => method)).toEqual([
      "runtime.context.get",
      "runtime.context.update",
      "runtime.context.get",
    ]);
    expect(maybeByTestId(tree, "custom-instructions-reconciled")).not.toBeNull();
    expect(maybeByTestId(tree, "custom-instructions-saved")).toBeNull();
    expect(writes).toBe(1);

    press(findByTestId(tree, "custom-instructions-save"));
    await flush();
    tree = render(CustomInstructionsSettings);
    expect(reads).toBe(2);
    expect(writes).toBe(2);
    expect(maybeByTestId(tree, "custom-instructions-saved")).not.toBeNull();
  });

  it("reconnects by reading the same target and clears the stuck saving state without replaying", async () => {
    let rejectWrite!: (value: unknown) => void;
    let reads = 0;
    let writes = 0;
    const write = new Promise<unknown>((_resolve, reject) => { rejectWrite = reject; });
    const target = makeTarget(async (method) => {
      if (method === "runtime.context.get") {
        reads += 1;
        return { instructions: "stored" };
      }
      writes += 1;
      return write;
    });
    let tree = render(CustomInstructionsSettings);
    await flush();
    tree = render(CustomInstructionsSettings);
    (findByTestId(tree, "custom-instructions-input").props.onChangeText as (value: string) => void)("draft");
    tree = render(CustomInstructionsSettings);
    press(findByTestId(tree, "custom-instructions-save"));

    target.ready = false;
    render(CustomInstructionsSettings);
    tree = render(CustomInstructionsSettings);
    rejectWrite(new MobileRpcError("connection closed", -1, "transport", "unknown"));
    await flush();
    tree = render(CustomInstructionsSettings);
    expect(maybeByTestId(tree, "custom-instructions-outcome-unknown")).not.toBeNull();
    target.ready = true;
    tree = render(CustomInstructionsSettings);
    await flush();
    tree = render(CustomInstructionsSettings);
    expect(target.request.mock.calls.map(([method]) => method)).toEqual([
      "runtime.context.get",
      "runtime.context.update",
      "runtime.context.get",
    ]);
    expect(reads).toBe(2);
    expect(writes).toBe(1);
    expect(findByTestId(tree, "custom-instructions-input").props.value).toBe("draft");
    expect(findByTestId(tree, "custom-instructions-save").props.disabled).toBe(false);

    expect(maybeByTestId(tree, "custom-instructions-reconciled")).not.toBeNull();
    expect(maybeByTestId(tree, "custom-instructions-saved")).toBeNull();
  });

  it("locks the draft while saving and enforces the UTF-8 byte limit", async () => {
    let resolveWrite!: (value: unknown) => void;
    const write = new Promise<unknown>((resolve) => { resolveWrite = resolve; });
    const target = makeTarget(async (method) => method === "runtime.context.get" ? { instructions: "stored" } : write);
    let tree = render(CustomInstructionsSettings);
    await flush();
    tree = render(CustomInstructionsSettings);
    (findByTestId(tree, "custom-instructions-input").props.onChangeText as (value: string) => void)("draft");
    tree = render(CustomInstructionsSettings);
    press(findByTestId(tree, "custom-instructions-save"));
    tree = render(CustomInstructionsSettings);
    const input = findByTestId(tree, "custom-instructions-input");
    expect(input.props.editable).toBe(false);
    (input.props.onChangeText as (value: string) => void)("changed while saving");
    tree = render(CustomInstructionsSettings);
    expect(findByTestId(tree, "custom-instructions-input").props.value).toBe("draft");
    resolveWrite({ instructions: "draft" });
    await flush();
    tree = render(CustomInstructionsSettings);
    expect(maybeByTestId(tree, "custom-instructions-saved")).not.toBeNull();

    (findByTestId(tree, "custom-instructions-input").props.onChangeText as (value: string) => void)("😀".repeat(16_385));
    tree = render(CustomInstructionsSettings);
    expect(maybeByTestId(tree, "custom-instructions-too-long")).not.toBeNull();
    expect(findByTestId(tree, "custom-instructions-save").props.disabled).toBe(true);
    expect(target.request).toHaveBeenCalledTimes(2);
  });
});

const editorCases = [
  { name: "permissions", component: ExecutionDefaultsSettings,
    read: "settings/execution-defaults/read", write: "settings/execution-defaults/save",
    prefix: "execution-defaults", original: "follow", submitted: "auto", other: "ask",
    dto: (value: string) => ({ ...validDefaults, persistedPermissionMode: value === "follow" ? null : value,
      effectivePermissionMode: value === "follow" ? "ask" : value }),
    edit: (tree: ElementLike, value: string) => {
      press(findByTestId(tree, "execution-defaults-permission-mode"));
      const sheet = findByTestId(render(ExecutionDefaultsSettings), "execution-defaults-choice-sheet");
      (sheet.props.onSelect as (value: string) => void)(value);
      (sheet.props.onClose as () => void)();
    },
    value: (tree: ElementLike) => findByTestId(tree, "execution-defaults-choice-sheet").props.selected,
  },
  { name: "instructions", component: CustomInstructionsSettings,
    read: "runtime.context.get", write: "runtime.context.update", prefix: "custom-instructions",
    original: "A original", submitted: "A submitted", other: "B original",
    dto: (value: string) => ({ instructions: value }),
    edit: (tree: ElementLike, value: string) => {
      (findByTestId(tree, "custom-instructions-input").props.onChangeText as (value: string) => void)(value);
    },
    value: (tree: ElementLike) => findByTestId(tree, "custom-instructions-input").props.value,
  },
];

async function settled(component: () => unknown): Promise<ElementLike> {
  let tree = render(component);
  for (let index = 0; index < 3; index += 1) {
    await flush();
    tree = render(component);
  }
  return tree;
}

for (const editor of editorCases) {
  describe(`${editor.name} target-owned snapshots`, () => {
    it("retains unknown writes and drafts through hook teardown and two target read failures", async () => {
      let readsA = 0;
      let writes = 0;
      let allowRead = false;
      const requestA = async (method: string) => {
        if (method === editor.write) {
          writes += 1;
          throw new MobileRpcError("lost acknowledgement", -1, "transport", "unknown");
        }
        readsA += 1;
        if (readsA > 1 && !allowRead) throw new MobileRpcError("read disconnected", -1, "transport", "unknown");
        return editor.dto(readsA === 1 ? editor.original : editor.submitted);
      };
      makeTarget(requestA);
      let tree = await settled(editor.component);
      editor.edit(tree, editor.submitted);
      tree = render(editor.component);
      press(findByTestId(tree, editor.prefix + "-save"));
      tree = await settled(editor.component);
      expect(maybeByTestId(tree, editor.prefix + "-outcome-unknown")).not.toBeNull();

      unmountEditor();
      const targetB = makeTarget(async () => editor.dto(editor.other), "profile-b/server-b");
      tree = await settled(editor.component);
      expect(editor.value(tree)).toBe(editor.other);
      expect(maybeByTestId(tree, editor.prefix + "-outcome-unknown")).toBeNull();
      expect(targetB.request.mock.calls.every(([method]) => method === editor.read)).toBe(true);

      unmountEditor();
      makeTarget(requestA);
      tree = await settled(editor.component);
      expect(editor.value(tree)).toBe(editor.submitted);
      expect(maybeByTestId(tree, editor.prefix + "-outcome-unknown")).not.toBeNull();
      expect(findByTestId(tree, editor.prefix + "-save").props.disabled).toBe(true);
      expect(writes).toBe(1);
      expect(readsA).toBe(3);

      allowRead = true;
      press(findByTestId(tree, editor.prefix + "-retry"));
      tree = await settled(editor.component);
      expect(editor.value(tree)).toBe(editor.submitted);
      expect(maybeByTestId(tree, editor.prefix + "-saved")).not.toBeNull();
      expect(writes).toBe(1);
    });

    it.each(["success", "unknown"])("waits for an in-flight write across target remount and observes late %s", async (outcome) => {
      let resolveWrite!: (value: unknown) => void;
      let rejectWrite!: (value: unknown) => void;
      const write = new Promise<unknown>((resolve, reject) => { resolveWrite = resolve; rejectWrite = reject; });
      let reads = 0;
      let writes = 0;
      const requestA = async (method: string) => {
        if (method === editor.write) { writes += 1; return write; }
        reads += 1;
        return editor.dto(reads === 1 ? editor.original : editor.submitted);
      };
      makeTarget(requestA);
      let tree = await settled(editor.component);
      editor.edit(tree, editor.submitted);
      tree = render(editor.component);
      press(findByTestId(tree, editor.prefix + "-save"));
      unmountEditor();
      makeTarget(async () => editor.dto(editor.other), "profile-b/server-b");
      tree = await settled(editor.component);
      expect(editor.value(tree)).toBe(editor.other);
      unmountEditor();
      makeTarget(requestA);
      tree = await settled(editor.component);
      expect(editor.value(tree)).toBe(editor.submitted);
      expect(findByTestId(tree, editor.prefix + "-save").props.disabled).toBe(true);
      expect(reads).toBe(1);
      if (outcome === "success") resolveWrite(editor.dto(editor.submitted));
      else rejectWrite(new MobileRpcError("lost acknowledgement", -1, "transport", "unknown"));
      tree = await settled(editor.component);
      expect(reads).toBe(2);
      expect(writes).toBe(1);
      expect(editor.value(tree)).toBe(editor.submitted);
      expect(maybeByTestId(tree, editor.prefix + "-outcome-unknown")).toBeNull();
      expect(findByTestId(tree, editor.prefix + "-save").props.disabled).toBe(true);
    });


    it("keeps a late unknown write isolated while B is active and recovers A after read failure", async () => {
      let rejectWrite!: (value: unknown) => void;
      const write = new Promise<unknown>((_resolve, reject) => { rejectWrite = reject; });
      let readsA = 0;
      let writes = 0;
      let allowRead = false;
      const requestA = async (method: string) => {
        if (method === editor.write) { writes += 1; return write; }
        readsA += 1;
        if (readsA > 1 && !allowRead) throw new MobileRpcError("read disconnected", -1, "transport", "unknown");
        return editor.dto(readsA === 1 ? editor.original : editor.submitted);
      };
      makeTarget(requestA);
      let tree = await settled(editor.component);
      editor.edit(tree, editor.submitted);
      tree = render(editor.component);
      press(findByTestId(tree, editor.prefix + "-save"));
      unmountEditor();
      const targetB = makeTarget(async () => editor.dto(editor.other), "profile-b/server-b");
      tree = await settled(editor.component);
      rejectWrite(new MobileRpcError("lost acknowledgement", -1, "transport", "unknown"));
      tree = await settled(editor.component);
      expect(editor.value(tree)).toBe(editor.other);
      expect(maybeByTestId(tree, editor.prefix + "-outcome-unknown")).toBeNull();
      expect(targetB.request).toHaveBeenCalledTimes(1);
      unmountEditor();
      makeTarget(requestA);
      tree = await settled(editor.component);
      expect(editor.value(tree)).toBe(editor.submitted);
      expect(maybeByTestId(tree, editor.prefix + "-outcome-unknown")).not.toBeNull();
      expect(findByTestId(tree, editor.prefix + "-save").props.disabled).toBe(true);
      expect(readsA).toBe(2);
      allowRead = true;
      press(findByTestId(tree, editor.prefix + "-retry"));
      tree = await settled(editor.component);
      expect(maybeByTestId(tree, editor.prefix + "-saved")).not.toBeNull();
      expect(writes).toBe(1);
    });

    it.each([false, true])("refreshes pristine cache and retains dirty cache on remount (dirty=%s)", async (dirty) => {
      let savedA = editor.original;
      const requestA = async () => editor.dto(savedA);
      makeTarget(requestA);
      let tree = await settled(editor.component);
      if (dirty) editor.edit(tree, editor.submitted);
      unmountEditor();
      makeTarget(async () => editor.dto(editor.other), "profile-b/server-b");
      await settled(editor.component);
      savedA = editor.other;
      unmountEditor();
      makeTarget(requestA);
      tree = await settled(editor.component);
      expect(editor.value(tree)).toBe(dirty ? editor.submitted : editor.other);
      expect(findByTestId(tree, editor.prefix + "-save").props.disabled).toBe(!dirty);
    });
  });
}
