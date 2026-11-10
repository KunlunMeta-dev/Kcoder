import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, expect, test, vi } from "vitest";
import { initLocale } from "@/i18n";
import type { AndroidUpdater, DownloadProgress } from "./android-updates";
import { AndroidUpdatePanel } from "./AndroidUpdatePanel";

const callbacks = vi.hoisted(() => ({ appState: (_state: string) => {} }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
vi.mock("react-native", () => ({ View: "View", Text: "Text", StyleSheet: { create: (value: unknown) => value },
  Linking: { openURL: vi.fn(async () => {}) },
  AppState: { addEventListener: (_: string, listener: (state: string) => void) => { callbacks.appState = listener; return { remove() {} }; } },
}));
vi.mock("lucide-react-native", () => ({ Download: () => null }));
vi.mock("@/components/settings/settings-layout", () => ({ SettingsGroup: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock("@/components/ui", () => ({ Button: ({ children, ...props }: Record<string, unknown> & { children: React.ReactNode }) => <button {...props}>{children}</button> }));
vi.mock("@/theme", () => ({ spacing: { sm: 8, lg: 16 }, useTheme: () => ({ colors: {} }), useThemedStyles: (make: (colors: object) => unknown) => make({}) }));

const info = { packageName: "dev.kcoder.studio", versionName: "2.0.1", versionCode: 20, abis: ["arm64-v8a"] };
const releases = [{ draft: false, prerelease: false, html_url: "https://github.com/yixuanchen189756-source/KCoder/releases/tag/v21", body: "Fixes", assets: [{
  name: "kcoder-studio-mobile-2.0.2-android-arm64-v8a-build21.apk", state: "uploaded", size: 100, digest: `sha256:${"a".repeat(64)}`,
  browser_download_url: "https://github.com/yixuanchen189756-source/KCoder/releases/download/v21/mobile.apk",
}] }];
function bridge() {
  let progress: (value: DownloadProgress) => void = () => {};
  const updater = { getInstalledInfo: vi.fn(async () => info), canInstall: vi.fn(async () => true),
    openInstallPermission: vi.fn(async () => {}), download: vi.fn<AndroidUpdater["download"]>(async () => {}), cancelDownload: vi.fn(), installUpdate: vi.fn<AndroidUpdater["installUpdate"]>(async () => {}),
    onProgress: (listener: typeof progress) => { progress = listener; return { remove: vi.fn() }; } } satisfies AndroidUpdater;
  return { updater, progress: (value: DownloadProgress) => progress(value) };
}
function button(renderer: ReactTestRenderer, id: string) {
  return renderer.root.findAll(node => node.props.testID === id && typeof node.type === "string")[0];
}
async function press(renderer: ReactTestRenderer, id: string) {
  await act(async () => { button(renderer, id).props.onPress(); await new Promise(resolve => setTimeout(resolve, 0)); });
}
beforeEach(() => {
  initLocale("en");
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(releases))));
});

test("checking and verified download precede a manual installer handoff, never an installed-success claim", async () => {
  const { updater } = bridge(); let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<AndroidUpdatePanel updater={updater} />); });
  await press(renderer, "android-update-check");
  expect(JSON.stringify(renderer.toJSON())).toContain("2.0.2");
  expect(updater.download).not.toHaveBeenCalled();
  await press(renderer, "android-update-download");
  expect(updater.download).toHaveBeenCalledOnce();
  expect(updater.installUpdate).not.toHaveBeenCalled();
  await press(renderer, "android-update-install");
  expect(updater.installUpdate).toHaveBeenCalledExactlyOnceWith(updater.download.mock.calls[0][1]);
  expect(JSON.stringify(renderer.toJSON())).toContain("Confirm the update in the system installer");
  await act(async () => renderer.unmount());
});

test("permission return only enables Install; it does not silently launch the installer", async () => {
  const { updater } = bridge(); updater.canInstall.mockResolvedValue(false); let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<AndroidUpdatePanel updater={updater} />); });
  await press(renderer, "android-update-check"); await press(renderer, "android-update-download"); await press(renderer, "android-update-install");
  await press(renderer, "android-update-permission");
  expect(updater.openInstallPermission).toHaveBeenCalledOnce();
  updater.canInstall.mockResolvedValue(true);
  await act(async () => callbacks.appState("active"));
  expect(button(renderer, "android-update-install")).toBeDefined();
  expect(updater.installUpdate).not.toHaveBeenCalled();
  await act(async () => renderer.unmount());
});

