import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { createRequire } from "node:module";
const { renderToStaticMarkup } = createRequire(import.meta.url)("react-dom/server") as {
  renderToStaticMarkup(element: React.ReactNode): string;
};
vi.mock("./ui", () => ({
  Button: (props: { testID?: string; onPress?: () => unknown }) => {
    if (props.testID && props.onPress)
      (globalThis as any).__interactionCardHandlers[props.testID] = props.onPress;
    return null;
  },
}));
vi.mock("react-native", () => ({
  Platform: { OS: "web" },
  Pressable: "button",
  ScrollView: "div",
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Text: "span",
  TextInput: "input",
  View: "div",
}));
vi.mock("@/theme", () => {
  const colors = new Proxy({}, { get: (_target, key) => String(key) });
  return {
    useTheme: () => ({ colors, mode: "dark" }),
    useThemedStyles: (factory: (value: any) => unknown) => factory(colors),
    radius: { sm: 4, md: 6, lg: 8, xl: 12, pill: 999 },
    spacing: { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 },
  };
});
vi.mock("@/i18n/use-locale", () => ({ useLocale: () => "en" }));
vi.mock("lucide-react-native", () => ({
  CheckSquare: () => null,
  HelpCircle: () => null,
  ShieldCheck: () => null,
  Square: () => null,
}));
import {
  actionDescription,
  approvalActionPresentation,
} from "./approval-action";
import {
  ApprovalCard,
  AsyncQuestionCard,
  QuestionCard,
  interactionCardIdentity,
} from "./interaction-cards";
import { GatewayRpcClient, MobileRpcError } from "@/gateway/rpc";
import type { GatewayProfile, KCoderServer } from "@/gateway/types";
import { TaskRuntime, taskRuntimeTestHelpers } from "@/runtime/task-runtime";
import { gatewaySessionExpired } from "@/gateway/http";
import type { AsyncQuestionRecord, QuestionInteraction } from "@/runtime/task-runtime/types";

vi.mock("@/gateway/http", () => ({
  ensureGatewayAuthorization: vi.fn(async () => {}),
  gatewaySessionExpired: vi.fn(async () => false),
}));

const getHandlers = () =>
  (globalThis as any).__interactionCardHandlers as Record<
    string,
    () => unknown
  >;

const profile: GatewayProfile = {
  id: "gateway-unit",
  label: "Unit Gateway",
  baseUrl: "https://gateway.invalid",
  accessToken: "unit-test-token",
  expiresAt: Number.MAX_SAFE_INTEGER,
  rpcToken: "unit-test-rpc-token",
};
const server: KCoderServer = {
  id: "local-unit",
  label: "Unit server",
  description: "transport fixture",
  runtime: "kcoder",
  transport: "local",
  workspacePath: "/workspace",
};

class FakeGatewaySocket {
  static OPEN = 1;
  readyState = 0;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  constructor() {
    fakeSocket = this;
    queueMicrotask(() => {
      this.readyState = FakeGatewaySocket.OPEN;
      this.onopen?.({});
    });
  }

  send(raw: string) {
    const request = JSON.parse(raw) as { id?: number; method?: string };
    if (typeof request.id !== "number") return;
    const thread = {
      id: "thread-interaction-test",
      title: "Interaction transport test",
      cwd: "/workspace",
      status: "idle",
    };
    const result =
      request.method === "initialize"
        ? {
            protocolVersion: "2026-07-27",
            sessionId: "engine-fixture",
            capabilities: { experimental: {} },
          }
        : request.method === "thread/resume"
          ? { thread }
          : request.method === "thread/read"
            ? { thread, messages: [] }
            : {};
    queueMicrotask(() =>
      this.onmessage?.({
        data: JSON.stringify({ jsonrpc: "2.0", id: request.id, result }),
      }),
    );
  }

  close() {
    this.readyState = 3;
    this.onclose?.({});
  }

