import { describe, expect, it } from "vitest";
import {
  clampDrawerTranslation,
  shouldActivateDrawerDismiss,
  shouldDismissDrawer,
} from "./mobile-drawer-gesture";

describe("mobile drawer gesture", () => {
  it("只响应具有明确水平意图的左滑", () => {
    expect(shouldActivateDrawerDismiss(-12, 2)).toBe(true);
    expect(shouldActivateDrawerDismiss(-5, 1)).toBe(false);
    expect(shouldActivateDrawerDismiss(-20, 19)).toBe(false);
    expect(shouldActivateDrawerDismiss(20, 1)).toBe(false);
  });

  it("根据距离或速度决定关闭", () => {
    expect(shouldDismissDrawer(-140, -0.1, 390)).toBe(true);
    expect(shouldDismissDrawer(-40, -0.6, 390)).toBe(true);
    expect(shouldDismissDrawer(-40, -0.1, 390)).toBe(false);
  });

  it("限制抽屉只能在自身宽度内向左移动", () => {
    expect(clampDrawerTranslation(20, 390)).toBe(0);
    expect(clampDrawerTranslation(-120, 390)).toBe(-120);
    expect(clampDrawerTranslation(-500, 390)).toBe(-390);
  });
});
