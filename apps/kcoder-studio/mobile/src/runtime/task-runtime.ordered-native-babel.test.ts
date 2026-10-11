import { transformFromAstSync } from "@babel/core";
import generate from "@babel/generator";
import { parse } from "@babel/parser";
import { getDefaultConfig } from "expo/metro-config";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import {
  canAcceptToolCallUpdate,
  decodeToolCallStatus,
} from "../../../shared/toolCallStatus";

const projectRoot = path.resolve(path.dirname(import.meta.filename), "../..");
const taskRuntimeRoot = path.join(projectRoot, "src/runtime/task-runtime");
const snapshotReducerPath = path.join(taskRuntimeRoot, "snapshotReducer.ts");
const orderedSegmentsPath = path.join(
  projectRoot,
  "src/features/task/OrderedMessageSegments.tsx",
);
const snapshotReducerSource = readFileSync(snapshotReducerPath, "utf8");
const orderedSegmentsSource = readFileSync(orderedSegmentsPath, "utf8");

type ProbeFunction = (...args: unknown[]) => void;
type TaskProbe = {
  transcriptArrivalOrdinal: number;
  pendingAssistantDeltas: Map<string, string[]>;
  pendingOrderedAssistantDeltas: Map<string, Array<Record<string, unknown>>>;
  pendingThinkingDeltas: Map<string, Array<Record<string, unknown>>>;
  attemptByTurn: Map<string, string>;
  snapshot: { messages: Array<Record<string, unknown>> };
  scheduleDeltaFlush(): void;
  ensureAssistantMessage(
    messages: Array<Record<string, unknown>>,
    turnId: string,
  ): number;
  patch(patch: Record<string, unknown>): void;
};

