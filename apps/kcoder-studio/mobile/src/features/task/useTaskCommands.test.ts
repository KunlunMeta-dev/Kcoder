import { describe, expect, it, vi } from "vitest";
import { useTaskCommands } from "./useTaskCommands";

function createInputHarness(initial: string) {
  let value = initial;
  const inputIntentRef = {
    current: { value: initial, revision: 0 },
  };
  const setInput = vi.fn((next: string | ((current: string) => string)) => {
    const current = inputIntentRef.current;
    value = typeof next === "function" ? next(current.value) : next;
    inputIntentRef.current = {
      value,
      revision: current.revision + 1,
    };
  });
  return {
    inputIntentRef,
    setInput,
    get value() {
      return value;
    },
  };
}

function commandContext(
  initialInput: string,
  task: Record<string, unknown>,
  onDraftChange?: (value: string | undefined) => void | Promise<void>,
) {
  const input = createInputHarness(initialInput);
  const context = {
    openModelPicker: vi.fn(),
    task,
    onDraftChange,
    snapshot: { threadId: "thread-1", running: false, interaction: null },
    messageQueue: { enqueue: vi.fn() },
    input: initialInput,
    setInput: input.setInput,
    inputIntentRef: input.inputIntentRef,
    messageInputRef: { current: null },
    goalEditExpectationRef: { current: null },
    attachments: [],
    setQueueError: vi.fn(),
    setComposerNotice: vi.fn(),
  } as unknown as Parameters<typeof useTaskCommands>[0];
  return { context, input };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

describe("useTaskCommands model modes", () => {
  it.each([
    ["/moa advice", "advice", "moa"],
    ["/moa-plan plan", "plan", "moa-plan"],
  ] as const)(
    "preserves %s turn mode when sending a direct slash command",
    async (input, content, turnMode) => {
      const task = { send: vi.fn(async () => {}) };
      const { context } = commandContext(input, task);

      const { executeSlashCommand } = useTaskCommands(context);
      await expect(executeSlashCommand(input)).resolves.toBe(true);

      expect(task.send).toHaveBeenCalledWith(content, [], turnMode);
    },
  );
});

describe("useTaskCommands draft ownership", () => {
  it("keeps a newer composer draft when an earlier goal command finishes sending", async () => {
    const sendPending = deferred<void>();
    const task = {
      getGoal: vi.fn(async () => null),
      setGoal: vi.fn(async () => undefined),
      send: vi.fn(() => sendPending.promise),
    };
    const initialInput = "/goal-pro Finish the migration";
    let persistedDraft: string | undefined = initialInput;
    const onDraftChange = vi.fn(async (value: string | undefined) => {
      persistedDraft = value;
    });
    const { context, input } = commandContext(
      initialInput,
      task,
      onDraftChange,
    );

    const { executeSlashCommand } = useTaskCommands(context);
    const commandPending = executeSlashCommand(initialInput);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(task.send).toHaveBeenCalledWith("Finish the migration");

    input.setInput("B must remain in the composer");
    await onDraftChange("B must remain in the composer");
    sendPending.resolve();
    await commandPending;

    expect({ composerInput: input.value, persistedDraft }).toEqual({
      composerInput: "B must remain in the composer",
      persistedDraft: "B must remain in the composer",
    });
  });

  it("preserves a same-text draft retyped after the earlier command clears its input", async () => {
    const sendPending = deferred<void>();
    const task = {
      getGoal: vi.fn(async () => null),
      setGoal: vi.fn(async () => undefined),
      send: vi.fn(() => sendPending.promise),
    };
    const submitted = "/goal-pro Finish the migration";
    let persistedDraft: string | undefined = submitted;
    const onDraftChange = vi.fn(async (value: string | undefined) => {
      persistedDraft = value;
    });
    const { context, input } = commandContext(submitted, task, onDraftChange);
    const { executeSlashCommand } = useTaskCommands(context);
    const commandPending = executeSlashCommand(submitted);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(input.value).toBe("");

    input.setInput(submitted);
    await onDraftChange(submitted);
    sendPending.resolve();
    await commandPending;

    expect(input.value).toBe(submitted);
    expect(persistedDraft).toBe(submitted);
  });

  it("does not persist an old clear after the user replaces then clears a draft", async () => {
    const sendPending = deferred<void>();
    const task = {
      getGoal: vi.fn(async () => null),
      setGoal: vi.fn(async () => undefined),
      send: vi.fn(() => sendPending.promise),
    };
    const submitted = "/goal-pro Finish the migration";
    const onDraftChange = vi.fn(async (_value: string | undefined) => {});
    const { context, input } = commandContext(submitted, task, onDraftChange);
    const { executeSlashCommand } = useTaskCommands(context);
    const commandPending = executeSlashCommand(submitted);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(task.send).toHaveBeenCalled();

    input.setInput("B");
    input.setInput("");
    await onDraftChange(undefined);
    const draftWritesBeforeASettles = onDraftChange.mock.calls.length;
    sendPending.resolve();
    await commandPending;

    expect(input.value).toBe("");
    expect(onDraftChange).toHaveBeenCalledTimes(draftWritesBeforeASettles);
  });

  it("uses the current owner for an async command selected from a slash prefix", async () => {
    const compactPending = deferred<{
      compacted: boolean;
      preTokens: number;
      postTokens: number;
    }>();
    const task = { compact: vi.fn(() => compactPending.promise) };
    let persistedDraft: string | undefined = "/comp";
    const onDraftChange = vi.fn(async (value: string | undefined) => {
      persistedDraft = value;
    });
    const { context, input } = commandContext("/comp", task, onDraftChange);
    const { executeSlashCommand } = useTaskCommands(context);
    const commandPending = executeSlashCommand("/compact");

    input.setInput("B survives the compact request");
    await onDraftChange("B survives the compact request");
    compactPending.resolve({
      compacted: true,
      preTokens: 20,
      postTokens: 10,
    });
    await commandPending;

    expect(input.value).toBe("B survives the compact request");
    expect(persistedDraft).toBe("B survives the compact request");
  });

  it("does not prefill a stale goal edit over text typed while getGoal is pending", async () => {
    const goalPending = deferred<{
      goalId: string;
      revision: number;
      objective: string;
    } | null>();
    const task = { getGoal: vi.fn(() => goalPending.promise) };
    let persistedDraft: string | undefined;
    const onDraftChange = vi.fn(async (value: string | undefined) => {
      persistedDraft = value;
    });
    const { context, input } = commandContext(
      "/goal-pro edit",
      task,
      onDraftChange,
    );
    const { executeSlashCommand } = useTaskCommands(context);
    const commandPending = executeSlashCommand("/goal-pro edit");

    input.setInput("B should not be replaced");
    await onDraftChange("B should not be replaced");
    goalPending.resolve({
      goalId: "goal-1",
      revision: 4,
      objective: "Existing objective",
    });
    await commandPending;

    expect(input.value).toBe("B should not be replaced");
    expect(persistedDraft).toBe("B should not be replaced");
    expect(context.goalEditExpectationRef.current).toBeNull();
  });

  it("does not clear a newer goal edit expectation when an earlier edit settles", async () => {
    const editPending = deferred<{
      goalId: string;
      revision: number;
      objective: string;
      mode: "strict";
      status: "paused";
      tokensUsed: number;
      timeUsedSeconds: number;
    }>();
    const prefillPending = deferred<{
      goalId: string;
      revision: number;
      objective: string;
    } | null>();
    const task = {
      editGoal: vi.fn(() => editPending.promise),
      getGoal: vi.fn(() => prefillPending.promise),
    };
    const oldExpectation = {
      command: "/goal-pro" as const,
      goalId: "goal-old",
      revision: 3,
    };
    const { context, input } = commandContext(
      "/goal-pro edit Older objective",
      task,
    );
    context.goalEditExpectationRef.current = oldExpectation;
    const { executeSlashCommand } = useTaskCommands(context);
    const oldEdit = executeSlashCommand("/goal-pro edit Older objective");

    input.setInput("/goal-pro edit");
    const newPrefill = executeSlashCommand("/goal-pro edit");
    prefillPending.resolve({
      goalId: "goal-new",
      revision: 9,
      objective: "New objective",
    });
    await newPrefill;
    const newExpectation = context.goalEditExpectationRef.current;
    expect(newExpectation).toEqual({
      command: "/goal-pro",
      goalId: "goal-new",
      revision: 9,
    });

    editPending.resolve({
      goalId: "goal-old",
      revision: 4,
      objective: "Older objective",
      mode: "strict",
      status: "paused",
      tokensUsed: 1,
      timeUsedSeconds: 1,
    });
    await oldEdit;

    expect(context.goalEditExpectationRef.current).toBe(newExpectation);
  });
});
