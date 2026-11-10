import { beforeEach, describe, expect, it, vi } from "vitest";

const cacheApi = vi.hoisted(() => ({
  clearModelCache: vi.fn(),
  clearWorkspaceOptionsCache: vi.fn(),
}));

vi.mock("@/runtime/task-runtime/modelCatalog", () => ({
  clearModelCache: cacheApi.clearModelCache,
}));
vi.mock("@/runtime/task-runtime/workspaces", () => ({
  clearWorkspaceOptionsCache: cacheApi.clearWorkspaceOptionsCache,
}));

import {
  clearRebuildableCatalogCaches,
  readBrowserOriginStorageEstimate,
} from "@/storage/cache-management";

describe("Mobile storage and cache management", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns only the browser's reported origin usage and quota", async () => {
    const estimate = vi.fn(async () => ({ usage: 2_048, quota: 16_384 }));

    await expect(readBrowserOriginStorageEstimate({ estimate })).resolves.toEqual({
      status: "available",
      usageBytes: 2_048,
      quotaBytes: 16_384,
    });
    expect(estimate).toHaveBeenCalledTimes(1);
  });

  it("does not invent measurements when the API or returned values are unavailable", async () => {
    await expect(readBrowserOriginStorageEstimate(null)).resolves.toEqual({
      status: "unavailable",
      reason: "api-unsupported",
    });
    await expect(
      readBrowserOriginStorageEstimate({ estimate: async () => ({ usage: Number.NaN }) }),
    ).resolves.toEqual({
      status: "unavailable",
      reason: "no-measurement",
    });
  });

  it("reports estimate read failures without substituting a size", async () => {
    await expect(
      readBrowserOriginStorageEstimate({ estimate: async () => { throw new Error("fixture"); } }),
    ).resolves.toEqual({ status: "unavailable", reason: "read-failed" });
  });

  it("clears only the explicitly supplied active Gateway profile caches", () => {
    clearRebuildableCatalogCaches("active-gateway");

    expect(cacheApi.clearModelCache).toHaveBeenCalledExactlyOnceWith("active-gateway");
    expect(cacheApi.clearWorkspaceOptionsCache).toHaveBeenCalledExactlyOnceWith("active-gateway");
  });

  it("refuses an empty profile instead of falling back to clearing all profiles", () => {
    expect(() => clearRebuildableCatalogCaches("  ")).toThrow(/active Gateway profile/);
    expect(cacheApi.clearModelCache).not.toHaveBeenCalled();
    expect(cacheApi.clearWorkspaceOptionsCache).not.toHaveBeenCalled();
  });
});
