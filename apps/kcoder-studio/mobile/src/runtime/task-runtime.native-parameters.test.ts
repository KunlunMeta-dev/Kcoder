import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";
import { profileAuthorizationScopeKey } from "@/state/profile-coordinator";
import { legacyAttachmentPrompt } from "@/protocol/attachment-prompt";
import { appServerId, profile, server } from "./task-runtime/fixture.test-support";
import { permissionParams } from "./task-runtime/turn-permissions";
import { assertNoTranscriptAction } from "./task-runtime/transcriptActions";
import { interactionServerIdentity } from "./task-runtime/threadDirectory";
import { t } from "@/i18n";

const require = createRequire(import.meta.url);
const expoRequire = createRequire(require.resolve("expo/package.json"));
const babel = expoRequire("@babel/core");
const preset = expoRequire.resolve("babel-preset-expo");
const ts: typeof import("typescript") = require("typescript");
const directory = fileURLToPath(new URL("./task-runtime/", import.meta.url));
type Api = Record<string, (...args: any[]) => any>;

function nativeModule(name: string, platform: "android" | "ios", modules: Record<string, unknown> = {}): Api {
  const result = babel.transformFileSync(join(directory, name), {
    babelrc: false, configFile: false, presets: [preset],
    caller: { name: "metro", platform, engine: "hermes", isDev: false, isServer: false, supportsStaticESM: false, supportsDynamicImport: true },
  });
  const exports: Api = {};
  runInNewContext(result.code, { exports, module: { exports }, require: (id: string) => id.startsWith("@babel/runtime/") ? require(id) : modules[id] ?? (id === "./turn-permissions" ? { permissionParams } : id === "./goalProjection" ? nativeModule("goalProjection.ts", platform) : {}),
    TextEncoder, Error, Date, Math, Map, Set, Object, setTimeout, clearTimeout });
  return exports;
}