  deliver(message: object) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

let fakeSocket: FakeGatewaySocket;
let activeRuntime: TaskRuntime | null = null;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  (globalThis as any).__interactionCardHandlers = {};
  vi.stubGlobal("WebSocket", FakeGatewaySocket);
  vi.mocked(gatewaySessionExpired).mockResolvedValue(false);
});

const asyncQuestion: AsyncQuestionRecord = {
  questionId: "durable-question-1",
  requestId: "request-1",
  threadId: "thread-interaction-test",
  sourceTurnId: "turn-source",
  toolCallId: "tool-call",
  revision: 0,
  createdAtMs: 1_800_000_000_000,
  status: "pending",
  questions: [{
    id: "mode",
    header: "Mode",
    question: "Choose a mode",
    options: [
      { id: "fast", label: "Fast", description: "" },
      { id: "careful", label: "Careful", description: "" },
    ],
    multiSelect: false,
  }],
};

describe("async question card", () => {
  let renderer: ReactTestRenderer | undefined;

  afterEach(async () => {
    if (renderer) await act(async () => renderer?.unmount());
    renderer = undefined;
  });

  it.each((["answer", "cancel", "continue"] as const).flatMap(action =>
    (["owner", "reconnect"] as const).map(transition => ({ action, transition }))))(
    "discards a queued $action press after $transition recovery without losing the current draft", async ({ action, transition }) => {
      const question: AsyncQuestionRecord = action === "continue" ? {
        ...asyncQuestion, revision: 2, status: "queued", answer: {
          submissionId: "saved-submission", acceptedAtMs: 1,
          answers: { mode: { selectedOptionIds: ["fast"] } },
        },
      } : { ...asyncQuestion, revision: 1 };
      const operation = vi.fn(async (_input: unknown) => {});
      const card = (ownerKey: string, disabled = false) => <AsyncQuestionCard question={question}
        ownerKey={ownerKey} disabled={disabled}
        onAnswer={operation} onCancel={operation} onRefresh={() => undefined} />;
      await act(async () => { renderer = create(card("original")); });
      if (action === "answer") {
        const option = renderer!.root.findAll(node =>
          node.props.testID === "async-question-durable-question-1-option-mode-fast")[0]!;
        await act(async () => option.props.onPress());
      }
      const buttonId = `async-question-${action === "answer" ? "submit"
        : action === "continue" ? "continue-delivery" : "cancel"}-durable-question-1`;
      // Native presses may already be queued with the previous render's callback.
      const queuedPress = getHandlers()[buttonId]!;
      if (transition === "reconnect") {
        await act(async () => { renderer!.update(card("original", true)); });
        await act(async () => { renderer!.update(card("original")); });
      } else {
        await act(async () => { renderer!.update(card("replacement")); });
      }
      await act(async () => { queuedPress(); });
      expect(operation).not.toHaveBeenCalled();
      // The current callback still owns the retained selection / saved answer.
      await act(async () => { getHandlers()[buttonId]!(); });
      expect(operation).toHaveBeenCalledTimes(1);
      expect(operation.mock.calls[0]![0]).toMatchObject({
        questionId: question.questionId, expectedRevision: question.revision,
        ...(action === "cancel" ? {} : { answers: { mode: { selectedOptionIds: ["fast"] } } }),
        ...(action === "continue" ? { submissionId: "saved-submission" } : {}),
      });
    },
  );

  it.each([
    ["answer", "answer"], ["answer", "cancel"],
    ["cancel", "answer"], ["cancel", "cancel"],
    ["continue", "continue"],
  ] as const)("serializes %s then %s before React commits busy state", async (first, second) => {
    const question: AsyncQuestionRecord = first === "continue" ? {
      ...asyncQuestion, status: "queued", answer: {
        submissionId: "saved-submission", acceptedAtMs: 1,
        answers: { mode: { selectedOptionIds: ["fast"] } },
      },
    } : asyncQuestion;
    let finish!: () => void;
    const waiting = new Promise<void>(resolve => { finish = resolve; });
    let calls = 0;
    const operation = vi.fn(async () => {
      calls++;
      // The runtime rejects a second in-flight mutation. Its rejection must
      // not clear the card's busy state while the original RPC is still pending.
      if (calls > 1) throw new Error("request already in progress");
      await waiting;
    });
    await act(async () => {
      renderer = create(<AsyncQuestionCard question={question}
        onAnswer={operation} onCancel={operation} onRefresh={() => undefined} />);
    });
    if (first !== "continue") {
      const option = renderer!.root.findAll(node =>
        node.props.testID === "async-question-durable-question-1-option-mode-fast")[0]!;
      await act(async () => option.props.onPress());
    }
    const buttonId = (action: string) => `async-question-${action === "answer" ? "submit"
      : action === "continue" ? "continue-delivery" : "cancel"}-durable-question-1`;
    const firstPress = getHandlers()[buttonId(first)]!;
    const secondPress = getHandlers()[buttonId(second)]!;
    try {
      await act(async () => { firstPress(); secondPress(); });
      expect(operation).toHaveBeenCalledTimes(1);
      expect(renderer!.root.findAllByProps({ testID: "async-question-response-error" })).toHaveLength(0);
      const button = renderer!.root.findAll(node => node.props.testID === buttonId(first))[0]!;
      expect(button.props.disabled).toBe(true);
    } finally {
      await act(async () => { finish(); await waiting; });
    }
  });

  it.each(["answer", "cancel", "continue"] as const)("releases %s admission after failure without losing its retry identity", async action => {
    const question: AsyncQuestionRecord = action === "continue" ? {
      ...asyncQuestion, status: "queued", answer: {
        submissionId: "saved-submission", acceptedAtMs: 1,
        answers: { mode: { selectedOptionIds: ["fast"] } },
      },
    } : asyncQuestion;
    const operation = vi.fn(async (_input: unknown) => { throw new Error("lost receipt"); });
    await act(async () => {
      renderer = create(<AsyncQuestionCard question={question}
        onAnswer={operation} onCancel={operation} onRefresh={() => undefined} />);
    });
    if (action === "answer") {
      const option = renderer!.root.findAll(node =>
        node.props.testID === "async-question-durable-question-1-option-mode-fast")[0]!;
      await act(async () => option.props.onPress());
    }
    const buttonId = `async-question-${action === "answer" ? "submit"
      : action === "continue" ? "continue-delivery" : "cancel"}-durable-question-1`;
    await act(async () => { getHandlers()[buttonId]!(); });
    expect(renderer!.root.findByProps({ testID: "async-question-response-error" }).children.join(""))
      .toContain("lost receipt");
    const firstInput = structuredClone(operation.mock.calls[0]![0]);
    await act(async () => { getHandlers()[buttonId]!(); });
    expect(operation).toHaveBeenCalledTimes(2);
    expect(operation.mock.calls[1]![0]).toEqual(firstInput);
    expect(renderer!.root.findAll(node => node.props.testID === buttonId)[0]!.props.disabled).toBe(false);
  });

  it("does not preselect an option, preserves the draft after an error, and reuses the submission ID on retry", async () => {
    const attempts: Array<{ submissionId: string; answers: unknown }> = [];
    let call = 0;
    await act(async () => {
      renderer = create(<AsyncQuestionCard
        question={asyncQuestion}
        onAnswer={async (input) => {
          attempts.push({ submissionId: input.submissionId, answers: input.answers });
          call += 1;
          if (call === 1) throw new Error("temporary receipt failure");
        }}
        onCancel={async () => undefined}
        onRefresh={() => undefined}
      />);
    });

    expect(renderer!.root.findByProps({ testID: "async-question-title" }).children.join(""))
      .toBe("KCoder has a question");
    expect(renderer!.root.findByProps({ testID: "async-question-status" }).children.join(""))
      .toBe("Waiting for your answer");
    expect(renderer!.root.findByProps({ testID: "async-question-answer-later-hint" }).children.join(""))
      .toContain("answer later");

    const options = renderer!.root.findAll((node) =>
      typeof node.props.testID === "string" && node.props.testID.startsWith("async-question-durable-question-1-option-"));
    expect(options).toHaveLength(2);
    expect(options.every((node) => node.props["aria-checked"] === false)).toBe(true);

    await act(async () => options[0]!.props.onPress());
    const submitId = "async-question-submit-durable-question-1";
    await act(async () => (getHandlers()[submitId] as () => Promise<void>)());
    expect(renderer!.root.findByProps({ testID: "async-question-response-error" })).toBeTruthy();
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.answers).toEqual({ mode: { selectedOptionIds: ["fast"] } });
    expect(attempts[0]?.submissionId).toMatch(/^mobile-[0-9a-f]{32}$/);

    const retainedOption = renderer!.root.findAll((node) => node.props.testID === options[0]!.props.testID)[0];
    expect(retainedOption?.props["aria-checked"]).toBe(true);
    await act(async () => (getHandlers()[submitId] as () => Promise<void>)());
    expect(attempts).toHaveLength(2);
    expect(attempts[1]?.submissionId).toBe(attempts[0]?.submissionId);
    expect(attempts[1]?.answers).toEqual(attempts[0]?.answers);
  });

  it.each(
    ["answer", "cancel", "continue"].flatMap(action =>
      ["answer_saved", "context_applied", "delivery_unknown", "delivery_failed", "cancelled", "stale"].flatMap(status =>
        [false, true].map(failureFirst => ({ action, status, failureFirst })))),
  )("$action failure (failureFirst=$failureFirst) is superseded by authoritative $status", async ({ action, status, failureFirst }) => {
    const savedAnswer = {
      submissionId: "original-submission",
      answers: { mode: { selectedOptionIds: ["fast"] } },
      acceptedAtMs: 1_800_000_000_001,
    };
    const initial: AsyncQuestionRecord = {
      ...asyncQuestion, revision: 2,
      ...(action === "continue" ? { status: "queued", answer: savedAnswer } : {}),
    };
    let reject!: (error: Error) => void;
    const operation = vi.fn(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
    const renderCard = (question: AsyncQuestionRecord) => <AsyncQuestionCard
      question={question} onAnswer={operation} onCancel={operation} onRefresh={() => undefined}
    />;
    await act(async () => { renderer = create(renderCard(initial)); });
    if (action === "answer") {
      const option = renderer!.root.findAll(node =>
        node.props.testID === "async-question-durable-question-1-option-mode-fast")[0]!;
      await act(async () => option.props.onPress());
    }
    const button = action === "answer" ? "submit" : action === "cancel" ? "cancel" : "continue-delivery";
    let pending!: Promise<void>;
    await act(async () => { pending = getHandlers()[`async-question-${button}-durable-question-1`]() as Promise<void>; });
    expect(operation).toHaveBeenCalledTimes(1);
    if (failureFirst) {
      await act(async () => { reject(new Error("lost receipt")); await pending; });
      expect(renderer!.root.findAllByProps({ testID: "async-question-response-error" })).toHaveLength(1);
    }
    const authoritative: AsyncQuestionRecord = {
      ...initial, revision: 3, status: status as AsyncQuestionRecord["status"],
      answer: savedAnswer,
      ...(status === "delivery_failed" ? { deliveryError: "authoritative delivery failure" } : {}),
    };
    await act(async () => renderer!.update(renderCard(authoritative)));
    if (!failureFirst) await act(async () => { reject(new Error("lost receipt")); await pending; });
    expect(renderer!.root.findAllByProps({ testID: "async-question-response-error" })).toHaveLength(0);
    expect(renderer!.root.findByProps({ testID: "async-question-status" })).toBeTruthy();
    expect(renderer!.root.findByProps({ testID: "async-question-authoritative-answer" })).toBeTruthy();
    if (status === "delivery_failed") {
      expect(renderer!.root.findByProps({ testID: "async-question-delivery-error" }).children.join(""))
        .toBe("authoritative delivery failure");
    }
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it.each(["pending", "queued"] as const)("retains an unconfirmed %s operation at the same revision", async status => {
    const question: AsyncQuestionRecord = {
      ...asyncQuestion, revision: 2, status,
      ...(status === "queued" ? { answer: {
        submissionId: "original-submission", answers: { mode: { selectedOptionIds: ["fast"] } }, acceptedAtMs: 1,
      } } : {}),
    };
    const operation = vi.fn(async () => { throw new Error("still unknown"); });
    const renderCard = () => <AsyncQuestionCard question={question}
      onAnswer={operation} onCancel={operation} onRefresh={() => undefined} />;
    await act(async () => { renderer = create(renderCard()); });
    const button = status === "pending" ? "cancel" : "continue-delivery";
    await act(async () => { await getHandlers()[`async-question-${button}-durable-question-1`](); });
    await act(async () => renderer!.update(renderCard()));
    expect(renderer!.root.findByProps({ testID: "async-question-response-error" }).children.join(""))
      .toContain("still unknown");
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("only checks unknown delivery, then continues a saved answer with its original identity", async () => {
    const unknown = {
      ...asyncQuestion,
      revision: 1,
      status: "delivery_unknown" as const,
      answer: {
        submissionId: "unknown-submission",
        answers: { mode: { selectedOptionIds: ["fast"], text: "  跨端原答案\n  " } },
        acceptedAtMs: 1_800_000_000_001,
      },
    };
    const answerCalls: unknown[] = [];
    let refreshCount = 0;
    await act(async () => {
      renderer = create(<AsyncQuestionCard
        question={unknown}
        onAnswer={async (input) => { answerCalls.push(input); }}
        onCancel={async () => undefined}
        onRefresh={() => { refreshCount += 1; }}
      />);
    });
    expect(renderer!.root.findByProps({ testID: "async-question-check-durable-question-1" })).toBeTruthy();
    expect(renderer!.root.findAll((node) => node.props.testID === "async-question-submit-durable-question-1")).toHaveLength(0);
    expect(renderer!.root.findAll((node) => node.props.testID === "async-question-continue-delivery-durable-question-1")).toHaveLength(0);
    expect(renderer!.root.findByProps({ testID: "async-question-status" }).children.join("")).toContain("Answer receipt is unknown");
    await act(async () => (getHandlers()["async-question-check-durable-question-1"] as () => void)());
    expect(refreshCount).toBe(1);
    expect(answerCalls).toHaveLength(0);

    const answered = {
      ...asyncQuestion,
      revision: 1,
      status: "answer_saved" as const,
      answer: {
        submissionId: "accepted-first",
        answers: { mode: { selectedOptionIds: ["fast"], text: "  跨端原答案\n  " } },
        acceptedAtMs: 1_800_000_000_001,
      },
    };
    await act(async () => renderer!.update(<AsyncQuestionCard
      question={answered}
      onAnswer={async (input) => { answerCalls.push(input); }}
      onCancel={async () => undefined}
      onRefresh={() => undefined}
    />));
    expect(renderer!.root.findByProps({ testID: "async-question-authoritative-answer" })).toBeTruthy();
    expect(renderer!.root.findAll((node) => node.props.testID === "async-question-submit-durable-question-1")).toHaveLength(0);
    await act(async () => (getHandlers()["async-question-continue-delivery-durable-question-1"] as () => Promise<void>)());
    expect(answerCalls).toEqual([{
      questionId: "durable-question-1",
      submissionId: "accepted-first",
      expectedRevision: 1,
      answers: { mode: { selectedOptionIds: ["fast"], text: "  跨端原答案\n  " } },
    }]);
  });
});

afterEach(() => {
  activeRuntime?.close();
  activeRuntime = null;
  taskRuntimeTestHelpers.resetConnector();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("gives reused request IDs from different app-server epochs distinct question card identities", () => {
  const base: QuestionInteraction = {
    kind: "question",
    requestId: 11,
    questionId: "question-reused",
    questions: [],
    owner: {
      profileId: profile.id,
      profileAuthorizationScopeKey: "scope",
      serverId: server.id,
      appServerId: "server-engine-S",
      serverConfigIdentity: "target",
      threadId: "parent",
      turnId: "turn-one",
      appServerEpoch: "epoch-one",
      runtimeInstanceNonce: 1,
      profileActivationEpoch: 1,
      originClientGeneration: 1,
      status: "pending",
    },
  };
  expect(interactionCardIdentity(base)).not.toBe(interactionCardIdentity({
    ...base,
    owner: { ...base.owner, turnId: "turn-two", appServerEpoch: "epoch-two" },
  }));
});

async function resumeRuntime(): Promise<TaskRuntime> {
  taskRuntimeTestHelpers.setConnector(GatewayRpcClient.connect);
  activeRuntime = await TaskRuntime.resume({
    profile,
    server,
    threadId: "thread-interaction-test",
    profileActivationEpoch: 1,
    isCurrentInteractionOwner: () => true,
  });
  return activeRuntime;
}

function deliverPendingInteraction(message: object) {
  fakeSocket.deliver(message);
}

describe("审批操作说明", () => {
  it("工具审批同时展示工具名和完整参数", () => {
    expect(
      actionDescription({
        type: "tool",
        name: "Write",
        input: { path: "/workspace/a.ts", content: "hello" },
      }),
    ).toContain('"path": "/workspace/a.ts"');
    expect(
      actionDescription({
        type: "tool",
        name: "Write",
        input: { path: "/workspace/a.ts" },
      }),
    ).toMatch(/^Tool: Write\nInput: /);
  });

  it("限制不受信任参数的展示长度", () => {
    const description = actionDescription({
      type: "tool",
      name: "Large",
      input: { data: "x".repeat(8_000) },
    });
    expect(description).toContain("input truncated");
    expect(description.length).toBeLessThan(4_200);
    expect(
      approvalActionPresentation({
        type: "tool",
        name: "Large",
        input: { data: "x".repeat(8_000) },
      }).safeToApprove,
    ).toBe(false);
  });

  it("缺少工具参数时明确告知用户", () => {
    expect(actionDescription({ type: "tool", name: "Unknown" })).toContain(
      "missing input",
    );
    expect(
      approvalActionPresentation({ type: "tool", name: "Unknown" })
        .safeToApprove,
    ).toBe(false);
  });

  it("approval RPC readiness races fail closed and retain the pending ledger", async () => {
    const runtime = await resumeRuntime();
    deliverPendingInteraction({
      jsonrpc: "2.0",
      id: 7,
      method: "approval/request",
      params: {
        serverId: "server-engine-fixture",
        threadId: "thread-interaction-test",
        turnId: "turn-7",
        appServerEpoch: "epoch-interaction-test",
        approvalId: "approval-7",
        reason: "需要批准",
        action: { type: "command", command: "ls" },
      },
    });
    const interaction = runtime.getSnapshot().interaction!;
    renderToStaticMarkup(
      <ApprovalCard
        interaction={interaction as Extract<typeof interaction, { kind: "approval" }>}
        onRespond={(decision) => runtime.respondApproval(decision)}
      />,
    );

    expect(getHandlers()["approval-accept"]).toBeTypeOf("function");
    fakeSocket.readyState = 3;
    expect(runtime.getSnapshot().connected).toBe(true);
    expect(getHandlers()["approval-accept"]()).toBe(
      "Approval response failed: 当前连接不可处理此请求，请返回收件箱核对状态。. You can try again.",
    );
    expect(runtime.pendingInteractions).toHaveLength(1);
    expect(runtime.pendingInteractions[0]?.responding).not.toBe(true);
    expect(getHandlers()["approval-accept"]()).toBe(
      "Approval response failed: 当前连接不可处理此请求，请返回收件箱核对状态。. You can try again.",
    );
    expect(runtime.pendingInteractions).toHaveLength(1);
    expect(runtime.pendingInteractions[0]?.responding).not.toBe(true);
  });

  it("question cancel RPC readiness races fail closed and retain the pending ledger", async () => {
    const runtime = await resumeRuntime();
    deliverPendingInteraction({
      jsonrpc: "2.0",
      id: 8,
      method: "question/request",
      params: {
        serverId: "server-engine-fixture",
        threadId: "thread-interaction-test",
        turnId: "turn-8",
        appServerEpoch: "epoch-interaction-test",
        questionId: "question-8",
        questions: [{ id: "choice", prompt: "选择一个选项", options: [] }],
      },
    });
    const interaction = runtime.getSnapshot().interaction!;
    renderToStaticMarkup(
      <QuestionCard
        interaction={interaction as Extract<typeof interaction, { kind: "question" }>}
        onSubmit={() => undefined}
        onCancel={() => runtime.cancelQuestions()}
      />,
    );

    expect(getHandlers()["question-cancel"]).toBeTypeOf("function");
    fakeSocket.readyState = 3;
    expect(runtime.getSnapshot().connected).toBe(true);
    expect(getHandlers()["question-cancel"]()).toBe(
      "Question cancellation failed: 当前连接不可处理此请求，请返回收件箱核对状态。. You can try again.",
    );
    expect(runtime.pendingInteractions).toHaveLength(1);
    expect(runtime.pendingInteractions[0]?.responding).not.toBe(true);
    expect(getHandlers()["question-cancel"]()).toBe(
      "Question cancellation failed: 当前连接不可处理此请求，请返回收件箱核对状态。. You can try again.",
    );
    expect(runtime.pendingInteractions).toHaveLength(1);
    expect(runtime.pendingInteractions[0]?.responding).not.toBe(true);
  });
});


const originalQuestionOwner: QuestionInteraction = {
  kind: "question", requestId: 11, questionId: "reused-question",
  owner: {
    profileId: "profile", profileAuthorizationScopeKey: "scope", serverId: "target",
    appServerId: "native", serverConfigIdentity: "config", threadId: "thread",
    turnId: "turn", appServerEpoch: "epoch", runtimeInstanceNonce: 1,
    profileActivationEpoch: 1, originClientGeneration: 1, status: "pending",
  },
  questions: [{ id: "choice", header: "Mode", prompt: "Which mode?",
    allowsFreeform: true, multiSelect: false, options: [{ label: "Fast", value: "fast" }] }],
};

it.each([
  { profileId: "other-profile" }, { profileAuthorizationScopeKey: "other-scope" },
  { serverId: "other-target" }, { appServerId: "other-native" },
  { serverConfigIdentity: "other-config" }, { runtimeInstanceNonce: 2 },
  { profileActivationEpoch: 2 }, { originClientGeneration: 2 },
])("a reused question cannot inherit drafts from a different owner: %j", async change => {
  const original = structuredClone(originalQuestionOwner);
  const replacement = { ...original, owner: { ...original.owner, ...change } };
  const submit = vi.fn();
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => { renderer = create(<QuestionCard interaction={original}
      onSubmit={submit} onCancel={() => undefined} />); });
    await act(async () => renderer.root.findByType("input").props.onChangeText("original owner's draft"));
    expect(renderer.root.findByType("input").props.value).toBe("original owner's draft");
    await act(async () => renderer.update(<QuestionCard interaction={replacement}
      onSubmit={submit} onCancel={() => undefined} />));
    expect(renderer.root.findByType("input").props.value).toBe("");
    expect(interactionCardIdentity(original)).not.toBe(interactionCardIdentity(replacement));
    expect(submit).not.toHaveBeenCalled();
  } finally { if (renderer) await act(async () => renderer.unmount()); }
});

it("a new background run cannot inherit the previous run's question identity", () => {
  const original = { ...originalQuestionOwner, sourceAgent: { parentSessionId: "thread", agentId: "worker",
    backgroundRun: { parentSessionId: "thread", agentId: "worker", runId: "run-one" } } };
  const next = { ...original, sourceAgent: { ...original.sourceAgent,
    backgroundRun: { ...original.sourceAgent.backgroundRun, runId: "run-two" } } };
  expect(interactionCardIdentity(original)).not.toBe(interactionCardIdentity(next));
  expect(interactionCardIdentity(original)).toBe(interactionCardIdentity({ ...original,
    responding: true, owner: { ...original.owner, status: "unknown" } }));
});
