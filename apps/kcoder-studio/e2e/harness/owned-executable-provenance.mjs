import { createHash } from "node:crypto";
import { readdir, readFile, readlink, realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";

export async function hashExecutableFile(executablePath) {
  const resolvedPath = await realpath(executablePath);
  const [contents, metadata] = await Promise.all([
    readFile(resolvedPath),
    stat(resolvedPath),
  ]);
  return {
    path: resolvedPath,
    size: metadata.size,
    mtime: metadata.mtime.toISOString(),
    sha256: createHash("sha256").update(contents).digest("hex"),
  };
}

/**
 * Read-only evidence for an executable running inside one owned process group.
 * This intentionally reads no command-line arguments or environment variables.
 */
export async function findOwnedExecutableProcesses({
  pgid,
  executablePath,
  procRoot = "/proc",
}) {
  if (!Number.isSafeInteger(pgid) || pgid <= 0) {
    throw new TypeError("pgid must be a positive process group ID");
  }
  const expectedPath = await realpath(executablePath);
  const entries = await readdir(procRoot, { withFileTypes: true });
  const matches = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    const pid = Number(entry.name);
    const processRoot = resolve(procRoot, entry.name);
    const statPath = resolve(processRoot, "stat");
    const exePath = resolve(processRoot, "exe");
    try {
      const before = parseProcessStat(await readFile(statPath, "utf8"));
      if (before.pgid !== pgid) continue;

      const exeLink = await readlink(exePath);
      const linkedPath = exeLink.replace(/ \(deleted\)$/, "");
      if (resolve(linkedPath) !== expectedPath) continue;

      // Read procfs executable bytes so a replaced on-disk file cannot make a
      // different running image look like the configured binary.
      const executableBytes = await readFile(exePath);
      const afterLink = await readlink(exePath);
      const after = parseProcessStat(await readFile(statPath, "utf8"));
      if (before.pgid !== after.pgid || before.startTime !== after.startTime || exeLink !== afterLink) {
        continue;
      }

      matches.push({
        pid,
        executablePath: linkedPath,
        sha256: createHash("sha256").update(executableBytes).digest("hex"),
      });
    } catch (error) {
      // Processes can exit while /proc is being enumerated. Other failures
      // are treated as missing evidence; callers must mark provenance unverified.
      if (!["ENOENT", "ESRCH", "EACCES", "EPERM"].includes(error?.code)) throw error;
    }
  }

  return matches.sort((left, right) => left.pid - right.pid);
}

function parseProcessStat(value) {
  const close = value.lastIndexOf(")");
  if (close < 0) throw new Error("invalid /proc process stat record");
  const fields = value.slice(close + 1).trim().split(/\s+/);
  if (fields.length < 20) throw new Error("short /proc process stat record");
  const pgid = Number(fields[2]);
  const startTime = fields[19];
  if (!Number.isSafeInteger(pgid) || !startTime) throw new Error("invalid /proc process identity");
  return { pgid, startTime };
}
