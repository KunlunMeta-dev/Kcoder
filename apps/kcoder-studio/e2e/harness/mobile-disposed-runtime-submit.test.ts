import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hookHarness = vi.hoisted(() => ({
  effects: [] as Array<() => void | (() => void)>,
  refs: [] as Array<{ current: unknown }>,
  refIndex: 0,
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useEffect: (effect: () => void | (() => void)) => {
      hookHarness.effects.push(effect);
    },
    useRef: (initial: unknown) => {
      const index = hookHarness.refIndex++;
      hookHarness.refs[index] ??= { current: initial };
      return hookHarness.refs[index];
    },
    useSyncExternalStore: (
      _subscribe: () => () => void,
      getSnapshot: () => unknown,
    ) => getSnapshot(),
  };
});

vi.mock("@/gateway/http", () => ({
  gatewaySessionExpired: vi.fn(async () => false),
}));

import { useTaskCommands } from "../../mobile/src/features/task/useTaskCommands";
import { useTaskSending } from "../../mobile/src/features/task/useTaskSending";
import { MobileRpcError, type JsonRecord } from "../../mobile/src/gateway/rpc";
import { taskMessageQueue } from "../../mobile/src/runtime/task-message-queue";
import {
  TaskRuntime,
  taskRuntimeTestHelpers,
} from "../../mobile/src/runtime/task-runtime";
import { TaskRuntimeRegistry } from "../../mobile/src/runtime/task-runtime/registry";
import {
  FakeClient,
  profile,
  server,
} from "../../mobile/src/runtime/task-runtime/fixture.test-support";
import type { WorkspaceFailedSubmission } from "../../mobile/src/storage/workspace-preferences";
import { runE2E } from "./run-context.mjs";

class RetryAcceptingFakeClient extends FakeClient {
  readonly turnStarts: JsonRecord[] = [];

  override async request<T>(
    method: string,
    params: JsonRecord = {},
  ): Promise<T> {
    if (method === "turn/start") {
      this.turnStarts.push(params);
      return { turn: { id: "turn-retried", status: "completed" } } as T;
    }
    return super.request<T>(method, params);
  }
}

class DeferredModelCatalogClient extends FakeClient {
  readonly writes: Array<{ method: string; params: JsonRecord }> = [];
  catalogRequests = 0;
  catalogRequestEntered!: () => void;
  readonly catalogEntered = new Promise<void>((resolve) => {
    this.catalogRequestEntered = resolve;
  });
  rejectCatalog!: (error: Error) => void;

  constructor(private readonly catalogError = new MobileRpcError("RPC 连接已关闭")) {
    super([]);
  }

  override async request<T>(
    method: string,
    params: JsonRecord = {},
  ): Promise<T> {
    if (method === "thread/resume") {
      return {
        thread: {
          id: "thread-preflight-disposal",
          title: "模型目录等待中的任务",
          cwd: "/workspace",
          model: "provider::model",
          status: "idle",
        },
      } as T;
    }
    if (method === "runtime.models.list") {
      this.catalogRequests += 1;
      this.catalogRequestEntered();
      return new Promise<T>((_resolve, reject) => {
        this.rejectCatalog = reject;
      });
    }
    this.writes.push({ method, params });
    return super.request<T>(method, params);
  }

  override close(): void {
    super.close();
    this.rejectCatalog?.(this.catalogError);
  }
}

function renderComposerSend(context: Parameters<typeof useTaskCommands>[0]) {
  hookHarness.refIndex = 0;
  return useTaskSending(useTaskCommands(context));
}

