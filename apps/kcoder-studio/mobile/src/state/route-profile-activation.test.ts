import { describe, expect, it } from "vitest";
import { shouldActivateRouteProfile } from "./route-profile-activation";

describe("shouldActivateRouteProfile", () => {
  it("后台保留的旧 screen 不得抢回它路由中的 profile", () => {
    expect(shouldActivateRouteProfile({
      focused: false,
      hydrated: true,
      routeProfileId: "A",
      activeProfileId: "B",
      profileIds: ["A", "B"],
    })).toBe(false);
  });

  it("当前 screen 在目标存在且尚未激活时请求切换", () => {
    expect(shouldActivateRouteProfile({
      focused: true,
      hydrated: true,
      routeProfileId: "B",
      activeProfileId: "A",
      profileIds: ["A", "B"],
    })).toBe(true);
  });

  it("未 hydrate、目标缺失或已经激活时不请求切换", () => {
    expect(shouldActivateRouteProfile({ focused: true, hydrated: false, routeProfileId: "B", activeProfileId: "A", profileIds: ["A", "B"] })).toBe(false);
    expect(shouldActivateRouteProfile({ focused: true, hydrated: true, routeProfileId: "missing", activeProfileId: "A", profileIds: ["A", "B"] })).toBe(false);
    expect(shouldActivateRouteProfile({ focused: true, hydrated: true, routeProfileId: "A", activeProfileId: "A", profileIds: ["A", "B"] })).toBe(false);
  });
});
