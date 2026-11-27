import { createRunContext } from "../run-context.mjs";
import { runContextRuntime, repoRoot } from "../runtime-paths.mjs";
import process from "node:process";
import { defaultCommandString } from "../runner-options.mjs";
import {
  writeStartMeta,
  writeTextArtifact,
  writeJsonArtifact,
  formatError,
} from "../runtime-artifacts.mjs";
import { spawnSync } from "node:child_process";
import { pollTmuxText, captureTmux } from "../tmux-control.mjs";
import { runStartupAssertions } from "../scenario-assertions.mjs";

export async function tmuxStartup(options) {
  const artifacts = await createRunContext(
    options,
    "tmux-startup",
    runContextRuntime(),
  );
  const runOptions = {
    ...options,
    runDir: artifacts.dir,
    workspaceDir: artifacts.workspace,
    requestsDir: artifacts.requestsDir,
    configHome: artifacts.configHome,
  };
  const sessionName = `kcoder-tui-lab-startup-${process.pid}`;
  const command = defaultCommandString(runOptions);
  await writeStartMeta(artifacts, runOptions, command, "tmux-startup");
  spawnSync("tmux", ["kill-session", "-t", sessionName], { stdio: "ignore" });
  const start = spawnSync(
    "tmux",
    [
      "new-session",
      "-d",
      "-s",
      sessionName,
      "-x",
      String(options.cols),
      "-y",
      String(options.rows),
      "-c",
      repoRoot,
    ],
    { encoding: "utf8" },
  );
  if (start.status !== 0) {
    throw new Error(start.stderr || "failed to start tmux session");
  }
  try {
    await new Promise((resolve) => setTimeout(resolve, 250));
    spawnSync("tmux", ["send-keys", "-l", "-t", sessionName, command], {
      encoding: "utf8",
    });
    spawnSync("tmux", ["send-keys", "-t", sessionName, "Enter"], {
      encoding: "utf8",
    });
    await pollTmuxText(sessionName, "Welcome to KCoder!", options.timeoutMs);
    await new Promise((resolve) => setTimeout(resolve, 350));
    const capture = captureTmux(sessionName);
    const ansiCapture = captureTmux(sessionName, { ansi: true });
    const assertions = runStartupAssertions({ text: capture });
    await writeTextArtifact(artifacts.text, capture);
    await writeTextArtifact(artifacts.ansiText, ansiCapture);
    await writeJsonArtifact(artifacts.assertions, assertions);
    if (!assertions.ok) {
      const error = new Error(
        `tmux startup assertions failed: ${assertions.failed.join(", ")}`,
      );
      error.assertions = assertions;
      throw error;
    }
    await writeJsonArtifact(artifacts.meta, {
      ok: true,
      mode: "tmux-startup",
      command,
      cwd: repoRoot,
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
      text: artifacts.text,
      ansiText: artifacts.ansiText,
      assertions: artifacts.assertions,
      pty: {
        cols: options.cols,
        rows: options.rows,
        launch: "interactive-shell",
      },
    });
    console.log(
      JSON.stringify(
        { ok: true, mode: "tmux-startup", text: artifacts.text, assertions },
        null,
        2,
      ),
    );
  } catch (error) {
    let text = "";
    try {
      text = captureTmux(sessionName);
      await writeTextArtifact(artifacts.text, text);
    } catch {
      // Session may not exist or may have exited before capture.
    }
    await writeJsonArtifact(artifacts.failure, {
      ok: false,
      mode: "tmux-startup",
      command,
      cwd: repoRoot,
      runId: artifacts.runId,
      date: artifacts.dateStamp,
      time: artifacts.timeStamp,
      description: artifacts.description,
      runDir: artifacts.dir,
      workspace: artifacts.workspace,
      workspaceTemplate: artifacts.workspaceTemplate,
      scenario: options.scenario,
      text: text ? artifacts.text : undefined,
      assertions: error.assertions,
      error: formatError(error),
      failedAt: new Date().toISOString(),
    });
    throw error;
  } finally {
    spawnSync("tmux", ["kill-session", "-t", sessionName], { stdio: "ignore" });
  }
}
