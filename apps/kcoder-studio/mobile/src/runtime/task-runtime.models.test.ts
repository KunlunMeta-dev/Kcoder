import { gatewaySessionExpired } from "@/gateway/http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installBrowserProfileFixture } from "@/test/browser-profile-fixture";
import {
  defaultModelOption,
  modelOptionSelector,
  selectedModelOption,
  listModels,
  TaskRuntime,
  taskRuntimeTestHelpers,
  threadModelSelector,
} from "./task-runtime";
import {
  FakeClient,
  profile,
  server,
} from "./task-runtime/fixture.test-support";
vi.mock("@/gateway/http", () => ({
  ensureGatewayAuthorization: vi.fn(async () => {}),
  gatewaySessionExpired: vi.fn(async () => false),
}));
beforeEach(() => {
  installBrowserProfileFixture([profile]);
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  vi.mocked(gatewaySessionExpired).mockResolvedValue(false);
});
afterEach(() => {
  vi.restoreAllMocks();
  taskRuntimeTestHelpers.resetConnector();
  vi.useRealTimers();
});
describe("defaultModelOption", () => {
  const option = (
    model: string,
    flags: { providerCurrent?: boolean; isDefault?: boolean },
  ) => ({
    id: model,
    model,
    displayName: model,
    providerId: model,
    providerName: model,
    ...flags,
  });
  it.each([false, true])(
    "negotiates old mobile targets without guessing multi-model defaults (%s)",
    async (ambiguous) => {
      const client = new FakeClient([]);
      client.request = vi.fn(async (method: string) => {
        if (method === "runtime.models.list")
          return {
            data: [
              { providerId: "first", model: "same" },
              { providerId: "second", model: "same" },
              ...(ambiguous ? [{ providerId: "second", model: "other" }] : []),
            ],
          } as never;
        if (method === "thread/start")
          return { thread: { id: "legacy-thread", model: "same" } } as never;
        if (method === "turn/start")
          return { turn: { id: "legacy-turn" } } as never;
        return {} as never;
      });
      taskRuntimeTestHelpers.setConnector(
        vi.fn(async () => client as never) as never,
      );
      const creation = TaskRuntime.create({
        profile,
        server,
        cwd: "/workspace",
        prompt: "hello",
        model: "second::same",
      });
      if (ambiguous) {
        await expect(creation).rejects.toThrow("升级");
        expect(client.request).not.toHaveBeenCalledWith(
          "thread/start",
          expect.anything(),
        );
      } else {
        const runtime = await creation;
        expect(client.request).toHaveBeenCalledWith(
          "thread/start",
          expect.objectContaining({ model: "second" }),
        );
        expect(client.request).toHaveBeenCalledWith(
          "turn/start",
          expect.objectContaining({ model: "second" }),
        );
        runtime.close();
      }
    },
  );

  it.each(["first::same", "first::other", "second::same"])(
    "sends the complete mobile model selector %s on thread and turn creation",
    async (selector) => {
      const client = new FakeClient([]);
      client.supportsExperimental = (capability) => capability === "qualifiedModelSelectionV1";
      client.request = vi.fn(async (method: string) => {
        if (method === "thread/start")
          return {
            thread: { id: "qualified-thread", model: selector },
          } as never;
        if (method === "turn/start")
          return { turn: { id: "qualified-turn" } } as never;
        return {} as never;
      });
      taskRuntimeTestHelpers.setConnector(
        vi.fn(async () => client as never) as never,
      );
      const runtime = await TaskRuntime.create({
        profile,
        server,
        cwd: "/workspace",
        prompt: "hello",
        model: selector,
      });
      expect(client.request).toHaveBeenCalledWith(
        "thread/start",
        expect.objectContaining({ model: selector }),
      );
      expect(client.request).toHaveBeenCalledWith(
        "turn/start",
        expect.objectContaining({ model: selector }),
      );
      expect(runtime.getSnapshot().model).toBe(selector);
      runtime.close();
    },
  );

  it("keeps same-name models on different providers distinct and accepts legacy bare selections", () => {
    const models = ["first", "second"].map((provider) => ({
      id: `${provider}::same`,
      model: "same",
      displayName: "same",
      providerId: provider,
      providerName: provider,
    }));
    expect(models.map(modelOptionSelector)).toEqual([
      "first::same",
      "second::same",
    ]);
    expect(selectedModelOption(models, "second::same")).toBe(models[1]);
    expect(selectedModelOption(models, "same")).toBe(models[0]);
    expect(
      threadModelSelector({ model: "same", modelProvider: "second" }),
    ).toBe("second::same");
    expect(
      threadModelSelector({ model: "second::same", modelProvider: "second" }),
    ).toBe("second::same");
    expect(threadModelSelector({ model: "same" })).toBe("same");
  });

  it("prefers the default model in the current provider", () => {
    const first = option("first", {});
    const defaultElsewhere = option("default-elsewhere", { isDefault: true });
    const currentDefault = option("current-default", {
      providerCurrent: true,
      isDefault: true,
    });

    expect(defaultModelOption([first, defaultElsewhere, currentDefault])).toBe(
      currentDefault,
    );
  });

  it("leaves selection unset when the catalog does not identify its default", () => {
    const first = option("first", {});
    const current = option("current", { providerCurrent: true });
    const anotherCurrent = option("another-current", { providerCurrent: true });

    expect(defaultModelOption([first, current])).toBeUndefined();
    expect(defaultModelOption([first, current, anotherCurrent])).toBeUndefined();
    expect(defaultModelOption([first])).toBeUndefined();
    expect(defaultModelOption([first, option("second", {})])).toBeUndefined();
  });

  it("does not send provider-current rows without a default flag as an explicit thread model", async () => {
    const selection = defaultModelOption([
      option("first-current", { providerCurrent: true }),
      option("second-current", { providerCurrent: true }),
    ]);
    const client = new FakeClient([]);
    client.supportsExperimental = (capability) => capability === "qualifiedModelSelectionV1";
    const request = vi.fn(async (method: string, _params: Record<string, unknown> = {}) => {
      if (method === "thread/start")
        return {
          thread: { id: "server-default-thread", model: "server-default::model" },
        } as never;
      if (method === "turn/start") return { turn: { id: "server-default-turn" } } as never;
      return {} as never;
    });
    client.request = request as never;
    taskRuntimeTestHelpers.setConnector(
      vi.fn(async () => client as never) as never,
    );

    const runtime = await TaskRuntime.create({
      profile,
      server,
      cwd: "/workspace",
      prompt: "hello",
      model: selection ? modelOptionSelector(selection) : undefined,
    });

    const start = request.mock.calls.find(([method]) => method === "thread/start");
    expect(start?.[1]).not.toHaveProperty("model");
    expect(request).toHaveBeenCalledWith(
      "turn/start",
      expect.objectContaining({ model: "server-default::model" }),
    );
    runtime.close();
  });
});