function loadExpoTransformedReducerFunction(
  functionName: string,
  bindings: Record<string, unknown> = {},
  privateDependencies: string[] = [],
): ProbeFunction {
  const parsed = parse(snapshotReducerSource, {
    sourceType: "module",
    plugins: ["typescript"],
  });
  const names = new Set([functionName, ...privateDependencies]);
  const declarations = new Map(
    parsed.program.body.flatMap((node) => {
      if (
        node.type === "ExportNamedDeclaration" &&
        node.declaration?.type === "FunctionDeclaration" &&
        node.declaration.id
      )
        return [[node.declaration.id.name, node.declaration] as const];
      if (node.type === "FunctionDeclaration" && node.id)
        return [[node.id.name, node] as const];
      return [];
    }),
  );
  const source = [...names]
    .map((name) => {
      const declaration = declarations.get(name);
      if (!declaration)
        throw new Error(`TaskRuntime ${name} declaration was not found`);
      return generate(declaration).code;
    })
    .join("\n");

  const metro = getDefaultConfig(projectRoot);
  const transformer = require(metro.transformer.babelTransformerPath) as {
    transform(input: {
      filename: string;
      src: string;
      options: Record<string, unknown>;
    }): { ast: Parameters<typeof transformFromAstSync>[0] };
  };
  const transformed = transformer.transform({
    filename: snapshotReducerPath,
    src: source,
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
    { module, exports: module.exports, require, ...bindings },
  );
  const target = module.exports.target;
  if (typeof target !== "function")
    throw new Error(`Expo Babel emitted no callable ${functionName} function`);
  return target as ProbeFunction;
}

function makeTaskProbe() {
  let task!: TaskProbe;
  task = {
    transcriptArrivalOrdinal: 41,
    pendingAssistantDeltas: new Map<string, string[]>(),
    pendingOrderedAssistantDeltas: new Map<
      string,
      Array<Record<string, unknown>>
    >(),
    pendingThinkingDeltas: new Map<string, Array<Record<string, unknown>>>(),
    attemptByTurn: new Map<string, string>([
      ["turn-native-babel", "attempt-1"],
    ]),
    snapshot: { messages: [] as Array<Record<string, unknown>> },
    scheduleDeltaFlush() {},
    ensureAssistantMessage(
      messages: Array<Record<string, unknown>>,
      turnId: string,
    ) {
      const found = messages.findIndex(
        (message) => message.role === "assistant" && message.turnId === turnId,
      );
      if (found >= 0) return found;
      messages.push({
        role: "assistant",
        turnId,
        tools: [],
        orderedBlocks: [],
      });
      return messages.length - 1;
    },
    patch(patch: Record<string, unknown>) {
      task.snapshot = { ...task.snapshot, ...patch };
    },
  };
  return task;
}

function reducerBindings() {
  return {
    canAcceptToolCallUpdate,
    decodeToolCallStatus,
    text(value: unknown): string | undefined {
      return typeof value === "string" && value.length > 0 ? value : undefined;
    },
    earlierSequence(left: number | undefined, right: number | undefined) {
      return left === undefined
        ? right
        : right === undefined
          ? left
          : Math.min(left, right);
    },
    upsertOrderedBlock(
      blocks: Array<Record<string, unknown>>,
      candidate: Record<string, unknown>,
    ) {
      // Capture the production reducer's candidate at this dependency boundary;
      // ordering/merge behavior is covered by its own runtime tests.
      blocks.push(candidate);
    },
    resegmentLiveTextBlocks() {},
    appendTextDelta(
      blocks: Array<Record<string, unknown>>,
      id: string,
      content: string,
      sequence: number | undefined,
      arrivalOrdinal: number,
    ) {
      // Capture arguments supplied by the production helper after Metro Babel.
      blocks.push({
        kind: "text",
        id,
        producerId: id,
        content,
        sequence,
        arrivalOrdinal,
      });
    },
  };
}

const explicitInputs = {
  turnId: "turn-native-babel",
  sequence: 0,
  arrivalOrdinal: 0,
  assistantItem: {
    type: "agentMessage",
    id: "assistant-item-native-babel",
    content: "completed-only text",
  },
  toolItem: {
    id: "tool-native-babel",
    name: "Read",
    input: { path: "README.md" },
  },
};

describe("Expo Android Babel for ordered TaskRuntime helpers", () => {
  it("preserves explicit zero sequence/ordinal and the completed flag", () => {
    const bindings = reducerBindings();
    const appendAssistantDelta = loadExpoTransformedReducerFunction(
      "appendAssistantDelta",
      bindings,
    );
    const appendThinkingDelta = loadExpoTransformedReducerFunction(
      "appendThinkingDelta",
      bindings,
    );
    const updateTool = loadExpoTransformedReducerFunction(
      "updateTool",
      bindings,
      ["textSegmentSpansOrder", "isBlockBetweenChunks"],
    );
    const updateAssistantItem = loadExpoTransformedReducerFunction(
      "updateAssistantItem",
      bindings,
    );

    const assistantTask = makeTaskProbe();
    appendAssistantDelta.apply(assistantTask, [
      explicitInputs.turnId,
      "assistant delta",
      "assistant-item-native-babel",
      explicitInputs.sequence,
      explicitInputs.arrivalOrdinal,
    ]);
    expect(
      assistantTask.pendingOrderedAssistantDeltas.get(explicitInputs.turnId),
    ).toMatchObject([
      {
        delta: "assistant delta",
        itemId: "assistant-item-native-babel",
        sequence: 0,
        arrivalOrdinal: 0,
      },
    ]);
    expect(assistantTask.transcriptArrivalOrdinal).toBe(41);

    const thinkingTask = makeTaskProbe();
    appendThinkingDelta.apply(thinkingTask, [
      explicitInputs.turnId,
      "thinking delta",
      explicitInputs.sequence,
      explicitInputs.arrivalOrdinal,
    ]);
    expect(
      thinkingTask.pendingThinkingDeltas.get(explicitInputs.turnId),
    ).toMatchObject([
      { delta: "thinking delta", sequence: 0, arrivalOrdinal: 0 },
    ]);
    expect(thinkingTask.transcriptArrivalOrdinal).toBe(41);

    const toolTask = makeTaskProbe();
    updateTool.apply(toolTask, [
      explicitInputs.turnId,
      explicitInputs.toolItem,
      true,
      explicitInputs.sequence,
      explicitInputs.arrivalOrdinal,
    ]);
    const toolMessage = toolTask.snapshot.messages[0];
    expect(toolMessage.orderedBlocks).toMatchObject([
      {
        kind: "tool",
        id: "tool-native-babel",
        status: "completed",
        sequence: 0,
        arrivalOrdinal: 0,
      },
    ]);
    expect(toolTask.transcriptArrivalOrdinal).toBe(41);

    const assistantItemTask = makeTaskProbe();
    updateAssistantItem.apply(assistantItemTask, [
      explicitInputs.turnId,
      explicitInputs.assistantItem,
      explicitInputs.sequence,
      true,
      explicitInputs.arrivalOrdinal,
    ]);
    const assistantMessage = assistantItemTask.snapshot.messages[0];
    expect(assistantMessage.orderedBlocks).toMatchObject([
      {
        kind: "text",
        id: "assistant-item-native-babel",
        content: "completed-only text",
        sequence: 0,
        arrivalOrdinal: 0,
      },
    ]);
    expect(assistantItemTask.transcriptArrivalOrdinal).toBe(41);
  }, 20_000);

  it("uses the runtime ordinal fallback when callers omit it", () => {
    const bindings = reducerBindings();
    const calls: Array<[string, unknown[]]> = [
      [
        "appendAssistantDelta",
        [
          explicitInputs.turnId,
          "assistant fallback",
          "assistant-item-fallback",
          0,
        ],
      ],
      ["appendThinkingDelta", [explicitInputs.turnId, "thinking fallback", 0]],
      ["updateTool", [explicitInputs.turnId, explicitInputs.toolItem, true, 0]],
      [
        "updateAssistantItem",
        [explicitInputs.turnId, explicitInputs.assistantItem, 0, true],
      ],
    ];

    for (const [functionName, args] of calls) {
      const target = loadExpoTransformedReducerFunction(
        functionName,
        bindings,
        functionName === "updateTool"
          ? ["textSegmentSpansOrder", "isBlockBetweenChunks"]
          : [],
      );
      const task = makeTaskProbe();
      target.apply(task, args);
      expect(task.transcriptArrivalOrdinal).toBe(42);
      if (functionName === "appendAssistantDelta") {
        expect(
          task.pendingOrderedAssistantDeltas.get(explicitInputs.turnId)?.[0]
            ?.arrivalOrdinal,
        ).toBe(41);
      } else if (functionName === "appendThinkingDelta") {
        expect(
          task.pendingThinkingDeltas.get(explicitInputs.turnId)?.[0]
            ?.arrivalOrdinal,
        ).toBe(41);
      } else {
        expect(task.snapshot.messages[0]?.orderedBlocks).toMatchObject([
          { arrivalOrdinal: 41, sequence: 0 },
        ]);
      }
    }
  });

  it("transforms the ordered transcript UI module through Expo Android Metro", () => {
    const metro = getDefaultConfig(projectRoot);
    const transformer = require(metro.transformer.babelTransformerPath) as {
      transform(input: {
        filename: string;
        src: string;
        options: Record<string, unknown>;
      }): { ast: Parameters<typeof transformFromAstSync>[0] };
    };
    const result = transformer.transform({
      filename: orderedSegmentsPath,
      src: orderedSegmentsSource,
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

    expect(result.ast).toBeDefined();
    expect(generate(result.ast).code).toContain("assistant-ordered-segments");
  });
});
