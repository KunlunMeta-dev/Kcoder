import { lstat, readdir, readFile, rm, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";

export const DEFAULT_RETENTION = Object.freeze({
  successfulMaxCount: 5,
  successfulMaxAgeMs: 3 * 24 * 60 * 60 * 1000,
  failedMaxCount: 20,
  failedMaxAgeMs: 14 * 24 * 60 * 60 * 1000,
  totalMaxBytes: 2 * 1024 * 1024 * 1024,
});

const FILE_STAT_CONCURRENCY = 8;

export async function enforceRetention(boundary, policy = DEFAULT_RETENTION, now = Date.now()) {
  const root = resolve(boundary);
  const runs = await discoverCompletedRuns(root);
  const removalPlan = planRetention(runs, now, policy);
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

export function planRetention(runs, now = Date.now(), policy = DEFAULT_RETENTION) {
  const remove = new Set();
  const groups = new Map();
  for (const run of runs) {
    const key = `${run.source}\0${run.status}`;
    const group = groups.get(key) || [];
    group.push(run);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    const ordered = [...group].sort(newestFirst);
    const failed = ordered[0]?.status === "failed";
    const maxCount = failed ? policy.failedMaxCount : policy.successfulMaxCount;
    const maxAgeMs = failed ? policy.failedMaxAgeMs : policy.successfulMaxAgeMs;
    ordered.forEach((run, index) => {
      if (index >= maxCount || now - run.endedAtMs > maxAgeMs) remove.add(run.path);
    });
  }
  const retained = runs.filter(run => !remove.has(run.path));
  let retainedBytes = retained.reduce((sum, run) => sum + run.sizeBytes, 0);
  for (const run of [...retained].sort(oldestLowValueFirst)) {
    if (retainedBytes <= policy.totalMaxBytes) break;
    remove.add(run.path);
    retainedBytes -= run.sizeBytes;
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
      if (!['passed', 'failed'].includes(manifest.status) || !manifest.source) return;
      if (manifest.cleanupSteps?.some(step => step.status === "failed") ||
          manifest.scratchDirectories?.some(item => item.requireCleanupConfirmation && !item.cleanupConfirmed)) return;
      assertWithinBoundary(boundary, directory);
      runs.push({
        path: directory,
        source: manifest.source,
        status: manifest.status,
        endedAtMs: Date.parse(manifest.endedAt || manifest.startedAt),
        sizeBytes: await directorySize(directory),
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

async function directorySize(root) {
  let total = 0;
  const files = await filesUnder(root);
  let nextFile = 0;
  const workerCount = Math.min(FILE_STAT_CONCURRENCY, files.length);
  const subtotals = await Promise.all(Array.from({ length: workerCount }, async () => {
    let subtotal = 0;
    while (true) {
      const index = nextFile;
      nextFile += 1;
      if (index >= files.length) break;
      const fileStat = await stat(files[index]);
      subtotal += fileStat.size;
    }
    return subtotal;
  }));
  for (const subtotal of subtotals) total += subtotal;
  return total;
}

async function filesUnder(root) {
  const files = [];
  const pending = [resolve(root)];
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) files.push(path);
    }
  }
  return files;
}

function assertWithinBoundary(boundary, path) {
  const root = resolve(boundary);
  const target = resolve(path);
  if (target === root || !target.startsWith(root + sep)) {
    throw new Error(`retention target escaped KCoder Studio E2E boundary: ${target}`);
  }
}

function newestFirst(left, right) {
  return right.endedAtMs - left.endedAtMs;
}

function oldestLowValueFirst(left, right) {
  if (left.status !== right.status) return left.status === "passed" ? -1 : 1;
  return left.endedAtMs - right.endedAtMs;
}
