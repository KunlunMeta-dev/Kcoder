import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import process from "node:process";
import { spawnSync } from "node:child_process";

export const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const toolRoot = path.resolve(__dirname, "..");

export const repoRoot = path.resolve(toolRoot, "..", "..");

export const targetRoot = path.join(repoRoot, "target", "tui-lab");

export const defaultWorkspaceTemplate = path.join(
  toolRoot,
  "workspace-template",
);

export const nodeModulesBin = path.join(toolRoot, "node_modules", ".bin");

export function runContextRuntime() {
  const userHome = os.homedir();
  return {
    now: new Date(),
    pid: process.pid,
    platform: process.platform,
    cwd: process.cwd(),
    targetRoot,
    configRoot:
      process.env.KCODER_TUI_LAB_CONFIG_ROOT ||
      path.join(userHome, ".kcoder-tui-lab"),
    configTrustRoot: process.env.KCODER_TUI_LAB_CONFIG_TRUST_ROOT || userHome,
    windowsVmVerified: process.env.KCODER_TUI_LAB_WINDOWS_VM_VERIFIED === "1",
    repoRoot,
    spawnSync,
  };
}
