import { constants } from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  readdir,
  readFile,
  readlink,
  realpath,
  symlink,
} from "node:fs/promises";
import { basename, dirname } from "node:path";

export async function stageManagedBrowserRuntime(
  context,
  kcoderBin,
  chromiumBin,
) {
  if (
    process.platform !== "linux" ||
    basename(dirname(chromiumBin)) !== "chrome-linux64"
  ) {
    throw new Error(
      "UNMET_PREREQUISITE: managed staging requires a Linux chrome-linux64/chrome distribution",
    );
  }
  const directory = context.pathInState("managed-runtime", "bin");
  context.registerTemporaryDirectory("managed runtime staging", directory);
  await mkdir(context.pathInState("managed-runtime", "bin", "chrome"), {
    recursive: true,
  });
  const stagedBin = context.pathInState("managed-runtime", "bin", "kcoder");
  // Copy the executable: current_exe resolves symlinks back to the source tree.
  await copyFile(
    kcoderBin,
    stagedBin,
    constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL,
  );
  await chmod(stagedBin, 0o700);
  const chromeDirectory = context.pathInState(
    "managed-runtime",
    "bin",
    "chrome",
    "chrome-linux64",
  );
  // The external verified distribution remains read-only and outside cleanup ownership.
  await symlink(await realpath(dirname(chromiumBin)), chromeDirectory, "dir");
  return { kcoderBin: stagedBin, chromeDirectory };
}

export async function managedChromeDescendants(gatewayPid, chromiumBin) {
  const expectedExecutable = await realpath(chromiumBin);
  const entries = (await readdir("/proc")).filter((name) => /^\d+$/.test(name));
  const records = await Promise.all(
    entries.map(async (name) => {
      const status = await readFile(`/proc/${name}/status`, "utf8").catch(
        () => "",
      );
      return {
        pid: Number(name),
        parent: Number(status.match(/^PPid:\s+(\d+)$/m)?.[1]),
      };
    }),
  );
  const parents = new Map(records.map((record) => [record.pid, record.parent]));
  const owned = records.filter((record) => {
    const visited = new Set();
    let pid = record.pid;
    while (pid && !visited.has(pid)) {
      if (pid === gatewayPid) return true;
      visited.add(pid);
      pid = parents.get(pid);
    }
    return false;
  });
  const matching = await Promise.all(
    owned.map(async (record) => {
      const executable = await readlink(`/proc/${record.pid}/exe`).catch(
        () => "",
      );
      return executable === expectedExecutable ? record.pid : null;
    }),
  );
  return matching.filter((pid) => pid !== null);
}
