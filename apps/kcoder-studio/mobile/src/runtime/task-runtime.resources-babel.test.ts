import { transformFromAstSync } from "@babel/core";
import generate from "@babel/generator";
import { parse } from "@babel/parser";
import { getDefaultConfig } from "expo/metro-config";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const projectRoot = path.resolve(path.dirname(import.meta.filename), "../..");
const resourcesPath = path.join(
  projectRoot,
  "src/runtime/task-runtime/resources.ts",
);

type RequestFunction = (
  this: {
    client: {
      request<T>(
        method: string,
        params: Record<string, unknown>,
        timeoutMs?: number,
      ): Promise<T>;
    } | null;
    snapshot: { connected: boolean };
  },
  method: string,
  params?: Record<string, unknown>,
  timeoutMs?: number,
) => Promise<unknown>;

function loadExpoTransformedRequest(): RequestFunction {
  const source = readFileSync(resourcesPath, "utf8");
  const parsed = parse(source, {
    sourceType: "module",
    plugins: ["typescript"],
  });
  const exportedRequest = parsed.program.body.find(
    (node) =>
      node.type === "ExportNamedDeclaration" &&
      node.declaration?.type === "FunctionDeclaration" &&
      node.declaration.id?.name === "request",
  );
  if (
    !exportedRequest ||
    exportedRequest.type !== "ExportNamedDeclaration" ||
    exportedRequest.declaration?.type !== "FunctionDeclaration"
  ) {
    throw new Error("TaskRuntime resources.request declaration was not found");
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
    filename: resourcesPath,
    src: generate(exportedRequest.declaration).code,
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
    throw new Error("Expo Babel did not emit resources.request code");

  const module = { exports: {} as Record<string, unknown> };
  vm.runInNewContext(`${commonJs.code}\nmodule.exports.request = request;`, {
    module,
    require,
  });
  const request = module.exports.request;
  if (typeof request !== "function")
    throw new Error("Expo Babel emitted no callable request function");
  return request as RequestFunction;
}

describe("Expo Android Babel output for TaskRuntime.resources.request", () => {
  it("forwards the params object from the ordinary two-argument call", async () => {
    const request = loadExpoTransformedRequest();
    const params = { threadId: "thread-babel-contract", limit: 17 };
    const calls: unknown[][] = [];
    const task = {
      client: {
        async request<T>(...args: unknown[]): Promise<T> {
          calls.push(args);
          return "ok" as T;
        },
      },
      snapshot: { connected: true },
    };

    await expect(
      request.call(task, "thread/read", params),
    ).resolves.toBe("ok");
    expect(calls).toEqual([["thread/read", params, undefined]]);
  });

  it("still supplies an empty params object when the caller omits it", async () => {
    const request = loadExpoTransformedRequest();
    const calls: unknown[][] = [];
    const task = {
      client: {
        async request<T>(...args: unknown[]): Promise<T> {
          calls.push(args);
          return "ok" as T;
        },
      },
      snapshot: { connected: true },
    };

    await expect(request.call(task, "thread/list")).resolves.toBe("ok");
    expect(calls).toEqual([["thread/list", {}, undefined]]);
  });

  it("preserves the explicit timeout after params", async () => {
    const request = loadExpoTransformedRequest();
    const params = { threadId: "thread-babel-contract", before: "item-5" };
    const calls: unknown[][] = [];
    const task = {
      client: {
        async request<T>(...args: unknown[]): Promise<T> {
          calls.push(args);
          return "ok" as T;
        },
      },
      snapshot: { connected: true },
    };

    await expect(
      request.call(task, "thread/compact", params, 60_000),
    ).resolves.toBe("ok");
    expect(calls).toEqual([["thread/compact", params, 60_000]]);
  });
});
