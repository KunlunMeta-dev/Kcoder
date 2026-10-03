import { spawnSync } from "node:child_process";

export async function pollTmuxText(sessionName, expected, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const text = captureTmux(sessionName);
    if (text.includes(expected)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`timed out waiting for tmux text: ${expected}`);
}

export function captureTmux(sessionName, options = {}) {
  const args = ["capture-pane", options.ansi ? "-epJ" : "-pJ"];
  if (options.history !== false) {
    args.push("-S", "-");
  }
  args.push("-t", sessionName);
  const result = spawnSync("tmux", args, {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || "tmux capture-pane failed");
  }
  return result.stdout;
}
