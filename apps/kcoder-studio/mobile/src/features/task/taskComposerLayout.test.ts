import { expect, test } from "vitest";
import {
  COMPOSER_INPUT_LINE_HEIGHT,
  getComposerInputMetrics,
  reduceComposerLayoutState,
  resolveComposerLayout,
  type ComposerLayoutState,
} from "./taskComposerLayout";

const emptyLayout: ComposerLayoutState = {
  focused: false,
  contentHeight: COMPOSER_INPUT_LINE_HEIGHT,
};

test("an empty composer expands on focus and returns to one line after blur", () => {
  const focused = reduceComposerLayoutState(emptyLayout, { type: "focus" });
  expect(resolveComposerLayout(focused, { draft: "", attachmentCount: 0 })).toMatchObject({
    expanded: true,
    inputHeight: COMPOSER_INPUT_LINE_HEIGHT * 2,
    scrollEnabled: false,
  });

  const blurred = reduceComposerLayoutState(focused, { type: "blur" });
  expect(resolveComposerLayout(blurred, { draft: "", attachmentCount: 0 }).expanded).toBe(false);
});

test("keyboard dismissal releases focus while preserving a nonempty draft", () => {
  const focused = reduceComposerLayoutState(emptyLayout, { type: "focus" });
  const hidden = reduceComposerLayoutState(focused, { type: "keyboard-hidden" });
  expect(hidden.focused).toBe(false);
  expect(resolveComposerLayout(hidden, { draft: "keep this draft", attachmentCount: 0 }).expanded).toBe(true);
});

test("staged attachments keep an otherwise empty composer expanded until removed", () => {
  const focused = reduceComposerLayoutState(emptyLayout, { type: "focus" });
  const blurred = reduceComposerLayoutState(focused, { type: "blur" });
  expect(resolveComposerLayout(blurred, { draft: "", attachmentCount: 2 }).expanded).toBe(true);
  expect(resolveComposerLayout(blurred, { draft: "", attachmentCount: 0 }).expanded).toBe(false);
});

test("opening an attachment or model sheet keeps an empty composer from shrinking underneath it", () => {
  const focused = reduceComposerLayoutState(emptyLayout, { type: "focus" });
  const dismissed = reduceComposerLayoutState(focused, { type: "keyboard-hidden" });
  expect(
    resolveComposerLayout(dismissed, {
      draft: "",
      attachmentCount: 0,
      preserveExpanded: true,
    }).expanded,
  ).toBe(true);
  expect(
    resolveComposerLayout(dismissed, {
      draft: "",
      attachmentCount: 0,
      preserveExpanded: false,
    }).expanded,
  ).toBe(false);
});

test("input starts at two lines, grows to five, then scrolls internally", () => {
  expect(getComposerInputMetrics(COMPOSER_INPUT_LINE_HEIGHT / 2)).toEqual({
    height: COMPOSER_INPUT_LINE_HEIGHT * 2,
    scrollEnabled: false,
  });
  expect(getComposerInputMetrics(COMPOSER_INPUT_LINE_HEIGHT * 3)).toEqual({
    height: COMPOSER_INPUT_LINE_HEIGHT * 3,
    scrollEnabled: false,
  });
  expect(getComposerInputMetrics(COMPOSER_INPUT_LINE_HEIGHT * 5)).toEqual({
    height: COMPOSER_INPUT_LINE_HEIGHT * 5,
    scrollEnabled: false,
  });
  expect(getComposerInputMetrics(COMPOSER_INPUT_LINE_HEIGHT * 5 + 1)).toEqual({
    height: COMPOSER_INPUT_LINE_HEIGHT * 5,
    scrollEnabled: true,
  });
});

test("invalid content measurements do not erase the last measured height", () => {
  const measured = reduceComposerLayoutState(emptyLayout, {
    type: "content-size-changed",
    height: COMPOSER_INPUT_LINE_HEIGHT * 3,
  });
  expect(
    reduceComposerLayoutState(measured, { type: "content-size-changed", height: Number.NaN }),
  ).toEqual(measured);
});

test("V3 long drafts preview two lines after blur or keyboard dismissal and restore their measured editing height", () => {
  const context = { draft: "Long draft".repeat(80), attachmentCount: 1, compactDraftWhenUnfocused: true };
  const editing = { focused: true, contentHeight: 420 };
  expect(resolveComposerLayout(editing, context)).toMatchObject({ inputHeight: 105, scrollEnabled: true });
  for (const type of ["blur", "keyboard-hidden"] as const) {
    const compact = reduceComposerLayoutState(editing, { type });
    expect(resolveComposerLayout(compact, context)).toMatchObject({ expanded: true, inputHeight: 42, scrollEnabled: false });
    expect(compact.contentHeight).toBe(420);
    expect(resolveComposerLayout(reduceComposerLayoutState(compact, { type: "focus" }), context))
      .toMatchObject({ inputHeight: 105, scrollEnabled: true });
    expect(resolveComposerLayout(compact, { ...context, preserveExpanded: true }))
      .toMatchObject({ inputHeight: 105, scrollEnabled: true });
    expect(resolveComposerLayout(compact, { ...context, compactDraftWhenUnfocused: false }))
      .toMatchObject({ inputHeight: 105, scrollEnabled: true });
  }
});
