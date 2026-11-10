import React from "react";
import { createRequire } from "node:module";
import { beforeEach, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({ target: null as unknown }));

vi.mock("@/components/settings/SettingsTargetContext", () => ({
  useSettingsTarget: () => state.target,
}));
vi.mock("@/components/settings/settings-layout", async () => {
  const ReactRuntime = await import("react");
  return {
    SettingsGroup: ({ title, testID, children }: { title?: string; testID?: string; children?: React.ReactNode }) =>
      ReactRuntime.createElement("section", { "data-testid": testID },
        title ? ReactRuntime.createElement("h2", null, title) : null,
        children,
      ),
  };
});
vi.mock("@/i18n", () => ({ t: (key: string) => key }));
vi.mock("@/i18n/use-locale", () => ({ useLocale: () => "en" }));
vi.mock("lucide-react-native", () => ({
  Check: () => null,
  RefreshCw: () => null,
  Server: () => null,
  ChevronRight: () => null,
}));

import { ToolConfigurationSettings } from "./ToolConfigurationSettings";
import { UsageSettings } from "./UsageSettings";

const { renderToStaticMarkup } = createRequire(import.meta.url)("react-dom/server") as {
  renderToStaticMarkup(element: React.ReactNode): string;
};

function target(overrides: Record<string, unknown> = {}) {
  return {
    profile: null,
    server: null,
    servers: [],
    serverId: null,
    targetIdentity: null,
    workspacePath: undefined,
    selectServer: vi.fn(),
    retry: vi.fn(),
    loading: false,
    error: null,
    ready: false,
    capabilities: { gateway: {}, appServer: null },
    request: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  state.target = target();
});

test("both settings stay target-scoped and show an explicit target prompt without a selection", () => {
  const toolMarkup = renderToStaticMarkup(<ToolConfigurationSettings />);
  const usageMarkup = renderToStaticMarkup(<UsageSettings />);

  expect(toolMarkup).toContain('data-testid="tool-configuration-settings"');
  expect(toolMarkup).toContain("settings_tools_usage.target_required");
  expect(usageMarkup).toContain('data-testid="usage-settings"');
  expect(usageMarkup).toContain('data-testid="usage-no-target"');
  expect(usageMarkup).toContain("settings_tools_usage.target_required");
  expect((state.target as ReturnType<typeof target>).request).not.toHaveBeenCalled();
});

test("tool-profile and usage controls remain capability-gated by the selected app-server", () => {
  const request = vi.fn();
  state.target = target({
    profile: { id: "profile-a" },
    server: { id: "server-a", label: "Fixture target" },
    servers: [{ id: "server-a", label: "Fixture target" }],
    serverId: "server-a",
    targetIdentity: "fixture-identity",
    ready: true,
    capabilities: { gateway: {}, appServer: { experimental: { toolProfilesV1: false, usageHistory: false } } },
    request,
  });

  const toolMarkup = renderToStaticMarkup(<ToolConfigurationSettings />);
  const usageMarkup = renderToStaticMarkup(<UsageSettings />);

  expect(toolMarkup).toContain('data-testid="tool-profile-error"');
  expect(toolMarkup).toContain("settings_tools_usage.profile_unsupported");
  expect(toolMarkup).not.toContain('data-testid="tool-profile-save"');
  expect(usageMarkup).toContain('data-testid="usage-unsupported"');
  expect(usageMarkup).toContain("settings_tools_usage.usage_unsupported");
  expect(request).not.toHaveBeenCalled();
});


test("search diagnostics stay folded and never probe while rendering the existing tools page", () => {
  const request = vi.fn();
  state.target = target({
    profile: { id: "profile-a" }, server: { id: "server-a", label: "Fixture target" },
    serverId: "server-a", targetIdentity: "fixture-identity", ready: true,
    capabilities: { gateway: {}, appServer: { experimental: { webSearchStatusV1: true, webSearchProbeV1: false } } }, request,
  });
  const markup = renderToStaticMarkup(<ToolConfigurationSettings />);
  expect(markup).toContain('data-testid="web-search-diagnostics"');
  expect(markup).toContain("web_search.details");
  expect(markup).not.toContain("web_search.check");
  expect(request).not.toHaveBeenCalled();
});