for (const platform of ["android", "ios"] as const) {
  // The first Expo/Babel preset transform can exceed Vitest's default timeout.
  it(`${platform} Expo/Hermes compilation preserves RPC object and timeout positions`, async () => {
    const api = nativeModule("resources.ts", platform), request = vi.fn(async () => ({ path: "/owned/note.txt" }));
    const task = { client: { request }, snapshot: { connected: true } };
    const params = { filename: "note.txt", content_base64: "aGk=" };
    await api.request.call(task, "attachment/save", params, 3210);
    expect(request).toHaveBeenCalledWith("attachment/save", params, 3210);
    await api.request.call(task, "agent/list");
    expect(request).toHaveBeenLastCalledWith("agent/list", {}, undefined);
  }, 20_000);
  it(`${platform} native compilation retains public history paging options and source ignore`, async () => {
    const agents = nativeModule("agents.ts", platform), interactions = nativeModule("interactions.ts", platform, {
      "@/i18n": { t },
      "@/state/profile-coordinator": { profileAuthorizationScopeKey },
      "./threadDirectory": { interactionServerIdentity },
    });
    const request = vi.fn(async () => ({ threadId: "parent", agentId: "worker", content: "public" }));
    const clientGeneration = 1;
    const runtimeInstanceNonce = 27;
    const profileActivationEpoch = 4;
    const profileScope = profileAuthorizationScopeKey(profile);
    const serverIdentity = interactionServerIdentity(server);
    const owner = {
      profileId: profile.id,
      profileAuthorizationScopeKey: profileScope,
      serverId: server.id,
      appServerId,
      serverConfigIdentity: serverIdentity,
      threadId: "parent",
      turnId: "turn-11",
      appServerEpoch: "epoch-11",
      runtimeInstanceNonce,
      profileActivationEpoch,
      originClientGeneration: clientGeneration,
      status: "pending" as const,
    };
    const task: any = {
      client: {
        isTransportOpen: () => true,
        getAppServerId: () => appServerId,
        respond: vi.fn(),
      },
      clientGeneration,
      runtimeInstanceNonce,
      disposed: false,
      reconnecting: false,
      reconnectContext: {
        profile,
        server,
        profileActivationEpoch,
        isCurrentInteractionOwner: (candidate: typeof owner) => candidate === owner,
      },
      snapshot: { connected: true, threadId: "parent" },
      request,
      agentCapabilities: () => ({ discover: true, pages: true }),
      pendingInteractions: [{
        kind: "question",
        requestId: 11,
        questionId: "question-11",
        questions: [{ id: "choice" }],
        sourceAgent: { agentId: "worker", parentSessionId: "parent" },
        owner,
      }],
      focusedInteractionSelector: null,
      patch: vi.fn(),
      notifyInteractionChanged: vi.fn(),
      notifyInteractionResolved: vi.fn(),
      markInteractionResponding: (selector: unknown, responding?: boolean) =>
        interactions.markInteractionResponding.call(task, selector, responding),
    };
    await agents.readSubagent.call(task, { agentId: "worker", status: "completed" }, { history: true, offset: 80, revision: "stable" });
    expect(request).toHaveBeenCalledWith("agent/artifact/read", { threadId: "parent", agentId: "worker", kind: "transcript", limit: 32768, offset: 80, revision: "stable" });
    expect(() => interactions.respondAgentQuestions.call(task, "worker", 11, { foreign: ["yes"] }))
      .toThrow(t("task.question_answer_items_mismatch"));
    expect(task.client.respond).not.toHaveBeenCalled();
    expect(task.pendingInteractions[0].responding).not.toBe(true);
    interactions.respondAgentQuestions.call(task, "worker", 11, {}, true);
    expect(task.client.respond).toHaveBeenCalledWith(11, { answers: {}, annotations: { ignored: true } });
    interactions.markInteractionResponding.call(task, 11, false);
    expect(task.pendingInteractions[0]).toMatchObject({ responding: false });
  });
  it(`${platform} native compilation preserves attachment/mode and exact reliable steer identity`, async () => {
    const api = nativeModule("turns.ts", platform, {
      "../../../../shared/modelSelection": { negotiateModelSelector: async () => undefined },
      "@/protocol/attachment-prompt": { legacyAttachmentPrompt },
      "./transcriptActions": { assertNoTranscriptAction },
    });
    const request = vi.fn(async (_method: string, params: any) => ({ agentId: params.agentId, clientMessageId: params.clientMessageId, status: "queued_live", queued: true }));
    const task = { client: { supportsExperimental: () => true }, clientGeneration: 1, disposed: false, snapshot: { connected: true, threadId: "parent", messages: [], transcriptActionPending: false },
      request, patch: vi.fn(), startOrdinaryTurn: vi.fn(), updateSubagentSteer: vi.fn() };
    const attachment = { path: "/owned/note.txt", filename: "note.txt", mimeType: "text/plain", fileSize: 2 };
    await api.send.call(task, "native text", [attachment], "moa");
    expect(task.startOrdinaryTurn).toHaveBeenCalledTimes(1);
    expect(task.startOrdinaryTurn.mock.calls[0][0]).toEqual(expect.objectContaining({
      turnMode: "moa",
      input: [{ type: "text", text: expect.stringContaining(JSON.stringify(attachment)) }],
    }));
    expect(task.startOrdinaryTurn.mock.calls[0][0]).not.toHaveProperty("clientMessageId");
    expect(task.startOrdinaryTurn.mock.calls[0][1]).toMatch(/^local-user-/);

    task.startOrdinaryTurn.mockClear();
    await api.send.call(task, "native text with explicit identity", [attachment], "moa", { clientMessageId: "native-message-id" });
    expect(task.startOrdinaryTurn).toHaveBeenCalledTimes(1);
    expect(task.startOrdinaryTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        turnMode: "moa",
        clientMessageId: "native-message-id",
        input: [{ type: "text", text: expect.stringContaining(JSON.stringify(attachment)) }],
      }),
      expect.stringMatching(/^local-user-/),
    );
    await api.steerSubagent.call(task, "worker", "中文追加", "cmd:2:original");
    expect(request).toHaveBeenCalledWith("agent/steer", { threadId: "parent", agentId: "worker", message: "中文追加", clientMessageId: "cmd:2:original" });
  });
  it(`${platform} native compilation keeps goal CAS/budget and explicit current-model continuation`, async () => {
    const goal = nativeModule("metadata.ts", platform), submitted = vi.fn(async (client: unknown, _params: unknown) => ({ client, result: { turn: { id: "continued", status: "running" } }, recovered: false }));
    const turns = nativeModule("turns.ts", platform, {
      "../../../../shared/modelSelection": { negotiateModelSelector: async () => "native-model" },
      "../../../../shared/turnReceipt": { startTurnWithReceipt: submitted },
    });
    const task = { client: {}, snapshot: { threadId: "parent", model: "native-model", reasoningEffort: "high", messages: [{ id: "failed", turnId: "old-turn", attemptId: "old-attempt" }] },
      request: vi.fn(async () => ({ goal: {} })), patch: vi.fn(), continuationState: () => ({ allowed: true, unknown: false }),
      supportsCurrentConfigurationContinuation: () => true, attemptByTurn: new Map(), finishedAttempts: new Set() };
    await goal.setGoal.call(task, "native goal", "standard", { tokenBudget: 900, expectedGoal: { goalId: "goal", revision: 4 } });
    expect(task.request).toHaveBeenCalledWith("thread/goal/set", { threadId: "parent", objective: "native goal", mode: "standard", tokenBudget: 900, expectedGoalId: "goal", expectedRevision: 4, status: "active" });
    await turns.continueFailed.call(task, "failed", true);
    expect(submitted.mock.calls[0][1]).toMatchObject({ retryModelConfiguration: "current", model: "native-model", reasoningEffort: "high" });
  });
  it(`${platform} native compilation preserves restored effort and its owner callback positions`, async () => {
    const restore = vi.fn(async (_client: unknown, _thread: string, _model: string, effort: string | undefined) => effort);
    const api = nativeModule("factories.ts", platform, {
      "./modelCatalog": { restoreReasoningEffortForThread: restore },
    });
    const client = {};
    const task = { disposed: false, client, clientGeneration: 4, workspaceConfiguration: {},
      snapshot: { connected: true, threadId: "native-thread", model: "native-model", pendingTurnPreferences: null },
      patch: vi.fn() };
    const stale = vi.fn(() => false);
    await api.restoreWorkspaceConfiguration.call(task, "high", stale);
    expect(stale).toHaveBeenCalled();
    expect(restore).not.toHaveBeenCalled();
    expect(task.patch).not.toHaveBeenCalled();
    const current = vi.fn(() => true);
    await api.restoreWorkspaceConfiguration.call(task, "high", current);
    expect(restore).toHaveBeenCalledWith(client, "native-thread", "native-model", "high");
    expect(task.workspaceConfiguration).toMatchObject({ reasoningEffort: "high", isCurrent: current });
    expect(task.patch).toHaveBeenLastCalledWith({ reasoningEffort: "high", configurationReady: true });
    await api.restoreWorkspaceConfiguration.call(task, undefined);
    expect(restore).toHaveBeenLastCalledWith(client, "native-thread", "native-model", undefined);
  });
  it(`${platform} native compilation preserves accepted result, optimistic row and owner positions`, async () => {
    const api = nativeModule("turns.ts", platform);
    const client = {};
    const result = { turn: { id: "native-turn", status: "running" } };
    const task = { disposed: false, finishedAttempts: new Set(), uncertainSend: { clientMessageId: "native-cid" },
      snapshot: { messages: [{ id: "local-user-native", role: "user", content: "native prompt", clientMessageId: "native-cid" }] },
      patch: vi.fn() };
    const stale = vi.fn(() => false);
    await api.acceptOrdinaryResult.call(task, result, client, false, "local-user-native", stale);
    expect(stale).toHaveBeenCalled();
    expect(task.patch).not.toHaveBeenCalled();
    expect(task.uncertainSend).toEqual({ clientMessageId: "native-cid" });
    const current = vi.fn(() => true);
    await api.acceptOrdinaryResult.call(task, result, client, false, "local-user-native", current);
    expect(current).toHaveBeenCalled();
    expect(task.patch).toHaveBeenLastCalledWith(expect.objectContaining({ running: true, activeTurnId: "native-turn",
      messages: [expect.objectContaining({ id: "local-user-native", turnId: "native-turn", clientMessageId: "native-cid" })] }));
    task.patch.mockClear();
    await api.acceptOrdinaryResult.call(task, result, client, false, "local-user-native");
    expect(task.patch).toHaveBeenLastCalledWith(expect.objectContaining({
      messages: [expect.objectContaining({ id: "local-user-native", turnId: "native-turn" })] }));
  });
}

it("mobile this-typed functions avoid formal defaults that shift native argument indices", () => {
  const violations: string[] = [];
  const walk = (folder: string) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const file = join(folder, entry.name);
      if (entry.isDirectory()) { walk(file); continue; }
      if (!/\.tsx?$/.test(file)) continue;
      const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
      const visit = (node: import("typescript").Node) => {
        if (ts.isFunctionLike(node) && node.parameters[0]?.name.getText(source) === "this" && node.parameters.some(parameter => parameter.initializer))
          violations.push(file + ":" + node.name?.getText(source));
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  };
  walk(fileURLToPath(new URL("../", import.meta.url)));
  expect(violations).toEqual([]);
});
