import React from "react";
import { createRequire } from "node:module";
import { beforeEach, expect, test, vi } from "vitest";
import { initLocale } from "@/i18n";
import { appPreferencesTestHelpers } from "@/storage/app-preferences";
import { themeTestHelpers } from "@/theme";
import { ConversationPreferencesSettings } from "./ConversationPreferencesSettings";

const { renderToStaticMarkup } = createRequire(import.meta.url)(
  "react-dom/server",
) as { renderToStaticMarkup(element: React.ReactNode): string };

vi.mock("@/components/settings/settings-choice-sheet", () => ({
  SettingsChoiceSheet: ({ testID, options }: { testID: string; options: { value: string; label: string; testID: string }[] }) => <select data-testid={testID}>{options.map(option => <option key={option.value} data-testid={option.testID} value={option.value}>{option.label}</option>)}</select>,
}));
vi.mock("@/components/settings/settings-layout", async () => {
  const ReactRuntime = await import("react");
  const { Pressable, Text, View } = await import("react-native");
  return {
    SettingsGroup: ({ testID, title, children }: {
      testID?: string;
      title?: string;
      children?: React.ReactNode;
    }) => ReactRuntime.createElement(
      View,
      { testID },
      title ? ReactRuntime.createElement(Text, null, title) : null,
      children,
    ),
    SettingsRow: ({ testID, label, note, value, onPress }: {
      testID: string;
      label: string;
      note?: string;
      value?: string;
      onPress(): void;
    }) => ReactRuntime.createElement(
      Pressable,
      { testID, onPress },
      ReactRuntime.createElement(Text, null, label),
      note ? ReactRuntime.createElement(Text, null, note) : null,
      value ? ReactRuntime.createElement(Text, null, value) : null,
    ),
  };
});

beforeEach(() => {
  appPreferencesTestHelpers.reset();
  themeTestHelpers.reset();
  initLocale("en");
});

test("conversation preference switches expose checked and disabled state in web DOM", () => {
  const html = renderToStaticMarkup(<ConversationPreferencesSettings />);
  const row = html.match(
    /<div(?=[^>]*data-testid="conversation-thinking-default-collapsed")[^>]*>/,
  )?.[0];

  expect(row).toBeDefined();
  expect(row).toContain('role="switch"');
  expect(row).toContain('aria-checked="true"');
  expect(row).not.toContain('aria-disabled="true"');
});

test.each(["en", "zh-CN"] as const)("exposes five line choices, three block/letter choices, and two font choices in %s", (locale) => {
  initLocale(locale);
  const html = renderToStaticMarkup(<ConversationPreferencesSettings />);
  for (const value of ["compact", "snug", "normal", "relaxed", "airy"]) expect(html).toContain(`conversation-line-spacing-choice-${value}`);
  for (const kind of ["block-spacing", "letter-spacing"]) for (const value of ["compact", "normal", "relaxed"]) expect(html).toContain(`conversation-${kind}-choice-${value}`);
  expect(html).toContain("conversation-font-family-choice-noto-sans-sc");
  expect(html).toContain("conversation-font-family-choice-system");
  expect(html).toMatch(new RegExp(`data-testid="conversation-font-family-choice-noto-sans-sc"[^>]*>${locale === "en" ? "Noto Sans SC" : "Noto Sans SC（思源黑体同源）"}`));
  expect(html).not.toContain("settings_personalization.line_spacing_snug");
  expect(html).not.toContain("settings_personalization.font_family_noto_sans_sc");
});
