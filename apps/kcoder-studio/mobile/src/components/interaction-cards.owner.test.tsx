import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { AsyncQuestionRecord } from "@/runtime/task-runtime/types";

vi.mock("./ui", () => ({ Button: "button" }));
vi.mock("react-native", () => ({
  Platform: { OS: "web" }, Pressable: "button", ScrollView: "div",
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Text: "span", TextInput: "input", View: "div",
}));
vi.mock("@/theme", () => {
  const colors = new Proxy({}, { get: (_target, key) => String(key) });
  return { useTheme: () => ({ colors }), useThemedStyles: (factory: (colors: unknown) => unknown) => factory(colors),
    radius: {}, spacing: {} };
});
vi.mock("@/i18n/use-locale", () => ({ useLocale: () => "en" }));
vi.mock("lucide-react-native", () => ({ CheckSquare: () => null, HelpCircle: () => null,
  ShieldCheck: () => null, Square: () => null }));
import { AsyncQuestionCard } from "./interaction-cards";

let renderer: ReactTestRenderer | undefined;
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); });
afterEach(async () => { if (renderer) await act(async () => renderer!.unmount()); renderer = undefined; });

const question: AsyncQuestionRecord = {
  questionId: "same-question", requestId: "request", threadId: "original-thread",
  sourceTurnId: "turn", toolCallId: "tool", revision: 1, createdAtMs: 1, status: "pending",
  questions: [{ id: "mode", header: "Mode", question: "Which mode?", multiSelect: false,
    options: [{ id: "fast", label: "Fast", description: "" }] }],
};
const node = (id: string) => renderer!.root.findAll(value => value.props.testID === id)[0]!;
const submit = () => node("async-question-submit-same-question");
const choose = async () => act(async () => node("async-question-same-question-option-mode-fast").props.onPress());
const deferred = () => {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const renderCard = (record: AsyncQuestionRecord, onAnswer = async (_input: unknown) => {},
  onCancel = async (_input: unknown) => {}) => <AsyncQuestionCard question={record}
    onAnswer={onAnswer} onCancel={onCancel} onRefresh={() => undefined} />;

test("same question ID in another task cannot inherit the original answer draft", async () => {
  await act(async () => { renderer = create(renderCard(question)); });
  await choose();
  await act(async () => renderer!.root.findByType("input").props.onChangeText("original draft"));
  await act(async () => renderer!.update(renderCard({ ...question, threadId: "replacement-thread" })));
  expect(submit().props.disabled).toBe(true);
  expect(renderer!.root.findByType("input").props.value).toBe("");
  expect(node("async-question-same-question-option-mode-fast").props.accessibilityState.checked).toBe(false);
});

for (const action of ["answer", "cancel", "continue"] as const) {
  test(`pending ${action} from another task cannot block or settle the current card`, async () => {
    const old = deferred(), current = deferred();
    const oldOperation = vi.fn(() => old.promise);
    const initial: AsyncQuestionRecord = action === "continue" ? { ...question, status: "queued",
      answer: { submissionId: "original-submission", acceptedAtMs: 1,
        answers: { mode: { selectedOptionIds: ["fast"] } } } } : question;
    await act(async () => { renderer = create(renderCard(initial, oldOperation, oldOperation)); });
    if (action === "answer") await choose();
    const actionId = action === "answer" ? "submit" : action === "continue" ? "continue-delivery" : "cancel";
    await act(async () => { node(`async-question-${actionId}-same-question`).props.onPress(); });
    expect(oldOperation).toHaveBeenCalledTimes(1);
    const currentOperation = vi.fn((_input: unknown) => current.promise);
    const replacement = { ...question, threadId: "replacement-thread" };
    await act(async () => renderer!.update(renderCard(replacement, currentOperation)));
    await choose();
    expect(submit().props.disabled).toBe(false);
    await act(async () => { submit().props.onPress(); });
    expect(currentOperation).toHaveBeenCalledTimes(1);
    await act(async () => { old.resolve(); await old.promise; });
    expect(submit().props.disabled).toBe(true);
    expect(node("async-question-same-question-option-mode-fast").props.accessibilityState.checked).toBe(true);
    await act(async () => { current.reject(new Error("current receipt unknown")); await current.promise.catch(() => {}); });
    expect(submit().props.disabled).toBe(false);
    expect(node("async-question-response-error").children.join("")).toContain("current receipt unknown");
    const firstInput = currentOperation.mock.calls[0][0];
    await act(async () => { submit().props.onPress(); });
    expect(currentOperation.mock.calls[1][0]).toEqual(firstInput);
  });
}

test("a question revision refresh preserves the same task's edited draft", async () => {
  await act(async () => { renderer = create(renderCard(question)); });
  await choose();
  await act(async () => renderer!.root.findByType("input").props.onChangeText("keep this draft"));
  await act(async () => renderer!.update(renderCard({ ...question, revision: 2 })));
  expect(submit().props.disabled).toBe(false);
  expect(renderer!.root.findByType("input").props.value).toBe("keep this draft");
});


test("a disconnected card preserves its answer draft and resumes without a false busy state", async () => {
  const onAnswer = vi.fn(async (_input: unknown) => {});
  const render = (disabled: boolean) => <AsyncQuestionCard question={question} disabled={disabled}
    onAnswer={onAnswer} onCancel={async () => {}} onRefresh={() => undefined} />;
  await act(async () => { renderer = create(render(false)); });
  await choose();
  await act(async () => renderer!.root.findByType("input").props.onChangeText("keep offline draft"));
  await act(async () => renderer!.update(render(true)));
  expect(submit().props.disabled).toBe(true);
  expect(node("async-question-cancel-same-question").props.disabled).toBe(true);
  expect(renderer!.root.findByType("input").props.editable).toBe(false);
  expect(node("async-question-same-question-option-mode-fast").props.disabled).toBe(true);
  // The handler itself must reject activation while disconnected.
  await act(async () => { submit().props.onPress(); });
  expect(onAnswer).not.toHaveBeenCalled();
  expect(renderer!.root.findAll(value => value.props.testID === "async-question-response-error")).toHaveLength(0);
  await act(async () => renderer!.update(render(false)));
  expect(submit().props.disabled).toBe(false);
  expect(renderer!.root.findByType("input").props.value).toBe("keep offline draft");
  expect(node("async-question-same-question-option-mode-fast").props.accessibilityState.checked).toBe(true);
  await act(async () => { submit().props.onPress(); });
  expect(onAnswer).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    questionId: question.questionId, expectedRevision: question.revision,
    answers: { mode: { selectedOptionIds: ["fast"], text: "keep offline draft" } },
  }));
});

