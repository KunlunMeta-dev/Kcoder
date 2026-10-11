import { createRunContext } from "../run-context.mjs";
import { runContextRuntime, repoRoot } from "../runtime-paths.mjs";
import process from "node:process";
import { shellQuote, defaultCommandString } from "../runner-options.mjs";
import {
  writeStartMeta,
  writeTextArtifact,
  writeJsonArtifact,
  formatError,
} from "../runtime-artifacts.mjs";
import { spawnSync } from "node:child_process";
import { pollTmuxText, captureTmux } from "../tmux-control.mjs";
import {
  TMUX_RESIZE_SEQUENCE,
  assertTmuxResizeChrome,
} from "../terminal-geometry.mjs";
import path from "node:path";

export async function tmuxSmoke(options) {
  const artifacts = await createRunContext(
    options,
    "tmux-smoke",
    runContextRuntime(),
  );
  const runOptions = {
    ...options,
    runDir: artifacts.dir,
    workspaceDir: artifacts.workspace,
    requestsDir: artifacts.requestsDir,
    configHome: artifacts.configHome,
  };
  const sessionName = `kcoder-tui-lab-${process.pid}`;
  const command = `cd ${shellQuote(repoRoot)} && exec ${defaultCommandString(runOptions)}`;
  await writeStartMeta(artifacts, runOptions, command, "tmux-smoke");
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
      command,
    ],
    { encoding: "utf8" },
  );
  if (start.status !== 0) {
    throw new Error(start.stderr || "failed to start tmux session");
  }
  try {
    await pollTmuxText(
      sessionName,
      "TUI dev mode is running mock scenario",
      options.timeoutMs,
    );
    spawnSync("tmux", ["send-keys", "-l", "-t", sessionName, options.message], {
      encoding: "utf8",
    });
    await new Promise((resolve) => setTimeout(resolve, 350));
    spawnSync("tmux", ["send-keys", "-t", sessionName, "Enter"], {
      encoding: "utf8",
    });
    await pollTmuxText(
      sessionName,
      "tui-lab-final-sentinel",
      options.timeoutMs,
    );
    const resizeCaptures = [];
    for (const [index, size] of TMUX_RESIZE_SEQUENCE.entries()) {
      const resize = spawnSync(
        "tmux",
        [
          "resize-window",
          "-t",
          sessionName,
          "-x",
          String(size.cols),
          "-y",
          String(size.rows),
        ],
        { encoding: "utf8" },
      );
      if (resize.status !== 0) {
        throw new Error(
          resize.stderr || `failed to resize tmux window at step ${index + 1}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 180));
      const stageText = captureTmux(sessionName);
      const stageVisibleText = captureTmux(sessionName, { history: false });
      const stageAnsiText = captureTmux(sessionName, { ansi: true });
      const textPath = path.join(
        artifacts.dir,
        `screen-resize-${index + 1}.txt`,
      );
      const visibleTextPath = path.join(
        artifacts.dir,
        `screen-resize-${index + 1}-visible.txt`,
      );
      const ansiPath = path.join(
        artifacts.dir,
        `screen-resize-${index + 1}.ansi.txt`,
      );
      await writeTextArtifact(textPath, stageText);
      await writeTextArtifact(visibleTextPath, stageVisibleText);
      await writeTextArtifact(ansiPath, stageAnsiText);
      assertTmuxResizeChrome(stageVisibleText, `resize-${index + 1}`, {
        requireWelcome: false,
        requireSentinel: true,
      });
      resizeCaptures.push({
        step: index + 1,
        ...size,
        text: textPath,
        visibleText: visibleTextPath,
        ansiText: ansiPath,
      });
    }
    const capture = captureTmux(sessionName);
    const visibleCapture = captureTmux(sessionName, { history: false });
    const ansiCapture = captureTmux(sessionName, { ansi: true });
    assertTmuxResizeChrome(visibleCapture, "final", {
      requireWelcome: false,
      requireSentinel: true,
    });
    await writeTextArtifact(artifacts.text, capture);
    const visibleText = path.join(artifacts.dir, "screen-visible.txt");
    await writeTextArtifact(visibleText, visibleCapture);
    await writeTextArtifact(artifacts.ansiText, ansiCapture);
    await writeJsonArtifact(artifacts.meta, {
      command,
      runId: artifacts.runId,
      date: artifacts.dateStamp,
      time: artifacts.timeStamp,
      description: artifacts.description,
      dateDir: artifacts.dateDir,
      runLabel: artifacts.runLabel,
      runDir: artifacts.dir,
      workspace: artifacts.workspace,
      workspaceTemplate: artifacts.workspaceTemplate,
      message: options.message,
      scenario: options.scenario,
      text: artifacts.text,
      visibleText,
      ansiText: artifacts.ansiText,
      resizeSequence: TMUX_RESIZE_SEQUENCE,
      resizeCaptures,
      resizedTo: TMUX_RESIZE_SEQUENCE[TMUX_RESIZE_SEQUENCE.length - 1],
    });
    console.log(
      JSON.stringify(
        { ok: true, text: artifacts.text, meta: artifacts.meta },
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
      mode: "tmux-smoke",
      command,
      cwd: repoRoot,
      runId: artifacts.runId,
      date: artifacts.dateStamp,
      time: artifacts.timeStamp,
      description: artifacts.description,
      runDir: artifacts.dir,
      workspace: artifacts.workspace,
      workspaceTemplate: artifacts.workspaceTemplate,
      message: options.message,
      scenario: options.scenario,
      text: text ? artifacts.text : undefined,
      error: formatError(error),
      failedAt: new Date().toISOString(),
    });
    throw error;
  } finally {
    spawnSync("tmux", ["kill-session", "-t", sessionName], { stdio: "ignore" });
  }
}
