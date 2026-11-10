import { beforeEach, describe, expect, it, vi } from "vitest";
import { settingsModelsEn } from "@/i18n/locales/settings-models.en";
import { ModelServicesSettings } from "./ModelServicesSettings";

type MemoEntry = { deps?: unknown[]; value: unknown };
type EffectEntry = { deps?: unknown[]; cleanup?: () => void };

const harness = vi.hoisted(() => ({
  states: [] as unknown[],
  refs: [] as Array<{ current: unknown } | undefined>,
  memos: [] as Array<MemoEntry | undefined>,
  effects: [] as Array<EffectEntry | undefined>,
  stateCursor: 0,
  refCursor: 0,
  memoCursor: 0,
  effectCursor: 0,
  target: null as Record<string, unknown> | null,
  labels: {} as Record<string, string>,
  router: { push: vi.fn() },
}));

function sameDependencies(previous: unknown[] | undefined, next: unknown[] | undefined): boolean {
  return previous !== undefined && next !== undefined && previous.length === next.length &&
    next.every((value, index) => Object.is(value, previous[index]));
}

vi.mock("react", async importOriginal => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: (initial: unknown) => {
      const index = harness.stateCursor++;
      if (!(index in harness.states)) harness.states[index] = typeof initial === "function"
        ? (initial as () => unknown)()
        : initial;
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
    useMemo: (factory: () => unknown, deps?: unknown[]) => {
      const index = harness.memoCursor++;
      const previous = harness.memos[index];
      if (previous && sameDependencies(previous.deps, deps)) return previous.value;
      const value = factory();
      harness.memos[index] = { deps: deps ? [...deps] : undefined, value };
      return value;
    },
    useCallback: (callback: unknown, deps?: unknown[]) => {
      const index = harness.memoCursor++;
      const previous = harness.memos[index];
      if (previous && sameDependencies(previous.deps, deps)) return previous.value;
      harness.memos[index] = { deps: deps ? [...deps] : undefined, value: callback };
      return callback;
    },
    useEffect: (effect: () => void | (() => void), deps?: unknown[]) => {
      const index = harness.effectCursor++;
      const previous = harness.effects[index];
      if (previous && sameDependencies(previous.deps, deps)) return;
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
vi.mock("expo-router", () => ({ useRouter: () => harness.router }));
vi.mock("lucide-react-native", () => ({
  Check: () => null,
  ChevronDown: () => null,
  ChevronUp: () => null,
  LoaderCircle: () => null,
  Plus: () => null,
  RefreshCw: () => null,
  Server: () => null,
  Trash2: () => null,
}));
vi.mock("@/components/settings/settings-layout", async () => {
  const ReactRuntime = await import("react");
  return {
    SettingsGroup: ({ children, ...props }: Record<string, unknown>) =>
      ReactRuntime.createElement("SettingsGroup", props, children as never),
  };
});
vi.mock("@/components/settings/SettingsTargetContext", () => ({
  useSettingsTarget: () => harness.target,
  SettingsTargetChangedError: class SettingsTargetChangedError extends Error {
    constructor(readonly delivery: "not-sent" | "unknown") { super("target changed"); }
  },
}));
vi.mock("@/i18n", () => ({ t: (key: string) => harness.labels[key] ?? key }));
vi.mock("@/i18n/use-locale", () => ({ useLocale: () => "en" }));
vi.mock("@/platform/confirmation", () => ({ requestConfirmation: vi.fn() }));
vi.mock("@/theme", () => {
  const colors = {
    accentText: "accentText", border: "border", blue: "blue", green: "green", overlay: "overlay",
    red: "red", settingsGroupBackground: "group", settingsPageBackground: "page", surface: "surface",
    text: "text", textDim: "dim", textMuted: "muted", yellow: "yellow",
  };
  return {
    radius: { lg: 12, md: 8, pill: 999, settingsGroup: 14 },
    spacing: { xs: 4, sm: 8, md: 12, lg: 16 },
    useTheme: () => ({ colors }),
    useThemedStyles: (create: (theme: typeof colors) => unknown) => create(colors),
  };
});

type ElementLike = { type: unknown; props: Record<string, unknown> & { children?: unknown } };

function makeTarget() {
  const settings = {
    supportsIndependentProbe: false,
    supportsOptimisticConcurrency: true,
    supportsModelCapabilities: true,
    profiles: [],
    restartRequired: false,
    revision: "revision-1",
  };
  const request = vi.fn(async (method: string): Promise<unknown> => {
    if (method === "runtime.providers.list") return { ...settings, profiles: [] };
    if (method === "runtime.providers.upsert") return { ...settings, revision: "revision-2", savedRevision: "revision-2" };
    throw new Error(`Unexpected target request: ${method}`);
  });
  const target = {
    profile: { id: "profile-a", label: "Fixture Gateway" },
    server: { id: "server-a", label: "Fixture target", transport: "local" },
    servers: [{ id: "server-a", label: "Fixture target", transport: "local" }],
    serverId: "server-a",
    targetIdentity: "profile-a/server-a",
    workspacePath: undefined,
    selectServer: vi.fn(),
    retry: vi.fn(),
    loading: false,
    error: null,
    ready: true,
    capabilities: { gateway: {}, appServer: { experimental: {
      providerConfiguration: true,
      providerConnectionValidation: true,
      providerModelCapabilities: true,
    } } },
    request,
    readDraft: vi.fn(() => null),
    writeDraft: vi.fn(),
    subscribeDraft: vi.fn(() => () => {}),
  };
  harness.target = target;
  return target;
}

function render(): ElementLike {
  harness.stateCursor = 0;
  harness.refCursor = 0;
  harness.memoCursor = 0;
  harness.effectCursor = 0;
  return ModelServicesSettings() as ElementLike;
}

function findByTestId(root: unknown, testID: string): ElementLike {
  if (Array.isArray(root)) {
    for (const child of root) {
      try { return findByTestId(child, testID); } catch { /* Search the remaining siblings. */ }
    }
    throw new Error(`Missing ${testID}`);
  }
  if (!root || typeof root !== "object") throw new Error(`Missing ${testID}`);
  const element = root as ElementLike;
  if (element.props?.testID === testID) return element;
  if (typeof element.type === "function")
    return findByTestId((element.type as (props: ElementLike["props"]) => unknown)(element.props), testID);
  const children = element.props?.children;
  for (const child of Array.isArray(children) ? children : [children]) {
    try { return findByTestId(child, testID); } catch { /* Search the remaining siblings. */ }
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
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

async function settled(): Promise<ElementLike> {
  render();
  await flush();
  const tree = render();
  await flush();
  return render() ?? tree;
}

function fill(tree: ElementLike, testID: string, value: string): ElementLike {
  const handler = findByTestId(tree, testID).props.onChangeText;
  if (typeof handler !== "function") throw new Error(`${testID} has no text handler`);
  (handler as (next: string) => void)(value);
  return render();
}

beforeEach(() => {
  for (const effect of harness.effects) effect?.cleanup?.();
  harness.states = [];
  harness.refs = [];
  harness.memos = [];
  harness.effects = [];
  harness.stateCursor = 0;
  harness.refCursor = 0;
  harness.memoCursor = 0;
  harness.effectCursor = 0;
  harness.labels = settingsModelsEn;
  harness.target = null;
  harness.router = { push: vi.fn() };
  makeTarget();
});

it("does not render null target state as loading and provides a connection recovery path", async () => {
  const target = harness.target as ReturnType<typeof makeTarget>;
  harness.target = {
    ...target,
    profile: null,
    server: null,
    serverId: null,
    targetIdentity: null,
    ready: false,
    loading: false,
  };

  const tree = await settled();
  const refresh = findByTestId(tree, "models-provider-refresh");
  const refreshChildren = refresh.props.children as ElementLike[];
  expect(refreshChildren.find(child => child.type === "Text")?.props.children).toBe("Refresh");
  expect(refreshChildren.some(child => child.type === "ActivityIndicator")).toBe(false);
  expect(findByTestId(tree, "models-open-connections")).toBeDefined();

  press(findByTestId(tree, "models-open-connections"));
  expect(harness.router.push).toHaveBeenCalledWith("/settings-connections");
});

describe("model service optional capability disclosure", () => {
  it("starts collapsed while keeping required model limits in the form", async () => {
    let tree = await settled();
    press(findByTestId(tree, "models-provider-new"));
    tree = render();

    const toggle = findByTestId(tree, "models-provider-capabilities-toggle");
    expect(toggle.props.accessibilityState).toEqual({ expanded: false });
    expect(toggle.props["aria-expanded"]).toBe(false);
    expect(maybeByTestId(tree, "models-provider-capability-tools")).toBeNull();
    expect(findByTestId(tree, "models-provider-context-window")).not.toBeNull();
    expect(findByTestId(tree, "models-provider-max-output")).not.toBeNull();
  });

  it("retains capability choices across collapse and sends the unchanged upsert payload", async () => {
    let tree = await settled();
    press(findByTestId(tree, "models-provider-new"));
    tree = render();
    press(findByTestId(tree, "models-provider-capabilities-toggle"));
    tree = render();
    expect(findByTestId(tree, "models-provider-capabilities-toggle").props["aria-expanded"]).toBe(true);
    press(findByTestId(tree, "models-provider-capability-tools"));
    tree = render();
    expect(findByTestId(tree, "models-provider-capability-tools").props.accessibilityState)
      .toEqual({ checked: true });

    press(findByTestId(tree, "models-provider-capabilities-toggle"));
    tree = render();
    expect(findByTestId(tree, "models-provider-capabilities-toggle").props["aria-expanded"]).toBe(false);
    expect(maybeByTestId(tree, "models-provider-capability-tools")).toBeNull();
    press(findByTestId(tree, "models-provider-capabilities-toggle"));
    tree = render();
    expect(findByTestId(tree, "models-provider-capabilities-toggle").props["aria-expanded"]).toBe(true);
    expect(findByTestId(tree, "models-provider-capability-tools").props.accessibilityState)
      .toEqual({ checked: true });

    tree = fill(tree, "models-provider-id", "fixture-provider");
    tree = fill(tree, "models-provider-endpoint", "http://127.0.0.1:8000/v1");
    tree = fill(tree, "models-provider-model", "fixture-model");
    tree = fill(tree, "models-provider-context-window", "65536");
    tree = fill(tree, "models-provider-max-output", "8192");
    press(findByTestId(tree, "models-provider-save"));
    await flush();

    const request = (harness.target as ReturnType<typeof makeTarget>).request;
    expect(request).toHaveBeenCalledWith("runtime.providers.upsert", {
      id: "fixture-provider",
      apiFormat: "openai_chat_completions",
      endpoint: "http://127.0.0.1:8000/v1",
      model: "fixture-model",
      contextWindowTokens: 65_536,
      maxOutputTokens: 8_192,
      makeDefault: false,
      validateConnection: true,
      expectedRevision: "revision-1",
      capabilities: { text: true, tools: true, vision: false, reasoning: false, structured_output: false },
    });
  });
});