test("cancel is scoped to this download and stale progress cannot replace it", async () => {
  const fixture = bridge(); let rejectDownload!: (error: Error) => void;
  fixture.updater.download.mockImplementation(() => new Promise((_resolve, reject) => { rejectDownload = reject; }));
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<AndroidUpdatePanel updater={fixture.updater} />); });
  await press(renderer, "android-update-check"); await press(renderer, "android-update-download");
  const requestId = fixture.updater.download.mock.calls[0][1];
  await act(async () => fixture.progress({ requestId: "old-request", received: 90, total: 100 }));
  expect(JSON.stringify(renderer.toJSON())).not.toContain("90%");
  await act(async () => fixture.progress({ requestId, received: 30, total: 100 }));
  expect(JSON.stringify(renderer.toJSON())).toContain("30");
  await press(renderer, "android-update-cancel");
  expect(fixture.updater.cancelDownload).toHaveBeenCalledWith(requestId);
  await act(async () => rejectDownload(new Error("cancelled")));
  expect(button(renderer, "android-update-download")).toBeDefined();
  expect(fixture.updater.installUpdate).not.toHaveBeenCalled();
  await act(async () => renderer.unmount());
});

test("leaving About aborts a check and late results cannot start a download", async () => {
  let resolveFetch!: (response: Response) => void;
  vi.stubGlobal("fetch", vi.fn(() => new Promise(resolve => { resolveFetch = resolve; })));
  const { updater } = bridge(); let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<AndroidUpdatePanel updater={updater} />); });
  await press(renderer, "android-update-check");
  const signal = vi.mocked(fetch).mock.calls[0][1]?.signal;
  await act(async () => renderer.unmount());
  expect(signal?.aborted).toBe(true);
  await act(async () => resolveFetch(new Response(JSON.stringify(releases))));
  expect(updater.download).not.toHaveBeenCalled();
});

test("an inaccessible source is a recoverable error rather than already up to date", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
  const { updater } = bridge(); let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<AndroidUpdatePanel updater={updater} />); });
  await press(renderer, "android-update-check");
  expect(JSON.stringify(renderer.toJSON())).toContain("not publicly accessible yet");
  expect(button(renderer, "android-update-check").props.disabled).toBe(false);
  await act(async () => renderer.unmount());
});

test("an installer error retains the verified package and only retries on another explicit click", async () => {
  const { updater } = bridge(); updater.installUpdate.mockRejectedValue({ code: "ERR_UPDATE_INSTALLER" });
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<AndroidUpdatePanel updater={updater} />); });
  await press(renderer, "android-update-check"); await press(renderer, "android-update-download"); await press(renderer, "android-update-install");
  expect(JSON.stringify(renderer.toJSON())).toContain("system installer could not be opened");
  expect(updater.installUpdate).toHaveBeenCalledTimes(1);
  expect(button(renderer, "android-update-download")).toBeUndefined();
  updater.installUpdate.mockResolvedValue();
  await press(renderer, "android-update-install");
  expect(updater.installUpdate).toHaveBeenCalledTimes(2);
  expect(updater.download).toHaveBeenCalledOnce();
  await act(async () => renderer.unmount());
});

test("returning to a retained About page after cancellation does not leave a stuck download", async () => {
  const { updater } = bridge(); let rejectDownload!: (reason: Error) => void;
  updater.download.mockImplementation(() => new Promise((_resolve, reject) => { rejectDownload = reject; }));
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<AndroidUpdatePanel updater={updater} />); });
  await press(renderer, "android-update-check"); await press(renderer, "android-update-download");
  await act(async () => renderer.update(<AndroidUpdatePanel updater={updater} active={false} />));
  expect(updater.cancelDownload).toHaveBeenCalledWith(updater.download.mock.calls[0][1]);
  await act(async () => rejectDownload(new Error("cancelled")));
  await act(async () => renderer.update(<AndroidUpdatePanel updater={updater} active />));
  expect(button(renderer, "android-update-check").props.disabled).toBe(false);
  expect(button(renderer, "android-update-download")).toBeDefined();
  await act(async () => renderer.unmount());
});

test("a stalled native version read times out, and a late response cannot revive the check", async () => {
  vi.useFakeTimers();
  const { updater } = bridge(); let resolveInfo!: (value: typeof info) => void;
  updater.getInstalledInfo.mockImplementation(() => new Promise(resolve => { resolveInfo = resolve; }));
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => { renderer = create(<AndroidUpdatePanel updater={updater} />); });
    await act(async () => button(renderer, "android-update-check").props.onPress());
    await act(async () => { await vi.advanceTimersByTimeAsync(20_001); });
    expect(button(renderer, "android-update-check").props.disabled).toBe(false);
    expect(JSON.stringify(renderer.toJSON())).toContain("Check your connection and retry");
    await act(async () => resolveInfo(info));
    expect(fetch).not.toHaveBeenCalled();
    expect(updater.download).not.toHaveBeenCalled();
  } finally {
    if (renderer) await act(async () => renderer.unmount());
    vi.useRealTimers();
  }
});
