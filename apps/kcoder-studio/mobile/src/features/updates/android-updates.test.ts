import { describe, expect, test, vi } from "vitest";
import { checkAndroidUpdate, selectAndroidUpdate, type InstalledAndroidApp } from "./android-updates";

const repository = "yixuanchen189756-source/KCoder";
const installed: InstalledAndroidApp = { packageName: "dev.kcoder.studio", versionName: "2.0.1", versionCode: 20, abis: ["arm64-v8a"] };
function release(build = 21, overrides: Record<string, unknown> = {}) {
  return { draft: false, prerelease: false, tag_name: "desktop-999.0.0", html_url: `https://github.com/${repository}/releases/tag/desktop-999`,
    body: "Android fixes", assets: [{ name: `kcoder-studio-mobile-2.0.2-android-arm64-v8a-build${build}.apk`,
      state: "uploaded", digest: `sha256:${"a".repeat(64)}`, size: 100,
      browser_download_url: `https://github.com/${repository}/releases/download/desktop-999/mobile.apk` }], ...overrides };
}

describe("Android GitHub release selection", () => {
  test("uses the Android asset version and monotonic build rather than a desktop tag or publication order", () => {
    expect(selectAndroidUpdate([release(21), release(23), release(22)], installed)).toMatchObject({ version: "2.0.2", versionCode: 23, sha256: "a".repeat(64) });
  });
  test("supports the existing v20 naming scheme and does not downgrade", () => {
    const old = release(20);
    old.assets[0].name = "kcoder-studio-mobile-1.0.0-android-arm64-v8a-v20.apk";
    expect(selectAndroidUpdate([old], installed)).toBeNull();
  });
  test.each(["draft", "prerelease"])("does not install a %s release", flag => {
    expect(() => selectAndroidUpdate([release(99, { [flag]: true })], installed)).toThrow("no_release");
  });
  test("distinguishes missing compatible APKs from already up to date", () => {
    const otherArch = release(); otherArch.assets[0].name = otherArch.assets[0].name.replace("arm64-v8a", "x86_64");
    expect(() => selectAndroidUpdate([otherArch], installed)).toThrow("no_release");
    expect(() => selectAndroidUpdate([], installed)).toThrow("no_release");
    expect(selectAndroidUpdate([release(19)], installed)).toBeNull();
  });
  test.each([
    { digest: null }, { size: -1 }, { size: 513 * 1024 * 1024 },
    { browser_download_url: "http://github.com/a/b/mobile.apk" },
    { browser_download_url: "https://github.com/attacker/repo/releases/download/x/mobile.apk" },
  ])("rejects unverified or misattributed update assets: %j", patch => {
    const item = release(); Object.assign(item.assets[0], patch);
    expect(() => selectAndroidUpdate([item], installed)).toThrow("invalid_release");
  });
  test("only considers release pages from the configured source", () => {
    expect(() => selectAndroidUpdate([release(21, { html_url: "https://example.com/release" })], installed)).toThrow("no_release");
  });
});

test.each([[404, "source_unavailable"], [403, "rate_limit"], [429, "rate_limit"], [502, "network"]])("handles GitHub HTTP %s without calling it up to date", async (status, error) => {
  const fetcher = vi.fn(async () => new Response("", { status }));
  await expect(checkAndroidUpdate(installed, new AbortController().signal, fetcher as typeof fetch)).rejects.toThrow(error as string);
});

test("an aborted check cannot deliver a late release result", async () => {
  const controller = new AbortController();
  const fetcher = vi.fn(async () => { controller.abort(); return new Response(JSON.stringify([release()])); });
  await expect(checkAndroidUpdate(installed, controller.signal, fetcher as typeof fetch)).rejects.toThrow();
});
