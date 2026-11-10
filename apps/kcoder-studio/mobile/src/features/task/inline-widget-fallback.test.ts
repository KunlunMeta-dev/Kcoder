import { expect, it } from "vitest";
import { inlineWidgetFallback } from "./inline-widget-fallback";

it("projects only complete standalone widget directives, retaining surrounding prose and source text", () => {
  const original = 'Before\n::kcoder-widget{widget_id="w-1" revision=2}\nAfter';
  expect(inlineWidgetFallback(original, "View in Studio")).toBe("Before\n> View in Studio\nAfter");
  expect(original).toContain('widget_id="w-1"');
});
it("retains quoted/fenced/partial/invalid protocol text without loading any resource", () => {
  for (const source of ['```text\n::kcoder-widget{widget_id="w" revision=1}\n```', '~~~\n::kcoder-widget{widget_id="w" revision=1}\n~~~',
    'Text ::kcoder-widget{widget_id="w" revision=1}', '    ::kcoder-widget{widget_id="w" revision=1}', '::kcoder-widget{widget_id="../path" revision=1}',
    '::kcoder-widget{widget_id="w" revision=0}', '::kcoder-widget{widget_id="w" revision=9007199254740992}', '::kcoder-widget{widget_id="w" revision=']) {
    expect(inlineWidgetFallback(source, "View in Studio")).toBe(source);
  }
});
