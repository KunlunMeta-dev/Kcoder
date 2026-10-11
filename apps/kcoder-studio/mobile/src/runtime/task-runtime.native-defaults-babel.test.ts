import { transformFromAstSync } from "@babel/core";
import generate from "@babel/generator";
import { parse } from "@babel/parser";
import { getDefaultConfig } from "expo/metro-config";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const projectRoot = path.resolve(path.dirname(import.meta.filename), "../..");
const taskRuntimeRoot = path.join(projectRoot, "src/runtime/task-runtime");

function loadExpoTransformedFunction(
  sourcePath: string,
  functionName: string,
  bindings: Record<string, unknown> = {},
): (...args: unknown[]) => unknown {
  const source = readFileSync(sourcePath, "utf8");
  const parsed = parse(source, {
    sourceType: "module",
    plugins: ["typescript"],
  });
  const exportedFunction = parsed.program.body.find(
    (node) =>
      node.type === "ExportNamedDeclaration" &&
      node.declaration?.type === "FunctionDeclaration" &&
      node.declaration.id?.name === functionName,
  );
  if (
    !exportedFunction ||
    exportedFunction.type !== "ExportNamedDeclaration" ||
    exportedFunction.declaration?.type !== "FunctionDeclaration"
  ) {
    throw new Error(`TaskRuntime ${functionName} declaration was not found`);
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
    filename: sourcePath,
    src: generate(exportedFunction.declaration).code,
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
    { module, require, ...bindings },
  );
  const target = module.exports.target;
  if (typeof target !== "function")
    throw new Error(`Expo Babel emitted no callable ${functionName} function`);
  return target as (...args: unknown[]) => unknown;
}

describe("Expo Android Babel default parameters with TypeScript this parameters", () => {
  it("honors false when rolling back an interaction response", () => {
    const interactionsPath = path.join(taskRuntimeRoot, "interactions.ts");
    const markResponding = loadExpoTransformedFunction(
      interactionsPath,
      "markInteractionResponding",
    );
    const task = {
      pendingInteractions: [
        { requestId: 71, kind: "approval", responding: false },
      ],
      snapshot: { interaction: null, interactionCount: 0 },
      patch(patch: Record<string, unknown>) {
        this.snapshot = { ...this.snapshot, ...patch };
      },
    };

    markResponding.apply(task, [71]);
    expect(task.pendingInteractions[0].responding).toBe(true);
    markResponding.apply(task, [71, false]);

    expect(task.pendingInteractions[0].responding).toBe(false);
    expect(task.snapshot.interaction).toMatchObject({
      requestId: 71,
      responding: false,
    });
  });

  it("preserves setGoal defaults, mode, budget, and options in the client request", async () => {
    const metadataPath = path.join(taskRuntimeRoot, "metadata.ts");
    const setGoal = loadExpoTransformedFunction(metadataPath, "setGoal");
    const requests: Array<{ method: string; params: Record<string, unknown> }> =
      [];
    const task = {
      client: {},
      snapshot: { threadId: "thread-babel-contract", running: false },
      async request(method: string, params: Record<string, unknown>) {
        requests.push({ method, params });
        return { goal: { goalId: "goal-babel-contract" } };
      },
    };
    const options = {
      tokenBudget: 0,
      verificationKind: "artifact",
      expectedGoal: { goalId: "goal-existing", revision: 4 },
      requireNoGoal: true,
    };

    await setGoal.apply(task, ["  default goal  "]);
    await setGoal.apply(task, ["  prepare the release  ", "strict", options]);

    expect(requests).toHaveLength(2);
    expect(requests[0].method).toBe("thread/goal/set");
    expect(requests[0].params).toMatchObject({
      objective: "default goal",
      mode: "standard",
      status: "active",
    });
    expect(requests[0].params).not.toHaveProperty("tokenBudget");
    expect(requests[1].method).toBe("thread/goal/set");
    expect(requests[1].params).toMatchObject({
      threadId: "thread-babel-contract",
      objective: "prepare the release",
      mode: "strict",
      tokenBudget: 0,
      verificationKind: "artifact",
      expectedGoalId: "goal-existing",
      expectedRevision: 4,
      requireNoGoal: true,
      status: "active",
    });
  });
});
