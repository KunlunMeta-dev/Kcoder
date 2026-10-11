import { describe, expect, it } from "vitest";
import {
  browserAddressAfterFrame,
  browserViewportForLayout,
  browserWheelDelta,
  classifyBrowserGesture,
  editBrowserAddressDraft,
  normalizeBrowserUrl,
  settleBrowserAddressDraft,
} from "./browser-viewport";

describe("browser viewport", () => {
  it("启动前未测量时使用手机尺寸", () => {
    expect(browserViewportForLayout({ width: 1, height: 1 })).toEqual({ width: 390, height: 640 });
  });

  it("使用可见面板尺寸并遵守 app-server 边界", () => {
    expect(browserViewportForLayout({ width: 428.4, height: 701.7 })).toEqual({ width: 428, height: 702 });
    expect(browserViewportForLayout({ width: 120, height: 120 })).toEqual({ width: 320, height: 240 });
    expect(browserViewportForLayout({ width: 4000, height: 3000 })).toEqual({ width: 1920, height: 1080 });
  });
});

describe("browser URL normalization", () => {
  it("uses http for local hosts and https for public hosts", () => {
    expect(normalizeBrowserUrl(" localhost:4173 ")).toBe("http://localhost:4173");
    expect(normalizeBrowserUrl("127.0.0.1:3000/path")).toBe("http://127.0.0.1:3000/path");
    expect(normalizeBrowserUrl("[::1]:5173")).toBe("http://[::1]:5173");
    expect(normalizeBrowserUrl("example.com/docs")).toBe("https://example.com/docs");
    expect(normalizeBrowserUrl("//example.com/docs")).toBe("https://example.com/docs");
  });

  it("keeps an explicit scheme and supplies a safe blank default", () => {
    expect(normalizeBrowserUrl("http://203.0.113.8:8080")).toBe("http://203.0.113.8:8080");
    expect(normalizeBrowserUrl("file:///tmp/index.html")).toBe("file:///tmp/index.html");
    expect(normalizeBrowserUrl("  ")).toBe("https://example.com");
  });
});

describe("browser touch gesture", () => {
  it("keeps tiny movement pending and recognizes vertical swipes as scroll", () => {
    expect(classifyBrowserGesture({ x: 10, y: 10 }, { x: 13, y: 14 })).toBe("pending");
    expect(classifyBrowserGesture({ x: 100, y: 300 }, { x: 104, y: 240 })).toBe("scroll");
  });

  it("preserves deliberate horizontal or diagonal element dragging", () => {
    expect(classifyBrowserGesture({ x: 100, y: 100 }, { x: 150, y: 110 })).toBe("drag");
    expect(browserWheelDelta({ x: 100, y: 300 }, { x: 100, y: 250 })).toBeGreaterThan(0);
  });
});

describe("browser address draft", () => {
  it("does not let screenshot polling overwrite an address being edited", () => {
    expect(browserAddressAfterFrame("example.com/typing", "https://old.example", true)).toBe("example.com/typing");
    expect(browserAddressAfterFrame("draft", "https://new.example", false)).toBe("https://new.example");
  });

  it("keeps a draft through pending or rejected navigation polls and commits only its submitted revision", () => {
    const initial = { revision: 0, value: null };
    const draft = editBrowserAddressDraft(initial, "https://new.example/path");
    const submittedRevision = draft.revision;

    // A same-generation poll can return the old page while browser/action is pending.
    expect(
      browserAddressAfterFrame(
        draft.value!,
        "https://old.example/",
        false,
        draft.value !== null,
      ),
    ).toBe("https://new.example/path");

    // Pending and rejected requests keep the address available for retry.
    expect(
      settleBrowserAddressDraft(draft, submittedRevision, {
        status: "pending",
      }),
    ).toEqual(draft);
    expect(
      settleBrowserAddressDraft(draft, submittedRevision, {
        status: "rejected",
      }),
    ).toEqual(draft);

    const newerDraft = editBrowserAddressDraft(draft, "https://next.example/");
    expect(
      settleBrowserAddressDraft(newerDraft, submittedRevision, {
        status: "confirmed",
        pageUrl: "https://new.example/path",
      }).value,
    ).toBe("https://next.example/");

    // A confirmed page URL releases only the revision that was actually submitted.
    const committed = settleBrowserAddressDraft(draft, submittedRevision, {
      status: "confirmed",
      pageUrl: "https://new.example/path",
    });
    expect(committed.value).toBeNull();
    expect(
      browserAddressAfterFrame(
        draft.value!,
        "https://new.example/path",
        false,
        committed.value !== null,
      ),
    ).toBe("https://new.example/path");
  });
});
