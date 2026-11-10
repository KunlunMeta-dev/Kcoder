import { beforeEach, describe, expect, it, vi } from "vitest";

interface TestQuickPhrase {
  id: string;
  title: string;
  content: string;
}

interface TestPreferences {
  language: string;
  theme: string;
  terminalScrollbackLines: number;
  conversationFontScale: string;
  conversationLineSpacing: string;
  thinkingCollapsedByDefault: boolean;
  toolsCollapsedByDefault: boolean;
  quickPhrases: TestQuickPhrase[];
}

const fixture = vi.hoisted(() => ({
  states: [] as unknown[],
  refs: [] as Array<{ current: unknown } | undefined>,
  stateCursor: 0,
  refCursor: 0,
  preferences: {
    language: "en",
    theme: "dark",
    terminalScrollbackLines: 10_000,
    conversationFontScale: "normal",
    conversationLineSpacing: "normal",
    thinkingCollapsedByDefault: true,
    toolsCollapsedByDefault: true,
    quickPhrases: [] as TestQuickPhrase[],
  },
  storageStatus: { hydration: "ready", writeError: false },
  pendingWrites: [] as Array<{
    update: { quickPhrases: TestQuickPhrase[] };
    resolve(value: TestPreferences): void;
  }>,
  updatePreferences: vi.fn(),
  retrySave: vi.fn(async () => {}),
  retryHydration: vi.fn(async () => fixture.preferences),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: (initial: unknown) => {
      const index = fixture.stateCursor++;
      if (!(index in fixture.states))
        fixture.states[index] = typeof initial === "function" ? (initial as () => unknown)() : initial;
      return [fixture.states[index], (update: unknown) => {
        fixture.states[index] = typeof update === "function"
          ? (update as (previous: unknown) => unknown)(fixture.states[index])
          : update;
      }];
    },
    useRef: (initial: unknown) => {
      const index = fixture.refCursor++;
      return fixture.refs[index] ??= { current: initial };
    },
    useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
  };
});

vi.mock("react-native", () => ({
  Pressable: "Pressable",
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Text: "Text",
  TextInput: "TextInput",
  View: "View",
}));
vi.mock("lucide-react-native", () => ({ Pencil: "Pencil", Plus: "Plus", Save: "Save", Trash2: "Trash2", X: "X" }));
vi.mock("@/components/settings/settings-layout", () => ({ SettingsGroup: "SettingsGroup" }));
vi.mock("@/i18n", () => ({ t: (key: string) => key }));
vi.mock("@/i18n/use-locale", () => ({ useLocale: () => "en" }));
vi.mock("@/theme", () => ({
  radius: { md: 6, pill: 999 },
  spacing: { xs: 4, sm: 8, md: 12, lg: 16 },
  useTheme: () => ({ colors: {
    text: "text", textMuted: "muted", textDim: "dim", red: "red", accentBright: "blue",
    accentText: "accent-text", accent: "accent", background: "background", border: "border",
    settingsGroupBackground: "group",
  } }),
  useThemedStyles: (create: (colors: Record<string, string>) => unknown) => create({
    text: "text", textMuted: "muted", textDim: "dim", red: "red", accentBright: "blue",
    accentText: "accent-text", accent: "accent", background: "background", border: "border",
    settingsGroupBackground: "group",
  }),
}));
vi.mock("@/storage/app-preferences", () => ({
  getAppPreferencesSnapshot: () => fixture.preferences,
  getAppPreferencesStorageStatus: () => fixture.storageStatus,
  retryAppPreferencesSave: () => fixture.retrySave(),
  retryHydrateAppPreferences: () => fixture.retryHydration(),
  subscribeAppPreferences: () => () => {},
  subscribeAppPreferencesStorageStatus: () => () => {},
  updateAppPreferencesAndWait: (update: { quickPhrases: typeof fixture.preferences.quickPhrases }) => {
    fixture.updatePreferences(update);
    return new Promise<typeof fixture.preferences>((resolve) => fixture.pendingWrites.push({ update, resolve }));
  },
}));

import { QuickPhrasesSettings } from "./QuickPhrasesSettings";

type ElementLike = {
  type: unknown;
  props: Record<string, unknown> & { children?: unknown };
};

function render(): ElementLike {
  fixture.stateCursor = 0;
  fixture.refCursor = 0;
  return QuickPhrasesSettings() as ElementLike;
}

