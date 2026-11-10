import { afterEach, expect, test, vi } from "vitest";
import { TaskRuntime, taskRuntimeTestHelpers } from "./task-runtime";
import { FakeClient, profile, server } from "./task-runtime/fixture.test-support";
import { selectorForInteraction } from "./task-runtime/interactions";
import { t } from "@/i18n";

vi.mock("@/gateway/http", () => ({ ensureGatewayAuthorization: vi.fn(async () => {}) }));

const runtimes: TaskRuntime[] = [];
afterEach(() => {
  runtimes.splice(0).forEach((runtime) => runtime.close());
  taskRuntimeTestHelpers.resetConnector();
});

async function fixture(sourceAgent: boolean) {
  const client = new FakeClient([]);
  client.respond = vi.fn();
  client.respondError = vi.fn();
  taskRuntimeTestHelpers.setConnector(async () => client as never);
  const runtime = await TaskRuntime.resume({
    profile, server, threadId: "thread-1", profileActivationEpoch: 1,
    isCurrentInteractionOwner: () => true,
  });
  runtimes.push(runtime);
  client.emit({ id: 41, method: "question/request", params: {
    serverId: client.getAppServerId(), threadId: "thread-1", turnId: "turn-1",
    appServerEpoch: "epoch-1", questionId: "original-question",
    ...(sourceAgent ? { sourceAgent: { parentSessionId: "thread-1", agentId: "worker" } } : {}),
    questions: [
      { id: "choice", prompt: "Which?", options: [], allowsFreeform: true },
      { id: "detail", prompt: "Any details?", options: [], allowsFreeform: true },
    ],
  } });
  const selector = selectorForInteraction(runtime.pendingInteractions[0]!);
  const answer = (answers: Record<string, string[]>, ignored = false) => sourceAgent
    ? runtime.respondAgentQuestions("worker", 41, answers, ignored, selector)
    : runtime.respondQuestions(answers, selector);
  return { client, runtime, selector, answer };
}

const invalidAnswers: { name: string; answers: Record<string, string[]> }[] = [
    { name: "foreign item", answers: { foreign: ["yes"] } },
    { name: "mixed items", answers: { choice: ["yes"], foreign: ["no"] } },
    { name: "prototype name", answers: { constructor: ["yes"] } },
];
const malformedAnswers: { name: string; value: unknown }[] = [
  { name: "string selection", value: { choice: "yes" } },
  { name: "numeric selection", value: { choice: [7] } },
  { name: "null selection", value: { choice: null } },
  { name: "object selection", value: { choice: [{ text: "yes" }] } },
  { name: "array answer map", value: [] },
  { name: "string answer map", value: "" },
  { name: "null answer map", value: null },
];
const compatibleAnswers: Record<string, string[]>[] = [{}, { choice: ["partial free text"] }];

for (const sourceAgent of [false, true]) {
  const route = sourceAgent ? "source agent" : "main task";
  test.each(malformedAnswers)(`${route}: reject $name without changing the answer or consuming the card`, async ({ value }) => {
    const f = await fixture(sourceAgent);
    const original = f.runtime.pendingInteractions[0]!;
    expect(() => f.answer(value as Record<string, string[]>)).toThrow(t("task.question_answer_items_mismatch"));
    expect(f.client.respond).not.toHaveBeenCalled();
    expect(f.runtime.pendingInteractions[0]).toBe(original);
    expect(f.runtime.getSnapshot().interaction?.responding).not.toBe(true);
    expect(f.runtime.isInteractionActionable(original)).toBe(true);
    f.answer({ choice: ["yes"], detail: [] });
    expect(f.client.respond).toHaveBeenCalledExactlyOnceWith(41, {
      answers: { choice: { answers: ["yes"] }, detail: { answers: [] } },
    });
  });
  test.each(invalidAnswers)(`${route}: reject $name before sending or marking the original card busy`, async ({ answers }) => {
    const f = await fixture(sourceAgent);
    const original = f.runtime.pendingInteractions[0];
    expect(() => f.answer(answers)).toThrow(t("task.question_answer_items_mismatch"));
    expect(f.client.respond).not.toHaveBeenCalled();
    expect(f.runtime.pendingInteractions[0]).toBe(original);
    expect(f.runtime.getSnapshot().interaction?.responding).not.toBe(true);
    expect(f.runtime.isInteractionActionable(original!)).toBe(true);

    f.answer({ choice: ["my free text"], detail: [] });
    expect(f.client.respond).toHaveBeenCalledExactlyOnceWith(41, {
      answers: { choice: { answers: ["my free text"] }, detail: { answers: [] } },
    });
    expect(f.runtime.getSnapshot().interaction?.responding).toBe(true);
    f.client.emit({ method: "question/resolved", params: {
      requestId: 41, questionId: "original-question", threadId: "thread-1",
      turnId: "turn-1", appServerEpoch: "epoch-1", reason: "client_response",
    } });
    expect(f.runtime.pendingInteractions).toHaveLength(0);
  });

  test.each(compatibleAnswers)(
    `${route}: preserve empty and partial answer semantics`, async (answers) => {
      const f = await fixture(sourceAgent);
      f.answer(answers);
      expect(f.client.respond).toHaveBeenCalledOnce();
      expect(f.runtime.getSnapshot().interaction?.responding).toBe(true);
    },
  );
}

test("source-agent ignore keeps its empty answer and original annotation", async () => {
  const f = await fixture(true);
  f.answer({}, true);
  expect(f.client.respond).toHaveBeenCalledExactlyOnceWith(41, {
    answers: {}, annotations: { ignored: true },
  });
});

test("a rejected mismatched answer leaves explicit cancellation available", async () => {
  const f = await fixture(false);
  expect(() => f.answer({ foreign: ["yes"] })).toThrow(t("task.question_answer_items_mismatch"));
  f.runtime.cancelQuestions(f.selector);
  expect(f.client.respond).not.toHaveBeenCalled();
  expect(f.client.respondError).toHaveBeenCalledExactlyOnceWith(
    41, -32800, "the user cancelled the question request",
  );
});
