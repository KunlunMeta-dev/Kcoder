import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { en } from "@/i18n/locales/en";
import { zhCN } from "@/i18n/locales/zh-CN";

const fixture = vi.hoisted(() => ({
  pathname: "/",
  sectionId: undefined as string | undefined,
  language: "en",
  messages: {} as Record<string, string>,
}));

vi.mock("react-native", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-native")>();
  return { ...actual, Platform: { ...actual.Platform, OS: "web" } };
});
vi.mock("expo-router", () => ({
  usePathname: () => fixture.pathname,
  useGlobalSearchParams: () => ({ section: fixture.sectionId }),
}));
vi.mock("@/i18n/use-translation", () => ({
  useTranslation: () => [
    (key: string) => fixture.messages[key] ?? key,
    { language: fixture.language },
    true,
  ],
}));

import MobileWebDocumentMetadata, {
  getMobileRouteTitleKey,
  normalizeMobileRoutePath,
  resolveMobileDocumentTitle,
} from "@/navigation/mobile-web-metadata";

let renderer: ReactTestRenderer | undefined;
let priorDocument: Document | undefined;
let fakeDocument: { title: string; documentElement: { lang: string } };

describe("Mobile Web document metadata", () => {
  beforeEach(() => {
    fixture.pathname = "/";
    fixture.sectionId = undefined;
    fixture.language = "en";
    fixture.messages = { ...en };
    priorDocument = globalThis.document;
    fakeDocument = { title: "", documentElement: { lang: "en" } };
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: fakeDocument as unknown as Document,
    });
  });

  afterEach(() => {
    act(() => renderer?.unmount());
    renderer = undefined;
    if (priorDocument) {
      Object.defineProperty(globalThis, "document", { configurable: true, value: priorDocument });
    } else {
      Reflect.deleteProperty(globalThis, "document");
    }
  });

  test("updates the title for route and locale changes", () => {
    act(() => {
      renderer = create(<MobileWebDocumentMetadata />);
    });
    expect(fakeDocument.title).toBe("Home · KCoder Mobile");

    fixture.pathname = "/settings-appearance";
    fixture.language = "zh-CN";
    fixture.messages = { ...en, ...zhCN };
    act(() => renderer?.update(<MobileWebDocumentMetadata />));

    expect(fakeDocument.title).toBe("外观 · KCoder Mobile");
    expect(fakeDocument.documentElement.lang).toBe("zh-CN");
  });

  test("uses the translated settings section label", () => {
    fixture.pathname = "/settings-section";
    fixture.sectionId = "usage";
    fixture.messages = { ...en, ...zhCN };
    expect(resolveMobileDocumentTitle(fixture.pathname, fixture.sectionId, (key) => fixture.messages[key] ?? key))
      .toBe("用量统计 · KCoder Mobile");
  });

  test("updates the document title as settings section search params change", () => {
    fixture.pathname = "/settings-section";
    fixture.sectionId = "models_services";
    act(() => {
      renderer = create(<MobileWebDocumentMetadata />);
    });
    expect(fakeDocument.title).toBe("Models & APIs · KCoder Mobile");

    fixture.sectionId = "tool_configuration";
    act(() => renderer?.update(<MobileWebDocumentMetadata />));
    expect(fakeDocument.title).toBe("Tool settings · KCoder Mobile");
  });

  test("uses a safe generic title for task and unknown routes", () => {
    const taskPath = "/h/profile-secret/task/server-secret/thread-secret";
    expect(getMobileRouteTitleKey(taskPath)).toBe("task.fallback_title");
    expect(resolveMobileDocumentTitle(taskPath, undefined, (key) => fixture.messages[key] ?? key))
      .toBe("Task · KCoder Mobile");
    expect(getMobileRouteTitleKey("/unknown-route")).toBe("not_found.title");
    expect(resolveMobileDocumentTitle("/unknown-route", undefined, (key) => fixture.messages[key] ?? key))
      .toBe("Page not found · KCoder Mobile");
  });

  test("recognizes both deployment mounts before route matching", () => {
    expect(normalizeMobileRoutePath("/mobile/settings-appearance")).toBe("/settings-appearance");
    expect(normalizeMobileRoutePath("/g/relay-preview/mobile/settings-appearance")).toBe("/settings-appearance");
    expect(normalizeMobileRoutePath("/__kcoder_mobile_mount_v1__/settings-appearance")).toBe("/settings-appearance");
  });
});