function findByTestId(root: unknown, testID: string): ElementLike {
  if (Array.isArray(root)) {
    for (const child of root) {
      try {
        return findByTestId(child, testID);
      } catch {
        // Keep searching sibling elements.
      }
    }
    throw new Error(`Missing ${testID}`);
  }
  if (!root || typeof root !== "object") throw new Error(`Missing ${testID}`);
  const element = root as ElementLike;
  if (element.props?.testID === testID) return element;
  const children = element.props?.children;
  for (const child of Array.isArray(children) ? children : [children]) {
    try {
      return findByTestId(child, testID);
    } catch {
      // Keep searching the rendered tree.
    }
  }
  throw new Error(`Missing ${testID}`);
}

function resolveNextWrite(): void {
  const pending = fixture.pendingWrites.shift();
  if (!pending) throw new Error("No pending preference write");
  fixture.preferences = { ...fixture.preferences, ...pending.update };
  pending.resolve(fixture.preferences);
}

function press(element: ElementLike): void {
  const handler = element.props.onPress;
  if (typeof handler === "function") (handler as () => void)();
}

beforeEach(() => {
  fixture.states = [];
  fixture.refs = [];
  fixture.stateCursor = 0;
  fixture.refCursor = 0;
  fixture.preferences = {
    language: "en",
    theme: "dark",
    terminalScrollbackLines: 10_000,
    conversationFontScale: "normal",
    conversationLineSpacing: "normal",
    thinkingCollapsedByDefault: true,
    toolsCollapsedByDefault: true,
    quickPhrases: [],
  };
  fixture.storageStatus = { hydration: "ready", writeError: false };
  fixture.pendingWrites = [];
  fixture.updatePreferences.mockClear();
  fixture.retrySave.mockClear();
  fixture.retryHydration.mockClear();
});

describe("QuickPhrasesSettings save serialization", () => {
  it("keeps the submitted draft stable and blocks edits until its save settles", async () => {
    const existingPhrase = { id: "existing", title: "Existing", content: "Existing body" };
    fixture.preferences.quickPhrases = [existingPhrase];
    let tree = render();
    press(findByTestId(tree, "quick-phrase-add"));
    tree = render();
    (findByTestId(tree, "quick-phrase-title-input").props.onChangeText as (value: string) => void)("Greeting");
    (findByTestId(tree, "quick-phrase-content-input").props.onChangeText as (value: string) => void)("Hello there");
    tree = render();
    press(findByTestId(tree, "quick-phrase-save"));

    expect(fixture.updatePreferences).toHaveBeenCalledTimes(1);
    const submitted = fixture.updatePreferences.mock.calls[0]?.[0] as { quickPhrases: Array<{ title: string; content: string }> };
    expect(submitted.quickPhrases).toEqual([
      existingPhrase,
      expect.objectContaining({ title: "Greeting", content: "Hello there" }),
    ]);

    tree = render();
    expect(findByTestId(tree, "quick-phrase-add").props.disabled).toBe(true);
    expect(findByTestId(tree, "quick-phrase-edit-existing").props.disabled).toBe(true);
    expect(findByTestId(tree, "quick-phrase-delete-existing").props.disabled).toBe(true);
    expect(findByTestId(tree, "quick-phrase-title-input").props.editable).toBe(false);
    expect(findByTestId(tree, "quick-phrase-content-input").props.editable).toBe(false);
    press(findByTestId(tree, "quick-phrase-add"));
    press(findByTestId(tree, "quick-phrase-edit-existing"));
    press(findByTestId(tree, "quick-phrase-delete-existing"));
    (findByTestId(tree, "quick-phrase-title-input").props.onChangeText as (value: string) => void)("Replacement draft");
    expect(fixture.states[0]).toEqual(expect.objectContaining({ title: "Greeting", content: "Hello there" }));

    resolveNextWrite();
    await Promise.resolve();
    expect(fixture.states[0]).toBeNull();
    expect(fixture.preferences.quickPhrases).toEqual([
      existingPhrase,
      expect.objectContaining({ title: "Greeting", content: "Hello there" }),
    ]);
  });

  it("does not let a second in-flight delete overwrite the first snapshot", () => {
    fixture.preferences.quickPhrases = [
      { id: "first", title: "First", content: "one" },
      { id: "second", title: "Second", content: "two" },
    ];
    const tree = render();

    press(findByTestId(tree, "quick-phrase-delete-first"));
    press(findByTestId(tree, "quick-phrase-delete-second"));

    expect(fixture.updatePreferences).toHaveBeenCalledTimes(1);
    expect(fixture.updatePreferences.mock.calls[0]?.[0]).toEqual({
      quickPhrases: [{ id: "second", title: "Second", content: "two" }],
    });
    resolveNextWrite();
  });
});
