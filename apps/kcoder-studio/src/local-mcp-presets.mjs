// Facts a client needs to offer one-click MCP presets that run on the local
// skill Node runtime. Only local same-account targets receive these facts,
// and only for launchers the Gateway actually generated at startup.
import { posix, win32 } from 'node:path';
import { providesSkillNodeRuntime } from './skill-node-runtime.mjs';

const PLAYWRIGHT_OUTPUT_DIRECTORY = 'playwright-mcp-output';

/**
 * Describe the presets available to `target`, or undefined when none are.
 *
 * The command is the launcher name the target's app-server resolves through
 * PATH. On Windows it carries the `.cmd` extension because the launcher
 * directory also holds an extensionless POSIX script for Git Bash, which a
 * PATH search would otherwise pick first and Windows cannot execute.
 * Automatically named Playwright outputs (console logs, downloads and
 * unnamed screenshots) go next to the private launcher directory instead of
 * into the conversation workspace.
 */
export function localMcpPresetsForTarget(runtime, target, platform = process.platform) {
  if (!runtime?.binDirectory || !providesSkillNodeRuntime(target)) return undefined;
  const windows = platform === 'win32';
  const paths = windows ? win32 : posix;
  if (!paths.isAbsolute(runtime.binDirectory)) return undefined;
  const command = windows ? 'playwright-mcp.cmd' : 'playwright-mcp';
  if (!Array.isArray(runtime.launchers) || !runtime.launchers.includes(command)) return undefined;
  return {
    version: 1,
    playwright: {
      command,
      defaultBrowser: windows ? 'msedge' : 'chrome',
      outputDirectory: paths.join(paths.dirname(runtime.binDirectory), PLAYWRIGHT_OUTPUT_DIRECTORY),
    },
  };
}
