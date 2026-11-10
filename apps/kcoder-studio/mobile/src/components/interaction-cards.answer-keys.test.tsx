import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { AsyncQuestionAnswerPayload, AsyncQuestionRecord, QuestionInteraction } from "@/runtime/task-runtime/types";

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
import { AsyncQuestionCard, QuestionCard } from "./interaction-cards";

let renderer: ReactTestRenderer | undefined;
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); });
afterEach(async () => { if (renderer) await act(async () => renderer!.unmount()); renderer = undefined; });

const itemIds = ["__proto__", "constructor", "toString"];
const question: AsyncQuestionRecord = {
  questionId: "question-1", requestId: "request-1", threadId: "thread-1",
  sourceTurnId: "turn-1", toolCallId: "tool-1", revision: 1, createdAtMs: 1, status: "pending",
  questions: [],
};
const interaction: QuestionInteraction = {
  kind: "question", requestId: 1, questionId: "question-1",
  owner: { threadId: "thread-1", turnId: "turn-1", appServerEpoch: "epoch-1",
    profileId: "profile-1", profileAuthorizationScopeKey: "scope", serverId: "server-1",
    appServerId: "app-server-1", serverConfigIdentity: "target", profileActivationEpoch: 1,
    originClientGeneration: 1, runtimeInstanceNonce: 1, status: "pending" },
  questions: [],
};
const node = (id: string) => renderer!.root.findAll(value => value.props.testID === id)[0]!;

test.each(itemIds)("sync question %s keeps selection and free text as own answer properties", async id => {
  const onSubmit = vi.fn();
  await act(async () => { renderer = create(<QuestionCard interaction={{ ...interaction, questions: [{
    id, header: "Mode", prompt: "Which mode?", allowsFreeform: true, multiSelect: true,
    options: [{ value: "fast", label: "Fast" }],
  }] }} onSubmit={onSubmit} onCancel={() => undefined} />); });
  expect(node("question-submit").props.disabled).toBe(true);
  expect(node(`question-option-${id}-fast`).props.accessibilityState.checked).toBe(false);
  await act(async () => node(`question-option-${id}-fast`).props.onPress());
  await act(async () => renderer!.root.findByType("input").props.onChangeText(" extra "));
  await act(async () => node("question-submit").props.onPress());
  const answer = onSubmit.mock.calls[0][0];
  expect(Object.keys(answer)).toEqual([id]);
  expect(JSON.parse(JSON.stringify(answer))).toEqual({ [id]: ["fast", "extra"] });
});

test.each(itemIds)("async question %s renders, toggles and submits the original item ID", async id => {
  const onAnswer = vi.fn(async (_input: {
    questionId: string; expectedRevision: number; answers: AsyncQuestionAnswerPayload;
  }) => undefined);
  await act(async () => { renderer = create(<AsyncQuestionCard question={{ ...question, questions: [{
    id, header: "Mode", question: "Which mode?", multiSelect: true,
    options: [{ id: "fast", label: "Fast", description: "" }],
  }] }} onAnswer={onAnswer} onCancel={async () => undefined} onRefresh={() => undefined} />); });
  expect(node("async-question-submit-question-1").props.disabled).toBe(true);
  await act(async () => node(`async-question-question-1-option-${id}-fast`).props.onPress());
  await act(async () => renderer!.root.findByType("input").props.onChangeText(" extra "));
  await act(async () => node("async-question-submit-question-1").props.onPress());
  expect(onAnswer).toHaveBeenCalledTimes(1);
  const input = onAnswer.mock.calls[0][0];
  expect(input).toMatchObject({ questionId: "question-1", expectedRevision: 1 });
  expect(Object.keys(input.answers)).toEqual([id]);
  expect(JSON.parse(JSON.stringify(input.answers))).toEqual({ [id]: { selectedOptionIds: ["fast"], text: " extra " } });
});

test.each(itemIds)("free-text-only sync answer %s preserves its own JSON key", async id => {
  const onSubmit = vi.fn();
  await act(async () => { renderer = create(<QuestionCard interaction={{ ...interaction, questions: [{
    id, header: "Details", prompt: "Any details?", allowsFreeform: true, multiSelect: true, options: [],
  }] }} onSubmit={onSubmit} onCancel={() => undefined} />); });
  expect(node("question-submit").props.disabled).toBe(true);
  await act(async () => renderer!.root.findByType("input").props.onChangeText(" original "));
  await act(async () => node("question-submit").props.onPress());
  expect(onSubmit).toHaveBeenCalledWith({ [id]: ["original"] });
  expect(Object.keys(onSubmit.mock.calls[0][0])).toEqual([id]);
});
