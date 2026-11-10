import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ComponentProps, ReactElement, ReactNode } from "react";
import type { TaskRuntime } from "@/runtime/task-runtime";
import { WorkspaceFileDiscoveryPanel } from "./workspace-file-discovery-panel";

const hooks = vi.hoisted(() => ({
  states: [] as unknown[],
  refs: [] as Array<{ current: unknown }>,
  effects: [] as Array<{
    deps: unknown[];
    cleanup?: () => void;
  }>,
  pendingEffects: [] as Array<{
    index: number;
    deps: unknown[];
    effect: () => void | (() => void);
  }>,
  stateIndex: 0,
  refIndex: 0,
  effectIndex: 0,
}));

vi.mock("react", async (importOriginal) => ({
  ...await importOriginal<typeof import("react")>(),
  useMemo: (factory: () => unknown) => factory(),
  useRef: (value: unknown) => {
    const index = hooks.refIndex++;
    return (hooks.refs[index] ??= { current: value });
  },
  useState: (value: unknown) => {
    const index = hooks.stateIndex++;
    if (!(index in hooks.states))
      hooks.states[index] = typeof value === "function" ? (value as () => unknown)() : value;
    return [hooks.states[index], (update: unknown) => {
      hooks.states[index] = typeof update === "function"
        ? (update as (current: unknown) => unknown)(hooks.states[index])
        : update;
    }];
  },
  useEffect: (effect: () => void | (() => void), deps: unknown[] = []) => {
    const index = hooks.effectIndex++;
    const previous = hooks.effects[index];
    const unchanged = previous && deps.length === previous.deps.length &&
      deps.every((value, position) => Object.is(value, previous.deps[position]));
    if (!unchanged) hooks.pendingEffects.push({ index, deps, effect });
  },
}));
vi.mock("react-native", () => ({
  ActivityIndicator: "ActivityIndicator",
  FlatList: "FlatList",
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Text: "Text",
  TextInput: "TextInput",
  View: "View",
}));
vi.mock("lucide-react-native", () => Object.fromEntries(
  ["Clock3", "File", "Folder", "RefreshCw", "Search", "X"].map((name) => [name, name]),
));
vi.mock("@/i18n", () => ({ t: (key: string) => key }));
vi.mock("@/i18n/use-locale", () => ({ useLocale: () => "en" }));
vi.mock("@/theme", () => ({
  radius: { md: 8, lg: 12 },
  spacing: { xs: 4, sm: 8, md: 12, lg: 16 },
  useTheme: () => ({ colors: new Proxy({}, { get: () => "color" }) }),
  useThemedStyles: (factory: (colors: unknown) => unknown) =>
    factory(new Proxy({}, { get: () => "color" })),
}));
vi.mock("./ui", () => ({ EmptyState: "EmptyState" }));

function beginRender() {
  hooks.stateIndex = 0;
  hooks.refIndex = 0;
  hooks.effectIndex = 0;
  hooks.pendingEffects = [];
}

function flushEffects() {
  for (const pending of hooks.pendingEffects) {
    hooks.effects[pending.index]?.cleanup?.();
    const cleanup = pending.effect();
    hooks.effects[pending.index] = {
      deps: pending.deps,
      cleanup: typeof cleanup === "function" ? cleanup : undefined,
    };
  }
  hooks.pendingEffects = [];
}

function renderPanel(props: ComponentProps<typeof WorkspaceFileDiscoveryPanel>) {
  beginRender();
  const tree = WorkspaceFileDiscoveryPanel(props);
  flushEffects();
  return tree;
}

function elements(node: ReactNode): Array<ReactElement<Record<string, unknown>>> {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as ReactElement<Record<string, unknown>>;
  return [element, ...elements(element.props.children as ReactNode)];
}

