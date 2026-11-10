import React from "react";
import { createRequire } from "node:module";
const { renderToStaticMarkup } = createRequire(import.meta.url)("react-dom/server") as {
  renderToStaticMarkup(element: React.ReactNode): string;
};
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/i18n";
vi.mock("lucide-react-native", () => ({
  Lightbulb: () => null,
  Wrench: () => null,
  ChevronDown: () => null,
  ChevronRight: () => null,
}));
import {
  BoundedOutput,
  CodeDisclosure,
  ProcessingDisclosure,
} from "./output-disclosure";

describe("mobile output disclosure", () => {
  beforeEach(() => setLocale("en"));

  it("does not mount expensive or failed tool details until expanded", () => {
    function ExpensiveOutput(): never {
      throw new Error("details must stay unmounted");
    }
    const html = renderToStaticMarkup(
      <ProcessingDisclosure count={2} running={false} failed={1}>
        <ExpensiveOutput />
      </ProcessingDisclosure>,
    );
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("message-processing-details");
    expect(html).toContain("1");
  });
  it("keeps failed, unknown, and canceled counts visible while collapsed", () => {
    const html = renderToStaticMarkup(
      <ProcessingDisclosure
        count={3}
        title="Tools · 3"
        running={false}
        failed={1}
        unknown={1}
        cancelled={1}
      >
        <span>details</span>
      </ProcessingDisclosure>,
    );
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("1 failed");
    expect(html).toContain("1 unknown");
    expect(html).toContain("1 cancelled");
    expect(html).not.toContain("message-processing-details");
  });
  it("keeps code collapsed on initial render", () => {
    const html = renderToStaticMarkup(
      <CodeDisclosure content="PRIVATE_CODE_CONTENT" language="typescript" />,
    );
    expect(html).toContain("typescript");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("PRIVATE_CODE_CONTENT");
  });
  it("bounds initially rendered log text without splitting surrogate pairs", () => {
    const html = renderToStaticMarkup(
      <BoundedOutput value={"a".repeat(7999) + "😀" + "HIDDEN_TAIL"} />,
    );
    expect(html).not.toContain("HIDDEN_TAIL");
    expect(html).not.toContain("�");
    expect(html).toContain("bounded-output");
  });
});
