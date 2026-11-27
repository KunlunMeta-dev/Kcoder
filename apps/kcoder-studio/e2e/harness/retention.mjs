import { lstat, readdir, readFile, rm } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { runVariantId } from "./run-variant.mjs";
import { canonicalTestSource } from "./suite-sources.mjs";

export const DEFAULT_RETENTION = Object.freeze({
  maxRunsPerVariant: 1,
});

export async function enforceRetention(boundary, policy = DEFAULT_RETENTION) {
  const root = resolve(boundary);
  const runs = await discoverCompletedRuns(root);
  const removalPlan = planRetention(runs, policy);
  const removed = [];
  for (const run of removalPlan) {
    assertWithinBoundary(root, run.path);
    try {
      await rm(run.path, { recursive: true });
      removed.push(run.path);
    } catch (error) {
      // A sibling account or concurrent cleanup must not block an owned run.
      if (["EACCES", "EPERM", "ENOENT"].includes(error?.code)) continue;
      throw error;
    }
  }
  return removed;
}

export function planRetention(runs, policy = DEFAULT_RETENTION) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) throw new TypeError('Invalid retention policy');
  policy = { ...DEFAULT_RETENTION, ...policy };
  for (const [key, value] of Object.entries(policy)) {
    if (!Object.hasOwn(DEFAULT_RETENTION, key) || !Number.isSafeInteger(value) || value < 0) {
      throw new TypeError('Invalid retention policy');
    }
  }
  const remove = new Set();
  const groups = new Map();
  for (const run of runs) {
    const key = JSON.stringify([canonicalTestSource(run.source), runVariantId(run.variantId)]);
    const group = groups.get(key) || [];
    group.push(run);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    const ordered = [...group].sort(newestFirst);
    for (const run of ordered.slice(policy.maxRunsPerVariant)) remove.add(run.path);
  }
  return runs.filter(run => remove.has(run.path));
}

async function discoverCompletedRuns(boundary) {
  const runs = [];
  try {
    await discoverRunsInDirectory(boundary, boundary, runs);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  return runs;
}

async function discoverRunsInDirectory(directory, boundary, runs) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    // A sibling run can disappear or be private to a different test account.
    // Keep that subtree opaque without preventing an owned test from starting.
    if (directory !== boundary && ["ENOENT", "EACCES", "EPERM"].includes(error?.code)) return;
    throw error;
  }
  const manifestEntry = entries.find(entry => entry.name === "manifest.json");
  if (manifestEntry) {
    if (!manifestEntry.isFile()) return;
    try {
      // Readable evidence from another POSIX account is not ours to delete.
      if (process.getuid && (await lstat(directory)).uid !== process.getuid()) return;
      const manifest = JSON.parse(await readFile(resolve(directory, manifestEntry.name), "utf8"));
      if (!['passed', 'failed'].includes(manifest.status) || typeof manifest.source !== "string" || !manifest.source) return;
      if (manifest.cleanupSteps?.some(step => step.status === "failed") ||
          manifest.scratchDirectories?.some(item => item.requireCleanupConfirmation && !item.cleanupConfirmed)) return;
      assertWithinBoundary(boundary, directory);
      const endedAtMs = Date.parse(manifest.endedAt || manifest.startedAt);
      if (!Number.isFinite(endedAtMs)) return;
      const variantId = runVariantId(manifest.variantId);
      const result = JSON.parse(await readFile(resolve(directory, "artifacts/result.json"), "utf8"));
      if (result.status !== manifest.status) return;
      runs.push({
        path: directory,
        source: manifest.source,
        variantId,
        status: manifest.status,
        endedAtMs,
      });
    } catch {
      // A partial/malformed run is retained for diagnosis; retention never guesses ownership.
    }
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    await discoverRunsInDirectory(resolve(directory, entry.name), boundary, runs);
  }
}

function assertWithinBoundary(boundary, path) {
  const root = resolve(boundary);
  const target = resolve(path);
  if (target === root || !target.startsWith(root + sep)) {
    throw new Error(`retention target escaped KCoder Studio E2E boundary: ${target}`);
  }
}

function newestFirst(left, right) {
  return right.endedAtMs - left.endedAtMs || right.path.localeCompare(left.path);
}