describe("listModels reasoning controls", () => {
  const catalogModel = (
    id: string,
    reasoningPolicy?: { mode: string; efforts: string[] },
  ) => ({
    id: `provider::${id}`,
    model: id,
    displayName: id,
    providerId: "provider",
    providerName: "Provider",
    defaultReasoningEffort:
      reasoningPolicy?.mode === "always_off"
        ? "none"
        : reasoningPolicy?.mode === "always_on"
          ? "high"
          : "medium",
    supportedReasoningEfforts: [
      reasoningPolicy?.mode === "always_off"
        ? "none"
        : reasoningPolicy?.mode === "always_on"
          ? "high"
          : "medium",
    ],
    configuration: {
      providerId: "provider",
      modelId: id,
      apiFormat: "openai_compatible",
      chatProtocol: "auto",
      contextWindowTokens: null,
      maxOutputTokens: null,
      requestOutputLimits: {},
      outputHeadroomTokens: null,
      text: true,
      tools: true,
      vision: false,
      reasoning: true,
      structuredOutput: false,
      reasoningEffort:
        reasoningPolicy?.mode === "always_off"
          ? "none"
          : reasoningPolicy?.mode === "always_on"
            ? "high"
            : "medium",
      ...(reasoningPolicy ? { reasoningPolicy } : {}),
      extraBodyConfigured: false,
      requestOverrideFields: [],
      revision: "e".repeat(64),
      boundary: "next_turn",
      sources: {},
    },
  });

  it("uses optional policy efforts, hides fixed controls, and preserves legacy catalogs", async () => {
    const client = new FakeClient([]);
    client.request = vi.fn(async () => ({
      data: [
        catalogModel("optional", {
          mode: "optional",
          efforts: [
            "none",
            "low",
            "medium",
            "high",
            "vendor_effort",
            "vendor_effort",
          ],
        }),
        catalogModel("hidden", { mode: "hidden", efforts: [] }),
        catalogModel("always-on", { mode: "always_on", efforts: ["high"] }),
        catalogModel("always-off", { mode: "always_off", efforts: ["none"] }),
        catalogModel("legacy"),
        catalogModel("invalid-policy", {
          mode: "future_mode",
          efforts: [],
        }),
      ],
    })) as never;
    taskRuntimeTestHelpers.setConnector(
      vi.fn(async () => client as never) as never,
    );

    const models = await listModels(profile, server);
    const byModel = new Map(models.map((model) => [model.model, model]));

    expect(byModel.get("optional")?.supportedReasoningEfforts).toEqual([
      "none",
      "low",
      "medium",
      "high",
      "vendor_effort",
    ]);
    expect(byModel.get("optional")?.defaultReasoningEffort).toBe("medium");
    expect(byModel.get("hidden")?.supportedReasoningEfforts).toEqual([]);
    expect(byModel.get("always-on")?.supportedReasoningEfforts).toEqual([]);
    expect(byModel.get("always-off")?.supportedReasoningEfforts).toEqual([]);
    expect(byModel.get("always-on")?.defaultReasoningEffort).toBe("high");
    expect(byModel.get("always-off")?.defaultReasoningEffort).toBe("none");
    expect(byModel.get("legacy")?.supportedReasoningEfforts).toEqual([
      "medium",
    ]);
    expect(byModel.get("invalid-policy")?.supportedReasoningEfforts).toEqual([
      "medium",
    ]);
  });
});
