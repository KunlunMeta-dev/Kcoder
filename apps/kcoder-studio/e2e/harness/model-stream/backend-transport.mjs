import { mkdir } from "node:fs/promises";
import { AppServerStdioClient, waitForStdioChildClose } from "../app-server-stdio.mjs";

export async function startBackendModelTransport(context, {
  label,
  binary,
  workspace,
  settingsFile,
  configDir,
  controller,
  transportMode = "standard",
}) {
  const home = context.pathInState("home");
  const tempRoot = context.pathInState("tmp");
  await Promise.all([home, tempRoot, configDir].map(path => mkdir(path, { recursive: true, mode: 0o700 })));

  const env = context.isolatedEnvironment({
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: configDir,
    KCODER_HOME: home,
    KCODER_CONFIG_DIR: configDir,
    TMPDIR: tempRoot,
    TMP: tempRoot,
    TEMP: tempRoot,
    ...(transportMode === "private" || transportMode === "environment-only" ? {
      KCODER_E2E_MODEL_TRANSPORT_URL: `${controller.controlUrl}/transport`,
      KCODER_E2E_MODEL_TRANSPORT_TOKEN: controller.controlToken,
    } : {}),
  });
  const child = context.spawnOwned(label, binary, [
    "--settings-file", settingsFile,
    "--cwd", workspace,
    "app-server",
    "--training-mode",
  ], { cwd: workspace, env, stdin: "pipe" });
  if (!child.stdin || !child.stdout) throw new Error(`${label} must expose JSONL stdin and stdout`);

  const client = new AppServerStdioClient(label, child, { defaultTimeoutMs: 30_000 });
  let closePromise;
  const close = () => {
    closePromise ??= (async () => {
      if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end();
      const exit = await waitForStdioChildClose(child, 20_000, label);
      await context.stopOwned(label);
      client.closeReader();
      return exit;
    })();
    return closePromise;
  };
  context.addCleanup(`close app-server model transport ${label}`, close, { timeoutMs: 25_000 });
  return { child, client, close, home, configDir, tempRoot, transportMode };
}
