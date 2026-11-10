import { describe, expect, test, vi } from "vitest";
import {
  getSafeNotFoundPathname,
  goToNotFoundHome,
  returnFromNotFound,
} from "@/navigation/not-found-presentation";

describe("Mobile not-found presentation", () => {
  test.each([
    "/mobile/__missing_route__",
    "/g/relay-preview/mobile/__missing_route__",
  ])("keeps the mounted pathname and removes query or fragment data from %s", (pathname) => {
    const safePath = getSafeNotFoundPathname(
      `${pathname}?token=query-secret&credential=other-secret#access_token=fragment-secret`,
    );
    expect(safePath).toBe(pathname);
    expect(safePath).not.toMatch(/query-secret|other-secret|fragment-secret|[?#]/);
  });

  test("uses the route path without exposing query or fragment values", () => {
    expect(getSafeNotFoundPathname("/missing?api_key=secret#token=fragment"))
      .toBe("/missing");
    expect(getSafeNotFoundPathname(undefined)).toBe("/");
  });

  test("returns to the previous route when one exists and otherwise replaces with the app home route", () => {
    const back = vi.fn();
    const replace = vi.fn();
    returnFromNotFound({ canGoBack: () => true, back, replace });
    expect(back).toHaveBeenCalledOnce();
    expect(replace).not.toHaveBeenCalled();

    returnFromNotFound({ canGoBack: () => false, back, replace });
    expect(replace).toHaveBeenCalledWith("/");
  });

  test("the home action always uses the Expo root route", () => {
    const replace = vi.fn();
    goToNotFoundHome({ canGoBack: () => true, back: vi.fn(), replace });
    expect(replace).toHaveBeenCalledWith("/");
  });
});