test.each(["cancel", "continue"] as const)("a disconnected card cannot dispatch %s", async action => {
  const operation = vi.fn(async (_input: unknown) => {});
  const record: AsyncQuestionRecord = action === "continue" ? { ...question, status: "queued",
    answer: { submissionId: "saved", acceptedAtMs: 1, answers: { mode: { selectedOptionIds: ["fast"] } } } } : question;
  const render = (disabled: boolean) => <AsyncQuestionCard question={record} disabled={disabled}
    onAnswer={operation} onCancel={operation} onRefresh={() => undefined} />;
  await act(async () => { renderer = create(render(true)); });
  const id = `async-question-${action === "continue" ? "continue-delivery" : "cancel"}-same-question`;
  expect(node(id).props.disabled).toBe(true);
  await act(async () => { node(id).props.onPress(); });
  expect(operation).not.toHaveBeenCalled();
  await act(async () => renderer!.update(render(false)));
  expect(node(id).props.disabled).toBe(false);
  await act(async () => { node(id).props.onPress(); });
  expect(operation).toHaveBeenCalledTimes(1);
});


test.each(["answer", "cancel", "continue"] as const)(
  "recovery fences an old %s operation while preserving the current draft and busy state",
  async action => {
    const old = deferred(), current = deferred();
    const initial: AsyncQuestionRecord = action === "continue" ? { ...question, status: "queued",
      answer: { submissionId: "saved", acceptedAtMs: 1,
        answers: { mode: { selectedOptionIds: ["fast"] } } } } : question;
    const operation = vi.fn((_input: unknown) => old.promise);
    const render = (disabled: boolean, record = initial) => <AsyncQuestionCard
      question={record} disabled={disabled} onAnswer={operation} onCancel={operation}
      onRefresh={() => undefined} />;
    await act(async () => { renderer = create(render(false)); });
    if (action === "answer") await choose();
    const actionId = action === "answer" ? "submit" : action === "continue" ? "continue-delivery" : "cancel";
    await act(async () => { node(`async-question-${actionId}-same-question`).props.onPress(); });
    expect(operation).toHaveBeenCalledTimes(1);
    await act(async () => renderer!.update(render(true)));
    await act(async () => renderer!.update(render(false)));
    if (action !== "continue") {
      await choose();
      await act(async () => renderer!.root.findByType("input").props.onChangeText("recovered draft"));
    }
    const currentAction = () => node(`async-question-${actionId}-same-question`);
    expect(currentAction().props.disabled).toBe(false);
    operation.mockImplementationOnce(() => current.promise);
    await act(async () => { currentAction().props.onPress(); });
    expect(operation).toHaveBeenCalledTimes(2);
    await act(async () => { old.resolve(); await old.promise; });
    expect(currentAction().props.disabled).toBe(true);
    if (action !== "continue")
      expect(renderer!.root.findByType("input").props.value).toBe("recovered draft");
    await act(async () => { current.reject(new Error("current receipt unknown")); await current.promise.catch(() => {}); });
    expect(node("async-question-response-error").children.join("")).toContain("current receipt unknown");
    expect(currentAction().props.disabled).toBe(false);
  },
);

