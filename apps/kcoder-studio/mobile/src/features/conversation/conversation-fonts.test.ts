import { afterEach, beforeEach, expect, test, vi } from "vitest";

const font = vi.hoisted(() => ({ loadAsync: vi.fn() }));
const platform = vi.hoisted(() => ({ OS: "web" }));
vi.mock("react-native", () => ({ Platform: platform }));
vi.mock("expo-font", () => ({ FontDisplay: { SWAP: "swap" }, loadAsync: font.loadAsync }));
vi.mock("./conversation-font-assets", () => ({ getConversationFontAssets: () => ({ regular: 42, bold: 43, license: 44 }) }));
beforeEach(() => {
  vi.resetModules();
  font.loadAsync.mockReset();
  platform.OS = "web";
});
afterEach(() => vi.unstubAllGlobals());

test("loads static regular and bold once without blocking the initial system-font state", async () => {
  let finish!: () => void;
  font.loadAsync.mockReturnValue(new Promise<void>(resolve => { finish = resolve; }));
  const fonts = await import("./conversation-fonts");
  expect(fonts.getConversationFontStatus()).toBe("idle");
  const pending = fonts.loadConversationFonts();
  expect(fonts.getConversationFontStatus()).toBe("loading");
  expect(fonts.loadConversationFonts()).toBe(pending);
  await vi.waitFor(() => expect(font.loadAsync).toHaveBeenCalledOnce());
  expect(font.loadAsync).toHaveBeenCalledWith({ "Noto Sans SC": { uri: 42, display: "swap" }, "Noto Sans SC Bold": { uri: 43, display: "swap" } });
  finish();
  await pending;
  expect(fonts.getConversationFontStatus()).toBe("ready");
});

test("settles loader failures into the observable system-fallback state", async () => {
  font.loadAsync.mockRejectedValue(new Error("font unavailable"));
  const fonts = await import("./conversation-fonts");
  await expect(fonts.loadConversationFonts()).resolves.toBeUndefined();
  expect(fonts.getConversationFontStatus()).toBe("error");
});

function face(family: string, status: FontFaceLoadStatus = "loaded"): FontFace {
  return { family, status } as FontFace;
}

test("recovers from an Expo observer timeout only after both real Web font faces arrive", async () => {
  font.loadAsync.mockRejectedValue(new Error("6000ms timeout exceeded"));
  let regular!: (faces: FontFace[]) => void;
  let bold!: (faces: FontFace[]) => void;
  const load = vi.fn()
    .mockReturnValueOnce(new Promise<FontFace[]>(resolve => { regular = resolve; }))
    .mockReturnValueOnce(new Promise<FontFace[]>(resolve => { bold = resolve; }));
  vi.stubGlobal("document", { fonts: { load } });
  const fonts = await import("./conversation-fonts");
  const pending = fonts.loadConversationFonts();
  await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  expect(fonts.getConversationFontStatus()).toBe("error");
  regular([face('"Noto Sans SC"')]);
  await Promise.resolve();
  expect(fonts.getConversationFontStatus()).toBe("error");
  bold([face("Noto Sans SC Bold")]);
  await pending;
  expect(fonts.getConversationFontStatus()).toBe("ready");
  expect(load.mock.calls).toEqual([[`17px "Noto Sans SC"`], [`17px "Noto Sans SC Bold"`]]);
  expect(font.loadAsync).toHaveBeenCalledOnce();
});

test("keeps system fallback when the underlying Web font download really fails", async () => {
  font.loadAsync.mockRejectedValue(new Error("6000ms timeout exceeded"));
  const load = vi.fn().mockRejectedValue(new Error("network failure"));
  vi.stubGlobal("document", { fonts: { load } });
  const fonts = await import("./conversation-fonts");
  await expect(fonts.loadConversationFonts()).resolves.toBeUndefined();
  expect(load).toHaveBeenCalledTimes(2);
  expect(fonts.getConversationFontStatus()).toBe("error");
});

test.each([
  ["empty results", []],
  ["a different family", [face("System")]],
  ["an unloaded face", [face("Noto Sans SC", "unloaded")]],
] as const)("does not mistake %s for a loaded conversation font", async (_name, faces) => {
  font.loadAsync.mockRejectedValue(new Error("timeout"));
  const load = vi.fn().mockResolvedValueOnce(faces).mockResolvedValueOnce([face("Noto Sans SC Bold")]);
  vi.stubGlobal("document", { fonts: { load } });
  const fonts = await import("./conversation-fonts");
  await fonts.loadConversationFonts();
  expect(fonts.getConversationFontStatus()).toBe("error");
});

test.each(["android", "ios"])("preserves the existing %s failure path without touching browser APIs", async (os) => {
  platform.OS = os;
  font.loadAsync.mockRejectedValue(new Error("font unavailable"));
  const load = vi.fn();
  vi.stubGlobal("document", { fonts: { load } });
  const fonts = await import("./conversation-fonts");
  await fonts.loadConversationFonts();
  expect(fonts.getConversationFontStatus()).toBe("error");
  expect(load).not.toHaveBeenCalled();
});
