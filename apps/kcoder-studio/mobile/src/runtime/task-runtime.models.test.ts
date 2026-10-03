import { gatewaySessionExpired } from "@/gateway/http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  defaultModelOption,
  modelOptionSelector,
  selectedModelOption,
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
  gatewaySessionExpired: vi.fn(async () => false),
}));
beforeEach(() => {
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
      client.supportsExperimental = () => true;
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

  it("falls back from default model to current provider and then list order", () => {
    const first = option("first", {});
    const current = option("current", { providerCurrent: true });

    expect(defaultModelOption([first, current])).toBe(current);
    expect(defaultModelOption([first])).toBe(first);
  });
});
