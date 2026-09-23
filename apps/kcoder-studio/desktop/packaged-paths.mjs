import { posix, win32 } from "node:path";

export function packagedRuntimePaths(resourcesPath, platform = process.platform) {
  const paths = platform === "win32" ? win32 : posix;
  return {
    kcoder: paths.join(resourcesPath, "bin", platform === "win32" ? "kcoder.exe" : "kcoder"),
    supervisor: platform === "win32"
      ? paths.join(resourcesPath, "bin", "kcoder-process-supervisor.exe")
      : undefined,
  };
}
