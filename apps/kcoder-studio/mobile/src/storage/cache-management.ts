import { clearModelCache } from "@/runtime/task-runtime/modelCatalog";
import { clearWorkspaceOptionsCache } from "@/runtime/task-runtime/workspaces";

export interface StorageEstimateSource {
  estimate(): Promise<{ usage?: number; quota?: number }>;
}

export type BrowserOriginStorageEstimate =
  | {
      status: "available";
      usageBytes?: number;
      quotaBytes?: number;
    }
  | {
      status: "unavailable";
      reason: "api-unsupported" | "no-measurement" | "read-failed";
    };

function browserStorageEstimateSource(): StorageEstimateSource | null {
  const navigatorValue = (globalThis as typeof globalThis & {
    navigator?: { storage?: StorageEstimateSource };
  }).navigator;
  return navigatorValue?.storage ?? null;
}

function measuredBytes(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

/** Reads only the browser's own origin-level usage estimate; it never scans app records. */
export async function readBrowserOriginStorageEstimate(
  source: StorageEstimateSource | null = browserStorageEstimateSource(),
): Promise<BrowserOriginStorageEstimate> {
  if (!source || typeof source.estimate !== "function") {
    return { status: "unavailable", reason: "api-unsupported" };
  }
  try {
    const estimate = await source.estimate();
    const usageBytes = measuredBytes(estimate.usage);
    const quotaBytes = measuredBytes(estimate.quota);
    if (usageBytes === undefined && quotaBytes === undefined) {
      return { status: "unavailable", reason: "no-measurement" };
    }
    return {
      status: "available",
      ...(usageBytes === undefined ? {} : { usageBytes }),
      ...(quotaBytes === undefined ? {} : { quotaBytes }),
    };
  } catch {
    return { status: "unavailable", reason: "read-failed" };
  }
}

/**
 * Clears only the active Gateway profile's rebuildable model/workspace catalog
 * read caches. A profile ID is mandatory so this API can never clear all Gateways.
 */
export function clearRebuildableCatalogCaches(profileId: string): void {
  if (!profileId.trim()) {
    throw new Error("An active Gateway profile is required to clear catalog caches");
  }
  clearModelCache(profileId);
  clearWorkspaceOptionsCache(profileId);
}
