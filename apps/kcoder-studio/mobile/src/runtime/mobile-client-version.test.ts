import { describe, expect, it, vi } from "vitest";
import appJson from "../../app.json";
vi.mock("expo-constants", () => ({ default: { expoConfig: { version: "0.1.0" } } }));
import { getMobileClientVersion, resolveMobileClientVersion } from "./mobile-client-version";

describe("Mobile client build version source", () => {
  it("uses the installed native app version when available", () => {
    expect(resolveMobileClientVersion("2.4.1", "2.4.0")).toEqual({
      value: "2.4.1",
      source: "nativeAppVersion",
    });
  });

  it("uses the bundled Expo configuration for Web builds", () => {
    expect(resolveMobileClientVersion(null, "2.4.0-beta.2")).toEqual({
      value: "2.4.0-beta.2",
      source: "app.json",
    });
    expect(getMobileClientVersion()).toEqual({ value: appJson.expo.version, source: "app.json" });
  });

  it("marks missing or unsafe build versions unavailable", () => {
    expect(resolveMobileClientVersion(undefined, null)).toEqual({ value: null, source: "unavailable" });
    expect(resolveMobileClientVersion("2.4.1\nsecret", "2 4 0")).toEqual({ value: null, source: "unavailable" });
  });
});
