import { createRunContext } from "../run-context.mjs";
import { runContextRuntime } from "../runtime-paths.mjs";
import { startSession } from "../session.mjs";
import { chromium } from "@playwright/test";
import {
  browserLaunchOptions,
  defaultCommandString,
} from "../runner-options.mjs";
import { writeJsonArtifact } from "../runtime-artifacts.mjs";
import process from "node:process";

export async function openInteractive(options) {
  const artifacts = await createRunContext(
    options,
    "open",
    runContextRuntime(),
  );
  const runOptions = {
    ...options,
    runDir: artifacts.dir,
    workspaceDir: artifacts.workspace,
    requestsDir: artifacts.requestsDir,
    configHome: artifacts.configHome,
  };
  const session = await startSession(runOptions);
  const browser = await chromium.launch(browserLaunchOptions(options));
  const page = await browser.newPage({
    viewport: {
      width: Math.max(900, options.cols * 9 + 80),
      height: Math.max(640, options.rows * 18 + 80),
    },
  });
  await page.goto(session.url);
  await writeJsonArtifact(artifacts.meta, {
    command: defaultCommandString(runOptions),
    runId: artifacts.runId,
    date: artifacts.dateStamp,
    time: artifacts.timeStamp,
    description: artifacts.description,
    dateDir: artifacts.dateDir,
    runLabel: artifacts.runLabel,
    runDir: artifacts.dir,
    workspace: artifacts.workspace,
    workspaceTemplate: artifacts.workspaceTemplate,
    scenario: options.scenario,
    url: session.url,
    mode: "open",
  });
  console.log(`KCoder TUI Lab open at ${session.url}`);
  console.log(`Run directory: ${artifacts.dir}`);
  console.log("Close the browser or press Ctrl+C here to stop the PTY.");

  const stop = async () => {
    await browser.close().catch(() => {});
    await session.stop().catch(() => {});
  };
  process.once("SIGINT", async () => {
    await stop();
    process.exit(130);
  });
  process.once("SIGTERM", async () => {
    await stop();
    process.exit(143);
  });

  while (browser.isConnected()) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  await stop();
}
