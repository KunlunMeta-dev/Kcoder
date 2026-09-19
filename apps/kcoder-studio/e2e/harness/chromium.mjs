import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "../../renderer/node_modules/@playwright/test/index.mjs";
import { requireExecutable, waitFor } from "./run-context.mjs";

export async function startChromium(context, options = {}) {
  const executablePath = await requireExecutable(
    options.executablePath || process.env.KCODER_E2E_CHROMIUM_BIN || "/usr/bin/chromium",
    "system Chromium",
  );
  const noSandbox = options.noSandbox ?? process.env.KCODER_E2E_CHROMIUM_NO_SANDBOX === "1";
  if (!noSandbox && process.env.KCODER_E2E_REQUIRE_CHROMIUM_SANDBOX !== "1") {
    throw new Error(
      "UNMET_PREREQUISITE: isolated VM runs must explicitly set KCODER_E2E_CHROMIUM_NO_SANDBOX=1; sandbox-capable hosts must set KCODER_E2E_REQUIRE_CHROMIUM_SANDBOX=1",
    );
  }

  const label = options.label || "chromium";
  const portLabel = options.portLabel || "chromium-cdp";
  const profileDir = context.pathInState("chromium", `${label}-profile`);
  context.registerTemporaryDirectory(`${label} profile`, profileDir);
  const args = [
    "--headless=new",
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=0",
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-component-update",
    "--disable-renderer-backgrounding",
    "--disable-sync",
    "--metrics-recording-only",
    "about:blank",
  ];
  if (noSandbox) args.unshift("--no-sandbox", "--disable-setuid-sandbox");

  const child = context.spawnOwned(label, executablePath, args, {
    env: context.isolatedEnvironment(options.env || {}, options.passEnv || []),
  });
  const activePortFile = resolve(profileDir, "DevToolsActivePort");
  const activePort = await waitFor(async () => {
    if (child.exitCode !== null) {
      throw new Error(`Chromium exited before CDP became ready with code ${child.exitCode}`);
    }
    const raw = await readFile(activePortFile, "utf8").catch(() => "");
    const [portText, webSocketPath] = raw.trim().split(/\r?\n/);
    const port = Number(portText);
    return Number.isInteger(port) && port > 0 && webSocketPath?.startsWith("/devtools/browser/")
      ? { port, webSocketPath }
      : null;
  }, options.startTimeoutMs || 20_000, `${label} CDP endpoint`, 50, context.abortSignal);
  context.registerPort(portLabel, activePort.port);

  const playwrightBrowser = await chromium.connectOverCDP(`http://127.0.0.1:${activePort.port}`);
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await playwrightBrowser.close().catch(() => undefined);
    await context.stopOwned(label);
  };
  context.addCleanup(`close ${label} CDP client`, close);

  return {
    browser: playwrightBrowser,
    child,
    cdpPort: activePort.port,
    executablePath,
    noSandbox,
    profileDir,
    newPage: options => playwrightBrowser.newPage(options),
    close,
  };
}
