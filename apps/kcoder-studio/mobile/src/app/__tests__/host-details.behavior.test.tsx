import React from "react";
import { createRequire } from "node:module";
import { beforeEach, expect, it, vi } from "vitest";
import { initLocale, t } from "@/i18n";
import HostDetailsRoute from "../host-details";
import type { ServerStatus } from "@/gateway/types";

const fixture = vi.hoisted(() => ({ serverId: "target", profileId: "gateway", statuses: [] as ServerStatus[], statusRefreshing: false, statusError: null as string | null, reauthorizationRequired: false }));
vi.mock("expo-router", () => ({ useLocalSearchParams: () => ({ serverId: fixture.serverId, profileId: fixture.profileId }), useRouter: () => ({ push() {}, replace() {} }), useIsFocused: () => true }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
vi.mock("@/state/AppContext", () => ({ useApp: () => ({ activeProfile: { id: "gateway", label: "Gateway", baseUrl: "https://gateway.test", accessToken: "test", rpcToken: "test", expiresAt: Number.MAX_SAFE_INTEGER, authorizationGeneration: "auth-A", deviceId: "device-A" }, demo: false, refresh() {}, runtime: {
  loading: false, serversReady: true, statuses: fixture.statuses, statusRefreshing: fixture.statusRefreshing, statusError: fixture.statusError, reauthorizationRequired: fixture.reauthorizationRequired,
  servers: ["target", "other"].map(id => ({ id, label: id, transport: "local", runtime: "kcoder", workspacePath: `/${id}`,
    capabilities: { terminalSessions: true, browserSessions: true, workspaceFiles: true } })),
} }) }));
vi.mock("@/theme", () => ({
  useTheme: () => ({ colors: new Proxy({}, { get: (_target, key) => String(key) }) }),
  useThemedStyles: (factory: (colors: unknown) => unknown) => factory(new Proxy({}, { get: (_target, key) => String(key) })),
  radius: { md: 8, lg: 12 }, spacing: { sm: 8, md: 12, lg: 16, xl: 24 },
}));
vi.mock("lucide-react-native", () => Object.fromEntries(["Bot", "ChevronLeft", "FileText", "Folder", "Globe2", "History", "Laptop", "RefreshCw", "Server", "SquareTerminal"].map(name => [name, () => null])));
vi.mock("react-native", async () => {
  const React = await import("react");
  const native = ({ children, testID, accessibilityLabel, accessibilityRole, disabled, style }: { children?: React.ReactNode; testID?: string; accessibilityLabel?: string; accessibilityRole?: string; disabled?: boolean; style?: unknown }) => {
    const background = Object.assign({}, ...[style].flat().filter(item => item && typeof item === "object")).backgroundColor;
    return React.createElement("div", { "data-testid": testID, "aria-label": accessibilityLabel, role: accessibilityRole, "data-disabled": disabled, "data-background": background }, children);
  };
  return { ActivityIndicator: native, Pressable: native, ScrollView: native, Text: native, TextInput: native, View: native,
    StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1 } };
});
const { renderToStaticMarkup } = createRequire(import.meta.url)("react-dom/server") as { renderToStaticMarkup(node: React.ReactNode): string };
function status(markup: string, capability: string): string {
  return markup.match(new RegExp(`data-testid="host-capability-${capability}-status">([^<]+)`))?.[1] ?? "";
}
const renderHost = () => renderToStaticMarkup(<HostDetailsRoute />);
beforeEach(() => {
  initLocale("en"); fixture.serverId = "target"; fixture.profileId = "gateway"; fixture.statuses = [];
  fixture.statusRefreshing = false; fixture.statusError = null; fixture.reauthorizationRequired = false;
});
it.each(["en", "zh-CN"] as const)("%s preserves true, false and absent capability states", locale => {
  initLocale(locale);
  fixture.statuses = [{ id: "target", status: "online", capabilities: { experimental: { terminalSessions: true, browserSessions: false } } }];
  const markup = renderHost();
  expect(status(markup, "terminal")).toBe(t("host_details.available"));
  expect(status(markup, "browser")).toBe(t("host_details.unavailable"));
  expect(status(markup, "files")).toBe(t("host_details.unknown"));
  expect(status(markup, "agent")).toBe(t("host_details.unknown"));
  expect(markup).toContain(`aria-label="${t("settings.status_online")}"`);
  expect(markup).toContain(`>${t("settings.status_online")}<`);
});
it("does not infer capabilities from an online KCoder runtime identity", () => {
  fixture.statuses = [{ id: "target", status: "online" }];
  const markup = renderHost();
  for (const capability of ["agent", "terminal", "browser", "files"])
    expect(status(markup, capability)).toBe(t("host_details.unknown"));
});
it.each(["offline", "checking"] as const)("does not present old handshake capabilities as current while %s", connectionStatus => {
  fixture.statuses = [{ id: "target", status: connectionStatus, capabilities: { experimental: { browserSessions: true } } }];
  const markup = renderHost();
  expect(status(markup, "browser")).toBe(t("host_details.unknown"));
  expect(markup).toContain(`aria-label="${t(connectionStatus === "offline" ? "settings.status_offline" : "settings.status_checking")}"`);
  expect(markup).toContain(`>${t(connectionStatus === "offline" ? "settings.status_offline" : "settings.status_checking")}<`);
});
it.each(["en", "zh-CN"] as const)("%s invalidates retained online observations during refresh, failure and reauthorization", locale => {
  initLocale(locale);
  const checkedAt = Date.UTC(2026, 9, 12, 8, 30);
  fixture.statuses = [{ id: "target", status: "online", checkedAt, latencyMs: 123, capabilities: { experimental: { terminalSessions: true, browserSessions: true, workspaceFiles: true } } }];
  for (const outcome of ["refreshing", "failed", "reauthorization"] as const) {
    fixture.statusRefreshing = outcome === "refreshing";
    fixture.statusError = outcome === "failed" ? "Status check failed" : null;
    fixture.reauthorizationRequired = outcome === "reauthorization";
    const markup = renderHost();
    for (const capability of ["agent", "terminal", "browser", "files"])
      expect(status(markup, capability)).toBe(t("host_details.unknown"));
    expect(markup).not.toContain(`aria-label="${t("settings.status_online")}"`);
    expect(markup).not.toContain(`>${t("settings.status_online")}<`);
    expect(markup).toContain(`aria-label="${t(outcome === "refreshing" ? "settings.status_checking" : "task.unknown")}"`);
    expect(markup).toContain(`>${t(outcome === "reauthorization" ? "settings.session_expired_reauth" : outcome === "refreshing" ? "settings.status_checking" : "host_details.unknown")}<`);
    expect(markup).toContain(t("host_details.checked_at"));
    expect(markup).toContain(new Date(checkedAt).toLocaleString(locale, { hour12: false }));
    expect(markup).not.toContain("123 ms");
    if (outcome === "failed") expect(markup).toMatch(/role="alert"[^>]*>Status check failed/);
  }
});
it("displays the selected target's offline error", () => {
  fixture.statuses = [{ id: "target", status: "offline", error: "SSH connection refused" }];
  expect(renderHost()).toMatch(/role="alert"[^>]*>SSH connection refused/);
});
it("does not present an unchecked target as actively checking", () => {
  const markup = renderHost();
  expect(markup).toContain(`aria-label="${t("task.unknown")}"`);
  expect(markup).not.toContain(`>${t("settings.status_checking")}<`);
});
it("keeps target-wide history refresh disabled until the active profile-owned catalog is complete", () => {
  const markup = renderHost();
  expect(markup).toContain('data-testid="host-refresh-known-history"');
  expect(markup).toContain('data-testid="host-refresh-known-history" aria-label="Only this host: target" role="button" data-disabled="true"');
  fixture.profileId = "another-gateway";
  const wrongProfile = renderHost();
  expect(wrongProfile).not.toContain('data-testid="host-refresh-known-history"');
  expect(wrongProfile).toContain(t("host_details.missing_title"));
});
it("keeps handshake observations owned by the selected server across route changes", () => {
  fixture.statuses = [
    { id: "target", status: "online", capabilities: { experimental: { browserSessions: false } } },
    { id: "other", status: "online", capabilities: { experimental: { browserSessions: true } } },
  ];
  expect(status(renderHost(), "browser")).toBe(t("host_details.unavailable"));
  fixture.serverId = "other";
  expect(status(renderHost(), "browser")).toBe(t("host_details.available"));
  fixture.statuses = [fixture.statuses[0]!];
  expect(status(renderHost(), "browser")).toBe(t("host_details.unknown"));
  fixture.serverId = "target";
  expect(status(renderHost(), "browser")).toBe(t("host_details.unavailable"));
});
