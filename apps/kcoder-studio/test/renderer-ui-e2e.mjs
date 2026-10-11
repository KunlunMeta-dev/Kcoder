import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "../renderer/node_modules/@playwright/test/index.mjs";

const appRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const repoRoot = resolve(appRoot, "../..");
const port = await availablePort();
const stamp = new Date().toISOString().replaceAll(":", "-").replace("T", "-").replace("Z", "");
const out = resolve(repoRoot, "target/client-lab/ui-e2e", `${stamp}-${process.pid}`);
await mkdir(out, { recursive: true });

const gateway = spawn(process.execPath, ["dev-server.mjs"], {
  cwd: appRoot,
  env: {
    ...process.env,
    KCODER_STUDIO_HOST: "127.0.0.1",
    KCODER_STUDIO_PORT: String(port),
    KCODER_STUDIO_MOCK: "1",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let gatewayLog = "";
gateway.stdout.setEncoding("utf8");
gateway.stderr.setEncoding("utf8");
gateway.stdout.on("data", (chunk) => { gatewayLog += chunk; });
gateway.stderr.on("data", (chunk) => { gatewayLog += chunk; });

let browser;
let page;
const browserErrors = [];
const runtimeStreamLogs = [];
const websocketFrames = [];
try {
  await waitFor(() => gatewayLog.includes(`127.0.0.1:${port}`), 10_000, "gateway startup");
  browser = await chromium.launch({ headless: true, executablePath: process.env.KCODER_STUDIO_CHROMIUM || "/usr/bin/chromium" });
  page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.addInitScript(() => localStorage.setItem("wework:debug-runtime-chat-stream", "1"));
  page.on("pageerror", (error) => browserErrors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(`console: ${message.text()}`);
    if (message.text().startsWith("[KCoder Studio] Runtime chat stream")) {
      runtimeStreamLogs.push({ type: message.type(), text: message.text() });
    }
  });
  page.on("websocket", (socket) => {
    socket.on("framesent", ({ payload }) => websocketFrames.push({ direction: "sent", payload: String(payload) }));
    socket.on("framereceived", ({ payload }) => websocketFrames.push({ direction: "received", payload: String(payload) }));
  });

  const response = await page.goto(`http://127.0.0.1:${port}/?e2e=1`, { waitUntil: "domcontentloaded" });
  if (response?.status() !== 200) throw new Error(`renderer returned HTTP ${response?.status()}`);
  await page.getByTestId("chat-message-input").waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId("chat-message-input").click();
  await page.keyboard.insertText("验证 KCoder 流式适配");
  const send = page.getByTestId("send-message-button");
  if (await send.isDisabled()) throw new Error("composer send button stayed disabled after input");
  await send.click();
  await page.getByText(/我收到了/, { exact: false }).waitFor({ timeout: 10_000 });
  await page.getByText("验证 KCoder 流式适配", { exact: true }).first().waitFor();

  const desktopMetrics = await page.evaluate(() => ({
    innerWidth,
    innerHeight,
    scrollWidth: document.documentElement.scrollWidth,
    scrollHeight: document.documentElement.scrollHeight,
  }));
  if (desktopMetrics.scrollWidth !== desktopMetrics.innerWidth) {
    throw new Error(`desktop horizontal overflow: ${JSON.stringify(desktopMetrics)}`);
  }
  if (desktopMetrics.scrollHeight !== desktopMetrics.innerHeight) {
    throw new Error(`desktop shell escaped viewport: ${JSON.stringify(desktopMetrics)}`);
  }
  await page.screenshot({ path: resolve(out, "conversation-1280x800.png") });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(500);
  const mobileMetrics = await page.evaluate(() => ({
    innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  if (mobileMetrics.scrollWidth !== mobileMetrics.innerWidth) {
    throw new Error(`mobile horizontal overflow: ${JSON.stringify(mobileMetrics)}`);
  }
  await page.screenshot({ path: resolve(out, "conversation-390x844.png") });

  if (browserErrors.length > 0) {
    throw new Error(`renderer emitted browser errors:\n${browserErrors.join("\n")}`);
  }
  const result = { ok: true, port, desktopMetrics, mobileMetrics, browserErrors, websocketFrameCount: websocketFrames.length };
  await writeFile(resolve(out, "result.json"), JSON.stringify(result, null, 2));
  await writeFile(resolve(out, "gateway.log"), gatewayLog);
  console.log(JSON.stringify(result));
} catch (error) {
  await writeFile(resolve(out, "gateway.log"), gatewayLog);
  await writeFile(resolve(out, "failure.json"), JSON.stringify({
    error: error instanceof Error ? error.stack ?? error.message : String(error),
    browserErrors,
    runtimeStreamLogs,
    websocketFrames,
  }, null, 2));
  if (page) {
    await page.screenshot({ path: resolve(out, "failure.png"), fullPage: true }).catch(() => undefined);
    await writeFile(resolve(out, "failure.html"), await page.content()).catch(() => undefined);
  }
  throw error;
} finally {
  await browser?.close();
  gateway.kill("SIGTERM");
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function availablePort() {
  const probe = createNetServer();
  await new Promise((resolveListen, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolveListen);
  });
  const address = probe.address();
  await new Promise((resolveClose) => probe.close(resolveClose));
  if (!address || typeof address === "string") throw new Error("failed to allocate E2E port");
  return address.port;
}