test.each(["answer", "cancel", "continue"].flatMap(action =>
  ["readonly", "owner"].map(transition => ({ action, transition }))))(
  "a late $action failure cannot replace the recovered same-revision snapshot ($transition)",
  async ({ action, transition }) => {
    const old = deferred();
    const record: AsyncQuestionRecord = action === "continue" ? { ...question, status: "queued",
      answer: { submissionId: "saved", acceptedAtMs: 1,
        answers: { mode: { selectedOptionIds: ["fast"] } } } } : question;
    const operation = vi.fn(() => old.promise);
    const render = (disabled: boolean, ownerKey = "original-connection") => <AsyncQuestionCard
      question={record} disabled={disabled} ownerKey={ownerKey}
      onAnswer={operation} onCancel={operation} onRefresh={() => undefined} />;
    await act(async () => { renderer = create(render(false)); });
    if (action === "answer") await choose();
    const actionId = action === "answer" ? "submit" : action === "continue" ? "continue-delivery" : "cancel";
    await act(async () => { node(`async-question-${actionId}-same-question`).props.onPress(); });
    if (transition === "readonly") {
      await act(async () => renderer!.update(render(true)));
      await act(async () => renderer!.update(render(false)));
    } else {
      // React can batch disconnect/reconnect into one connected render.
      await act(async () => renderer!.update(render(false, "replacement-connection")));
    }
    await act(async () => { old.reject(new Error("old connection lost")); await old.promise.catch(() => {}); });
    expect(renderer!.root.findAllByProps({ testID: "async-question-response-error" })).toHaveLength(0);
    expect(operation).toHaveBeenCalledTimes(1);
  },
);


test("recovery preserves runtime busy and the original submission identity until an explicit retry", async () => {
  const old = deferred();
  const operation = vi.fn((_input: unknown) => old.promise);
  const render = (disabled: boolean, busy: boolean) => <AsyncQuestionCard question={question}
    disabled={disabled} busy={busy} onAnswer={operation} onCancel={operation} onRefresh={() => undefined} />;
  await act(async () => { renderer = create(render(false, false)); });
  await choose();
  await act(async () => { submit().props.onPress(); });
  const original = operation.mock.calls[0][0];
  await act(async () => renderer!.update(render(true, true)));
  await act(async () => renderer!.update(render(false, true)));
  await act(async () => { old.resolve(); await old.promise; });
  expect(submit().props.disabled).toBe(true);
  await act(async () => { submit().props.onPress(); });
  expect(operation).toHaveBeenCalledTimes(1);
  await act(async () => renderer!.update(render(false, false)));
  expect(submit().props.disabled).toBe(false);
  await act(async () => { submit().props.onPress(); });
  expect(operation.mock.calls[1][0]).toEqual(original);
});
