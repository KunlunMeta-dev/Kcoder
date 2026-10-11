import { initLocale } from "@/i18n";
beforeEach(() => initLocale("zh-CN"));
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const backing = new Map<string, string>();
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getAllKeys: vi.fn(async () => [...backing.keys()]),
    multiGet: vi.fn(async (keys: string[]) =>
      keys.map((key) => [key, backing.get(key) ?? null]),
    ),
    getItem: vi.fn(async (key: string) => backing.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      backing.set(key, value);
    }),
    removeItem: vi.fn(async (key: string) => {
      backing.delete(key);
    }),
  },
}));
import {
  agentIntentKey,
  clearAgentIntent,
  readAgentIntent,
  saveAgentIntent,
} from "./mobileAgentIntent";
afterEach(() => backing.clear());
it("unknown command lookup survives UI recreation and contains no command body or secret", async () => {
  const scope = "profile/server/thread/agent/actual-journal";
  await saveAgentIntent(scope, {
    clientMessageId: "cmd:0:original",
    createdAt: 42,
    body: "private command",
  } as never);
  expect(await readAgentIntent(scope)).toEqual({
    clientMessageId: "cmd:0:original",
    createdAt: 42,
  });
  expect(backing.get(agentIntentKey(scope))).not.toContain("private command");
  expect(
    await readAgentIntent("different-account/server/thread/agent/journal"),
  ).toBeNull();
  await clearAgentIntent(scope);
  expect(await readAgentIntent(scope)).toBeNull();
});
it("corrupt or excessive lookup storage cannot become a replacement send instruction", async () => {
  backing.set(
    agentIntentKey("scope"),
    JSON.stringify({ clientMessageId: "another", createdAt: 1 }),
  );
  await expect(readAgentIntent("scope")).rejects.toThrow("无效");
  backing.set(agentIntentKey("scope"), "x".repeat(1025));
  await expect(readAgentIntent("scope")).rejects.toThrow("过大");
});

it("capacity refuses new unknown handles instead of discarding old identities", async () => {
  for (let index = 0; index < 128; index++)
    backing.set(
      agentIntentKey(`scope-${index}`),
      JSON.stringify({ clientMessageId: "cmd:0:kept", createdAt: 1 }),
    );
  await expect(
    saveAgentIntent("new-scope", {
      clientMessageId: "cmd:0:new",
      createdAt: 2,
    }),
  ).rejects.toThrow("已满");
  expect(backing.size).toBe(128);
  await expect(
    saveAgentIntent("scope-0", {
      clientMessageId: "cmd:0:replacement",
      createdAt: 3,
    }),
  ).rejects.toThrow("不能覆盖");
  expect(await readAgentIntent("scope-0")).toEqual({
    clientMessageId: "cmd:0:kept",
    createdAt: 1,
  });
});