describe("Mobile model-independent disposed-runtime composer lifecycle", () => {
  beforeEach(() => {
    hookHarness.effects = [];
    hookHarness.refs = [];
    hookHarness.refIndex = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    taskRuntimeTestHelpers.resetConnector();
  });

  it("does not turn a held real route runtime into demo success after LRU close during draft persistence", async () => {
    await runE2E(
      import.meta.url,
      {
        testId: "mobile-disposed-runtime-submit",
        tier: "harness-unit",
        modelPolicy: "model-independent",
        boundary: "Mobile composer runtime/registry lifecycle; no model request",
      },
      async (runContext) => {
        await runContext.writeArtifactJson("classification-note.json", {
          classification: {
            tier: "harness-unit",
            modelPolicy: "model-independent",
            boundary:
              "Actual Mobile TaskRuntimeRegistry and composer hooks with FakeClient; no browser, Gateway, Provider, or model request.",
          },
          priorRun: {
            runRoot:
              "target/test/apps/kcoder-studio/e2e/harness/mobile-disposed-runtime-submit.test.ts/20260930-203038.861Z",
            historicalTier: "full-integration",
            note:
              "The prior manifest is preserved unchanged; RunContext used its default tier because the test did not explicitly set tier.",
          },
          futureRuns:
            "This source explicitly sets tier=harness-unit and modelPolicy=model-independent.",
        });
        vi.useFakeTimers();
        runContext.addCleanup("clear Mobile submit test timers", () => {
          vi.clearAllTimers();
        });

        const client = new FakeClient([]);
        let activeClient: FakeClient = client;
        const request = vi.spyOn(client, "request");
        taskRuntimeTestHelpers.setConnector(
          vi.fn(async () => activeClient as never) as never,
        );

        const runtime = await TaskRuntime.resume({
          profile,
          server,
          threadId: "thread-disposed-during-submit",
        });
        const registry = new TaskRuntimeRegistry();
        let retryRuntime: TaskRuntime | undefined;
        runContext.addCleanup("close Mobile TaskRuntime registry entries", () => {
          registry.removeProfile(profile.id);
          runtime.close();
          retryRuntime?.close();
        });
        registry.put(profile.id, server.id, runtime);
        const routeTask = registry.get(
          profile.id,
          server.id,
          runtime.getSnapshot().threadId,
        );
        expect(routeTask).toBe(runtime);
        if (!routeTask) throw new Error("registered route runtime is missing");

        let releaseFirstPersistence!: () => void;
        let notifyPersistenceEntered!: () => void;
        const persistenceGate = new Promise<void>((resolve) => {
          releaseFirstPersistence = resolve;
        });
        const firstPersistenceEntered = new Promise<void>((resolve) => {
          notifyPersistenceEntered = resolve;
        });
        runContext.addCleanup("release deferred failed-draft persistence", () => {
          releaseFirstPersistence();
        });
        const persistedSnapshots: unknown[] = [];
        const onFailedSubmissionsChange = vi.fn(async (items) => {
          persistedSnapshots.push(items ?? null);
          if (persistedSnapshots.length === 1) {
            notifyPersistenceEntered();
            await persistenceGate;
          }
        });

        const inputIntentRef = {
          current: { value: "held while saving", revision: 0 },
        };
        const context = {
          task: routeTask,
          demo: false,
          onDraftChange: vi.fn(),
          initialFailedSubmissions: [],
          onFailedSubmissionsChange,
          snapshot: routeTask.getSnapshot(),
          messageQueue: taskMessageQueue(routeTask),
          queuedMessages: [],
          input: "held while saving",
          setInput: vi.fn(),
          inputIntentRef,
          goalEditExpectationRef: { current: null },
          attachments: [],
          setAttachments: vi.fn(),
          setQueueError: vi.fn(),
          setComposerNotice: vi.fn(),
          openModelPicker: vi.fn(),
          messageInputRef: { current: null },
          sendingQueued: { current: false },
        } as unknown as Parameters<typeof useTaskCommands>[0];

        const composer = renderComposerSend(context);
        const pendingSubmit = composer.submit();
        await firstPersistenceEntered;

        const draftWhileSaving = renderComposerSend(context).failedSubmissions;
        expect(runtime.getSnapshot().running).toBe(false);
        expect(draftWhileSaving).toMatchObject([
          { content: "held while saving", outcome: "failed", retrying: true },
        ]);

        // The route still holds `runtime`, but the cache has no focused-route or
        // pending-submit lease. Eight subsequent inserts push its idle entry out.
        for (let index = 0; index < 8; index += 1) {
          registry.put(
            profile.id,
            server.id,
            TaskRuntime.demo(`lru-filler-${index}`),
          );
        }
        const disposedDuringPersistence = runtime.isDisposed();
        const heldRouteEntry = registry.get(
          profile.id,
          server.id,
          runtime.getSnapshot().threadId,
        );
        releaseFirstPersistence();
        await pendingSubmit;

        const turnStartWrites = request.mock.calls.filter(
          ([method]) => method === "turn/start",
        );
        const sentAsDemo = runtime
          .getSnapshot()
          .messages.some(
            (message) =>
              message.role === "user" &&
              message.id.startsWith("demo-user-") &&
              message.content === "held while saving",
          );
        const remainingFailedSubmissions =
          renderComposerSend(context).failedSubmissions;
        const retainedDraft = remainingFailedSubmissions.some(
          (item) =>
            item.content === "held while saving" && item.outcome === "failed",
        );
        const persistedFailedDrafts =
          persistedSnapshots.at(-1) as WorkspaceFailedSubmission[] | null;
        const persistedDraft = persistedFailedDrafts?.find(
          (item) => item.content === "held while saving",
        );
        const observation = {
          heldRouteEntryStillRegistered: heldRouteEntry !== undefined,
          runtimeDisposedBeforePersistenceResolved: disposedDuringPersistence,
          turnStartWrites: turnStartWrites.length,
          sentAsDemo,
          retainedDraft,
          persistedDraft,
          persistedSnapshots,
        };
        await runContext.writeArtifactJson("disposal-observation.json", observation);

        if (turnStartWrites.length !== 0)
          throw new Error("Disposed-runtime fixture unexpectedly sent turn/start");
        if (sentAsDemo || !retainedDraft) {
          throw new Error(
            `Disposed runtime became demo success or lost the failed draft: ${JSON.stringify(observation)}`,
          );
        }
        if (!persistedDraft || persistedDraft.outcome !== "failed")
          throw new Error("The not-sent draft was not durably restored as failed");

        // A new route/runtime rehydrates only the persisted failed card. It
        // does not auto-replay it; explicit user retry sends its stable ID once.
        const retryClient = new RetryAcceptingFakeClient([]);
        activeClient = retryClient;
        retryRuntime = await TaskRuntime.resume({
          profile,
          server,
          threadId: runtime.getSnapshot().threadId,
        });
        const retryPersistence: Array<WorkspaceFailedSubmission[] | null> = [];
        const retryContext = {
          ...context,
          task: retryRuntime,
          initialFailedSubmissions: persistedFailedDrafts,
          onFailedSubmissionsChange: vi.fn(async (items) => {
            retryPersistence.push(items ?? null);
          }),
          snapshot: retryRuntime.getSnapshot(),
          messageQueue: taskMessageQueue(retryRuntime),
          input: "draft after reload",
        } as unknown as Parameters<typeof useTaskCommands>[0];
        const reloadedComposer = renderComposerSend(retryContext);
        expect(reloadedComposer.failedSubmissions).toMatchObject([
          {
            id: persistedDraft.id,
            content: "held while saving",
            outcome: "failed",
            retrying: false,
          },
        ]);
        expect(retryClient.turnStarts).toHaveLength(0);
        await reloadedComposer.retryFailedSubmission(persistedDraft.id);
        expect(retryClient.turnStarts).toHaveLength(1);
        expect(retryClient.turnStarts[0]?.clientMessageId).toBe(
          persistedDraft.id,
        );
        expect(renderComposerSend(retryContext).failedSubmissions).toHaveLength(0);
        expect(retryPersistence.at(-1)).toBeNull();

        const result = {
          ...observation,
          reloadedStableId: persistedDraft.id,
          automaticRetryWrites: 0,
          manualRetryWrites: retryClient.turnStarts.length,
          manualRetryClientMessageId:
            retryClient.turnStarts[0]?.clientMessageId ?? null,
          draftRemovedAfterConfirmedManualRetry:
            renderComposerSend(retryContext).failedSubmissions.length === 0,
        };
        await runContext.writeArtifactJson("manual-retry-observation.json", {
          reloadedStableId: result.reloadedStableId,
          automaticRetryWrites: result.automaticRetryWrites,
          manualRetryWrites: result.manualRetryWrites,
          manualRetryClientMessageId: result.manualRetryClientMessageId,
          draftRemovedAfterConfirmedManualRetry:
            result.draftRemovedAfterConfirmedManualRetry,
        });
        return result;
      },
    );
  });

  it("keeps a disposed qualified-model preflight draft retryable before turn/start", async () => {
    await runE2E(
      import.meta.url,
      {
        testId: "mobile-disposed-runtime-model-preflight",
        tier: "harness-unit",
        modelPolicy: "model-independent",
        boundary:
          "Actual Mobile TaskRuntime and composer hooks with deferred FakeClient model discovery; explicit profile removal closes runtime before turn/start, with no model request.",
      },
      async (runContext) => {
        const client = new DeferredModelCatalogClient();
        taskRuntimeTestHelpers.setConnector(
          vi.fn(async () => client as never) as never,
        );
        const runtime = await TaskRuntime.resume({
          profile,
          server,
          threadId: "thread-preflight-disposal",
        });
        const registry = new TaskRuntimeRegistry();
        registry.put(profile.id, server.id, runtime);
        runContext.addCleanup("close preflight test runtime", () => {
          registry.removeProfile(profile.id);
          runtime.close();
        });

        const routeTask = registry.get(
          profile.id,
          server.id,
          runtime.getSnapshot().threadId,
        );
        if (!routeTask) throw new Error("registered route runtime is missing");
        const sendSpy = vi.spyOn(routeTask, "send");
        const context = {
          task: routeTask,
          demo: false,
          onDraftChange: vi.fn(),
          initialFailedSubmissions: [],
          onFailedSubmissionsChange: vi.fn(async () => {}),
          snapshot: routeTask.getSnapshot(),
          messageQueue: taskMessageQueue(routeTask),
          queuedMessages: [],
          input: "retry after model discovery closes",
          setInput: vi.fn(),
          inputIntentRef: {
            current: {
              value: "retry after model discovery closes",
              revision: 0,
            },
          },
          goalEditExpectationRef: { current: null },
          attachments: [],
          setAttachments: vi.fn(),
          setQueueError: vi.fn(),
          setComposerNotice: vi.fn(),
          openModelPicker: vi.fn(),
          messageInputRef: { current: null },
          sendingQueued: { current: false },
        } as unknown as Parameters<typeof useTaskCommands>[0];

        const composer = renderComposerSend(context);
        const pendingSubmit = composer.submit();
        await client.catalogEntered;
        registry.removeProfile(profile.id);
        await pendingSubmit;

        const finalFailedSubmissions = renderComposerSend(context).failedSubmissions;
        const observation = {
          disposedByExplicitProfileRemoval: runtime.isDisposed(),
          modelCatalogRequests: client.catalogRequests,
          turnStartWrites: client.writes.filter(
            ({ method }) => method === "turn/start",
          ).length,
          sentAsDemo: runtime
            .getSnapshot()
            .messages.some(
              (message) =>
                message.role === "user" &&
                message.id.startsWith("demo-user-") &&
                message.content === "retry after model discovery closes",
            ),
          failedSubmissions: finalFailedSubmissions.map((item) => ({
            content: item.content,
            outcome: item.outcome,
            retrying: item.retrying,
            error: item.error ?? null,
          })),
        };
        await runContext.writeArtifactJson("preflight-disposal-observation.json", observation);

        expect(observation.disposedByExplicitProfileRemoval).toBe(true);
        expect(observation.modelCatalogRequests).toBe(1);
        expect(observation.turnStartWrites).toBe(0);
        expect(observation.sentAsDemo).toBe(false);
        const sendResult = sendSpy.mock.results[0]?.value as
          | Promise<void>
          | undefined;
        expect(sendResult).toBeDefined();
        await expect(sendResult).rejects.toMatchObject({
          message: "RPC 连接已关闭",
          code: -1,
          reason: "transport",
          delivery: "not-sent",
        });
        expect(observation.failedSubmissions).toMatchObject([
          {
            content: "retry after model discovery closes",
            outcome: "failed",
            retrying: false,
          },
        ]);
        return observation;
      },
    );
  });

  it("preserves catalog rejection details when disposal races preflight", async () => {
    await runE2E(
      import.meta.url,
      {
        testId: "mobile-disposed-runtime-model-preflight-error",
        tier: "harness-unit",
        modelPolicy: "model-independent",
        boundary:
          "Actual TaskRuntime send with a deferred model-list RPC that rejects remotely as profile removal closes its runtime; proves original error metadata survives local not-sent classification before turn/start.",
      },
      async () => {
        const remoteError = new MobileRpcError(
          "目标模型目录拒绝请求",
          -32031,
          "remote",
        );
        const client = new DeferredModelCatalogClient(remoteError);
        taskRuntimeTestHelpers.setConnector(
          vi.fn(async () => client as never) as never,
        );
        const runtime = await TaskRuntime.resume({
          profile,
          server,
          threadId: "thread-preflight-error-disposal",
        });
        const registry = new TaskRuntimeRegistry();
        registry.put(profile.id, server.id, runtime);
        try {
          const pendingSend = runtime.send(
            "keep the selector error",
            [],
            undefined,
            { clientMessageId: "stable-preflight-error-id" },
          );
          await client.catalogEntered;
          registry.removeServer(profile.id, server.id);
          await expect(pendingSend).rejects.toMatchObject({
            message: "目标模型目录拒绝请求",
            code: -32031,
            reason: "remote",
            delivery: "not-sent",
          });
          expect(client.writes.filter(({ method }) => method === "turn/start"))
            .toHaveLength(0);
        } finally {
          registry.removeProfile(profile.id);
          runtime.close();
        }
      },
    );
  });
});
