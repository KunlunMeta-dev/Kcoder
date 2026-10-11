import { readdir, readFile, rm, stat } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

export const DEFAULT_RETENTION = Object.freeze({
  successfulMaxCount: 5,
  successfulMaxAgeMs: 3 * 24 * 60 * 60 * 1000,
  failedMaxCount: 20,
  failedMaxAgeMs: 14 * 24 * 60 * 60 * 1000,
  totalMaxBytes: 2 * 1024 * 1024 * 1024,
});

export async function enforceRetention(boundary, policy = DEFAULT_RETENTION, now = Date.now()) {
  const root = resolve(boundary);
  const runs = await discoverCompletedRuns(root);
  const removalPlan = planRetention(runs, now, policy);
  for (const run of removalPlan) {
    assertWithinBoundary(root, run.path);
    await rm(run.path, { recursive: true, force: true });
  }
  return removalPlan.map(run => run.path);
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
  let files;
  try {
    files = await filesUnder(boundary);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const manifests = files.filter(path => path.endsWith(`${sep}manifest.json`));
  const runs = [];
  for (const manifestPath of manifests) {
    try {
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      if (!['passed', 'failed'].includes(manifest.status) || !manifest.source) continue;
      const path = dirname(manifestPath);
      assertWithinBoundary(boundary, path);
      runs.push({
        path,
        source: manifest.source,
        status: manifest.status,
        endedAtMs: Date.parse(manifest.endedAt || manifest.startedAt),
        sizeBytes: await directorySize(path),
      });
    } catch {
      // A partial/malformed run is retained for diagnosis; retention never guesses ownership.
    }
  }
  return runs;
}

async function directorySize(root) {
  let total = 0;
  for (const path of await filesUnder(root)) total += (await stat(path)).size;
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
