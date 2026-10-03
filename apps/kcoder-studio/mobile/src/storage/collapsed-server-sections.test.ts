import { beforeEach, describe, expect, it, vi } from "vitest";

const asyncStorage = vi.hoisted(() => ({
  getItem: vi.fn(),
  setItem: vi.fn(),
}));

vi.mock("@react-native-async-storage/async-storage", () => ({ default: asyncStorage }));

import {
  collapsedServerSectionsTestHelpers,
  collapsedServerSectionsKey,
  getCollapsedServerSectionsSnapshot,
  hydrateCollapsedServerSections,
  loadCollapsedServerIds,
  normalizeCollapsedServerIds,
  saveCollapsedServerIds,
  subscribeCollapsedServerSections,
  toggleCollapsedServerId,
  toggleProfileServerCollapsed,
} from "./collapsed-server-sections";

describe("collapsed server sections", () => {
  beforeEach(() => {
    asyncStorage.getItem.mockReset();
    asyncStorage.setItem.mockReset();
    collapsedServerSectionsTestHelpers.reset();
  });

  it("规范化已折叠的 server id", () => {
    expect(normalizeCollapsedServerIds(["local", "ssh/a", "local", 42, ""])).toEqual([
      "local",
      "ssh/a",
    ]);
    expect(normalizeCollapsedServerIds({ local: true })).toEqual([]);
  });

  it("隔离不同 profile 的折叠状态", () => {
    expect(collapsedServerSectionsKey("host:4174/a")).toBe(
      "kcoder-studio:mobile-collapsed-server-sections:v1:host%3A4174%2Fa",
    );
  });

  it("切换单个 server 时不改变其他折叠项", () => {
    expect(toggleCollapsedServerId(new Set(["a"]), "b")).toEqual(new Set(["a", "b"]));
    expect(toggleCollapsedServerId(new Set(["a", "b"]), "a")).toEqual(new Set(["b"]));
  });

  it("按调用顺序串行保存同一 profile 的状态", async () => {
    let finishFirstWrite = () => {};
    asyncStorage.setItem
      .mockImplementationOnce(() => new Promise<void>((resolve) => { finishFirstWrite = resolve; }))
      .mockResolvedValueOnce(undefined);

    const first = saveCollapsedServerIds("profile", new Set(["a"]));
    const second = saveCollapsedServerIds("profile", new Set(["a", "b"]));
    await vi.waitFor(() => expect(asyncStorage.setItem).toHaveBeenCalledTimes(1));
    finishFirstWrite();
    await Promise.all([first, second]);
    expect(asyncStorage.setItem.mock.calls.map((call) => call[1])).toEqual([
      '["a"]',
      '["a","b"]',
    ]);
  });

  it("多个页面订阅同一个 profile 快照", async () => {
    asyncStorage.getItem.mockResolvedValueOnce('["a"]');
    asyncStorage.setItem.mockResolvedValue(undefined);
    const listener = vi.fn();
    const unsubscribe = subscribeCollapsedServerSections("profile", listener);

    await hydrateCollapsedServerSections("profile");
    expect(getCollapsedServerSectionsSnapshot("profile")).toMatchObject({ hydrated: true });
    expect([...getCollapsedServerSectionsSnapshot("profile").serverIds]).toEqual(["a"]);

    toggleProfileServerCollapsed("profile", "b");
    expect([...getCollapsedServerSectionsSnapshot("profile").serverIds]).toEqual(["a", "b"]);
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it("读取同一 profile 前等待未完成写入", async () => {
    let finishWrite = () => {};
    asyncStorage.setItem.mockImplementationOnce(() => new Promise<void>((resolve) => { finishWrite = resolve; }));
    asyncStorage.getItem.mockResolvedValueOnce('["a"]');

    const write = saveCollapsedServerIds("profile", new Set(["a"]));
    const load = loadCollapsedServerIds("profile");
    await vi.waitFor(() => expect(asyncStorage.setItem).toHaveBeenCalledTimes(1));
    expect(asyncStorage.getItem).not.toHaveBeenCalled();
    finishWrite();
    await write;
    expect([...(await load)]).toEqual(["a"]);
  });
});
