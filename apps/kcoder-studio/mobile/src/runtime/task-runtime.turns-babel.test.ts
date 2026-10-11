import { transformFromAstSync } from "@babel/core";
import generate from "@babel/generator";
import { parse } from "@babel/parser";
import { getDefaultConfig } from "expo/metro-config";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const projectRoot = path.resolve(path.dirname(import.meta.filename), "../..");
const turnsPath = path.join(
  projectRoot,
  "src/runtime/task-runtime/turns.ts",
);

function loadExpoTransformedFunction(
  functionName: string,
  bindings: Record<string, unknown> = {},
): (...args: unknown[]) => Promise<unknown> {
  const source = readFileSync(turnsPath, "utf8");
  const parsed = parse(source, {
    sourceType: "module",
    plugins: ["typescript"],
  });
  const exportedSend = parsed.program.body.find(
    (node) =>
      node.type === "ExportNamedDeclaration" &&
      node.declaration?.type === "FunctionDeclaration" &&
      node.declaration.id?.name === functionName,
  );
  if (
    !exportedSend ||
    exportedSend.type !== "ExportNamedDeclaration" ||
    exportedSend.declaration?.type !== "FunctionDeclaration"
  ) {
    throw new Error(`TaskRuntime turns.${functionName} declaration was not found`);
  }

  const metro = getDefaultConfig(projectRoot);
  const transformer = require(metro.transformer.babelTransformerPath) as {
    transform(input: {
      filename: string;
      src: string;
      options: Record<string, unknown>;
    }): { ast: Parameters<typeof transformFromAstSync>[0] };
  };
  const transformed = transformer.transform({
    filename: turnsPath,
    src: generate(exportedSend.declaration).code,
    options: {
      projectRoot,
      platform: "android",
      dev: false,
      type: "module",
      customTransformOptions: { engine: "hermes", routerRoot: "app" },
      enableBabelRCLookup: true,
      experimentalImportSupport: true,
    },
  });
  const commonJs = transformFromAstSync(transformed.ast, undefined, {
    configFile: false,
    babelrc: false,
    plugins: [require.resolve("@babel/plugin-transform-modules-commonjs")],
  });
  if (!commonJs?.code)
    throw new Error(`Expo Babel did not emit ${functionName} code`);

  const module = { exports: {} as Record<string, unknown> };
  vm.runInNewContext(
    `${commonJs.code}\nmodule.exports.target = ${functionName};`,
    {
      module,
      require,
      ...bindings,
    },
  );
  const target = module.exports.target;
  if (typeof target !== "function")
    throw new Error(`Expo Babel emitted no callable ${functionName} function`);
  return target as (...args: unknown[]) => Promise<unknown>;
}

async function captureStartParamsForCalls(calls: unknown[][]) {
  const requests: Record<string, unknown>[] = [];
  const send = loadExpoTransformedFunction("send", {
    negotiateModelSelector: async () => undefined,
  });
  const task = {
    client: { supportsExperimental: () => true },
    snapshot: {
      threadId: "thread-babel-contract",
      messages: [],
      model: undefined,
      running: false,
      continuationUnknown: null,
      sendAcceptanceUnknown: false,
    },
    pendingInteractions: [],
    patch(patch: Record<string, unknown>) {
      this.snapshot = { ...this.snapshot, ...patch };
    },
    async startOrdinaryTurn(params: Record<string, unknown>) {
      requests.push(params);
      this.snapshot = { ...this.snapshot, running: false };
    },
  };
  for (const args of calls) await send.apply(task, args);
  return requests;
}

async function captureStartParams(args: unknown[]) {
  const requests = await captureStartParamsForCalls([args]);
  expect(requests).toHaveLength(1);
  return requests[0];
}

describe("Expo Android Babel output for TaskRuntime.send", () => {
  it("keeps a stable composer retry id out of the execution-mode argument", async () => {
    const params = await captureStartParams([
      "retry the failed draft",
      [],
      undefined,
      { clientMessageId: "failed-card-id" },
    ]);

    expect(params.turnMode).toBeUndefined();
    expect(params.clientMessageId).toBe("failed-card-id");
  });

  it("preserves an explicit /moa mode and its separate stable message id", async () => {
    const params = await captureStartParams([
      "inspect the migration",
      [],
      "moa",
      { clientMessageId: "moa-message-id" },
    ]);

    expect(params.turnMode).toBe("moa");
    expect(params.clientMessageId).toBe("moa-message-id");
  });

  it("preserves the stable identity on the second composer send", async () => {
    const requests = await captureStartParamsForCalls([
      ["first user message", []],
      [
        "second user message",
        [],
        undefined,
        { clientMessageId: "second-message-id" },
      ],
    ]);

    expect(requests).toHaveLength(2);
    expect(requests[1].turnMode).toBeUndefined();
    expect(requests[1].clientMessageId).toBe("second-message-id");
  });
});

describe("Expo Android Babel output for other TaskRuntime turn methods", () => {
  it("keeps the selected-model continuation flag in its declared argument", async () => {
    const requests: Record<string, unknown>[] = [];
    const continueFailed = loadExpoTransformedFunction("continueFailed", {
      negotiateModelSelector: async () => ({
        provider: "provider-a",
        model: "model-a",
      }),
      startTurnWithReceipt: async (client: unknown, params: Record<string, unknown>) => {
        requests.push(params);
        return {
          client,
          result: {
            turn: { id: "continued-turn", attemptId: "continued-attempt", status: "running" },
          },
          recovered: false,
        };
      },
    });
    const task = {
      client: {},
      snapshot: {
        threadId: "thread-babel-contract",
        messages: [
          { id: "failed-message", turnId: "failed-turn", attemptId: "failed-attempt" },
        ],
        model: { provider: "provider-a", model: "model-a" },
        reasoningEffort: "high",
        running: false,
      },
      continuationState: () => ({ allowed: true, unknown: false }),
      supportsCurrentConfigurationContinuation: () => true,
      patch(patch: Record<string, unknown>) {
        this.snapshot = { ...this.snapshot, ...patch };
      },
      disposed: false,
      attemptByTurn: new Map<string, string>(),
      finishedAttempts: new Set<string>(),
      clientGeneration: 0,
    };

    await continueFailed.apply(task, ["failed-message", true]);

    expect(requests).toHaveLength(1);
    expect(requests[0].retryModelConfiguration).toBe("current");
    expect(requests[0].model).toEqual({
      provider: "provider-a",
      model: "model-a",
    });
    expect(requests[0].reasoningEffort).toBe("high");
  });

  it("preserves an explicit stable id for subagent steering", async () => {
    const requests: Record<string, unknown>[] = [];
    const steerSubagent = loadExpoTransformedFunction("steerSubagent", {
      TextEncoder,
    });
    const task = {
      client: { supportsExperimental: () => true },
      snapshot: { threadId: "thread-babel-contract", connected: true },
      async request(_method: string, params: Record<string, unknown>) {
        requests.push(params);
        return {
          agentId: params.agentId,
          status: "sent",
          messageId: "steer-message",
          clientMessageId: params.clientMessageId,
        };
      },
      updateSubagentSteer() {},
    };

    const result = await steerSubagent.apply(task, [
      "agent-a",
      "adjust course",
      "stable-steer-id",
    ]);

    expect(requests).toHaveLength(1);
    expect(requests[0].clientMessageId).toBe("stable-steer-id");
    expect(result).toMatchObject({ clientMessageId: "stable-steer-id" });
  });
});