function byTestId(tree: ReactNode, testID: string) {
  return elements(tree).find((element) => element.props.testID === testID)!;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function settleSearch() {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

function baseProps(task: TaskRuntime, overrides: Record<string, unknown> = {}) {
  return {
    task,
    ownerKey: "owner-a",
    root: "/workspace",
    path: "/workspace",
    entries: [],
    loading: false,
    error: null,
    recentFilesError: null,
    demo: false,
    recentFiles: [],
    onRefresh: vi.fn(),
    onLoadTree: vi.fn(),
    onOpenFile: vi.fn(async () => true),
    ...overrides,
  } as ComponentProps<typeof WorkspaceFileDiscoveryPanel>;
}

beforeEach(() => {
  hooks.states = [];
  hooks.refs = [];
  hooks.effects = [];
  hooks.pendingEffects = [];
  vi.useFakeTimers();
});

afterEach(() => vi.useRealTimers());

it.each([
  { switch: "owner", ownerKey: "owner-b", root: "/workspace" },
  { switch: "root", ownerKey: "owner-a", root: "/other-workspace" },
])("ignores an old search response after a $switch switch", async ({ ownerKey, root }) => {
  const oldReply = deferred<unknown>();
  const newReply = deferred<unknown>();
  const request = vi.fn()
    .mockImplementationOnce(() => oldReply.promise)
    .mockImplementationOnce(() => newReply.promise);
  const task = { request } as unknown as TaskRuntime;
  const oldProps = baseProps(task);
  let props = oldProps;
  let tree = renderPanel(props);
  (byTestId(tree, "workspace-path-search-toggle").props.onPress as () => void)();
  tree = renderPanel(props);
  (byTestId(tree, "file-search").props.onChangeText as (value: string) => void)("notes");
  tree = renderPanel(props);
  await vi.advanceTimersByTimeAsync(250);
  expect(request).toHaveBeenNthCalledWith(1, "runtime.workspace.search", {
    root: "/workspace",
    query: "notes",
  });

  props = baseProps(task, { ownerKey, root, path: root });
  tree = renderPanel(props);
  await vi.advanceTimersByTimeAsync(250);
  expect(request).toHaveBeenNthCalledWith(2, "runtime.workspace.search", {
    root,
    query: "notes",
  });
  newReply.resolve({ files: [{ path: "new-notes.md", fileName: "new-notes.md", matchType: "file" }] });
  await settleSearch();
  tree = renderPanel(props);
  const newList = byTestId(tree, "workspace-path-search-results");
  expect((newList.props.data as Array<{ path: string }>).map((item) => item.path)).toEqual([
    `${root}/new-notes.md`,
  ]);

  oldReply.resolve({ files: [{ path: "old-notes.md", fileName: "old-notes.md", matchType: "file" }] });
  await settleSearch();
  tree = renderPanel(props);
  const finalList = byTestId(tree, "workspace-path-search-results");
  expect((finalList.props.data as Array<{ path: string }>).map((item) => item.path)).toEqual([
    `${root}/new-notes.md`,
  ]);
});

it("routes selected search directories and files to their existing open actions", async () => {
  const task = {
    request: vi.fn(async () => ({ files: [
      { path: "src", fileName: "src", matchType: "directory" },
      { path: "src/main.ts", fileName: "main.ts", matchType: "file" },
    ] })),
  } as unknown as TaskRuntime;
  const props = baseProps(task);
  let tree = renderPanel(props);
  (byTestId(tree, "workspace-path-search-toggle").props.onPress as () => void)();
  tree = renderPanel(props);
  (byTestId(tree, "file-search").props.onChangeText as (value: string) => void)("src");
  renderPanel(props);
  await vi.advanceTimersByTimeAsync(250);
  await settleSearch();
  tree = renderPanel(props);
  const list = byTestId(tree, "workspace-path-search-results");
  const data = list.props.data as Array<{ path: string; name: string; is_directory: boolean }>;
  const renderItem = list.props.renderItem as (input: { item: typeof data[number] }) => ReactElement<Record<string, unknown>>;
  const directoryRow = renderItem({ item: data.find((item) => item.is_directory)! });
  (directoryRow.props.onPress as () => void)();
  expect(props.onLoadTree).toHaveBeenCalledWith("/workspace/src");
  expect(props.onOpenFile).not.toHaveBeenCalled();

  const fileRow = renderItem({ item: data.find((item) => !item.is_directory)! });
  (fileRow.props.onPress as () => void)();
  expect(props.onOpenFile).toHaveBeenCalledWith({
    path: "/workspace/src/main.ts",
    name: "main.ts",
    is_directory: false,
  });
});

it("hides results from the previous query during the next debounce window", async () => {
  const firstReply = deferred<unknown>();
  const secondReply = deferred<unknown>();
  const task = {
    request: vi.fn()
      .mockImplementationOnce(() => firstReply.promise)
      .mockImplementationOnce(() => secondReply.promise),
  } as unknown as TaskRuntime;
  const props = baseProps(task);
  let tree = renderPanel(props);
  (byTestId(tree, "workspace-path-search-toggle").props.onPress as () => void)();
  tree = renderPanel(props);
  (byTestId(tree, "file-search").props.onChangeText as (value: string) => void)("first");
  renderPanel(props);
  await vi.advanceTimersByTimeAsync(250);
  firstReply.resolve({ files: [{ path: "first-result.ts", fileName: "first-result.ts", matchType: "file" }] });
  await settleSearch();
  tree = renderPanel(props);
  const firstList = byTestId(tree, "workspace-path-search-results");
  expect((firstList.props.data as Array<{ path: string }>).map((entry) => entry.path)).toEqual([
    "/workspace/first-result.ts",
  ]);

  (byTestId(tree, "file-search").props.onChangeText as (value: string) => void)("second");
  tree = renderPanel(props);
  const debounceList = byTestId(tree, "workspace-path-search-results");
  expect(debounceList.props.data).toEqual([]);
  expect(elements(tree).some((element) => element.props.children === "first-result.ts")).toBe(false);
  expect(task.request).toHaveBeenCalledTimes(1);

  await vi.advanceTimersByTimeAsync(250);
  expect(task.request).toHaveBeenCalledTimes(2);
  secondReply.resolve({ files: [{ path: "second-result.ts", fileName: "second-result.ts", matchType: "file" }] });
  await settleSearch();
  tree = renderPanel(props);
  const secondList = byTestId(tree, "workspace-path-search-results");
  expect((secondList.props.data as Array<{ path: string }>).map((entry) => entry.path)).toEqual([
    "/workspace/second-result.ts",
  ]);
});

it("shows only current-root recent files and opens a selected recent file", () => {
  const task = { request: vi.fn() } as unknown as TaskRuntime;
  const props = baseProps(task, {
    recentFiles: ["/workspace/src/recent.ts", "/workspace-old/private.txt"],
  });
  let tree = renderPanel(props);
  (byTestId(tree, "workspace-recent-files-toggle").props.onPress as () => void)();
  tree = renderPanel(props);
  const list = byTestId(tree, "workspace-recent-files");
  const data = list.props.data as Array<{ path: string; name: string; is_directory: boolean }>;
  expect(data).toEqual([{
    path: "/workspace/src/recent.ts",
    name: "recent.ts",
    is_directory: false,
  }]);
  const row = (list.props.renderItem as (input: { item: typeof data[number] }) => ReactElement<Record<string, unknown>>)(
    { item: data[0] },
  );
  (row.props.onPress as () => void)();
  expect(props.onOpenFile).toHaveBeenCalledWith(data[0]);
  expect(task.request).not.toHaveBeenCalled();
});

it("shows and opens Windows search and recent-file paths", async () => {
  const task = {
    request: vi.fn(async () => ({ files: [
      { path: "src/main.ts", fileName: "main.ts", matchType: "file" },
    ] })),
  } as unknown as TaskRuntime;
  const onOpenFile = vi.fn(async () => true);
  const recentPath = "C:\\workspace\\docs\\recent.md";
  const props = baseProps(task, {
    ownerKey: "windows-owner",
    root: "C:\\workspace",
    path: "C:\\workspace",
    recentFiles: [recentPath],
    onOpenFile,
  });

  let tree = renderPanel(props);
  (byTestId(tree, "workspace-path-search-toggle").props.onPress as () => void)();
  tree = renderPanel(props);
  (byTestId(tree, "file-search").props.onChangeText as (value: string) => void)("main");
  renderPanel(props);
  await vi.advanceTimersByTimeAsync(250);
  await settleSearch();
  tree = renderPanel(props);
  const searchList = byTestId(tree, "workspace-path-search-results");
  const searchEntry = (searchList.props.data as Array<{ path: string; name: string; is_directory: boolean }>)[0];
  expect(searchEntry).toEqual({
    path: "C:\\workspace\\src\\main.ts",
    name: "main.ts",
    is_directory: false,
  });
  const searchRow = (searchList.props.renderItem as (input: { item: typeof searchEntry }) => ReactElement<Record<string, unknown>>)(
    { item: searchEntry },
  );
  (searchRow.props.onPress as () => void)();
  expect(onOpenFile).toHaveBeenCalledWith(searchEntry);
  expect(task.request).toHaveBeenCalledWith("runtime.workspace.search", {
    root: "C:\\workspace",
    query: "main",
  });

  tree = renderPanel(props);
  (byTestId(tree, "workspace-recent-files-toggle").props.onPress as () => void)();
  tree = renderPanel(props);
  const recentList = byTestId(tree, "workspace-recent-files");
  const recentEntry = (recentList.props.data as Array<{ path: string; name: string; is_directory: boolean }>)[0];
  expect(recentEntry).toEqual({
    path: recentPath,
    name: "recent.md",
    is_directory: false,
  });
  const recentRow = (recentList.props.renderItem as (input: { item: typeof recentEntry }) => ReactElement<Record<string, unknown>>)(
    { item: recentEntry },
  );
  (recentRow.props.onPress as () => void)();
  expect(onOpenFile).toHaveBeenLastCalledWith(recentEntry);
});

it("renders recent-file persistence failure as a recoverable alert", () => {
  const task = { request: vi.fn() } as unknown as TaskRuntime;
  const message = "文件已打开，但无法保存到最近文件记录。";
  const tree = renderPanel(baseProps(task, { recentFilesError: message }));
  const alert = elements(tree).find((element) => element.props.accessibilityRole === "alert");
  expect(alert?.props.children).toBe(message);
});
