import { describe, expect, it, vi } from "vitest";
import { backOrReplace, type BackCapableRouter } from "./back-or-replace";

function fakeRouter(canGoBack: boolean) {
  return {
    back: vi.fn(),
    canGoBack: vi.fn(() => canGoBack),
    replace: vi.fn(),
  } satisfies BackCapableRouter;
}

describe("backOrReplace", () => {
  it("有历史记录时返回上一页", () => {
    const router = fakeRouter(true);
    backOrReplace(router, "/welcome");
    expect(router.back).toHaveBeenCalledOnce();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("冷启动深层链接时替换到安全页面", () => {
    const router = fakeRouter(false);
    backOrReplace(router, "/welcome");
    expect(router.back).not.toHaveBeenCalled();
    expect(router.replace).toHaveBeenCalledWith("/welcome");
  });
});
